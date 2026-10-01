'use strict';
/**
 * SQLite 数据层（sql.js WASM）。
 * 设计要点：
 *  - 所有时间以 epoch 毫秒整数存储，客户端可传 ?now 模拟时钟（用于验收：跨午夜、打印迟到）
 *  - 楼栋名称版本化：scope_version + scope_building + building_name_version
 *    公告绑定"当时的范围版"，楼栋更名后历史公告仍保留发布时名称
 *  - announcement_revision 保存每次内容快照 hash；confirmation 绑定 revision hash，
 *    作者改联系人/时间/正文/级别后 hash 变化 -> 旧确认标记 superseded（失效留痕）
 *  - publication_event 记录发布/撤回/替代等审计事件；supersession_link 保存替代链
 *  - 幂等：publish 支持 client_request_id，重复请求返回同一条，不重复发布
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const DB_FILE = path.join(__dirname, '..', 'data', 'notice.db');
const WASM_FILE = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist');

const SCHEMA = `
PRAGMA foreign_keys = ON;

-- 后台/审批用户
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY,
  username     TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  can_publish  INTEGER NOT NULL DEFAULT 0,   -- 可发布普通公告 / 起草紧急公告
  can_confirm  INTEGER NOT NULL DEFAULT 0    -- 可确认紧急公告（须与作者不同的另一有权人员）
);

-- 楼栋实体（id 稳定，更名不改 id）
CREATE TABLE IF NOT EXISTS buildings (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,           -- 如 A、B、12
  current_name TEXT NOT NULL,                -- 当前名称
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- 楼栋名称版本：每次更名追加一行，历史区间 [valid_from, valid_to)
CREATE TABLE IF NOT EXISTS building_name_version (
  id          INTEGER PRIMARY KEY,
  building_id INTEGER NOT NULL REFERENCES buildings(id),
  name        TEXT NOT NULL,
  valid_from  INTEGER NOT NULL,
  valid_to    INTEGER,                      -- NULL = 当前有效
  UNIQUE(building_id, valid_from)
);

-- 范围版：一次冻结的楼栋集合，公告创建时绑定，之后楼栋增删/更名都不动它
CREATE TABLE IF NOT EXISTS scope_version (
  id         INTEGER PRIMARY KEY,
  label      TEXT NOT NULL,                 -- 如 '2026 秋季全域'
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scope_building (
  scope_id    INTEGER NOT NULL REFERENCES scope_version(id),
  building_id INTEGER NOT NULL REFERENCES buildings(id),
  PRIMARY KEY (scope_id, building_id)
);

-- 公告主表
CREATE TABLE IF NOT EXISTS announcement (
  id              INTEGER PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,     -- 业务编号 如 GG-20261001-001
  urgency         TEXT NOT NULL CHECK (urgency IN ('normal','important','urgent')),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,            -- 长正文
  contact_name    TEXT NOT NULL,
  contact_phone   TEXT NOT NULL,
  scope_id        INTEGER NOT NULL REFERENCES scope_version(id),
  start_at        INTEGER NOT NULL,         -- 有效开始（含）
  end_at          INTEGER NOT NULL,         -- 有效结束（不含）
  status          TEXT NOT NULL CHECK (status IN ('draft','pending_confirm','published','withdrawn','superseded')),
  author_id       INTEGER NOT NULL REFERENCES users(id),
  current_revision INTEGER NOT NULL DEFAULT 1,
  client_request_id TEXT,                   -- 发布幂等键
  published_at    INTEGER,
  withdrawn_at    INTEGER,
  withdraw_reason TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
-- 幂等：同一作者同一 request id 只能产生一次发布
CREATE UNIQUE INDEX IF NOT EXISTS idx_announce_req
  ON announcement(author_id, client_request_id) WHERE client_request_id IS NOT NULL;

-- 内容快照（每次修改追加；confirm 绑定快照 hash）
CREATE TABLE IF NOT EXISTS announcement_revision (
  id           INTEGER PRIMARY KEY,
  announce_id  INTEGER NOT NULL REFERENCES announcement(id),
  revision_no  INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  urgency      TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_phone TEXT NOT NULL,
  start_at     INTEGER NOT NULL,
  end_at       INTEGER NOT NULL,
  created_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  UNIQUE(announce_id, revision_no)
);

-- 紧急公告确认：必须另一名 can_confirm 用户确认"同一内容快照"
CREATE TABLE IF NOT EXISTS confirmation (
  id           INTEGER PRIMARY KEY,
  announce_id  INTEGER NOT NULL REFERENCES announcement(id),
  revision_no  INTEGER NOT NULL,            -- 被确认的快照号
  content_hash TEXT NOT NULL,               -- 被确认的快照 hash
  confirmer_id INTEGER NOT NULL REFERENCES users(id),
  state        TEXT NOT NULL CHECK (state IN ('valid','superseded')),
  -- superseded: 作者事后修改了联系人/时间/正文/级别，快照不再是当前版
  created_at   INTEGER NOT NULL,
  UNIQUE(announce_id, revision_no, confirmer_id)
);

-- 发布 / 撤回 / 替代审计事件（SQL 保存发布、确认和替代记录）
CREATE TABLE IF NOT EXISTS publication_event (
  id           INTEGER PRIMARY KEY,
  announce_id  INTEGER NOT NULL REFERENCES announcement(id),
  event_type   TEXT NOT NULL CHECK (event_type IN
                 ('created','submitted','confirmed','publish_failed','published','withdrawn','superseded')),
  actor_id     INTEGER REFERENCES users(id),
  detail       TEXT,                        -- JSON
  created_at   INTEGER NOT NULL
);

-- 替代链：new 取代 old；kind=replace 保持一条链，kind=withdraw_republish 为撤回重发
CREATE TABLE IF NOT EXISTS supersession_link (
  id          INTEGER PRIMARY KEY,
  old_id      INTEGER NOT NULL REFERENCES announcement(id),
  new_id      INTEGER REFERENCES announcement(id), -- 撤回重发时可能先空
  kind        TEXT NOT NULL CHECK (kind IN ('replace','withdraw_republish')),
  reason      TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  INTEGER NOT NULL
);

-- 打印任务：scheduled_at 计划打印时间；executed_at 实际；迟到完全由两者比较派生
CREATE TABLE IF NOT EXISTS print_job (
  id           INTEGER PRIMARY KEY,
  announce_id  INTEGER NOT NULL REFERENCES announcement(id),
  station      TEXT NOT NULL,               -- 打印点位，如 '东门公告栏'
  scheduled_at INTEGER NOT NULL,
  executed_at  INTEGER,                     -- NULL = 尚未执行
  created_at   INTEGER NOT NULL
);

-- 模拟时钟（验收用）；NULL 表示跟随系统
CREATE TABLE IF NOT EXISTS app_setting (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

let db;

function sha256(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

/** 公告内容快照 hash：任何影响"同一内容"的字段都进 hash */
function contentHash(r) {
  return sha256([
    r.title, r.body, r.urgency, r.contact_name, r.contact_phone, r.start_at, r.end_at,
  ]);
}

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs({ locateFile: (f) => path.join(WASM_FILE, f) });
  if (fs.existsSync(DB_FILE)) {
    const buf = fs.readFileSync(DB_FILE);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  db.run(SCHEMA);
  db.run('PRAGMA foreign_keys = ON;');
  const count = db.exec('SELECT COUNT(*) FROM users')[0].values[0][0];
  if (count === 0) seed(db);
  persist.debounce = null;
  return db;
}

/** sql.js 是内存库，写后落盘 */
function persist() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

function run(sql, params = {}) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
}
function get(sql, params = {}) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}
function all(sql, params = {}) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function seed(d) {
  const now = Date.now();
  const oldRun = d.run.bind(d);
  d.run = (sql, params) => { if (params) { const s = d.prepare(sql); s.bind(params); s.step(); s.free(); } else oldRun(sql); };
  const R = (sql, p) => d.run(sql, p);

  R(`INSERT INTO users (id,username,display_name,can_publish,can_confirm) VALUES
     (1,'zhang','张干事',1,0),(2,'li','李主任',1,1),(3,'wang','王主管',0,1),(4,'zhao','赵专员',1,0);`);

  // 楼栋：B 栋曾经叫"老旧 B 座"，后更名为"梧桐苑 B 栋"
  R(`INSERT INTO buildings (id,code,current_name,active,created_at) VALUES
     (1,'A','梧桐苑 A 栋',1,$now),(2,'B','梧桐苑 B 栋',1,$now),(3,'C','梧桐苑 C 栋',1,$now),
     (4,'SVC','物业服务中心',1,$now);`, { $now: now });
  // B 栋名称史
  R(`INSERT INTO building_name_version (building_id,name,valid_from,valid_to) VALUES
     (2,'老旧 B 座',0,$rename),(2,'梧桐苑 B 栋',$rename,NULL);`,
    { $rename: now - 90 * 86400000 });
  R(`INSERT INTO building_name_version (building_id,name,valid_from,valid_to)
     SELECT 1,'梧桐苑 A 栋',0,NULL WHERE NOT EXISTS(SELECT 1 FROM building_name_version WHERE building_id=1);`);
  R(`INSERT INTO building_name_version (building_id,name,valid_from,valid_to)
     SELECT 3,'梧桐苑 C 栋',0,NULL WHERE NOT EXISTS(SELECT 1 FROM building_name_version WHERE building_id=3);`);
  R(`INSERT INTO building_name_version (building_id,name,valid_from,valid_to)
     SELECT 4,'物业服务中心',0,NULL WHERE NOT EXISTS(SELECT 1 FROM building_name_version WHERE building_id=4);`);

  // 范围版 v1 = 全域（发布当时冻结）
  R(`INSERT INTO scope_version (id,label,created_by,created_at) VALUES (1,'2026 秋季全域',1,$now);`, { $now: now });
  R(`INSERT INTO scope_building (scope_id,building_id) VALUES (1,1),(1,2),(1,3),(1,4);`);

  d.run = oldRun;
  persist();
}

module.exports = { getDb, persist, run, get: get, all, contentHash, sha256, DB_FILE };
