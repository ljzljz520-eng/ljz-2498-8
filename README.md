# 社区公告排版台

Vue 双布局预览（公告栏 / 手机）+ Node/Express 后台 + SQLite（sql.js WASM，零原生依赖）。
后台管理**楼栋范围、有效时段、紧急级别**；SQL 保存**发布、确认、替代**记录；
提供"撤回旧公告再发新公告"与"保持替代链"两种处置，查询当前有效通知并保留过往证据。

## 运行

```bash
npm install
npm start          # http://localhost:3000
npm test           # 15 个验收场景（自动使用独立端口与全新数据库）
```

顶栏可切换操作人；"系统时间"卡片可模拟时钟（跨午夜 / 打印迟到验收用）。

预置用户：

| 用户 | 权限 |
|---|---|
| 张干事 zhang | 可发布（常用作者） |
| 李主任 li | 可发布 + 可确认 |
| 王主管 wang | 仅可确认（紧急公告的"另一有权人员"） |
| 赵专员 zhao | 可发布（无确认权，用于权限反例） |

## 需求 → 实现对照

| 需求 | 实现 |
|---|---|
| 公告栏 + 手机两种布局实时预览 | `public/app.js` 的 `BoardView` / `PhoneView`，排版台实时预览，详情页双栏 |
| 后台管理楼栋范围 / 有效时段 / 紧急级别 | 排版台表单；级别 normal/important/urgent；时间可跨午夜（区间毫秒比较，无定时任务） |
| SQL 保存发布、确认、替代记录 | `publication_event`（created/submitted/confirmed/publish_failed/published/withdrawn/superseded）、`confirmation`、`supersession_link` |
| 手机折叠不得藏掉影响范围与开始结束时间 | 手机布局中范围/开始/结束放在**独立于滚动区**的 `p-scope` 固定区；只有正文 `p-page` 可滚动/分页 |
| 长正文续页时紧急提示保持可见 | 正文按 120 字分页独立滚动；`p-urgentbar` 在滚动区之外（公告栏为续页红字提示）；`domain.paginate()` |
| 楼栋选择绑定当时范围版 | 创建/改稿勾选楼栋即冻结一条不可变 `scope_version`+`scope_building`，公告只存 scope_id |
| 楼栋更名不丢失历史含义 | `building_name_version` 名称版本表；历史公告按发布时刻解析 `name_at`，并标注"现名"；新公告用新名、另冻新版 |
| 紧急公告须另一有权人员确认同一内容快照 | 作者自审 403；`confirmation` 记录 revision_no + content_hash + confirmer；发布时校验快照仍为当前版 |
| 作者改联系人或时间后旧确认失效 | 改稿生成新 revision、新 hash；旧确认置 `superseded`（留痕可查），紧急公告回到待确认，强行发布被拦并写 `publish_failed` |
| 撤回重发 vs 保持替代链 | `/supersede` 支持 `withdraw_republish`（旧→withdrawn，分享页撤回说明，新公告现行）与 `replace`（旧→superseded，顺链追溯） |
| 查询当前有效通知 | `GET /api/announcements/effective`：`status=published AND start<=now<end`，支持按楼栋/级别过滤；撤回/被替代/未开始/过期均不出现 |
| 保留过往证据 | 公告、revision 快照、确认记录（含失效）、事件时间线、替代链均不删除 |
| 旧分享页可见撤回说明而不继续表现为现行公告 | 分享页 `#/notice/:id` 顶部撤回横幅（时间+原因）；状态为 withdrawn，不进 effective |
| 重复发布请求 | `client_request_id`（作者+请求键唯一）幂等；重放返回 `duplicated:true` 且只有一条 published 事件 |
| 打印任务迟到 | 计划 vs 实际/当前派生（5 分钟宽限），不存迟到状态；未执行逾期与执行迟到都判定，事实保留 |
| 两端展示相同事实 | 公告栏/手机/列表/分享页全部消费同一个 `services.toDto()`（范围、时间、级别、确认、分页一次计算） |

## 验收场景（`npm test`，15 项）

1. 作者自审被拒（即使作者有确认权）；无确认权用户被拒
2. 另一有权人员确认同一快照后可发布，确认/发布写入 SQL
3. 无有效确认发布被拒并留 `publish_failed`
4. **审批中时间调整**：生成 rev2，旧确认 superseded，发布被拦；重新确认后可发布
5. **楼栋更名**后历史公告保留发布时名称并标注现名，新公告另冻范围版
6. **同时更改楼栋**：两次调整各自冻结独立范围版，互不串改
7. **跨午夜** 23:50–00:40：23:55 生效、00:20 仍生效、00:41 过期
8. **撤回重发**：旧公告撤回+分享页说明、不现行；新版现行；链记录
9. **保持替代链**：旧 superseded、双向链可追溯、证据保留
10. 旧分享页撤回状态与说明
11. **重复发布请求**幂等
12. **打印任务迟到**（未执行逾期/执行迟到/宽限内准时）
13. 长正文分页可还原全文，紧急提示独立；两端 DTO 深相等
14. 当前有效查询排除撤回/被替代/未开始/过期，但证据完整
15. 权限与快照的综合一致性

## 数据表

```
users / buildings / building_name_version
scope_version / scope_building          -- 冻结的楼栋范围版
announcement / announcement_revision    -- 主表 + 内容快照（hash）
confirmation                            -- 紧急确认（valid/superseded）
publication_event                       -- 审计事件流
supersession_link                       -- 替代链（replace / withdraw_republish）
print_job                               -- 打印任务（迟到由时间派生）
app_setting                             -- 模拟时钟
```

## API 摘要

```
GET  /api/announcements/effective?building_id=&urgency=
GET  /api/announcements | /api/announcements/:id
POST /api/announcements                      （body 可带 building_ids 冻结范围）
PATCH /api/announcements/:id                 （发布前改稿；旧确认失效）
POST /api/announcements/:id/submit           （紧急→审批中）
POST /api/announcements/:id/confirm          （另一有权人；X-User-Id 模拟登录）
POST /api/announcements/:id/publish          （{client_request_id} 幂等）
POST /api/announcements/:id/withdraw
POST /api/announcements/:id/supersede        （mode=replace|withdraw_republish）
GET  /api/scopes | POST /api/scopes
POST /api/buildings/:id/rename               （追加名称版本，不改 id）
GET/POST /api/print-jobs , POST /api/print-jobs/:id/execute
POST /api/dev/clock                          （{mock_now}，验收用）
```
所有请求头 `X-User-Id` 表示当前操作人；`X-Mock-Now`（毫秒）可单次请求模拟时间。
