window.API_BASE = 'https://pixel-pick-odds.mgbouldering.workers.dev';
window.AUTH_TOKEN_KEY = 'pp_auth_token';
window.AUTH_USER_KEY = 'pp_auth_user';

function getToken() {
  return localStorage.getItem(window.AUTH_TOKEN_KEY);
}

function authHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` };
}

/* textContent, not an innerHTML template — `message` is usually `data.error`
   straight off the API response, and this page holds the auth token. Same
   fix as login.js's showMessage. */
function showMessage(elementId, message, isError = false) {
  const el = document.getElementById(elementId);
  el.textContent = '';
  if (!message) return;
  const box = document.createElement('div');
  box.className = isError ? 'error' : 'success';
  box.textContent = message;
  el.append(box);
}

async function loadAccount() {
  const res = await fetch(`${window.API_BASE}/api/auth/me`, { headers: authHeaders() });
  if (res.status === 401) {
    // Token is dead (expired, or invalidated by "Sign Out Everywhere" /
    // a password change elsewhere) — clear it before redirecting, or
    // login.html's own "already logged in" check sees the stale token
    // and immediately bounces straight back to app.html.
    localStorage.removeItem(window.AUTH_TOKEN_KEY);
    localStorage.removeItem(window.AUTH_USER_KEY);
    window.location.href = '/login.html';
    return null;
  }
  if (!res.ok) throw new Error('Failed to load account');
  return res.json();
}

function renderPendingEmailBanner(pendingEmail) {
  const el = document.getElementById('pending-email-banner');
  if (!pendingEmail) {
    el.innerHTML = '';
    return;
  }
  // Assembled rather than interpolated: pendingEmail is a value the
  // account holder supplied, so it must not be able to carry markup
  // into this page's DOM.
  const banner = document.createElement('div');
  banner.className = 'pending-banner';
  banner.append('Verification pending for ');
  const strong = document.createElement('strong');
  strong.textContent = pendingEmail;
  banner.append(strong,
    '\u2014 check that inbox to confirm the change. Your current email stays active until then.');
  el.textContent = '';
  el.append(banner);
}

function populateForm(data) {
  document.getElementById('username-input').value = data.username || '';
  document.getElementById('email-current').value = data.email;
  renderPendingEmailBanner(data.pendingEmail);

  document.getElementById('notif-potd-email').checked = !!data.notifications.potdEmail;
  document.getElementById('notif-picks-email').checked = !!data.notifications.picksEmail;
  document.getElementById('notif-ladder-email').checked = !!data.notifications.ladderEmail;
  document.getElementById('notif-potd-sms').checked = !!data.notifications.potdSms;
  document.getElementById('notif-picks-sms').checked = !!data.notifications.picksSms;
  document.getElementById('notif-tracking-report').checked = !!data.notifications.trackingReportEmail;
}

async function init() {
  if (!getToken()) {
    window.location.href = '/login.html';
    return;
  }

  // Auto-confirm an email change if we arrived here via the confirmation
  // link (?emailToken=...), same silent-auto-verify pattern login.html
  // already uses for the original signup verification link.
  const params = new URLSearchParams(window.location.search);
  const emailToken = params.get('emailToken');
  if (emailToken) {
    try {
      const res = await fetch(`${window.API_BASE}/api/account/email/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: emailToken }),
      });
      const data = await res.json();
      if (res.ok) {
        showMessage('email-message', 'Email updated successfully!', false);
      } else {
        showMessage('email-message', data.error, true);
      }
    } catch (err) {
      showMessage('email-message', 'Confirmation failed: ' + err.message, true);
    }
    window.history.replaceState({}, document.title, '/account.html');
  }

  try {
    const data = await loadAccount();
    if (!data) return;
    populateForm(data);
    document.getElementById('loading-state').classList.add('hidden');
    document.getElementById('settings-body').classList.remove('hidden');
  } catch (err) {
    document.getElementById('loading-state').textContent = 'Failed to load account: ' + err.message;
  }
}

document.getElementById('username-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  const original = btn.textContent;
  const username = document.getElementById('username-input').value;
  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving...';
    const res = await fetch(`${window.API_BASE}/api/account/username`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ username }),
    });
    const data = await res.json();
    if (!res.ok) { showMessage('username-message', data.error, true); return; }
    showMessage('username-message', 'Username updated!', false);
  } catch (err) {
    showMessage('username-message', 'Connection failed: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

document.getElementById('email-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  const original = btn.textContent;
  const newEmail = document.getElementById('email-new').value;
  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Sending...';
    const res = await fetch(`${window.API_BASE}/api/account/email`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ newEmail }),
    });
    const data = await res.json();
    if (!res.ok) { showMessage('email-message', data.error, true); return; }
    showMessage('email-message', data.message, false);
    renderPendingEmailBanner(newEmail);
    document.getElementById('email-new').value = '';
  } catch (err) {
    showMessage('email-message', 'Connection failed: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

document.getElementById('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  const original = btn.textContent;
  const currentPassword = document.getElementById('password-current').value;
  const newPassword = document.getElementById('password-new').value;
  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving...';
    const res = await fetch(`${window.API_BASE}/api/account/password`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json();
    if (!res.ok) { showMessage('password-message', data.error, true); return; }
    // The server revoked every session (epoch bump) and handed this one
    // a fresh token — swap it in so THIS session keeps working while
    // all others are signed out.
    if (data.token) localStorage.setItem(window.AUTH_TOKEN_KEY, data.token);
    showMessage('password-message', 'Password updated — other devices have been signed out.', false);
    document.getElementById('password-form').reset();
  } catch (err) {
    showMessage('password-message', 'Connection failed: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

// Notification toggles save immediately on change — no separate submit
// button, matches the instant feel of a settings switch rather than a form.
document.querySelectorAll('#settings-body input[data-field]').forEach((input) => {
  input.addEventListener('change', async () => {
    const field = input.dataset.field;
    try {
      const res = await fetch(`${window.API_BASE}/api/account/notifications`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ [field]: input.checked }),
      });
      const data = await res.json();
      if (!res.ok) {
        showMessage('notif-message', data.error, true);
        input.checked = !input.checked; // revert on failure
        return;
      }
      showMessage('notif-message', 'Saved.', false);
      setTimeout(() => showMessage('notif-message', ''), 1500);
    } catch (err) {
      showMessage('notif-message', 'Connection failed: ' + err.message, true);
      input.checked = !input.checked;
    }
  });
});

document.getElementById('delete-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!confirm('This permanently deletes your account and everything saved to it. There is no undo. Continue?')) return;
  const btn = e.target.querySelector('button');
  const original = btn.textContent;
  const currentPassword = document.getElementById('delete-password').value;
  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Deleting...';
    const res = await fetch(`${window.API_BASE}/api/account`, {
      method: 'DELETE',
      headers: authHeaders(),
      body: JSON.stringify({ currentPassword }),
    });
    const data = await res.json();
    if (!res.ok) { showMessage('delete-message', data.error, true); return; }
    localStorage.removeItem(window.AUTH_TOKEN_KEY);
    localStorage.removeItem(window.AUTH_USER_KEY);
    alert('Your account has been deleted.');
    window.location.href = '/login.html';
  } catch (err) {
    showMessage('delete-message', 'Connection failed: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

document.getElementById('signout-all-btn').addEventListener('click', async () => {
  if (!confirm('Sign out on every device, including this one?')) return;
  try {
    const res = await fetch(`${window.API_BASE}/api/account/logout-all`, {
      method: 'POST',
      headers: authHeaders(),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showMessage('session-message', data.error ?? 'Something went wrong — try again.', true);
      return;
    }
  } catch (err) {
    showMessage('session-message', 'Connection failed: ' + err.message, true);
    return;
  }
  localStorage.removeItem(window.AUTH_TOKEN_KEY);
  localStorage.removeItem(window.AUTH_USER_KEY);
  window.location.href = '/login.html';
});

document.getElementById('signout-btn').addEventListener('click', () => {
  if (!confirm('Are you sure you want to sign out?')) return;
  localStorage.removeItem(window.AUTH_TOKEN_KEY);
  localStorage.removeItem(window.AUTH_USER_KEY);
  window.location.href = 'https://perpetualpicks.com/login.html';
});

init();
