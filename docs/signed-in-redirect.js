/* Sends an already-signed-in visitor straight to the app instead of showing
   them the marketing page. Lifted out of an inline <script> in index.html so
   that page can carry a Content-Security-Policy that refuses inline
   execution; deliberately NOT deferred, since the whole point is to redirect
   before the landing page paints. */
try {
  if (localStorage.getItem('pp_auth_token')) {
    window.location.href = '/app.html';
  }
} catch (e) {}
