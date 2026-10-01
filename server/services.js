'use strict';
/**
 * 服务层：组装两端共用的公告事实 DTO，执行创建/改稿/确认/发布/撤回/替代/打印。
 */
const dbm = require('./db');
const dom = require('./domain');

const PAGE_SIZE = 120; // 手机长正文每页字符数

function nowTs(req) {
  // 验收用模拟时钟：头 x-mock-now（毫秒）优先，其次 app_setting
  const h = req && req.headers && req.headers['x-mock-now'];
  if (h && /^\d+$/.test(String(h))) return parseInt(h, 10);
  const s = dbm.get('SELECT value FROM app_setting WHERE key=$k', { $k: 'mock_now' });
  if (s && /^\d+$/.test(s.value)) return parseInt(s.value, 10);
  return Date.now();
}

function loadScope(scopeId) {
  const sv = dbm.get('SELECT * FROM scope_version WHERE id=$id', { $id: scopeId });
  if (!sv) return null;
  const rows = dbm.all(
    `SELECT sb.building_id, b.code, b.current_name
       FROM scope_building sb JOIN buildings b ON b.id = sb.building_id
      WHERE sb.scope_id=$id ORDER BY b.code`, { $id: scopeId });
  return { ...sv, buildings: rows };
}

/** 取某时刻楼栋名称（更名后历史公告保留发布时含义） */
function scopeNamesAt(scope, at) {
  return scope.buildings.map((b) => {
    const versions = dbm.all(
      'SELECT name,valid_from,valid_to FROM building_name_version WHERE building_id=$id ORDER BY valid_from',
      { $id: b.building_id });
    const then = dom.nameAt(versions, at, b.current_name);
    return {
      building_id: b.building_id,
      code: b.code,
      name_at: then,                                   // 该时点名称
      current_name: b.current_name,
      renamed: then !== b.current_name,
    };
  });
}

function loadAnnouncementRow(id) {
  return dbm.get('SELECT * FROM announcement WHERE id=$id', { $id: id });
}

function latestRevision(aid) {
  return dbm.get('SELECT * FROM announcement_revision WHERE announce_id=$a ORDER BY revision_no DESC LIMIT 1',
    { $a: aid });
}

/** 两端展示相同事实：后台/公告栏/手机/分享页都用这同一个 DTO */
function toDto(row, now) {
  const a = row || {};
  const rev = latestRevision(a.id) || {};
  const scope = loadScope(a.scope_id);
  const publishedAt = a.published_at || now;
  const namesAt = scope ? scopeNamesAt(scope, publishedAt) : [];
  const state = dom.effectiveState(a.status, a.start_at, a.end_at, now);
  const confirmations = dbm.all(
    `SELECT c.*, u.display_name AS confirmer_name FROM confirmation c
       JOIN users u ON u.id=c.confirmer_id WHERE c.announce_id=$a ORDER BY c.id`, { $a: a.id });
  const aliveConfirm = confirmations.find((c) => dom.confirmationAlive(c, {
    author_id: a.author_id, content_hash: rev.content_hash, current_revision: a.current_revision,
  }));
  const events = dbm.all(
    `SELECT pe.*, u.display_name AS actor_name FROM publication_event pe
       LEFT JOIN users u ON u.id=pe.actor_id WHERE pe.announce_id=$a ORDER BY pe.id`, { $a: a.id });
  const links = dbm.all(
    `SELECT sl.*, o.code AS old_code, n.code AS new_code, o.title AS old_title, n.title AS new_title
       FROM supersession_link sl
       JOIN announcement o ON o.id=sl.old_id
       LEFT JOIN announcement n ON n.id=sl.new_id
      WHERE sl.old_id=$a OR sl.new_id=$a ORDER BY sl.id`, { $a: a.id });
  const bodyPages = dom.paginate(rev.body || '', PAGE_SIZE);
  return {
    id: a.id,
    code: a.code,
    status: a.status,
    state,                                   // active/upcoming/expired/withdrawn/superseded/...
    urgency: rev.urgency,
    urgency_label: dom.LEVELS[rev.urgency].label,
    title: rev.title,
    body: rev.body,
    body_pages: bodyPages,
    page_count: bodyPages.length,
    contact: { name: rev.contact_name, phone: rev.contact_phone },
    start_at: a.start_at,
    end_at: a.end_at,
    start_iso: new Date(a.start_at).toISOString(),
    end_iso: new Date(a.end_at).toISOString(),
    author_id: a.author_id,
    current_revision: a.current_revision,
    content_hash: rev.content_hash,
    scope: scope ? {
      id: scope.id, label: scope.label, created_at: scope.created_at,
      buildings_at_publish: namesAt,        // 绑定的当时范围版 + 发布时名称
    } : null,
    confirmation_required: rev.urgency === 'urgent',
    confirmation: aliveConfirm ? {
      revision_no: aliveConfirm.revision_no,
      confirmer_id: aliveConfirm.confirmer_id,
      confirmer_name: aliveConfirm.confirmer_name,
      content_hash: aliveConfirm.content_hash,
      created_at: aliveConfirm.created_at,
      alive: true,
    } : null,
    confirmations: confirmations.map((c) => ({
      id: c.id, revision_no: c.revision_no, confirmer_id: c.confirmer_id,
      confirmer_name: c.confirmer_name, state: c.state, created_at: c.created_at,
      alive: dom.confirmationAlive(c, {
        author_id: a.author_id, content_hash: rev.content_hash, current_revision: a.current_revision,
      }),
    })),
    published_at: a.published_at,
    withdrawn_at: a.withdrawn_at,
    withdraw_reason: a.withdraw_reason,
    events,
    links,
  };
}

function logEvent(aid, type, actorId, detail) {
  dbm.run(
    `INSERT INTO publication_event (announce_id,event_type,actor_id,detail,created_at)
     VALUES ($a,$t,$u,$d,$n)`,
    { $a: aid, $t: type, $u: actorId, $d: detail ? JSON.stringify(detail) : null, $n: Date.now() });
}

function nextCode(now) {
  const d = new Date(now);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const prefix = `GG-${ymd}-`;
  const rows = dbm.all("SELECT code FROM announcement WHERE code LIKE $p", { $p: prefix + '%' });
  const max = rows.reduce((m, r) => Math.max(m, parseInt(r.code.slice(prefix.length), 10) || 0), 0);
  return prefix + String(max + 1).padStart(3, '0');
}

/** 以选中楼栋冻结一个新范围版（"楼栋选择绑定当时范围版"） */
function freezeScopeFromBuildings(buildingIds, label, userId, now) {
  const ids = [...new Set(buildingIds.map(Number))].sort((x, y) => x - y);
  if (ids.length === 0) throw httpError(400, '范围不能为空');
  const ph = ids.map((_, i) => `$b${i}`).join(',');
  const params = {};
  ids.forEach((v, i) => { params[`$b${i}`] = v; });
  const found = dbm.all(`SELECT id FROM buildings WHERE active=1 AND id IN (${ph})`, params);
  if (found.length !== ids.length) throw httpError(400, '存在已停用的楼栋');
  dbm.run('INSERT INTO scope_version (label,created_by,created_at) VALUES ($l,$u,$n)',
    { $l: label || `范围@${new Date(now).toLocaleString('zh-CN')}`, $u: userId, $n: now });
  const sv = dbm.get('SELECT * FROM scope_version ORDER BY id DESC LIMIT 1');
  ids.forEach((bid) => dbm.run(
    'INSERT INTO scope_building (scope_id,building_id) VALUES ($s,$b)',
    { $s: sv.id, $b: bid }));
  return sv.id;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function validatePayload(p) {
  const out = {
    title: String(p.title || '').trim(),
    body: String(p.body || '').trim(),
    urgency: ['normal', 'important', 'urgent'].includes(p.urgency) ? p.urgency : null,
    contact_name: String(p.contact_name || '').trim(),
    contact_phone: String(p.contact_phone || '').trim(),
    start_at: Number(p.start_at),
    end_at: Number(p.end_at),
  };
  if (!out.title) throw httpError(400, '标题不能为空');
  if (!out.body) throw httpError(400, '正文不能为空');
  if (!out.urgency) throw httpError(400, '级别非法');
  if (!out.contact_name || !out.contact_phone) throw httpError(400, '联系人与电话必填');
  if (!dom.isValidWindow(out.start_at, out.end_at)) throw httpError(400, '有效时段非法（结束须晚于开始，支持跨午夜）');
  return out;
}

/** 创建草稿 */
function createAnnouncement(p, user, now) {
  if (!user.can_publish) throw httpError(403, '无发布权限');
  const data = validatePayload(p);
  let scopeId = Number(p.scope_id);
  if (Array.isArray(p.building_ids)) {
    scopeId = freezeScopeFromBuildings(p.building_ids, p.scope_label, user.id, now);
  } else {
    if (!loadScope(scopeId)) throw httpError(400, '范围版不存在');
  }
  const code = nextCode(now);
  dbm.run(
    `INSERT INTO announcement
       (code,urgency,title,body,contact_name,contact_phone,scope_id,start_at,end_at,status,author_id,current_revision,created_at,updated_at)
     VALUES ($code,$u,$t,$b,$cn,$cp,$s,$st,$e,'draft',$au,1,$n,$n)`,
    { $code: code, $u: data.urgency, $t: data.title, $b: data.body, $cn: data.contact_name,
      $cp: data.contact_phone, $s: scopeId, $st: data.start_at, $e: data.end_at, $au: user.id, $n: now });
  const row = dbm.get('SELECT * FROM announcement WHERE code=$c', { $c: code });
  const hash = dbm.contentHash(data);
  dbm.run(
    `INSERT INTO announcement_revision
       (announce_id,revision_no,content_hash,title,body,urgency,contact_name,contact_phone,start_at,end_at,created_by,created_at)
     VALUES ($a,1,$h,$t,$b,$u,$cn,$cp,$st,$e,$by,$n)`,
    { $a: row.id, $h: hash, $t: data.title, $b: data.body, $u: data.urgency,
      $cn: data.contact_name, $cp: data.contact_phone, $st: data.start_at, $e: data.end_at, $by: user.id, $n: now });
  // 主表冗余字段也同步（便于查询），内容权威以 revision 为准
  logEvent(row.id, 'created', user.id, { scope_id: scopeId });
  dbm.persist();
  return row.id;
}

/** 改稿：任何内容字段变化 -> 追加 revision，并使旧确认失效 */
function updateAnnouncement(id, p, user, now) {
  if (!user.can_publish) throw httpError(403, '无发布权限');
  const row = loadAnnouncementRow(id);
  if (!row) throw httpError(404, '公告不存在');
  if (row.author_id !== user.id) throw httpError(403, '只有作者可修改');
  if (row.status !== 'draft' && row.status !== 'pending_confirm') {
    throw httpError(409, '已发布公告不能改稿，请撤回或发起替代');
  }
  const rev = latestRevision(id);
  const data = validatePayload({ ...rev, ...p });
  let scopeId = row.scope_id;
  if (Array.isArray(p.building_ids)) {
    scopeId = freezeScopeFromBuildings(p.building_ids, p.scope_label, user.id, now);
  } else if (p.scope_id != null && Number(p.scope_id) !== row.scope_id) {
    if (!loadScope(Number(p.scope_id))) throw httpError(400, '范围版不存在');
    scopeId = Number(p.scope_id);
  }
  const newHash = dbm.contentHash(data);
  const contentChanged =
    newHash !== rev.content_hash || scopeId !== row.scope_id;
  const nextNo = row.current_revision + 1;

  dbm.run(
    `UPDATE announcement SET urgency=$u,title=$t,body=$b,contact_name=$cn,contact_phone=$cp,
       scope_id=$s,start_at=$st,end_at=$e,current_revision=$r,updated_at=$n WHERE id=$id`,
    { $u: data.urgency, $t: data.title, $b: data.body, $cn: data.contact_name, $cp: data.contact_phone,
      $s: scopeId, $st: data.start_at, $e: data.end_at, $r: nextNo, $n: now, $id: id });

  if (contentChanged) {
    dbm.run(
      `INSERT INTO announcement_revision
         (announce_id,revision_no,content_hash,title,body,urgency,contact_name,contact_phone,start_at,end_at,created_by,created_at)
       VALUES ($a,$r,$h,$t,$b,$u,$cn,$cp,$st,$e,$by,$n)`,
      { $a: id, $r: nextNo, $h: newHash, $t: data.title, $b: data.body, $u: data.urgency,
        $cn: data.contact_name, $cp: data.contact_phone, $st: data.start_at, $e: data.end_at, $by: user.id, $n: now });
    // 关键规则：作者修改联系人或时间（及正文/级别/范围）后，旧确认全部失效（留痕）
    const old = dbm.all('SELECT * FROM confirmation WHERE announce_id=$a AND state=$st',
      { $a: id, $st: 'valid' });
    if (old.length) {
      dbm.run("UPDATE confirmation SET state='superseded' WHERE announce_id=$a AND state='valid'", { $a: id });
      logEvent(id, 'confirmed', user.id, { note: '旧确认因内容快照变更失效', invalidated: old.map((x) => x.id) });
    }
    // 一旦内容改动，需重新走审批
    dbm.run("UPDATE announcement SET status='pending_confirm' WHERE id=$id AND urgency='urgent' AND status='draft'",
      { $id: id });
    dbm.run("UPDATE announcement SET status='draft' WHERE id=$id AND urgency!='urgent'", { $id: id });
  }
  dbm.persist();
}

/** 提交紧急公告进入审批中 */
function submitForConfirm(id, user, now) {
  const row = loadAnnouncementRow(id);
  if (!row) throw httpError(404, '公告不存在');
  if (row.author_id !== user.id) throw httpError(403, '只有作者可提交');
  const rev = latestRevision(id);
  if (rev.urgency !== 'urgent') throw httpError(409, '仅紧急公告需要确认');
  if (!['draft', 'pending_confirm'].includes(row.status)) throw httpError(409, '当前状态不可提交');
  dbm.run("UPDATE announcement SET status='pending_confirm',updated_at=$n WHERE id=$id",
    { $id: id, $n: now });
  logEvent(id, 'submitted', user.id, { revision_no: row.current_revision });
  dbm.persist();
}

/** 另一有权人员确认同一内容快照 */
function confirmAnnouncement(id, user) {
  const row = loadAnnouncementRow(id);
  if (!row) throw httpError(404, '公告不存在');
  if (!user.can_confirm) throw httpError(403, '无确认权限');
  if (row.author_id === user.id) throw httpError(403, '紧急公告须由另一有权人员确认，不能自审');
  const rev = latestRevision(id);
  const exists = dbm.get(
    'SELECT * FROM confirmation WHERE announce_id=$a AND revision_no=$r AND confirmer_id=$u',
    { $a: id, $r: row.current_revision, $u: user.id });
  if (exists && exists.state === 'valid') return; // 重复点击幂等
  if (exists) {
    dbm.run("UPDATE confirmation SET state='valid' WHERE id=$id", { $id: exists.id });
  } else {
    dbm.run(
      `INSERT INTO confirmation (announce_id,revision_no,content_hash,confirmer_id,state,created_at)
       VALUES ($a,$r,$h,$u,'valid',$n)`,
      { $a: id, $r: row.current_revision, $h: rev.content_hash, $u: user.id, $n: Date.now() });
  }
  logEvent(id, 'confirmed', user.id, { revision_no: row.current_revision, content_hash: rev.content_hash.slice(0, 10) });
  dbm.persist();
}

/** 发布；clientRequestId 幂等（重复发布请求） */
function publishAnnouncement(id, user, now, clientRequestId) {
  const row = loadAnnouncementRow(id);
  if (!row) throw httpError(404, '公告不存在');
  if (!user.can_publish) throw httpError(403, '无发布权限');
  if (row.status === 'published') {
    if (clientRequestId && row.client_request_id === clientRequestId) {
      return { id, duplicated: true }; // 同一请求重放：返回原结果，不产生第二条
    }
    throw httpError(409, '公告已发布');
  }
  if (clientRequestId) {
    const dup = dbm.get(
      'SELECT id FROM announcement WHERE author_id=$u AND client_request_id=$r',
      { $u: user.id, $r: clientRequestId });
    if (dup && dup.id !== id) return { id: dup.id, duplicated: true };
  }
  if (row.status === 'withdrawn' || row.status === 'superseded') {
    throw httpError(409, '已撤回/被替代公告不能重新发布，请新建或使用撤回重发');
  }
  const rev = latestRevision(id);
  if (rev.urgency === 'urgent') {
    const validConf = dbm.get(
      `SELECT * FROM confirmation WHERE announce_id=$a AND state='valid'
        AND revision_no=$r AND content_hash=$h AND confirmer_id!=$au`,
      { $a: id, $r: row.current_revision, $h: rev.content_hash, $au: row.author_id });
    if (!validConf) {
      logEvent(id, 'publish_failed', user.id, { reason: '紧急公告缺少对当前快照的有效确认' });
      dbm.persist();
      throw httpError(409, '紧急公告须由另一有权人员确认当前内容快照后方可发布（旧确认已失效）');
    }
  }
  dbm.run(
    `UPDATE announcement SET status='published',published_at=$n,updated_at=$n,client_request_id=$r WHERE id=$id`,
    { $id: id, $n: now, $r: clientRequestId || null });
  logEvent(id, 'published', user.id, { at: now, request_id: clientRequestId || null });
  dbm.persist();
  return { id, duplicated: false };
}

/** 撤回 */
function withdrawAnnouncement(id, user, reason, now) {
  const row = loadAnnouncementRow(id);
  if (!row) throw httpError(404, '公告不存在');
  if (!user.can_publish && !user.can_confirm) throw httpError(403, '无撤回权限');
  if (row.status !== 'published') throw httpError(409, '仅已发布公告可撤回');
  dbm.run("UPDATE announcement SET status='withdrawn',withdrawn_at=$n,withdraw_reason=$r,updated_at=$n WHERE id=$id",
    { $id: id, $n: now, $r: reason || null });
  logEvent(id, 'withdrawn', user.id, { reason: reason || null });
  dbm.persist();
}

/**
 * 两种处置方式（对比"撤回旧公告再发新公告"与"保持替代链"）：
 *  mode=withdraw_republish：旧公告撤回（分享页显示撤回说明，不再表现为现行公告），新公告发布，链上留证
 *  mode=replace：旧公告直接进入 superseded，保持替代链，可顺链追溯
 */
function supersede(oldId, payload, user, now, mode, clientRequestId) {
  const old = loadAnnouncementRow(oldId);
  if (!old) throw httpError(404, '旧公告不存在');
  if (!user.can_publish) throw httpError(403, '无发布权限');
  if (!['published'].includes(old.status)) throw httpError(409, '只有现行公告可被替代/撤回');

  const data = validatePayload(payload);
  let scopeId = Number(payload.scope_id || old.scope_id);
  if (Array.isArray(payload.building_ids)) {
    scopeId = freezeScopeFromBuildings(payload.building_ids, payload.scope_label, user.id, now);
  }
  // 新公告（替代者）。紧急替代同样需要有效确认后才能发布。
  const code = nextCode(now);
  dbm.run(
    `INSERT INTO announcement
       (code,urgency,title,body,contact_name,contact_phone,scope_id,start_at,end_at,status,author_id,current_revision,published_at,client_request_id,created_at,updated_at)
     VALUES ($code,$u,$t,$b,$cn,$cp,$s,$st,$e,$st2,$au,1,$n,$r,$n,$n)`,
    { $code: code, $u: data.urgency, $t: data.title, $b: data.body, $cn: data.contact_name,
      $cp: data.contact_phone, $s: scopeId, $st: data.start_at, $e: data.end_at,
      $st2: data.urgency === 'urgent' ? 'pending_confirm' : 'published',
      $au: user.id, $n: now, $r: clientRequestId || null });
  const neu = dbm.get('SELECT * FROM announcement WHERE code=$c', { $c: code });
  const hash = dbm.contentHash(data);
  dbm.run(
    `INSERT INTO announcement_revision
       (announce_id,revision_no,content_hash,title,body,urgency,contact_name,contact_phone,start_at,end_at,created_by,created_at)
     VALUES ($a,1,$h,$t,$b,$u,$cn,$cp,$st,$e,$by,$n)`,
    { $a: neu.id, $h: hash, $t: data.title, $b: data.body, $u: data.urgency,
      $cn: data.contact_name, $cp: data.contact_phone, $st: data.start_at, $e: data.end_at, $by: user.id, $n: now });

  if (mode === 'withdraw_republish') {
    dbm.run("UPDATE announcement SET status='withdrawn',withdrawn_at=$n,withdraw_reason=$r,updated_at=$n WHERE id=$id",
      { $id: oldId, $n: now, $r: payload.reason || '撤回后重新发布' });
    logEvent(oldId, 'withdrawn', user.id, { reason: payload.reason || '撤回后重新发布', republished_as: neu.id });
  } else {
    dbm.run("UPDATE announcement SET status='superseded',updated_at=$n WHERE id=$id",
      { $id: oldId, $n: now });
    logEvent(oldId, 'superseded', user.id, { replaced_by: neu.id });
  }
  dbm.run(
    `INSERT INTO supersession_link (old_id,new_id,kind,reason,created_by,created_at)
     VALUES ($o,$n,$k,$r,$u,$t)`,
    { $o: oldId, $n: neu.id, $k: mode, $r: payload.reason || null, $u: user.id, $t: now });

  let published = false;
  if (data.urgency !== 'urgent') {
    logEvent(neu.id, 'published', user.id, { at: now, via: mode, request_id: clientRequestId || null });
    published = true;
  } else {
    logEvent(neu.id, 'created', user.id, { via: mode, needs_confirm: true });
  }
  dbm.persist();
  return { old_id: oldId, new_id: neu.id, urgent_needs_confirm: !published };
}

/** 查询当前有效通知（状态 published 且 now∈[start,end)）；撤回/被替代/过期都不会出现 */
function listEffective(now, opts = {}) {
  const rows = dbm.all(
    `SELECT * FROM announcement WHERE status='published' AND start_at<=$n AND end_at>$n
      ORDER BY CASE urgency WHEN 'urgent' THEN 0 WHEN 'important' THEN 1 ELSE 2 END, start_at DESC`,
    { $n: now });
  let dtos = rows.map((r) => toDto(r, now));
  if (opts.buildingId) {
    const bid = Number(opts.buildingId);
    dtos = dtos.filter((d) => d.scope.buildings_at_publish.some((b) => b.building_id === bid));
  }
  if (opts.urgency) dtos = dtos.filter((d) => d.urgency === opts.urgency);
  return dtos;
}

function listAll(now) {
  return dbm.all('SELECT * FROM announcement ORDER BY id DESC').map((r) => toDto(r, now));
}

function renameBuilding(buildingId, newName, now) {
  const b = dbm.get('SELECT * FROM buildings WHERE id=$id', { $id: buildingId });
  if (!b) throw httpError(404, '楼栋不存在');
  if (newName === b.current_name) return;
  dbm.run('UPDATE building_name_version SET valid_to=$now WHERE building_id=$b AND valid_to IS NULL',
    { $now: now, $b: buildingId });
  dbm.run('INSERT INTO building_name_version (building_id,name,valid_from,valid_to) VALUES ($b,$name,$now,NULL)',
    { $b: buildingId, $name: newName, $now: now });
  dbm.run('UPDATE buildings SET current_name=$name WHERE id=$b', { $name: newName, $b: buildingId });
  dbm.persist();
}

function createPrintJob(announceId, station, scheduledAt, now) {
  const a = loadAnnouncementRow(announceId);
  if (!a) throw httpError(404, '公告不存在');
  dbm.run(
    `INSERT INTO print_job (announce_id,station,scheduled_at,created_at) VALUES ($a,$s,$t,$n)`,
    { $a: announceId, $s: station || '公告栏', $t: scheduledAt, $n: now });
  dbm.persist();
}

function executePrintJob(jobId, now) {
  const j = dbm.get('SELECT * FROM print_job WHERE id=$id', { $id: jobId });
  if (!j) throw httpError(404, '打印任务不存在');
  if (j.executed_at) throw httpError(409, '任务已执行');
  dbm.run('UPDATE print_job SET executed_at=$n WHERE id=$id', { $n: now, $id: jobId });
  dbm.persist();
}

function listPrintJobs(now) {
  return dbm.all(
    `SELECT j.*, a.code, a.title, a.urgency, a.status AS announce_status, a.start_at, a.end_at
       FROM print_job j JOIN announcement a ON a.id=j.announce_id ORDER BY j.scheduled_at`
  ).map((j) => ({ ...j, ...dom.printJobState(j, now) }));
}

module.exports = {
  nowTs, loadScope, scopeNamesAt, toDto, createAnnouncement, updateAnnouncement,
  submitForConfirm, confirmAnnouncement, publishAnnouncement, withdrawAnnouncement,
  supersede, listEffective, listAll, renameBuilding,
  createPrintJob, executePrintJob, listPrintJobs,
  createScope: (buildingIds, label, userId, now) =>
    freezeScopeFromBuildings(buildingIds, label, userId, now),
  httpError, PAGE_SIZE,
};
