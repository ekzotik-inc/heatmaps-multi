'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const archiver = require('archiver');
const db = require('./db');
const { requireAuth, requireAdmin, requireProject, registerRoutes } = require('./auth');

// --- env ---
const fs = require('fs');
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });
}
const PORT = parseInt(process.env.PORT || '3001', 10);

// --- SSE connections: projectId → Set<res> ---
const sseClients = new Map();

function sseNotify(projectId, data) {
  const clients = sseClients.get(projectId);
  if (!clients) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch (_) {}
  }
}

// --- app ---
const app = express();

app.use(cookieParser());
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, '..')));

registerRoutes(app);

// --- Projects ---
app.get('/api/projects', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT p.id, p.name, p.created_at, p.updated_at, pm.role,
            length(ps.json) as size_bytes
     FROM projects p
     JOIN project_members pm ON pm.project_id = p.id
     LEFT JOIN project_state ps ON ps.project_id = p.id
     WHERE pm.user_id = ?
     ORDER BY p.updated_at DESC`
  ).all(req.user.id);
  res.json(rows);
});

app.post('/api/projects', requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const result = db.prepare('INSERT INTO projects(name) VALUES(?)').run(name.trim());
  const pid = result.lastInsertRowid;
  db.prepare('INSERT INTO project_members(project_id, user_id, role) VALUES(?,?,?)').run(pid, req.user.id, 'owner');
  db.prepare('INSERT INTO project_state(project_id, json) VALUES(?,?)').run(pid, JSON.stringify({ _app: 'hm-br', _version: 1 }));
  res.json({ id: pid, name: name.trim(), role: 'owner' });
});

app.patch('/api/projects/:id', requireAuth, requireProject, (req, res) => {
  if (req.project.role !== 'owner') return res.status(403).json({ error: 'Only owner can rename' });
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  db.prepare("UPDATE projects SET name=?, updated_at=datetime('now') WHERE id=?").run(name.trim(), req.project.id);
  res.json({ ok: true });
});

app.delete('/api/projects/:id', requireAuth, requireProject, (req, res) => {
  if (req.project.role !== 'owner') return res.status(403).json({ error: 'Only owner can delete' });
  db.prepare('DELETE FROM projects WHERE id=?').run(req.project.id);
  res.json({ ok: true });
});

// --- Project state ---
app.get('/api/projects/:id/state', requireAuth, requireProject, (req, res) => {
  const row = db.prepare('SELECT json, version FROM project_state WHERE project_id=?').get(req.project.id);
  if (!row) return res.json({ _app: 'hm-br', _version: 1 });
  const parsed = JSON.parse(row.json);
  parsed._version = row.version;
  res.json(parsed);
});

app.put('/api/projects/:id/state', requireAuth, requireProject, (req, res) => {
  if (req.project.role === 'viewer') return res.status(403).json({ error: 'Viewers cannot edit' });
  const body = req.body;
  if (!body || body._app !== 'hm-br') return res.status(400).json({ error: 'Invalid state (_app marker missing)' });

  const current = db.prepare('SELECT version FROM project_state WHERE project_id=?').get(req.project.id);
  const clientVersion = parseInt(body._version, 10) || 0;
  if (current && clientVersion && clientVersion !== current.version) {
    return res.status(409).json({ error: 'conflict', serverVersion: current.version });
  }

  const newVersion = (current ? current.version : 0) + 1;
  body._version = newVersion;
  const json = JSON.stringify(body);

  // Save history (keep last 20)
  if (current) {
    const old = db.prepare('SELECT json FROM project_state WHERE project_id=?').get(req.project.id);
    db.prepare('INSERT INTO project_state_history(project_id, json, saved_by_user_id) VALUES(?,?,?)').run(req.project.id, old.json, req.user.id);
    const histCount = db.prepare('SELECT count(*) as c FROM project_state_history WHERE project_id=?').get(req.project.id).c;
    if (histCount > 20) {
      db.prepare(`DELETE FROM project_state_history WHERE id IN (
        SELECT id FROM project_state_history WHERE project_id=? ORDER BY saved_at ASC LIMIT ?
      )`).run(req.project.id, histCount - 20);
    }
  }

  db.prepare(`INSERT INTO project_state(project_id, json, version, updated_at)
    VALUES(?,?,?,datetime('now'))
    ON CONFLICT(project_id) DO UPDATE SET json=excluded.json, version=excluded.version, updated_at=excluded.updated_at`
  ).run(req.project.id, json, newVersion);

  db.prepare("UPDATE projects SET updated_at=datetime('now') WHERE id=?").run(req.project.id);

  sseNotify(req.project.id, { type: 'state_updated', version: newVersion, by: req.user.username });
  res.json({ ok: true, version: newVersion });
});

// --- History ---
app.get('/api/projects/:id/history', requireAuth, requireProject, (req, res) => {
  const rows = db.prepare(
    `SELECT h.id, h.saved_at, u.username
     FROM project_state_history h
     LEFT JOIN users u ON u.id = h.saved_by_user_id
     WHERE h.project_id = ?
     ORDER BY h.saved_at DESC`
  ).all(req.project.id);
  res.json(rows);
});

app.get('/api/projects/:id/history/:hid', requireAuth, requireProject, (req, res) => {
  const row = db.prepare('SELECT json FROM project_state_history WHERE id=? AND project_id=?').get(req.params.hid, req.project.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(JSON.parse(row.json));
});

app.post('/api/projects/:id/history/:hid/restore', requireAuth, requireProject, (req, res) => {
  if (req.project.role === 'viewer') return res.status(403).json({ error: 'Viewers cannot restore' });
  const row = db.prepare('SELECT json FROM project_state_history WHERE id=? AND project_id=?').get(req.params.hid, req.project.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const current = db.prepare('SELECT version, json FROM project_state WHERE project_id=?').get(req.project.id);
  const newVersion = (current ? current.version : 0) + 1;
  if (current) {
    db.prepare('INSERT INTO project_state_history(project_id, json, saved_by_user_id) VALUES(?,?,?)').run(req.project.id, current.json, req.user.id);
  }
  db.prepare(`INSERT INTO project_state(project_id, json, version, updated_at) VALUES(?,?,?,datetime('now'))
    ON CONFLICT(project_id) DO UPDATE SET json=excluded.json, version=excluded.version, updated_at=excluded.updated_at`
  ).run(req.project.id, row.json, newVersion);
  db.prepare("UPDATE projects SET updated_at=datetime('now') WHERE id=?").run(req.project.id);
  sseNotify(req.project.id, { type: 'state_updated', version: newVersion, by: req.user.username });
  res.json({ ok: true, version: newVersion });
});

// --- Members ---
app.get('/api/projects/:id/members', requireAuth, requireProject, (req, res) => {
  const members = db.prepare(
    `SELECT u.id, u.username, u.email, pm.role, pm.added_at
     FROM project_members pm JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = ?`
  ).all(req.project.id);
  res.json(members);
});

app.post('/api/projects/:id/members', requireAuth, requireProject, (req, res) => {
  if (req.project.role !== 'owner') return res.status(403).json({ error: 'Only owner can add members' });
  const { username, role } = req.body || {};
  if (!username || !['editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'username and role (editor|viewer) required' });
  const user = db.prepare('SELECT id FROM users WHERE username=?').get(username.trim());
  if (!user) return res.status(404).json({ error: 'User not found' });
  const existing = db.prepare('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?').get(req.project.id, user.id);
  if (existing) return res.status(409).json({ error: 'Already a member' });
  db.prepare('INSERT INTO project_members(project_id, user_id, role) VALUES(?,?,?)').run(req.project.id, user.id, role);
  res.json({ ok: true });
});

app.patch('/api/projects/:id/members/:uid', requireAuth, requireProject, (req, res) => {
  if (req.project.role !== 'owner') return res.status(403).json({ error: 'Only owner can change roles' });
  const { role } = req.body || {};
  if (!['editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'role must be editor or viewer' });
  const uid = parseInt(req.params.uid, 10);
  const member = db.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get(req.project.id, uid);
  if (!member) return res.status(404).json({ error: 'Member not found' });
  if (member.role === 'owner') return res.status(400).json({ error: 'Cannot change owner role' });
  db.prepare('UPDATE project_members SET role=? WHERE project_id=? AND user_id=?').run(role, req.project.id, uid);
  res.json({ ok: true });
});

app.delete('/api/projects/:id/members/:uid', requireAuth, requireProject, (req, res) => {
  if (req.project.role !== 'owner') return res.status(403).json({ error: 'Only owner can remove members' });
  const uid = parseInt(req.params.uid, 10);
  const member = db.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get(req.project.id, uid);
  if (!member) return res.status(404).json({ error: 'Member not found' });
  if (member.role === 'owner') return res.status(400).json({ error: 'Cannot remove owner' });
  db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(req.project.id, uid);
  res.json({ ok: true });
});

// --- SSE ---
app.get('/api/projects/:id/events', requireAuth, requireProject, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const pid = req.project.id;
  if (!sseClients.has(pid)) sseClients.set(pid, new Set());
  sseClients.get(pid).add(res);

  req.on('close', () => {
    const s = sseClients.get(pid);
    if (s) { s.delete(res); if (!s.size) sseClients.delete(pid); }
  });
});

// --- Duplicate project ---
app.post('/api/projects/:id/duplicate', requireAuth, requireProject, (req, res) => {
  if (req.project.role === 'viewer') return res.status(403).json({ error: 'Viewers cannot duplicate' });
  const orig = db.prepare('SELECT json FROM project_state WHERE project_id=?').get(req.project.id);
  const newName = req.project.name + ' (копия)';
  const result = db.prepare('INSERT INTO projects(name) VALUES(?)').run(newName);
  const pid = result.lastInsertRowid;
  db.prepare('INSERT INTO project_members(project_id, user_id, role) VALUES(?,?,?)').run(pid, req.user.id, 'owner');
  const json = orig ? orig.json : JSON.stringify({ _app: 'hm-br', _version: 1 });
  db.prepare('INSERT INTO project_state(project_id, json) VALUES(?,?)').run(pid, json);
  res.json({ id: pid, name: newName, role: 'owner' });
});

// --- Export project ---
app.get('/api/projects/:id/export', requireAuth, requireProject, (req, res) => {
  const state = db.prepare('SELECT json FROM project_state WHERE project_id=?').get(req.project.id);
  const safeName = req.project.name.replace(/[^a-zA-Zа-яА-Я0-9_-]/g, '_');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`);
  const archive = archiver('zip');
  archive.pipe(res);
  archive.append(state ? state.json : '{}', { name: 'state.json' });
  archive.append(JSON.stringify({ name: req.project.name, exported_at: new Date().toISOString() }), { name: 'metadata.json' });
  archive.append('Импорт: POST /api/projects/import с multipart/form-data полем "file" (zip)', { name: 'README.txt' });
  archive.finalize();
});

// --- Import project ---
const multer = require('multer');
const unzipper = require('unzipper');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

app.post('/api/projects/import', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const dir = await unzipper.Open.buffer(req.file.buffer);
    const stateFile = dir.files.find(f => f.path === 'state.json');
    const metaFile = dir.files.find(f => f.path === 'metadata.json');
    if (!stateFile) return res.status(400).json({ error: 'Invalid archive: state.json missing' });
    const stateJson = (await stateFile.buffer()).toString('utf8');
    let name = 'Импортированный проект';
    if (metaFile) {
      try { name = JSON.parse((await metaFile.buffer()).toString()).name || name; } catch (_) {}
    }
    const result = db.prepare('INSERT INTO projects(name) VALUES(?)').run(name);
    const pid = result.lastInsertRowid;
    db.prepare('INSERT INTO project_members(project_id, user_id, role) VALUES(?,?,?)').run(pid, req.user.id, 'owner');
    db.prepare('INSERT INTO project_state(project_id, json) VALUES(?,?)').run(pid, stateJson);
    res.json({ id: pid, name, role: 'owner' });
  } catch (e) {
    res.status(400).json({ error: 'Failed to parse archive: ' + e.message });
  }
});

// --- Admin routes ---
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, email, username, is_admin, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

app.delete('/api/admin/users/:uid', requireAuth, requireAdmin, (req, res) => {
  const uid = parseInt(req.params.uid, 10);
  if (uid === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  db.prepare('DELETE FROM users WHERE id=?').run(uid);
  res.json({ ok: true });
});

app.post('/api/admin/users/:uid/reset', requireAuth, requireAdmin, (req, res) => {
  const uid = parseInt(req.params.uid, 10);
  const bcrypt = require('bcryptjs');
  const tmp = require('crypto').randomBytes(6).toString('hex');
  const hash = bcrypt.hashSync(tmp, 10);
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hash, uid);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(uid);
  res.json({ ok: true, temporaryPassword: tmp });
});

app.patch('/api/admin/users/:uid', requireAuth, requireAdmin, (req, res) => {
  const uid = parseInt(req.params.uid, 10);
  const { is_admin } = req.body || {};
  if (typeof is_admin !== 'number') return res.status(400).json({ error: 'is_admin (0|1) required' });
  db.prepare('UPDATE users SET is_admin=? WHERE id=?').run(is_admin ? 1 : 0, uid);
  res.json({ ok: true });
});

// Health
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// --- Start ---
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`\n Heat Map server running on port ${PORT}`);
  console.log(`   http://localhost:${PORT}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
