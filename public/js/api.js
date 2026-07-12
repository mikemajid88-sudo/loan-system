const Auth = {
  getToken: () => localStorage.getItem('lms_token'),
  getUser: () => {
    const raw = localStorage.getItem('lms_user');
    return raw ? JSON.parse(raw) : null;
  },
  setSession: (token, user) => {
    localStorage.setItem('lms_token', token);
    localStorage.setItem('lms_user', JSON.stringify(user));
  },
  clear: () => {
    localStorage.removeItem('lms_token');
    localStorage.removeItem('lms_user');
  },
  requireRole: (roles) => {
    const user = Auth.getUser();
    const token = Auth.getToken();
    if (!token || !user || !roles.includes(user.role)) {
      window.location.href = '/index.html';
      return null;
    }
    return user;
  },
};

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = Auth.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data;
  try {
    data = await res.json();
  } catch (e) {
    data = {};
  }

  if (!res.ok) {
    throw new Error(data.error || 'Something went wrong');
  }
  return data;
}

function money(n) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function badge(status) {
  const label = status.replace('_', ' ');
  return `<span class="badge badge-${status}">${label}</span>`;
}

function fmtDate(s) {
  if (!s) return '';
  return new Date(s.replace(' ', 'T') + 'Z').toLocaleString();
}

function logout() {
  Auth.clear();
  window.location.href = '/index.html';
}

function countdownPill(daysRemaining, status) {
  if (status !== 'disbursed' || daysRemaining === null || daysRemaining === undefined) return '';
  if (daysRemaining < 0) return `<span class="countdown-pill countdown-overdue">Overdue ${Math.abs(daysRemaining)}d</span>`;
  if (daysRemaining <= 3) return `<span class="countdown-pill countdown-overdue">${daysRemaining}d left</span>`;
  if (daysRemaining <= 7) return `<span class="countdown-pill countdown-soon">${daysRemaining}d left</span>`;
  return `<span class="countdown-pill countdown-ok">${daysRemaining}d left</span>`;
}

async function getSettings() {
  const { settings } = await api('/settings');
  return settings;
}
