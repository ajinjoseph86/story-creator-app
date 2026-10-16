const crypto = require('crypto');
const express = require('express');

function makeToken(secret) {
  return crypto.createHmac('sha256', secret).update('authenticated').digest('hex');
}

// Simple shared-password gate — no accounts/database. Protects the app from being
// publicly accessible to anyone with the link.
function applyAuth(app, { password, secret, cookieName = 'app_auth' } = {}) {
  if (!password) {
    console.warn('APP_PASSWORD not set — login gate is disabled, app is publicly accessible.');
    return;
  }

  const validToken = makeToken(secret || password);
  const maxAge = 60 * 60 * 24 * 30; // 30 days

  app.use(express.urlencoded({ extended: false }));

  app.get('/login', (req, res) => {
    const error = req.query.error ? '<p class="error">Incorrect password.</p>' : '';
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
    if (req.body && req.body.password === password) {
      res.setHeader('Set-Cookie', `${cookieName}=${validToken}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`);
      return res.redirect('/');
    }
    res.redirect('/login?error=1');
  });

  app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${cookieName}=; Path=/; Max-Age=0`);
    res.redirect('/login');
  });

  app.use((req, res, next) => {
    if (req.path === '/login' || req.path === '/logout') return next();

    const cookies = req.headers.cookie || '';
    const match = cookies.match(new RegExp(`${cookieName}=([^;]+)`));
    const token = match ? match[1] : null;

    if (token === validToken) return next();

    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized. Please log in.' });
    }
    return res.redirect('/login');
  });
}

module.exports = { applyAuth };
