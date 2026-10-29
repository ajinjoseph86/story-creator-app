const crypto = require('crypto');
const express = require('express');

const sha = (value) => crypto.createHash('sha256').update(String(value)).digest();

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Admin password + a list of people, each with their own password and a total spending allowance.
//   ADMIN_PASSWORD (or the older APP_PASSWORD)  -> sees everything, no allowance limit
//   APP_USERS="maria:her-password:20;john:his-password:15"  -> name:password:allowanceUsd, separated by ;
function buildUsers({ adminPassword, usersEnv }) {
  const users = [];
  if (adminPassword) {
    users.push({ id: 'admin', name: 'Admin', role: 'admin', password: adminPassword });
  }
  for (const part of String(usersEnv || '').split(';')) {
    const [name, password, allowance] = part.split(':').map((s) => (s || '').trim());
    if (!name || !password) continue;
    const id = 'u-' + name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (users.some((u) => u.id === id)) continue;
    users.push({ id, name, role: 'user', password, allowanceUsd: Math.max(0, parseFloat(allowance) || 0) });
  }
  return users;
}

function applyAuth(app, { adminPassword, usersEnv, secret, cookieName = 'app_auth' } = {}) {
  const users = buildUsers({ adminPassword, usersEnv });

  if (!users.length) {
    console.warn('No ADMIN_PASSWORD/APP_PASSWORD/APP_USERS set — login gate is disabled, app is publicly accessible.');
    app.use((req, res, next) => {
      req.user = { id: 'admin', name: 'Admin', role: 'admin' };
      next();
    });
    return;
  }

  const signingSecret = secret || adminPassword || 'dev-secret';
  const maxAge = 60 * 60 * 24 * 30; // 30 days
  const attempts = new Map(); // ip -> { count, resetAt }

  app.use(express.urlencoded({ extended: false }));

  app.get('/login', (req, res) => {
    const error = req.query.error
      ? '<p class="error">' + (req.query.error === 'locked' ? 'Too many attempts. Try again in a few minutes.' : 'Incorrect password.') + '</p>'
      : '';
    res.type('html').send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Login</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#0f1115; color:#fff; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
  form { background:#1a1d24; padding:2rem; border-radius:12px; width:280px; box-shadow:0 10px 30px rgba(0,0,0,0.3); }
  h1 { font-size:1.1rem; margin:0 0 1rem; font-weight:600; }
  input { width:100%; padding:0.6rem 0.7rem; border-radius:8px; border:1px solid #333; background:#0f1115; color:#fff; box-sizing:border-box; margin-bottom:0.8rem; font-size:0.95rem; }
  button { width:100%; padding:0.6rem; border-radius:8px; border:none; background:#4f8cff; color:#fff; font-weight:600; cursor:pointer; font-size:0.95rem; }
  button:hover { background:#3d7aed; }
  .error { color:#ff6b6b; font-size:0.85rem; margin:0 0 0.8rem; }
</style>
</head>
<body>
  <form method="POST" action="/login">
    <h1>Enter password to continue</h1>
    ${error}
    <input type="password" name="password" placeholder="Password" autofocus required />
    <button type="submit">Enter</button>
  </form>
</body>
</html>`);
  });

  app.post('/login', (req, res) => {
    const now = Date.now();
    const rec = attempts.get(req.ip);
    if (rec && rec.resetAt > now && rec.count >= 10) {
      return res.redirect('/login?error=locked');
    }
    const supplied = sha((req.body && req.body.password) || '');
    const user = users.find((u) => crypto.timingSafeEqual(supplied, sha(u.password)));
    if (!user) {
      const next = rec && rec.resetAt > now ? rec : { count: 0, resetAt: now + 15 * 60 * 1000 };
      next.count += 1;
      attempts.set(req.ip, next);
      return res.redirect('/login?error=1');
    }
    attempts.delete(req.ip);
    const token = user.id + '.' + hmac(signingSecret, user.id);
    res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`);
    return res.redirect('/');
  });

  app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${cookieName}=; Path=/; Max-Age=0`);
    res.redirect('/login');
  });

  app.use((req, res, next) => {
    if (req.path === '/login' || req.path === '/logout') return next();
    // kie.ai (and other providers) must be able to fetch uploaded/generated media over a plain
    // unauthenticated request — these paths hold randomly-named files, not sensitive by filename,
    // so exempting them from the login gate is safe and necessary for generation to work at all.
    if (req.path.startsWith('/uploads/') || req.path.startsWith('/generated/')) return next();

    const cookies = req.headers.cookie || '';
    const match = cookies.match(new RegExp(`${cookieName}=([^;]+)`));
    const token = match ? match[1] : '';
    const dot = token.lastIndexOf('.');
    if (dot > 0) {
      const id = token.slice(0, dot);
      const user = users.find((u) => u.id === id);
      if (user && safeEqual(token.slice(dot + 1), hmac(signingSecret, id))) {
        req.user = { id: user.id, name: user.name, role: user.role, allowanceUsd: user.allowanceUsd };
        return next();
      }
    }

    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized. Please log in.' });
    }
    return res.redirect('/login');
  });
}

module.exports = { applyAuth, buildUsers };
