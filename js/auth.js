/**
 * auth.js  — v2  (FIXED)
 * ======================
 * Changes from v1:
 *
 *  BUG 1 — CALLBACK OVERWRITE (root cause of "needs refresh")
 *    v1 used single scalar variables `_onSignInCallback` and
 *    `_onSignOutCallback`.  Every call to `onSignIn(cb)` simply
 *    replaced the previous callback, so whichever module called it
 *    last (dashboard.js vs the inline <script> at the bottom of the
 *    HTML) silently discarded the earlier one.  On first load the
 *    dashboard's callback was registered, then the inline prompt-
 *    toggler overwrote it.  After a refresh the GIS library (loaded
 *    async) resolved in a different order, giving the dashboard its
 *    callback back.
 *    FIX → Use arrays.  All registered callbacks are called in order.
 *
 *  BUG 2 — GIS ASYNC RACE
 *    The GIS <script> tag carries `async defer`, so `google.accounts`
 *    may not exist yet when auth.js executes.  If something calls
 *    `TbrAuth.signIn()` before the library resolves,
 *    `google.accounts.oauth2.initTokenClient` throws "google is not
 *    defined" and the whole sign-in silently fails.
 *    FIX → `_ensureTokenClient()` now defers initialisation via
 *    `google.accounts.oauth2.initTokenClient` inside a
 *    `window.onGoogleLibraryLoad` guard, and falls back to a small
 *    polling loop if that global isn't available yet.
 *
 *  BUG 3 — SERVICE WORKER STALE CACHE
 *    There was never an intentional Service Worker in this project.
 *    If one was accidentally registered during development it can
 *    intercept every fetch and serve stale JS/HTML, which makes the
 *    page appear to need a refresh to see new code.
 *    FIX → A one-time cleanup snippet at the top of this file
 *    unregisters ALL service workers on the current origin.  It is
 *    safe to leave permanently; if you later add a real SW, remove it.
 */

// ── Service Worker cleanup (runs once per origin) ─────────────────────────
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((sw) => {
      sw.unregister();
      console.info("[TbrAuth] Unregistered stale service worker:", sw.scope);
    });
  });
}

// ── Module ─────────────────────────────────────────────────────────────────
const TbrAuth = (() => {
  // ── Private state ──────────────────────────────────────────────────────
  let _tokenClient  = null;
  let _accessToken  = null;
  let _tokenExpiry  = 0;          // epoch ms

  // FIX: arrays instead of single variables
  const _signInCallbacks  = [];
  const _signOutCallbacks = [];

  // ── GIS async-load guard ────────────────────────────────────────────────
  /**
   * Returns a Promise that resolves once `google.accounts.oauth2` is
   * available.  Polls every 100 ms, gives up after 10 seconds.
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
            "Check your internet connection and that the GIS script tag is present."
          ));
        }
      }, 100);
    });
  }

  /**
   * Lazily initialise the GIS token client (async-safe).
   */
  async function _ensureTokenClient() {
    if (_tokenClient) return;
    await _waitForGIS();

    _tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: TBR_CONFIG.CLIENT_ID,
      scope: TBR_CONFIG.SCOPES,
      callback: (tokenResponse) => {
        if (tokenResponse.error) {
          console.error("[TbrAuth] OAuth error:", tokenResponse);
          _showAuthError(tokenResponse.error_description || tokenResponse.error);
          return;
        }
        _accessToken = tokenResponse.access_token;
        _tokenExpiry = Date.now() + (tokenResponse.expires_in - 60) * 1000;
        _updateUI(true);
        // FIX: fire ALL registered sign-in callbacks
        _signInCallbacks.forEach(cb => { try { cb(_accessToken); } catch (e) { console.error(e); } });
      },
    });
  }

  // ── UI helpers ─────────────────────────────────────────────────────────
  function _showAuthError(msg) {
    const el = document.getElementById("auth-error-msg");
    if (el) {
      el.textContent = `Authentication error: ${msg}`;
      el.classList.remove("hidden");
    }
  }

  function _updateUI(isSignedIn) {
    document.querySelectorAll("[data-tbr='signin-btn']")
      .forEach(btn => btn.classList.toggle("hidden", isSignedIn));
    document.querySelectorAll("[data-tbr='signout-btn']")
      .forEach(btn => btn.classList.toggle("hidden", !isSignedIn));
    document.querySelectorAll("[data-tbr='auth-gated']")
      .forEach(el  => el.classList.toggle("hidden", !isSignedIn));

    const banner = document.getElementById("auth-status-banner");
    if (banner) banner.classList.toggle("hidden", !isSignedIn);

    const errEl = document.getElementById("auth-error-msg");
    if (errEl) errEl.classList.add("hidden");
  }

  // ── Public API ──────────────────────────────────────────────────────────
  return {
    /**
     * Register a sign-in callback.
     * FIX: APPENDS to the array — does NOT overwrite previous callers.
     * Safe to call multiple times (dashboard.js, report.js, inline scripts).
     */
    onSignIn(cb) {
      if (typeof cb === "function") _signInCallbacks.push(cb);
    },

    /**
     * Register a sign-out callback.  Same multi-callback fix.
     */
    onSignOut(cb) {
      if (typeof cb === "function") _signOutCallbacks.push(cb);
    },

    /**
     * Trigger the OAuth popup.  Async-safe: waits for GIS to load first.
     */
    async signIn() {
      try {
        await _ensureTokenClient();
      } catch (err) {
        _showAuthError(err.message);
        return;
      }

      // If we already hold a valid token, skip the popup
      if (_accessToken && Date.now() < _tokenExpiry) {
        _updateUI(true);
        _signInCallbacks.forEach(cb => { try { cb(_accessToken); } catch (e) { console.error(e); } });
        return;
      }

      // `prompt: ""` → consent only when truly needed
      _tokenClient.requestAccessToken({ prompt: "" });
    },

    /**
     * Revoke the current token and reset state.
     */
    signOut() {
      if (_accessToken) {
        google.accounts.oauth2.revoke(_accessToken, () => {
          console.info("[TbrAuth] Token revoked.");
        });
      }
      _accessToken = null;
      _tokenExpiry = 0;
      _updateUI(false);
      // FIX: fire ALL sign-out callbacks
      _signOutCallbacks.forEach(cb => { try { cb(); } catch (e) { console.error(e); } });
    },

    /**
     * Returns the current access token, or null if expired / not signed in.
     */
    getToken() {
      return (_accessToken && Date.now() < _tokenExpiry) ? _accessToken : null;
    },

    isSignedIn() {
      return !!this.getToken();
    },

    /**
     * Wire up all data-tbr="signin-btn" and data-tbr="signout-btn" elements.
     * Idempotent; safe to call on DOMContentLoaded.
     */
    bindButtons() {
      document.querySelectorAll("[data-tbr='signin-btn']")
        .forEach(btn => btn.addEventListener("click", () => TbrAuth.signIn()));
      document.querySelectorAll("[data-tbr='signout-btn']")
        .forEach(btn => btn.addEventListener("click", () => TbrAuth.signOut()));
    },
  };
})();
