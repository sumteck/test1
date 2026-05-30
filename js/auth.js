/**
 * auth.js — v3
 * ============
 * Google OAuth 2.0 authentication for the Treasury Bill Reconciliation App.
 * Uses Google Identity Services (GIS) token-based / implicit flow.
 *
 * ==========================================================================
 * WHAT'S NEW IN v3  (session persistence across MPA page navigation)
 * ==========================================================================
 *
 * PROBLEM
 * -------
 * The app is a Multi-Page Application. Every time the user follows a navbar
 * link (index.html → report.html, or back), the browser discards the entire
 * JavaScript environment. The in-memory `_accessToken` is destroyed and the
 * user sees the sign-in prompt again on every page.
 *
 * SOLUTION — sessionStorage persistence
 * --------------------------------------
 * On every successful sign-in (new token received from GIS) the access token
 * and its expiry timestamp are written to sessionStorage under two keys:
 *
 *   sessionStorage["tbr_access_token"]   – the raw OAuth access token string
 *   sessionStorage["tbr_token_expiry"]   – epoch-ms expiry as a string
 *
 * On every page load the IIFE immediately calls _tryRestoreSession(), which:
 *   1. Reads both keys from sessionStorage.
 *   2. Checks that the token exists AND has not expired.
 *   3. If valid: copies the values back into the in-memory variables.
 *      (No UI update yet — page modules haven't registered callbacks yet.)
 *   4. If missing or expired: removes the stale keys and leaves state empty.
 *
 * The deferred UI update is handled by the new public `init()` method, which
 * must be called from DOMContentLoaded AFTER all page modules have registered
 * their `onSignIn` / `onSignOut` callbacks. `init()` checks the in-memory
 * state (already populated by _tryRestoreSession) and fires _updateUI and all
 * callbacks exactly once, in the right order.
 *
 * WHY sessionStorage AND NOT localStorage?
 * -----------------------------------------
 * • sessionStorage is cleared automatically when the tab closes or the
 *   browser session ends — correct behaviour for OAuth tokens.
 * • Each tab has its own independent sessionStorage, so signing out in one
 *   tab does not affect other tabs (desirable in a multi-user environment).
 * • localStorage would persist tokens across browser restarts, creating a
 *   stale-token risk if the machine is shared or the token is revoked.
 *
 * SECURITY NOTE
 * -------------
 * sessionStorage is readable by any same-origin JavaScript. If an attacker
 * can execute arbitrary JS on the page they can read the token — but this is
 * identical to the risk of storing it in memory. sessionStorage does NOT
 * increase the XSS attack surface compared to the previous in-memory approach.
 * HTTPS (enforced on GitHub Pages) prevents network-level interception.
 *
 * ==========================================================================
 * FIXES CARRIED FORWARD FROM v2
 * ==========================================================================
 *
 * FIX-1 (v2) — CALLBACK OVERWRITE
 *   v1 used scalar `_onSignInCallback` / `_onSignOutCallback`. The last
 *   caller to `onSignIn(cb)` silently discarded all previous registrations.
 *   Fixed by using arrays: every call appends; all callbacks fire in order.
 *
 * FIX-2 (v2) — GIS ASYNC RACE
 *   `async defer` on the GIS <script> tag means `google.accounts` may not
 *   exist when auth.js executes. `_ensureTokenClient()` now awaits a 100 ms
 *   polling loop (max 10 s) before initialising the token client.
 *
 * FIX-3 (v2) — STALE SERVICE WORKER
 *   A leftover dev-time SW can intercept requests and serve cached JS/HTML.
 *   A one-time cleanup at module load unregisters all SWs on the origin.
 */

// ── Service Worker cleanup ────────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((sw) => {
      sw.unregister();
      console.info("[TbrAuth] Unregistered stale service worker:", sw.scope);
    });
  });
}

// ── Module ────────────────────────────────────────────────────────────────
const TbrAuth = (() => {

  // ── Storage keys ─────────────────────────────────────────────────────────
  const SS_TOKEN  = "tbr_access_token";
  const SS_EXPIRY = "tbr_token_expiry";

  // ── Private state ─────────────────────────────────────────────────────────
  let _tokenClient = null;
  let _accessToken = null;
  let _tokenExpiry = 0;         // epoch ms

  // Callback arrays — append-only, never overwritten (FIX-1)
  const _signInCallbacks  = [];
  const _signOutCallbacks = [];

  // ── sessionStorage helpers ────────────────────────────────────────────────

  /**
   * Write the current token + expiry to sessionStorage.
   * Called immediately after a successful GIS token response.
   */
  function _saveSession() {
    try {
      sessionStorage.setItem(SS_TOKEN,  _accessToken);
      sessionStorage.setItem(SS_EXPIRY, String(_tokenExpiry));
    } catch (e) {
      // sessionStorage can be blocked in some privacy modes — not fatal.
      console.warn("[TbrAuth] Could not write to sessionStorage:", e.message);
    }
  }

  /**
   * Remove token data from sessionStorage.
   * Called on sign-out and on detection of an expired stored token.
   */
  function _clearSession() {
    try {
      sessionStorage.removeItem(SS_TOKEN);
      sessionStorage.removeItem(SS_EXPIRY);
    } catch (e) {
      console.warn("[TbrAuth] Could not clear sessionStorage:", e.message);
    }
  }

  /**
   * On page load, attempt to restore a previously saved auth session.
   *
   * Reads sessionStorage, validates the token is present and non-expired,
   * and if so copies the values into the in-memory state variables.
   *
   * Deliberately does NOT call _updateUI() or fire callbacks here — page
   * modules have not yet registered their callbacks at IIFE-execution time.
   * The deferred UI update is handled by the public init() method, which is
   * called from DOMContentLoaded after all modules are ready.
   *
   * @returns {boolean}  true if a valid token was restored, false otherwise.
   */
  function _tryRestoreSession() {
    try {
      const token  = sessionStorage.getItem(SS_TOKEN);
      const expiry = parseInt(sessionStorage.getItem(SS_EXPIRY) || "0", 10);

      if (token && expiry > Date.now()) {
        _accessToken = token;
        _tokenExpiry = expiry;
        console.info("[TbrAuth] Session restored from sessionStorage.");
        return true;
      }

      // Token missing or expired — remove stale entries and stay signed out.
      if (token || expiry) {
        _clearSession();
        console.info("[TbrAuth] Stale session cleared from sessionStorage.");
      }
    } catch (e) {
      // sessionStorage blocked (private browsing with strict settings, etc.)
      console.warn("[TbrAuth] Could not read sessionStorage:", e.message);
    }
    return false;
  }

  // ── GIS async-load guard (FIX-2) ─────────────────────────────────────────

  /**
   * Returns a Promise that resolves once `google.accounts.oauth2` is ready.
   * Polls every 100 ms; rejects after 10 seconds with a clear error message.
   */
  function _waitForGIS() {
    return new Promise((resolve, reject) => {
      if (typeof google !== "undefined" && google.accounts?.oauth2) {
        resolve();
        return;
      }
      let attempts = 0;
      const MAX = 100; // 100 × 100 ms = 10 s
      const id = setInterval(() => {
        attempts++;
        if (typeof google !== "undefined" && google.accounts?.oauth2) {
          clearInterval(id);
          resolve();
        } else if (attempts >= MAX) {
          clearInterval(id);
          reject(new Error(
            "Google Identity Services did not load within 10 seconds. " +
            "Check that the GIS <script> tag is present and the network is reachable."
          ));
        }
      }, 100);
    });
  }

  /**
   * Lazily initialise the GIS TokenClient (async-safe).
   * No-op if already initialised.
   */
  async function _ensureTokenClient() {
    if (_tokenClient) return;
    await _waitForGIS();

    _tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: TBR_CONFIG.CLIENT_ID,
      scope:     TBR_CONFIG.SCOPES,
      callback:  (tokenResponse) => {
        if (tokenResponse.error) {
          console.error("[TbrAuth] OAuth error:", tokenResponse);
          _showAuthError(tokenResponse.error_description || tokenResponse.error);
          return;
        }

        _accessToken = tokenResponse.access_token;
        _tokenExpiry = Date.now() + (tokenResponse.expires_in - 60) * 1000;

        // Persist immediately so the next page load can restore without a popup.
        _saveSession();

        _updateUI(true);
        _signInCallbacks.forEach(cb => {
          try { cb(_accessToken); } catch (e) { console.error(e); }
        });
      },
    });
  }

  // ── UI helpers ────────────────────────────────────────────────────────────

  function _showAuthError(msg) {
    const el = document.getElementById("auth-error-msg");
    if (el) {
      el.textContent = `Authentication error: ${msg}`;
      el.classList.remove("hidden");
    }
  }

  function _updateUI(isSignedIn) {
    document.querySelectorAll("[data-tbr='signin-btn']")
      .forEach(btn => btn.classList.toggle("hidden",  isSignedIn));
    document.querySelectorAll("[data-tbr='signout-btn']")
      .forEach(btn => btn.classList.toggle("hidden", !isSignedIn));
    document.querySelectorAll("[data-tbr='auth-gated']")
      .forEach(el  => el.classList.toggle("hidden", !isSignedIn));

    const banner = document.getElementById("auth-status-banner");
    if (banner) banner.classList.toggle("hidden", !isSignedIn);

    // Clear any stale error message
    const errEl = document.getElementById("auth-error-msg");
    if (errEl) errEl.classList.add("hidden");
  }

  // ── Session restore on module load ────────────────────────────────────────
  // Run immediately when the script is parsed. Populates in-memory state if
  // a valid session exists. No UI side-effects yet (DOM may not be ready).
  _tryRestoreSession();

  // ── Public API ────────────────────────────────────────────────────────────
  return {

    /**
     * Register a sign-in callback.
     * APPENDS to the array — never overwrites previous registrations (FIX-1).
     * Safe to call multiple times from different modules.
     *
     * @param {function(string):void} cb  Receives the access token.
     */
    onSignIn(cb) {
      if (typeof cb === "function") _signInCallbacks.push(cb);
    },

    /**
     * Register a sign-out callback. Same append semantics as onSignIn.
     *
     * @param {function():void} cb
     */
    onSignOut(cb) {
      if (typeof cb === "function") _signOutCallbacks.push(cb);
    },

    /**
     * Initialise the auth UI state for the current page.
     *
     * MUST be called from DOMContentLoaded, AFTER all page modules have
     * registered their onSignIn / onSignOut callbacks. It checks the
     * in-memory state (already hydrated from sessionStorage by the IIFE)
     * and fires _updateUI plus all registered callbacks exactly once.
     *
     * Typical usage in each HTML file:
     *
     *   document.addEventListener("DOMContentLoaded", () => {
     *     TbrAuth.bindButtons();
     *     TbrAuth.init();        // ← must come after onSignIn() registrations
     *   });
     */
    init() {
      if (_accessToken && Date.now() < _tokenExpiry) {
        // Valid session restored — update DOM and notify all modules.
        _updateUI(true);
        _signInCallbacks.forEach(cb => {
          try { cb(_accessToken); } catch (e) { console.error(e); }
        });
      } else {
        // No valid session — show sign-in prompt.
        _updateUI(false);
      }
    },

    /**
     * Trigger the Google OAuth sign-in popup.
     *
     * • If a valid in-memory token already exists (restored from sessionStorage
     *   or from a previous sign-in on this page), skips the popup and fires
     *   callbacks immediately.
     * • Otherwise requests a new token via GIS. On success the GIS callback
     *   saves the token to sessionStorage and fires all registered callbacks.
     *
     * Async-safe: waits for the GIS library to load before proceeding (FIX-2).
     */
    async signIn() {
      try {
        await _ensureTokenClient();
      } catch (err) {
        _showAuthError(err.message);
        return;
      }

      // Already signed in (e.g. user clicked button again, or restored from storage)
      if (_accessToken && Date.now() < _tokenExpiry) {
        _updateUI(true);
        _signInCallbacks.forEach(cb => {
          try { cb(_accessToken); } catch (e) { console.error(e); }
        });
        return;
      }

      // prompt: "" → show consent screen only when truly needed
      _tokenClient.requestAccessToken({ prompt: "" });
    },

    /**
     * Sign the user out.
     *
     * Revokes the token with Google, clears sessionStorage, resets in-memory
     * state, updates the UI, and fires all registered sign-out callbacks.
     */
    signOut() {
      if (_accessToken) {
        google.accounts.oauth2.revoke(_accessToken, () => {
          console.info("[TbrAuth] Token revoked with Google.");
        });
      }

      _accessToken = null;
      _tokenExpiry = 0;
      _clearSession();           // ← remove from sessionStorage

      _updateUI(false);
      _signOutCallbacks.forEach(cb => {
        try { cb(); } catch (e) { console.error(e); }
      });
    },

    /**
     * Return the current valid access token, or null if not signed in /
     * token expired. API callers should handle null by showing an error or
     * calling signIn().
     *
     * @returns {string|null}
     */
    getToken() {
      return (_accessToken && Date.now() < _tokenExpiry) ? _accessToken : null;
    },

    /**
     * Return true if the user is currently authenticated with a non-expired
     * token.
     *
     * @returns {boolean}
     */
    isSignedIn() {
      return !!this.getToken();
    },

    /**
     * Wire up all [data-tbr="signin-btn"] and [data-tbr="signout-btn"]
     * elements on the current page. Idempotent; safe to call multiple times.
     */
    bindButtons() {
      document.querySelectorAll("[data-tbr='signin-btn']")
        .forEach(btn => btn.addEventListener("click", () => TbrAuth.signIn()));
      document.querySelectorAll("[data-tbr='signout-btn']")
        .forEach(btn => btn.addEventListener("click", () => TbrAuth.signOut()));
    },
  };
})();
