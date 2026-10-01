-- =====================================================================
-- 社区公告排版台 数据模型 (SQLite)
-- 设计要点：
--  * scope_version 冻结"当时范围版"：公告只引用版本行，楼栋更名不溯及历史。
--  * announcement 保存 status / superseded_by / chain_root_id 双链：
--      撤回重发 = 新 chain（旧件保留为 withdrawn 的历史证据）；
--      保持替代链 = 同 chain 上 superseded_by 串起的证据序列。
--  * confirmation 带 content_hash + scope_version_id：
--      作者修改联系人/时间/正文/范围/级别后 hash 不匹配，旧确认立即失效。
--  * audit_log 追加式记录所有发布/确认/替代/撤回/编辑/打印事件，永不删改。
-- =====================================================================

PRAGMA foreign_keys = ON;

-- 演示用账号系统：author 可起草发布，confirmer 可确认，admin 二者兼可
CREATE TABLE IF NOT EXISTS user (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('author','confirmer','admin')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 楼栋主档：code 为稳定标识，name 可变；更名历史另存
CREATE TABLE IF NOT EXISTS building (
    id         INTEGER PRIMARY KEY,
    code       TEXT NOT NULL UNIQUE,   -- 稳定键，例如 A、B、C
    name       TEXT NOT NULL,          -- 当前名称
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 楼栋更名历史：保证历史含义可追溯
CREATE TABLE IF NOT EXISTS building_name_history (
    id          INTEGER PRIMARY KEY,
    building_id INTEGER NOT NULL REFERENCES building(id),
    old_name    TEXT NOT NULL,
    new_name    TEXT NOT NULL,
    changed_at  TEXT NOT NULL DEFAULT (datetime('now')),
    changed_by  INTEGER REFERENCES user(id)
);

-- 范围版本（冻结快照）：member 列表为排序后建筑 id，names 为当时名称
-- 内容相同（成员+当时名称）才复用，否则新建版本
CREATE TABLE IF NOT EXISTS scope_version (
    id           INTEGER PRIMARY KEY,
    member_ids   TEXT NOT NULL,   -- 例 "1,2,3"
    member_names TEXT NOT NULL,   -- 例 "1号楼,2号楼,3号楼"
    member_hash  TEXT NOT NULL,   -- 对 ids+names 的哈希
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    created_by   INTEGER REFERENCES user(id),
    UNIQUE (member_hash)
);

CREATE TABLE IF NOT EXISTS announcement (
    id                 INTEGER PRIMARY KEY,
    chain_root_id      INTEGER NOT NULL,              -- 替代链根；撤回重发则另起新链
    chain_seq          INTEGER NOT NULL DEFAULT 1,     -- 链内序号
    title              TEXT NOT NULL,
    body               TEXT NOT NULL DEFAULT '',
    contact_name       TEXT,
    contact_phone      TEXT,
    urgency            TEXT NOT NULL DEFAULT 'normal'
                           CHECK (urgency IN ('info','normal','urgent')),
    scope_version_id   INTEGER NOT NULL REFERENCES scope_version(id),
    starts_at          TEXT NOT NULL,   -- 'YYYY-MM-DD HH:MM:SS'
    ends_at            TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','pending','published','superseded','withdrawn','cancelled')),
    idempotency_key    TEXT UNIQUE,
    author_id          INTEGER NOT NULL REFERENCES user(id),
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    published_at       TEXT,
    effective_at       TEXT,           -- 发布后生效时间（一般等于 starts_at）
    superseded_by      INTEGER REFERENCES announcement(id),
    supersede_reason   TEXT,
    withdrawn_at       TEXT,
    withdraw_reason    TEXT,
    withdrawn_by       INTEGER REFERENCES user(id),
    reissued_by        INTEGER REFERENCES announcement(id), -- 撤回后另发的新公告
    pending_edits_since_conf INTEGER NOT NULL DEFAULT 0,
    CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_ann_status      ON announcement(status);
CREATE INDEX IF NOT EXISTS idx_ann_chain       ON announcement(chain_root_id, chain_seq);
CREATE INDEX IF NOT EXISTS idx_ann_window      ON announcement(starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_ann_author      ON announcement(author_id);

-- 紧急公告确认：另一有权人员对同一内容快照的确认
CREATE TABLE IF NOT EXISTS confirmation (
    id                 INTEGER PRIMARY KEY,
    announcement_id    INTEGER NOT NULL REFERENCES announcement(id),
    confirmer_id       INTEGER NOT NULL REFERENCES user(id),
    content_hash       TEXT NOT NULL,    -- 确认时刻内容哈希
    scope_version_id   INTEGER NOT NULL REFERENCES scope_version(id),
    snapshot_json      TEXT NOT NULL,    -- 完整快照，留证
    decision           TEXT NOT NULL DEFAULT 'confirmed'
                           CHECK (decision IN ('confirmed','rejected')),
    comment            TEXT,
    confirmed_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (announcement_id, confirmer_id)
);

-- 追加式审计日志（历史证据）
CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY,
    announcement_id INTEGER REFERENCES announcement(id),
    actor_id        INTEGER REFERENCES user(id),
    action          TEXT NOT NULL,   -- create/edit/publish/confirm/reject/supersede/withdraw/reissue/scope/print ...
    detail          TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_ann ON audit_log(announcement_id);

-- 打印任务（公告栏纸质张贴）：迟到检测
CREATE TABLE IF NOT EXISTS print_task (
    id                INTEGER PRIMARY KEY,
    announcement_id   INTEGER NOT NULL REFERENCES announcement(id),
    due_at            TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','printed','late','cancelled')),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    printed_at        TEXT,
    marked_late_at    TEXT,
    operator_id       INTEGER REFERENCES user(id),
    note              TEXT
);
CREATE INDEX IF NOT EXISTS idx_print_status ON print_task(status);
