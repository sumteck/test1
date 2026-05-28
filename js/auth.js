/**
 * auth.js
 * =======
 * Handles all Google OAuth 2.0 authentication flows using the
 * Google Identity Services (GIS) library (the modern replacement for gapi.auth2).
 *
 * Pattern: Token-based (implicit flow) — ideal for client-side only apps.
 * The access token is stored in memory (never localStorage) for security.
 */

const TbrAuth = (() => {
  // ── Private state ────────────────────────────────────────────────────────
  let _tokenClient = null;
  let _accessToken = null;
  let _tokenExpiry = 0;   // epoch ms
  let _onSignInCallback = null;
  let _onSignOutCallback = null;

  // ── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Initialise the GIS token client once the library is ready.
   * Called lazily on first sign-in attempt.
   */
  function _ensureTokenClient() {
    if (_tokenClient) return;

    _tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: TBR_CONFIG.CLIENT_ID,
      scope: TBR_CONFIG.SCOPES,
      callback: (tokenResponse) => {
        if (tokenResponse.error) {
          console.error("OAuth error:", tokenResponse);
          _showAuthError(tokenResponse.error_description || tokenResponse.error);
          return;
        }

        _accessToken = tokenResponse.access_token;
        // expires_in is in seconds
        _tokenExpiry = Date.now() + (tokenResponse.expires_in - 60) * 1000;

        _updateUI(true);
        if (_onSignInCallback) _onSignInCallback(_accessToken);
      },
    });
  }

  function _showAuthError(msg) {
    const el = document.getElementById("auth-error-msg");
    if (el) {
      el.textContent = `Authentication error: ${msg}`;
      el.classList.remove("hidden");
    }
  }

  /**
   * Update every sign-in/out button & user panel on the page.
   * Works across both the Dashboard and Report pages.
   */
  function _updateUI(isSignedIn) {
    // Sign-in buttons
    document.querySelectorAll("[data-tbr='signin-btn']").forEach(btn => {
      btn.classList.toggle("hidden", isSignedIn);
    });

    // Sign-out buttons
    document.querySelectorAll("[data-tbr='signout-btn']").forEach(btn => {
      btn.classList.toggle("hidden", !isSignedIn);
    });

    // Gated sections only visible when signed in
    document.querySelectorAll("[data-tbr='auth-gated']").forEach(el => {
      el.classList.toggle("hidden", !isSignedIn);
    });

    // Auth banner / welcome area
    const authBanner = document.getElementById("auth-status-banner");
    if (authBanner) {
      authBanner.classList.toggle("hidden", !isSignedIn);
    }

    // Error message reset
    const errEl = document.getElementById("auth-error-msg");
    if (errEl) errEl.classList.add("hidden");
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    /**
     * Register callbacks that fire after sign-in / sign-out.
     * Call this from app.js before anything else.
     */
    onSignIn(cb) { _onSignInCallback = cb; },
    onSignOut(cb) { _onSignOutCallback = cb; },

    /**
     * Kick off the OAuth popup flow.
     * Requests a new token even if one exists (handles expiry gracefully).
     */
    signIn() {
      _ensureTokenClient();
      // If we already have a valid token, skip the popup
      if (_accessToken && Date.now() < _tokenExpiry) {
        _updateUI(true);
        if (_onSignInCallback) _onSignInCallback(_accessToken);
        return;
      }
      // prompt: "" triggers consent only when needed; avoids repeat popups
      _tokenClient.requestAccessToken({ prompt: "" });
    },

    /**
     * Revoke the token and clear local state.
     */
    signOut() {
      if (_accessToken) {
        google.accounts.oauth2.revoke(_accessToken, () => {
          console.log("Token revoked.");
        });
      }
      _accessToken = null;
      _tokenExpiry = 0;
      _updateUI(false);
      if (_onSignOutCallback) _onSignOutCallback();
    },

    /**
     * Returns the current valid access token, or null.
     * Callers should handle null by triggering signIn().
     */
    getToken() {
      if (_accessToken && Date.now() < _tokenExpiry) return _accessToken;
      return null;
    },

    /**
     * Convenience: returns true if a non-expired token is held.
     */
    isSignedIn() {
      return !!this.getToken();
    },

    /**
     * Wire up DOM buttons once the page is ready.
     * Idempotent — safe to call multiple times.
     */
    bindButtons() {
      document.querySelectorAll("[data-tbr='signin-btn']").forEach(btn => {
        btn.addEventListener("click", () => TbrAuth.signIn());
      });
      document.querySelectorAll("[data-tbr='signout-btn']").forEach(btn => {
        btn.addEventListener("click", () => TbrAuth.signOut());
      });
    },
  };
})();
