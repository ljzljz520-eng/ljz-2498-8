'use strict';
const path = require('path');
const express = require('express');
const dbm = require('./db');
const svc = require('./services');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function makeAsync(fn) {
  return (req, res, next) => {
    try {
      Promise.resolve(fn(req, res, next)).catch((e) => sendError(res, e));
    } catch (e) {
      sendError(res, e);
    }
  };
}
function sendError(res, e) {
  res.status(e.status || 500).json({ error: e.message || '服务器错误' });
}

function auth(req, _res, next) {
  const uid = Number(req.header('x-user-id') || 1);
  req.user = dbm.get('SELECT * FROM users WHERE id=$id', { $id: uid });
  req.now = svc.nowTs(req);
  next();
}
app.use('/api', auth);

// ---- 元数据 ----
app.get('/api/me', (req, res) => res.json({ now: req.now, user: req.user }));
app.get('/api/users', (_req, res) =>
  res.json(dbm.all('SELECT id,username,display_name,can_publish,can_confirm FROM users ORDER BY id')));

app.get('/api/buildings', (_req, res) =>
  res.json(dbm.all('SELECT * FROM buildings WHERE active=1 ORDER BY code')));

app.get('/api/buildings/:id/history', (req, res) =>
  res.json(dbm.all(
    `SELECT * FROM building_name_version WHERE building_id=$id ORDER BY valid_from`,
    { $id: Number(req.params.id) })));

app.post('/api/buildings/:id/rename', makeAsync((req, res) => {
  svc.renameBuilding(Number(req.params.id), String(req.body.name || '').trim(), req.now);
  res.json({ ok: true });
}));

app.get('/api/scopes', (_req, res) => {
  const scopes = dbm.all('SELECT * FROM scope_version ORDER BY id DESC');
  res.json(scopes.map((s) => svc.loadScope(s.id)));
});

app.post('/api/scopes', makeAsync((req, res) => {
  if (!req.user.can_publish) return res.status(403).json({ error: '无权限' });
  if (!Array.isArray(req.body.building_ids) || req.body.building_ids.length === 0) {
    return res.status(400).json({ error: 'building_ids 不能为空' });
  }
  const id = svc.createScope(req.body.building_ids, req.body.label, req.user.id, req.now);
  res.status(201).json({ id });
}));

// ---- 公告 ----
app.get('/api/announcements', (req, res) =>
  res.json(svc.listAll(req.now)));

app.get('/api/announcements/effective', (req, res) =>
  res.json(svc.listEffective(req.now, {
    buildingId: req.query.building_id,
    urgency: req.query.urgency,
  })));

app.get('/api/announcements/:id', makeAsync((req, res) => {
  const row = dbm.get('SELECT * FROM announcement WHERE id=$id', { $id: Number(req.params.id) });
  if (!row) return res.status(404).json({ error: '公告不存在' });
  res.json(svc.toDto(row, req.now));
}));

app.post('/api/announcements', makeAsync((req, res) => {
  const id = svc.createAnnouncement(req.body || {}, req.user, req.now);
  res.status(201).json({ id });
}));

app.patch('/api/announcements/:id', makeAsync((req, res) => {
  svc.updateAnnouncement(Number(req.params.id), req.body || {}, req.user, req.now);
  res.json({ ok: true });
}));

app.post('/api/announcements/:id/submit', makeAsync((req, res) => {
  svc.submitForConfirm(Number(req.params.id), req.user, req.now);
  res.json({ ok: true });
}));

app.post('/api/announcements/:id/confirm', makeAsync((req, res) => {
  svc.confirmAnnouncement(Number(req.params.id), req.user);
  res.json({ ok: true });
}));

app.post('/api/announcements/:id/publish', makeAsync((req, res) => {
  const result = svc.publishAnnouncement(
    Number(req.params.id), req.user, req.now,
    (req.body && req.body.client_request_id) || req.header('idempotency-key') || null);
  res.json(result);
}));

app.post('/api/announcements/:id/withdraw', makeAsync((req, res) => {
  svc.withdrawAnnouncement(Number(req.params.id), req.user, (req.body || {}).reason, req.now);
  res.json({ ok: true });
}));

/** 替代/撤回重发：body.mode = replace | withdraw_republish */
app.post('/api/announcements/:id/supersede', makeAsync((req, res) => {
  const mode = req.body.mode === 'withdraw_republish' ? 'withdraw_republish' : 'replace';
  const out = svc.supersede(
    Number(req.params.id), req.body || {}, req.user, req.now, mode,
    req.body.client_request_id || req.header('idempotency-key') || null);
  res.status(201).json(out);
}));

app.get('/api/announcements/:id/events', makeAsync((req, res) => {
  const id = Number(req.params.id);
  res.json(dbm.all(
    `SELECT pe.*, u.display_name AS actor_name FROM publication_event pe
       LEFT JOIN users u ON u.id=pe.actor_id WHERE announce_id=$a ORDER BY pe.id`, { $a: id }));
}));

// ---- 打印任务 ----
app.get('/api/print-jobs', (req, res) => res.json(svc.listPrintJobs(req.now)));

app.post('/api/print-jobs', makeAsync((req, res) => {
  const at = Number(req.body.scheduled_at);
  if (!Number.isInteger(at)) return res.status(400).json({ error: 'scheduled_at 必填' });
  svc.createPrintJob(Number(req.body.announce_id), req.body.station, at, req.now);
  res.status(201).json({ ok: true });
}));

app.post('/api/print-jobs/:id/execute', makeAsync((req, res) => {
  svc.executePrintJob(Number(req.params.id), req.now);
  res.json({ ok: true });
}));

// ---- 模拟时钟（验收：跨午夜/打印迟到）----
app.post('/api/dev/clock', (req, res) => {
  const v = req.body.mock_now;
  if (v == null || v === '') {
    dbm.run("DELETE FROM app_setting WHERE key='mock_now'");
  } else {
    dbm.run(`INSERT INTO app_setting (key,value) VALUES ('mock_now',$v)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value`, { $v: String(v) });
  }
  dbm.persist();
  res.json({ now: svc.nowTs(req) });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  dbm.getDb().then(() => {
    app.listen(PORT, () => console.log(`社区公告排版台 http://localhost:${PORT}`));
  });
}
module.exports = { app };
