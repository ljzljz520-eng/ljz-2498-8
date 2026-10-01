/* 社区公告排版台 HTTP 服务：API + 静态前端（Vue 3，无构建） */
const path = require('path');
const express = require('express');
const store = require('./store');
const core = require('../shared/core');
const seed = require('./seed');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---- 演示鉴权：前端选身份后带 X-User-Id；生产应换成会话/JWT ----
app.use('/api', (req, res, next) => {
  const id = Number(req.header('X-User-Id'));
  if (!id) return res.status(401).json({ error: { code: 'unauthorized', message: '请先选择登录身份' } });
  const user = store.getUserById(id);
  if (!user) return res.status(401).json({ error: { code: 'unknown_user', message: '用户不存在' } });
  req.user = user;
  next();
});
const canConfirm = u => u.role === 'confirmer' || u.role === 'admin';

const idem = req => req.header('Idempotency-Key') || req.body.idempotency_key || null;
function wrap(handler) {
  return (req, res) => Promise.resolve(handler(req, res)).catch(err => {
    if (err instanceof store.HttpError)
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    console.error(err);
    res.status(500).json({ error: { code: 'internal', message: String(err.message || err) } });
  });
}
// 补充派生展示字段（两端共用 core，保证同事实）
function present(a, at) {
  if (!a) return a;
  const out = JSON.parse(JSON.stringify(a));
  out.presentation_status = core.presentationStatus(a, at);
  out.status_text = core.STATUS_TEXT[out.presentation_status];
  out.crosses_midnight = core.crossesMidnight(a.starts_at, a.ends_at);
  return out;
}

// ---- 账号 / 楼栋 ----
app.get('/api/me', wrap((req, res) => res.json({ user: req.user })));
app.get('/api/users', wrap((req, res) => res.json({ users: store.listUsers() })));

app.get('/api/buildings', wrap((req, res) =>
  res.json({ buildings: store.listBuildings(req.query.all === '1') })));
app.post('/api/buildings/:id/rename', wrap((req, res) =>
  res.json({ building: store.renameBuilding(Number(req.params.id), req.body.name, req.user.id) })));
app.get('/api/buildings/:id/history', wrap((req, res) =>
  res.json({ history: store.buildingHistory(Number(req.params.id)) })));

app.get('/api/scopes', wrap((req, res) => res.json({ scopes: store.listScopeVersions() })));

// ---- 公告 CRUD / 发布 / 确认 / 替代 / 撤回 ----
app.post('/api/announcements', wrap((req, res) => {
  const r = store.createAnnouncement(req.body, req.user.id, idem(req));
  res.status(r.idempotent_replay ? 200 : 201).json({ ...r, announcement: present(r.announcement) });
}));
app.get('/api/announcements', wrap((req, res) => {
  const f = {};
  if (req.query.status) f.status = req.query.status;
  if (req.query.author) f.authorId = Number(req.query.author);
  if (req.query.chain) f.chainRootId = Number(req.query.chain);
  res.json({ announcements: store.listAnnouncements(f).map(a => present(a)) });
}));
app.get('/api/announcements/:id', wrap((req, res) =>
  res.json({ announcement: present(store.getAnnouncement(Number(req.params.id))) })));
app.put('/api/announcements/:id', wrap((req, res) =>
  res.json({ announcement: present(store.editAnnouncement(Number(req.params.id), req.body, req.user.id)) })));
app.post('/api/announcements/:id/submit', wrap((req, res) =>
  res.json({ announcement: present(store.submitForConfirmation(Number(req.params.id), req.user.id)) })));
app.post('/api/announcements/:id/confirm', wrap((req, res) => {
  if (!canConfirm(req.user))
    return res.status(403).json({ error: { code: 'forbidden', message: '当前身份无确认权限' } });
  const r = store.confirmAnnouncement(Number(req.params.id), req.user.id,
    req.body.decision === 'rejected' ? 'rejected' : 'confirmed', req.body.comment);
  res.json({ ...r, announcement: present(r.announcement) });
}));
app.post('/api/announcements/:id/publish', wrap((req, res) => {
  const r = store.publishAnnouncement(Number(req.params.id), req.user.id, idem(req));
  res.json({ ...r, announcement: present(r.announcement) });
}));
app.post('/api/announcements/:id/supersede', wrap((req, res) => {
  const r = store.supersedeAnnouncement(Number(req.params.id), req.body, req.user.id, idem(req));
  res.json({ ...r, announcement: present(r.announcement), predecessor: present(r.predecessor) });
}));
app.post('/api/announcements/:id/withdraw', wrap((req, res) => {
  const a = store.withdrawAnnouncement(Number(req.params.id), req.user.id,
    req.body.reason, req.body.reissue_id ? Number(req.body.reissue_id) : null);
  res.json({ announcement: present(a) });
}));
app.post('/api/announcements/:id/reissue', wrap((req, res) => {
  const r = store.withdrawAndReissue(Number(req.params.id), req.body, req.user.id, idem(req));
  res.json({ ...r, new: present(r.new), old: present(r.old) });
}));
app.get('/api/announcements/:id/chain', wrap((req, res) =>
  res.json({ chain: store.chainOf(Number(req.params.id)).map(a => present(a)) })));
app.get('/api/announcements/:id/audit', wrap((req, res) =>
  res.json({ audit: store.listAudit(Number(req.params.id)) })));

// ---- 当前有效通知（同一事实口径；?at= 支持验收时间注入；?building= 范围过滤）----
app.get('/api/effective', wrap((req, res) => {
  const at = req.query.at ? core.fromInput(req.query.at) : core.nowStamp();
  const rows = store.effectiveAt(at, req.query.building ? Number(req.query.building) : null);
  res.json({ at: at, announcements: rows.map(a => present(a, at)) });
}));

// ---- 打印任务 ----
app.post('/api/print-tasks', wrap((req, res) => {
  const t = store.createPrintTask(Number(req.body.announcement_id), req.body.due_at,
    req.user.id, req.body.note);
  res.status(201).json({ task: t });
}));
app.get('/api/print-tasks', wrap((req, res) => {
  // 每次查看先扫一遍迟到
  const at = req.query.at ? core.fromInput(req.query.at) : core.nowStamp();
  store.sweepPrintTasks(at);
  res.json({ at: at, tasks: store.listPrintTasks() });
}));
app.post('/api/print-tasks/:id/printed', wrap((req, res) => {
  const r = store.markPrinted(Number(req.params.id), req.user.id);
  res.json(r);
}));

// ---- 旧分享页（免登录）：撤回件显示撤回说明，绝不继续表现为现行公告 ----
app.get('/api/public/announcements/:id', wrap((req, res) => {
  const a = store.getAnnouncement(Number(req.params.id));
  if (!a) return res.status(404).json({ error: { code: 'not_found', message: '公告不存在或已彻底删除' } });
  const at = core.nowStamp();
  const p = present(a, at);
  p.is_current = core.isEffectiveAt(a, at);
  if (a.status === 'withdrawn') {
    p.public_notice = { type: 'withdrawn', title: '该公告已撤回', message: a.withdraw_reason || '该公告已被发布方撤回，不再作为现行通知执行。' };
  } else if (a.status === 'superseded') {
    p.public_notice = { type: 'superseded', title: '该公告已有新版本', message: a.supersede_reason ? '替代原因：' + a.supersede_reason : '请以最新版本内容为准。' };
    const cur = store.getAnnouncement(a.superseded_by);
    p.current_id = cur ? cur.id : null;
  } else if (a.status === 'cancelled') {
    p.public_notice = { type: 'cancelled', title: '该公告审批已取消', message: a.withdraw_reason || '' };
  } else if (!p.is_current) {
    p.public_notice = { type: p.presentation_status, title: p.status_text, message: '当前不在该公告有效时段内。' };
  }
  if (a.reissued_by) { const re = store.getAnnouncement(a.reissued_by); p.reissue = re ? { id: re.id, title: re.title } : null; }
  res.json({ announcement: p });
}));

// ---- 静态资源：前端与 shared/core.js ----
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get(/\/announce\/.*/, (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
store.init().then(async () => {
  await seed(store);
  app.listen(PORT, () => console.log('社区公告排版台已启动: http://localhost:' + PORT));
});
