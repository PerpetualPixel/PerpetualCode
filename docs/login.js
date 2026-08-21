// Global constants
window.API_BASE = 'https://pixel-pick-odds.mgbouldering.workers.dev';
window.AUTH_TOKEN_KEY = 'pp_auth_token';
window.AUTH_USER_KEY = 'pp_auth_user';

const API_BASE = window.API_BASE;
const AUTH_TOKEN_KEY = window.AUTH_TOKEN_KEY;
const AUTH_USER_KEY = window.AUTH_USER_KEY;

/* Built as DOM with textContent rather than an innerHTML template. Most of
   what lands here is `data.error` / `data.message` straight off the auth API
   response — interpolating that into innerHTML made every one of those
   strings an execution sink on the one page that handles credentials and
   writes the auth token. textContent closes it without changing what the
   user sees. */
function showMessage(elementId, message, isError = false) {
  const el = document.getElementById(elementId);
  el.textContent = '';
  if (!message) return;
  const box = document.createElement('div');
  box.className = isError ? 'error' : 'success';
  box.textContent = message;
  el.append(box);
}

const AUTH_SECTION_IDS = ['login-form', 'register-form', 'verify-form', 'forgot-form', 'reset-form'];

// Shows exactly one auth section, hiding the rest — explicit rather
// than the old pairwise .toggle() (fine back when only login/register
// existed, broken once forgot/reset joined: toggling two classLists
// independently can't guarantee "exactly one visible" once there are
// more than two sections in play).
function toggleForms(target = 'login') {
  for (const id of AUTH_SECTION_IDS) {
    document.getElementById(id).classList.toggle('hidden', id !== `${target}-form`);
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const username = document.getElementById('register-username').value;
  const email = document.getElementById('register-email').value;
  const password = document.getElementById('register-password').value;
  const notifyEmail = document.getElementById('register-notify-email').checked;
  const agree21 = document.getElementById('register-agree-21').checked;
  // The Turnstile widget injects this hidden input into the form once
  // the challenge passes; the server re-verifies it (tokens are
  // single-use and mean nothing until siteverify confirms them).
  const turnstileToken = e.target.querySelector('[name="cf-turnstile-response"]')?.value ?? '';
  const btn = e.target.querySelector('button[type="submit"]');
  const originalText = btn.textContent;

  if (!agree21) {
    showMessage('register-message', "Please confirm you're 21+ and agree to the Terms & Privacy Policy.", true);
    return;
  }

  if (!turnstileToken) {
    showMessage('register-message', 'Please complete the verification challenge first.', true);
    return;
  }

  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Creating...';

    const res = await fetch(`${window.API_BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password, notifyEmail, turnstileToken }),
    });

    const data = await res.json();

    if (!res.ok) {
      showMessage('register-message', data.error, true);
      // Tokens are single-use — this one was just consumed (or
      // rejected) by the failed attempt, so the widget must issue a
      // fresh one before a retry can succeed.
      window.turnstile?.reset();
      return;
    }

    showMessage('register-message', 'Account created! Check your email to verify.', false);
    document.getElementById('register-input').reset();

    // Redirect to login after 2 seconds
    setTimeout(() => {
      window.location.href = '/app.html';
    }, 2000);
  } catch (err) {
    showMessage('register-message', 'Connection failed: ' + err.message, true);
    window.turnstile?.reset(); // token may have been consumed by the failed request
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const identifier = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const btn = e.target.querySelector('button');
  const originalText = btn.textContent;

  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Signing in...';

    const res = await fetch(`${window.API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      if (res.status === 403 && data.needsVerification) {
        showMessage('login-message', 'Please verify your email first', true);
      } else {
        showMessage('login-message', data.error, true);
      }
      return;
    }

    // Store token and redirect
    localStorage.setItem(AUTH_TOKEN_KEY, data.token);
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify({ id: data.userId, email: data.email, username: data.username }));
    // One-time flag for app.html's boot sequence — sessionStorage
    // (not localStorage) so it only ever fires for this fresh login,
    // never on a later page refresh/revisit within the same session.
    sessionStorage.setItem('pp_show_welcome', data.username);
    showMessage('login-message', 'Logged in! Redirecting...', false);

    setTimeout(() => {
      window.location.href = '/app.html';
    }, 1000);
  } catch (err) {
    showMessage('login-message', 'Connection failed: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function handleVerify(e) {
  e.preventDefault();
  const token = document.getElementById('verify-token').value;
  const btn = e.target.querySelector('button');
  const originalText = btn.textContent;

  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Verifying...';

    const res = await fetch(`${window.API_BASE}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    const data = await res.json();

    if (!res.ok) {
      showMessage('verify-message', data.error, true);
      return;
    }

    showMessage('verify-message', 'Email verified! Redirecting to login...', false);
    setTimeout(() => {
      document.getElementById('verify-form').classList.add('hidden');
      document.getElementById('login-form').classList.remove('hidden');
    }, 2000);
  } catch (err) {
    showMessage('verify-message', 'Connection failed: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function handleForgotPassword(e) {
  e.preventDefault();
  const identifier = document.getElementById('forgot-identifier').value;
  const btn = e.target.querySelector('button');
  const originalText = btn.textContent;

  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Sending...';

    const res = await fetch(`${window.API_BASE}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier }),
    });

    const data = await res.json();

    if (!res.ok) {
      showMessage('forgot-message', data.error, true);
      return;
    }

    // Same message whether or not an account matched — the worker
    // deliberately doesn't distinguish (see handleForgotPassword's own
    // comment), so the UI shouldn't either.
    showMessage('forgot-message', data.message, false);
    document.getElementById('forgot-input').reset();
  } catch (err) {
    showMessage('forgot-message', 'Connection failed: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// Populated by the ?resetToken= URL-param check below, read by
// handleResetPassword on submit — the reset form itself has no token
// field for the user to see or edit, it's just carried through.
let pendingResetToken = null;

async function handleResetPassword(e) {
  e.preventDefault();
  const newPassword = document.getElementById('reset-password').value;
  const btn = e.target.querySelector('button');
  const originalText = btn.textContent;

  if (!pendingResetToken) {
    showMessage('reset-message', 'Missing reset token — use the link from your email again.', true);
    return;
  }

  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving...';

    const res = await fetch(`${window.API_BASE}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: pendingResetToken, newPassword }),
    });

    const data = await res.json();

    if (!res.ok) {
      showMessage('reset-message', data.error, true);
      return;
    }

    showMessage('reset-message', 'Password updated! Redirecting to login...', false);
    pendingResetToken = null;
    setTimeout(() => toggleForms('login'), 1500);
  } catch (err) {
    showMessage('reset-message', 'Connection failed: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// Check if we're verifying email, or resetting a password, from a URL param
window.addEventListener('load', async () => {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const resetToken = params.get('resetToken');

  if (resetToken) {
    pendingResetToken = resetToken;
    toggleForms('reset');
    window.history.replaceState({}, document.title, '/login.html');
  }

  if (token) {
    // Auto-verify silently
    try {
      const res = await fetch(`${window.API_BASE}/api/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      if (res.ok) {
        showMessage('verify-message', 'Email verified! Redirecting to login...', false);
        setTimeout(() => {
          toggleForms('login');
          // Clear the token from URL
          window.history.replaceState({}, document.title, '/login.html');
        }, 2000);
      } else {
        const data = await res.json();
        showMessage('verify-message', data.error, true);
        toggleForms('verify');
        document.getElementById('verify-token').value = token;
      }
    } catch (err) {
      showMessage('verify-message', 'Verification failed: ' + err.message, true);
      toggleForms('verify');
    }
  }

  // Check if already logged in — but never steal the screen from an
  // in-progress email verification or password reset even if this
  // browser also happens to have an old session stored (e.g. a reset
  // link opened on a device that's still logged in from before).
  const storedToken = localStorage.getItem(AUTH_TOKEN_KEY);
  if (storedToken && !token && !resetToken) {
    window.location.href = '/app.html';
    return;
  }

  // Landing page's "Join Now" button links here with ?form=register so
  // visitors land straight on the signup form instead of having to
  // find the "Create one" link themselves.
  if (params.get('form') === 'register') {
    toggleForms('register');
  }
});

// Add logout handler (called from app.js)
window.logout = function() {
  if (confirm('Are you sure you want to sign out?')) {
    localStorage.removeItem(window.AUTH_TOKEN_KEY);
    localStorage.removeItem(window.AUTH_USER_KEY);
    window.location.href = 'https://perpetualpicks.com/login.html';
  }
};

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

/* These were onsubmit="" / onclick="" attributes in login.html. Moved here
   so the page carries no inline script at all, which is what lets its
   Content-Security-Policy refuse inline execution outright. */
const AUTH_SUBMIT_HANDLERS = {
  handleLogin,
  handleForgotPassword,
  handleResetPassword,
  handleRegister,
  handleVerify,
};

document.querySelectorAll('[data-auth-submit]').forEach((form) => {
  const handler = AUTH_SUBMIT_HANDLERS[form.dataset.authSubmit];
  if (handler) form.addEventListener('submit', handler);
});

document.addEventListener('click', (event) => {
  const nav = event.target.closest('[data-auth-nav]');
  if (nav) toggleForms(nav.dataset.authNav);
});

