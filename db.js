'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.hm_session;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const session = db.prepare(
    `SELECT s.*, u.id as uid, u.email, u.username, u.is_admin
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).get(token);
  if (!session) return res.status(401).json({ error: 'Session expired' });
  req.user = { id: session.uid, email: session.email, username: session.username, is_admin: session.is_admin };
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'Forbidden' });
  next();
}

function requireProject(req, res, next) {
  const projectId = parseInt(req.params.id, 10);
  if (!projectId) return res.status(400).json({ error: 'Invalid project id' });
  const member = db.prepare(
    `SELECT pm.role, p.id, p.name FROM project_members pm
     JOIN projects p ON p.id = pm.project_id
     WHERE pm.project_id = ? AND pm.user_id = ?`
  ).get(projectId, req.user.id);
  if (!member) return res.status(403).json({ error: 'Forbidden' });
  req.project = { id: projectId, name: member.name, role: member.role };
  next();
}

function setCookie(res, token) {
  res.cookie('hm_session', token, {
    httpOnly: true,
    sameSite: 'Strict',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    path: '/'
  });
}

function registerRoutes(app) {
  app.post('/api/auth/signup', (req, res) => {
    const { email, username, password } = req.body || {};
    if (!email || !username || !password) {
      return res.status(400).json({ error: 'email, username and password are required' });
    }
    if (password.length < 6) return res.status(400).json({ error: 'Password too short (min 6)' });
    const existing = db.prepare('SELECT id FROM users WHERE email=? OR username=?').get(email, username);
    if (existing) return res.status(409).json({ error: 'Email or username already taken' });
    const hash = bcrypt.hashSync(password, 10);
    const isFirst = !db.prepare('SELECT id FROM users LIMIT 1').get();
    const result = db.prepare(
      'INSERT INTO users(email, username, pass_hash, is_admin) VALUES(?,?,?,?)'
    ).run(email.toLowerCase().trim(), username.trim(), hash, isFirst ? 1 : 0);
    const token = generateToken();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)').run(token, result.lastInsertRowid, expires);
    setCookie(res, token);
    res.json({ ok: true, user: { id: result.lastInsertRowid, email, username, is_admin: isFirst ? 1 : 0 } });
  });

  app.post('/api/auth/login', (req, res) => {
    const { login, password } = req.body || {};
    if (!login || !password) return res.status(400).json({ error: 'login and password are required' });
    const user = db.prepare('SELECT * FROM users WHERE email=? OR username=?').get(login.toLowerCase().trim(), login.trim());
    if (!user || !bcrypt.compareSync(password, user.pass_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = generateToken();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)').run(token, user.id, expires);
    setCookie(res, token);
    res.json({ ok: true, user: { id: user.id, email: user.email, username: user.username, is_admin: user.is_admin } });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = req.cookies && req.cookies.hm_session;
    if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
    res.clearCookie('hm_session');
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });
}

module.exports = { requireAuth, requireAdmin, requireProject, registerRoutes };
