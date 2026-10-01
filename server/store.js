/* sql.js 数据访问层：所有写入在事务中完成并落盘，SQL 保存在 schema.sql。 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const core = require('../shared/core');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'bulletin.db');
const WASM = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let db;

async function init() {
  const SQL = await initSqlJs({ locateFile: () => WASM });
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
    db.run(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    persist();
  }
  db.run('PRAGMA foreign_keys = ON');
  return db;
}

function persist() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}

// 可重入事务：嵌套调用使用 SAVEPOINT（撤回重发内部会调用 createAnnouncement）
let _depth = 0;
function tx(fn) {
  const sp = 'sp' + _depth;
  if (_depth === 0) db.run('BEGIN'); else db.run('SAVEPOINT ' + sp);
  _depth++;
  try {
    const r = fn();
    _depth--;
    if (_depth === 0) { db.run('COMMIT'); persist(); } else db.run('RELEASE SAVEPOINT ' + sp);
    return r;
  } catch (e) {
    _depth--;
    if (_depth === 0) db.run('ROLLBACK'); else db.run('ROLLBACK TO SAVEPOINT ' + sp);
    throw e;
  }
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function get(sql, params = []) { return all(sql, params)[0] || null; }
function run(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
}

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function nowIso() { return new Date().toISOString(); }

// ---------------- 用户 ----------------
function getUserById(id) { return get('SELECT * FROM user WHERE id = ?', [id]); }
function getUserByName(name) { return get('SELECT * FROM user WHERE username = ?', [name]); }
function listUsers() { return all('SELECT * FROM user ORDER BY id'); }

// ---------------- 楼栋 ----------------
function listBuildings(includeInactive) {
  return all(includeInactive
    ? 'SELECT * FROM building ORDER BY CAST(code AS INTEGER), code'
    : "SELECT * FROM building WHERE active = 1 ORDER BY CAST(code AS INTEGER), code");
}
function getBuilding(id) { return get('SELECT * FROM building WHERE id = ?', [id]); }

function renameBuilding(id, newName, actorId) {
  return tx(() => {
    const b = getBuilding(id);
    if (!b) throw new HttpError(404, 'building_not_found', '楼栋不存在');
    if (!newName || !newName.trim()) throw new HttpError(400, 'bad_name', '名称不能为空');
    newName = newName.trim();
    if (newName === b.name) return b;
    run('INSERT INTO building_name_history (building_id, old_name, new_name, changed_by) VALUES (?,?,?,?)',
      [id, b.name, newName, actorId]);
    run("UPDATE building SET name = ? WHERE id = ?", [newName, id]);
    audit(null, actorId, 'building_rename', { building_id: id, old_name: b.name, new_name: newName });
    return getBuilding(id);
  });
}
function buildingHistory(id) {
  return all('SELECT h.*, u.display_name AS changed_by_name FROM building_name_history h ' +
    'LEFT JOIN user u ON u.id = h.changed_by WHERE building_id = ? ORDER BY h.id DESC', [id]);
}

// ---------------- 范围版本 ----------------
// 绑定"当时范围版"：取所选楼栋当前名称快照；ids+names 相同才复用。
function resolveScopeVersion(buildingIds, actorId) {
  const ids = [...new Set(buildingIds.map(Number))].sort((a, b) => a - b);
  if (!ids.length) throw new HttpError(400, 'scope_empty', '影响范围不能为空');
  const buildings = all(`SELECT * FROM building WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  if (buildings.length !== ids.length) throw new HttpError(400, 'scope_bad_building', '包含不存在的楼栋');
  const byId = Object.fromEntries(buildings.map(b => [b.id, b]));
  const names = ids.map(i => byId[i].name);
  const memberIds = ids.join(',');
  const memberNames = names.join(',');
  const memberHash = core.cyrb53(memberIds + '|' + memberNames);
  return tx(() => {
    let v = get('SELECT * FROM scope_version WHERE member_hash = ?', [memberHash]);
    if (!v) {
      run('INSERT INTO scope_version (member_ids, member_names, member_hash, created_by) VALUES (?,?,?,?)',
        [memberIds, memberNames, memberHash, actorId]);
      v = get('SELECT * FROM scope_version WHERE member_hash = ?', [memberHash]);
      audit(null, actorId, 'scope_create', { scope_version_id: v.id, member_ids: memberIds, member_names: memberNames });
    }
    return v;
  });
}
function getScopeVersion(id) { return get('SELECT * FROM scope_version WHERE id = ?', [id]); }
function listScopeVersions() { return all('SELECT * FROM scope_version ORDER BY id DESC'); }

// ---------------- 审计 ----------------
function audit(annId, actorId, action, detail) {
  run('INSERT INTO audit_log (announcement_id, actor_id, action, detail) VALUES (?,?,?,?)',
    [annId, actorId, action, JSON.stringify(detail || {})]);
}
function listAudit(annId) {
  return all('SELECT l.*, u.display_name AS actor_name FROM audit_log l ' +
    'LEFT JOIN user u ON u.id = l.actor_id WHERE announcement_id = ? ORDER BY l.id', [annId]);
}

// ---------------- 公告组装 ----------------
function _row(sql, params) {
  const a = get(sql, params);
  if (a) decorate(a);
  return a;
}
function decorate(a) {
  const scope = getScopeVersion(a.scope_version_id);
  a.scope_member_ids = scope ? scope.member_ids : '';
  a.scope_member_names = scope ? scope.member_names : '';
  a.scope_frozen_at = scope ? scope.created_at : null;
  const author = getUserById(a.author_id);
  a.author_name = author ? author.display_name : String(a.author_id);
  a.content_hash = core.contentHash(a);
  a.confirmations = all('SELECT c.*, u.display_name AS confirmer_name FROM confirmation c ' +
    'JOIN user u ON u.id = c.confirmer_id WHERE announcement_id = ? ORDER BY c.id', [a.id]);
  const valid = core.validConfirmation(a, a.confirmations);
  a.valid_confirmation = valid || null;
  return a;
}

function getAnnouncement(id) {
  return _row('SELECT * FROM announcement WHERE id = ?', [id]);
}
function listAnnouncements(filter = {}) {
  let sql = 'SELECT * FROM announcement WHERE 1=1';
  const p = [];
  if (filter.status) { sql += ' AND status = ?'; p.push(filter.status); }
  if (filter.authorId) { sql += ' AND author_id = ?'; p.push(filter.authorId); }
  if (filter.chainRootId) { sql += ' AND chain_root_id = ?'; p.push(filter.chainRootId); }
  sql += ' ORDER BY id DESC';
  return all(sql, p).map(decorate);
}

function validateFields(f, { partial = false } = {}) {
  const out = {};
  const need = (k) => {
    if (!partial && (f[k] === undefined || f[k] === null || f[k] === ''))
      throw new HttpError(400, 'missing_field', `缺少字段 ${k}`);
  };
  need('title'); if (f.title !== undefined) out.title = String(f.title).trim();
  if (!partial && !out.title) throw new HttpError(400, 'bad_title', '标题不能为空');
  out.body = f.body !== undefined ? String(f.body) : (partial ? undefined : '');
  out.contact_name = f.contact_name ? String(f.contact_name).trim() : null;
  out.contact_phone = f.contact_phone ? String(f.contact_phone).trim() : null;
  if (f.urgency !== undefined || !partial) {
    if (!core.URGENCY[f.urgency || 'normal']) throw new HttpError(400, 'bad_urgency', '紧急级别非法');
    out.urgency = f.urgency || 'normal';
  }
  if (f.building_ids !== undefined) {
    if (!Array.isArray(f.building_ids) || !f.building_ids.length)
      throw new HttpError(400, 'scope_empty', '影响范围不能为空');
    out.building_ids = f.building_ids.map(Number);
  }
  if (f.starts_at !== undefined || f.ends_at !== undefined || (!partial)) {
    need('starts_at'); need('ends_at');
    const s = core.fromInput(String(f.starts_at).trim());
    const e = core.fromInput(String(f.ends_at).trim());
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) throw new HttpError(400, 'bad_time', '开始时间格式错误');
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(e)) throw new HttpError(400, 'bad_time', '结束时间格式错误');
    if (!(e > s)) throw new HttpError(400, 'bad_window', '结束时间必须晚于开始时间（支持跨午夜）');
    out.starts_at = s.length === 16 ? s + ':00' : s;
    out.ends_at = e.length === 16 ? e + ':00' : e;
  }
  return out;
}

// 创建（draft 或直接进入待确认/发布）
function createAnnouncement(f, actorId, idemKey) {
  if (idemKey) {
    const ex = get('SELECT * FROM announcement WHERE idempotency_key = ?', [idemKey]);
    if (ex) return { announcement: getAnnouncement(ex.id), idempotent_replay: true };
  }
  const v = validateFields(f);
  return tx(() => {
    const scope = resolveScopeVersion(v.building_ids, actorId);
    run(`INSERT INTO announcement
      (chain_root_id, title, body, contact_name, contact_phone, urgency,
       scope_version_id, starts_at, ends_at, status, idempotency_key, author_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [0, v.title, v.body || '', v.contact_name, v.contact_phone, v.urgency || 'normal',
       scope.id, v.starts_at, v.ends_at, 'draft', idemKey || null, actorId]);
    const id = get('SELECT last_insert_rowid() AS x').x;
    run('UPDATE announcement SET chain_root_id = ? WHERE id = ?', [id, id]);
    audit(id, actorId, 'create', { title: v.title });
    return { announcement: getAnnouncement(id), idempotent_replay: false };
  });
}

// 编辑：draft 任意改；pending 仅可改联系人/时间（验收：审批中时间调整），
// 任何快照字段改动都会让旧确认的 content_hash 不再匹配 → 自动失效。
function editAnnouncement(id, f, actorId) {
  return tx(() => {
    const a = get('SELECT * FROM announcement WHERE id = ?', [id]);
    if (!a) throw new HttpError(404, 'not_found', '公告不存在');
    if (a.author_id !== actorId) throw new HttpError(403, 'forbidden', '只有作者可修改');
    if (!['draft', 'pending'].includes(a.status))
      throw new HttpError(409, 'immutable', '已发布公告不可直接修改，请使用"替代"发布新版本');

    const allowedInPending = ['contact_name', 'contact_phone', 'starts_at', 'ends_at'];
    let keys = Object.keys(f);
    if (a.status === 'pending') {
      const bad = keys.filter(k => !allowedInPending.includes(k) &&
        !['id'].includes(k));
      if (bad.length) throw new HttpError(409, 'pending_locked',
        '紧急公告审批中只允许调整联系人或开始/结束时间；其余改动请先撤回再重发或发后替代');
    }
    const v = validateFields({ ...a, ...f }, { partial: true });

    let scopeId = a.scope_version_id;
    if (v.building_ids) {
      if (a.status === 'pending') throw new HttpError(409, 'pending_locked', '审批中不可改楼栋');
      scopeId = resolveScopeVersion(v.building_ids, actorId).id;
    }
    const beforeHash = core.contentHash(a);
    run(`UPDATE announcement SET title=?, body=?, contact_name=?, contact_phone=?, urgency=?,
         scope_version_id=?, starts_at=?, ends_at=?, updated_at=datetime('now') WHERE id=?`,
      [v.title !== undefined ? v.title : a.title,
       v.body !== undefined ? v.body : a.body,
       v.contact_name !== undefined ? v.contact_name : a.contact_name,
       v.contact_phone !== undefined ? v.contact_phone : a.contact_phone,
       v.urgency !== undefined ? v.urgency : a.urgency,
       scopeId,
       v.starts_at || a.starts_at, v.ends_at || a.ends_at, id]);
    const after = get('SELECT * FROM announcement WHERE id = ?', [id]);
    const afterHash = core.contentHash(after);
    audit(id, actorId, 'edit', { changed: keys, hash_before: beforeHash, hash_after: afterHash });
    return getAnnouncement(id);
  });
}

// 发布（进入 published；紧急公告必须先有另一有权人员对同一快照的有效确认）
// 幂等：重复发布请求返回同一条当前公告。幂等键按动作加前缀，避免与创建键碰撞。
function publishAnnouncement(id, actorId, idemKey) {
  return tx(() => {
    if (idemKey) {
      const ex = get('SELECT * FROM announcement WHERE idempotency_key = ?', ['publish:' + idemKey]);
      if (ex) return { announcement: getAnnouncement(ex.id), idempotent_replay: true };
    }
    const a = get('SELECT * FROM announcement WHERE id = ?', [id]);
    if (!a) throw new HttpError(404, 'not_found', '公告不存在');
    if (a.status === 'published') return { announcement: decorate(a), idempotent_replay: true };
    if (!['draft', 'pending'].includes(a.status))
      throw new HttpError(409, 'not_publishable', `状态 ${a.status} 不可发布`);
    if (a.urgency === 'urgent') {
      const dec = decorate(a);
      if (!dec.valid_confirmation)
        throw new HttpError(409, 'confirmation_required',
          '紧急公告需由另一名有权人员确认当前内容快照后方可发布');
      if (dec.valid_confirmation.confirmer_id === a.author_id)
        throw new HttpError(409, 'self_confirmation', '确认人不得是作者本人');
    }
    run(`UPDATE announcement SET status='published', published_at=datetime('now'),
         effective_at=MAX(starts_at, datetime('now')),
         idempotency_key=CASE WHEN idempotency_key IS NULL THEN ? ELSE idempotency_key END,
         updated_at=datetime('now') WHERE id=?`, [idemKey ? 'publish:' + idemKey : null, id]);
    audit(id, actorId, 'publish', { urgency: a.urgency });
    return { announcement: getAnnouncement(id), idempotent_replay: false };
  });
}

// 紧急公告提交（进入 pending）；非紧急无需确认，可直接发布
function submitForConfirmation(id, actorId) {
  return tx(() => {
    const a = get('SELECT * FROM announcement WHERE id = ?', [id]);
    if (!a) throw new HttpError(404, 'not_found', '公告不存在');
    if (a.author_id !== actorId) throw new HttpError(403, 'forbidden', '只有作者可提交');
    if (a.urgency !== 'urgent') throw new HttpError(409, 'not_urgent', '仅紧急公告需要双人确认');
    if (!['draft', 'pending'].includes(a.status)) throw new HttpError(409, 'bad_status', '当前状态不可提交');
    run("UPDATE announcement SET status='pending', updated_at=datetime('now') WHERE id=?", [id]);
    audit(id, actorId, 'submit_confirm', {});
    return getAnnouncement(id);
  });
}

// 另一有权人员对快照进行确认/拒绝
function confirmAnnouncement(id, confirmerId, decision, comment) {
  return tx(() => {
    const a = get('SELECT * FROM announcement WHERE id = ?', [id]);
    if (!a) throw new HttpError(404, 'not_found', '公告不存在');
    if (a.urgency !== 'urgent') throw new HttpError(409, 'not_urgent', '仅紧急公告需要确认');
    if (confirmerId === a.author_id)
      throw new HttpError(403, 'self_confirmation', '必须由作者之外的另一有权人员确认');
    if (!['draft', 'pending'].includes(a.status))
      throw new HttpError(409, 'bad_status', '该公告已结束确认流程');
    const hash = core.contentHash(a);
    // 同一确认人重复确认同一快照 → 幂等返回；快照变了 → 插入新行（旧行自然失配）
    const ex = get('SELECT * FROM confirmation WHERE announcement_id=? AND confirmer_id=?', [id, confirmerId]);
    if (ex && ex.content_hash === hash && ex.decision === decision) {
      return { announcement: getAnnouncement(id), idempotent_replay: true };
    }
    run(`INSERT INTO confirmation (announcement_id, confirmer_id, content_hash, scope_version_id,
         snapshot_json, decision, comment) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(announcement_id, confirmer_id) DO UPDATE SET
           content_hash=excluded.content_hash, scope_version_id=excluded.scope_version_id,
           snapshot_json=excluded.snapshot_json, decision=excluded.decision,
           comment=excluded.comment, confirmed_at=datetime('now')`,
      [id, confirmerId, hash, a.scope_version_id, core.canonicalJson(a), decision, comment || null]);
    run("UPDATE announcement SET status='pending', updated_at=datetime('now') WHERE id=?", [id]);
    audit(id, confirmerId, decision === 'confirmed' ? 'confirm' : 'reject',
      { content_hash: hash, comment: comment || null });
    return { announcement: getAnnouncement(id), idempotent_replay: false };
  });
}

// 替代：基于已发布公告 a 生成同链新版本 b（范围/时间/正文均可修订）
function supersedeAnnouncement(id, patch, actorId, idemKey) {
  return tx(() => {
    const src = get('SELECT * FROM announcement WHERE id = ?', [id]);
    if (!src) throw new HttpError(404, 'not_found', '原公告不存在');
    if (!['published'].includes(src.status))
      throw new HttpError(409, 'not_supersedable', '只有生效（含未开始/已过期但未撤回）公告可被替代');
    if (idemKey) {
      const ex = get('SELECT * FROM announcement WHERE idempotency_key = ?', ['supersede:' + idemKey]);
      if (ex) return { announcement: getAnnouncement(ex.id), idempotent_replay: true };
    }
    const merged = {
      title: patch.title !== undefined ? patch.title : src.title,
      body: patch.body !== undefined ? patch.body : src.body,
      contact_name: patch.contact_name !== undefined ? patch.contact_name : src.contact_name,
      contact_phone: patch.contact_phone !== undefined ? patch.contact_phone : src.contact_phone,
      urgency: patch.urgency || src.urgency,
      building_ids: patch.building_ids || (getScopeVersion(src.scope_version_id).member_ids.split(',').map(Number)),
      starts_at: patch.starts_at !== undefined ? core.fromInput(patch.starts_at) : src.starts_at,
      ends_at: patch.ends_at !== undefined ? core.fromInput(patch.ends_at) : src.ends_at
    };
    const v = validateFields(merged);
    const scope = resolveScopeVersion(v.building_ids, actorId);
    const seq = get('SELECT MAX(chain_seq) AS m FROM announcement WHERE chain_root_id = ?',
      [src.chain_root_id]).m + 1;
    run(`INSERT INTO announcement
      (chain_root_id, chain_seq, title, body, contact_name, contact_phone, urgency,
       scope_version_id, starts_at, ends_at, status, idempotency_key, author_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [src.chain_root_id, seq, v.title, v.body || '', v.contact_name, v.contact_phone,
       v.urgency || 'normal', scope.id, v.starts_at, v.ends_at, 'draft',
       idemKey ? 'supersede:' + idemKey : null, actorId]);
    const newId = get('SELECT last_insert_rowid() AS x').x;
    // 新版本若为紧急，同样需要重新确认（快照是新内容）
    let needsConfirm = (v.urgency || 'normal') === 'urgent';
    if (!needsConfirm) {
      run(`UPDATE announcement SET status='published', published_at=datetime('now'),
           effective_at=MAX(starts_at, datetime('now')), updated_at=datetime('now') WHERE id=?`, [newId]);
    }
    run("UPDATE announcement SET status='superseded', superseded_by=?, supersede_reason=?, updated_at=datetime('now') WHERE id=?",
      [newId, patch.reason || null, id]);
    audit(id, actorId, 'supersede', { new_id: newId, reason: patch.reason || null });
    audit(newId, actorId, 'create_from_supersede', { predecessor: id });
    return { announcement: getAnnouncement(newId), predecessor: getAnnouncement(id), needsConfirm };
  });
}

// 撤回（pending 撤回=取消审批；published 撤回=撤下，可选 reissue 指向重发件）
function withdrawAnnouncement(id, actorId, reason, reissueId) {
  return tx(() => {
    const a = get('SELECT * FROM announcement WHERE id = ?', [id]);
    if (!a) throw new HttpError(404, 'not_found', '公告不存在');
    if (a.status === 'pending') {
      run("UPDATE announcement SET status='cancelled', withdrawn_at=datetime('now'), withdraw_reason=?, withdrawn_by=? WHERE id=?",
        [reason || null, actorId, id]);
      audit(id, actorId, 'cancel_pending', { reason: reason || null });
    } else if (a.status === 'published') {
      if (reissueId) {
        const r = get('SELECT * FROM announcement WHERE id = ?', [reissueId]);
        if (!r) throw new HttpError(404, 'reissue_not_found', '重发公告不存在');
        run('UPDATE announcement SET reissued_by = ? WHERE id = ?', [reissueId, id]);
      }
      run("UPDATE announcement SET status='withdrawn', withdrawn_at=datetime('now'), withdraw_reason=?, withdrawn_by=? WHERE id=?",
        [reason || null, actorId, id]);
      audit(id, actorId, 'withdraw', { reason: reason || null, reissue_id: reissueId || null });
      // 打印任务随之作废
      run("UPDATE print_task SET status='cancelled' WHERE announcement_id=? AND status IN ('queued','late')", [id]);
    } else {
      throw new HttpError(409, 'not_withdrawable', `状态 ${a.status} 不可撤回`);
    }
    return getAnnouncement(id);
  });
}

// 撤回旧公告再发新公告：两步合一，新公告另起新链，旧件记录 reissued_by
function withdrawAndReissue(id, patch, actorId, idemKey) {
  return tx(() => {
    const src = get('SELECT * FROM announcement WHERE id = ?', [id]);
    if (!src) throw new HttpError(404, 'not_found', '公告不存在');
    if (src.status !== 'published') throw new HttpError(409, 'not_withdrawable', '仅已发布公告可撤回重发');
    if (idemKey) {
      const ex = get('SELECT * FROM announcement WHERE idempotency_key = ?', ['reissue:' + idemKey]);
      if (ex) return { new: getAnnouncement(ex.id), old: getAnnouncement(id), idempotent_replay: true };
    }
    const created = createAnnouncement({
      title: patch.title || src.title,
      body: patch.body !== undefined ? patch.body : src.body,
      contact_name: patch.contact_name !== undefined ? patch.contact_name : src.contact_name,
      contact_phone: patch.contact_phone !== undefined ? patch.contact_phone : src.contact_phone,
      urgency: patch.urgency || src.urgency,
      building_ids: patch.building_ids || getScopeVersion(src.scope_version_id).member_ids.split(',').map(Number),
      starts_at: patch.starts_at ? core.fromInput(patch.starts_at) : src.starts_at,
      ends_at: patch.ends_at ? core.fromInput(patch.ends_at) : src.ends_at
    }, actorId, null).announcement;
    const newId = created.id;
    // 嵌套事务由 tx 的 SAVEPOINT 支持
    run('UPDATE announcement SET reissued_by = ? WHERE id = ?', [newId, id]);
    run("UPDATE announcement SET status='withdrawn', withdrawn_at=datetime('now'), withdraw_reason=?, withdrawn_by=? WHERE id=?",
      [patch.reason || '撤回后以新公告重发', actorId, id]);
    run("UPDATE print_task SET status='cancelled' WHERE announcement_id=? AND status IN ('queued','late')", [id]);
    audit(id, actorId, 'withdraw', { reason: patch.reason || '撤回重发', reissue_id: newId });
    if ((patch.urgency || src.urgency) !== 'urgent') {
      run(`UPDATE announcement SET status='published', published_at=datetime('now'),
           effective_at=MAX(starts_at, datetime('now')), idempotency_key=? WHERE id=?`,
        [idemKey ? 'reissue:' + idemKey : null, newId]);
      audit(newId, actorId, 'publish', { reissue_of: id });
    } else {
      run("UPDATE announcement SET status='pending', idempotency_key=? WHERE id=?",
        [idemKey ? 'reissue:' + idemKey : null, newId]);
    }
    return { new: getAnnouncement(newId), old: getAnnouncement(id), idempotent_replay: false };
  });
}

// ---------------- 查询：当前有效通知 ----------------
// 唯一事实口径：status=published 且 窗口覆盖 at；可按楼栋（命中冻结版本成员）过滤。
function effectiveAt(at, buildingId) {
  const rows = all(
    `SELECT * FROM announcement
     WHERE status='published' AND starts_at <= ? AND ? < ends_at
     ORDER BY (urgency='urgent') DESC, starts_at DESC, id DESC`, [at, at])
    .map(decorate);
  if (!buildingId) return rows;
  return rows.filter(a => a.scope_member_ids.split(',').includes(String(buildingId)));
}

function chainOf(id) {
  const a = getAnnouncement(id);
  if (!a) return [];
  return all('SELECT * FROM announcement WHERE chain_root_id = ? ORDER BY chain_seq, id', [a.chain_root_id])
    .map(decorate);
}

// ---------------- 打印任务 ----------------
function createPrintTask(announcementId, dueAt, actorId, note) {
  return tx(() => {
    const a = get('SELECT * FROM announcement WHERE id = ?', [announcementId]);
    if (!a) throw new HttpError(404, 'not_found', '公告不存在');
    const due = core.fromInput(String(dueAt).trim());
    run('INSERT INTO print_task (announcement_id, due_at, operator_id, note) VALUES (?,?,?,?)',
      [announcementId, due, actorId, note || null]);
    const id = get('SELECT last_insert_rowid() AS x').x;
    audit(announcementId, actorId, 'print_queue', { print_task_id: id, due_at: due });
    return getPrintTask(id);
  });
}
function getPrintTask(id) { return get('SELECT * FROM print_task WHERE id = ?', [id]); }
function listPrintTasks() {
  return all('SELECT p.*, a.title AS announcement_title FROM print_task p ' +
    'JOIN announcement a ON a.id = p.announcement_id ORDER BY p.id DESC');
}
// 迟到检测：到 due_at 未打印即标记 late（幂等，支持验收"打印任务迟到"）
function sweepPrintTasks(at) {
  return tx(() => {
    const due = all("SELECT * FROM print_task WHERE status='queued' AND due_at <= ?", [at]);
    due.forEach(t => {
      run("UPDATE print_task SET status='late', marked_late_at=datetime('now') WHERE id=?", [t.id]);
      audit(t.announcement_id, t.operator_id, 'print_late', { print_task_id: t.id, due_at: t.due_at, at });
    });
    return due.length;
  });
}
function markPrinted(id, actorId) {
  return tx(() => {
    const t = getPrintTask(id);
    if (!t) throw new HttpError(404, 'not_found', '打印任务不存在');
    const late = t.status === 'late';
    run("UPDATE print_task SET status='printed', printed_at=datetime('now'), operator_id=? WHERE id=?",
      [actorId, id]);
    audit(t.announcement_id, actorId, 'printed', { print_task_id: id, was_late: late });
    return { task: getPrintTask(id), was_late: late };
  });
}

module.exports = {
  init, persist, HttpError,
  listUsers, getUserById, getUserByName,
  listBuildings, renameBuilding, buildingHistory,
  resolveScopeVersion, getScopeVersion, listScopeVersions,
  createAnnouncement, editAnnouncement, publishAnnouncement,
  submitForConfirmation, confirmAnnouncement,
  supersedeAnnouncement, withdrawAnnouncement, withdrawAndReissue,
  getAnnouncement, listAnnouncements, effectiveAt, chainOf,
  createPrintTask, listPrintTasks, sweepPrintTasks, markPrinted,
  listAudit
};

// 供种子脚本直接执行 SQL
module.exports.runForSeed = function (sql, params = []) { run(sql, params); persist(); };
