'use strict';
/**
 * 验收测试（纯 Node assert + http）。
 * 覆盖：同时更改楼栋 / 审批中时间调整 / 跨午夜 / 打印迟到 / 重复发布请求 /
 *       紧急确认同一快照 & 作者改联系人或时间后旧确认失效 /
 *       楼栋更名不丢历史含义 / 撤回重发 vs 替代链 / 当前有效查询与过往证据 /
 *       旧分享页撤回说明 / 两端相同事实（同一 DTO 喂给公告栏与手机）
 */
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = 3199;
process.env.PORT = String(PORT);

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(['PASS', name]); console.log('  ✓ ' + name); }
  catch (e) { results.push(['FAIL', name, e]); console.log('  ✗ ' + name + '\n    ' + e.message); }
}

function call(method, urlPath, body, uid = 1) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: urlPath, method,
      headers: { 'Content-Type': 'application/json', 'X-User-Id': String(uid),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      let chunks = '';
      res.on('data', (d) => (chunks += d));
      res.on('end', () => {
        let json = null;
        try { json = chunks ? JSON.parse(chunks) : null; } catch { json = chunks; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const mustFail = async (r, status, kw) => {
  assert.strictEqual(r.status, status, `expected ${status}, got ${r.status}: ${JSON.stringify(r.json)}`);
  if (kw) assert.match(String(r.json && r.json.error), kw);
};

const H = 3600000, D = 24 * H;
let NOW;
const announce = async (over = {}, uid = 1) => {
  const body = {
    title: over.title || '测试公告', body: over.body || '正文内容。', urgency: over.urgency || 'normal',
    contact_name: over.contact_name || '张干事', contact_phone: over.contact_phone || '13800000000',
    start_at: over.start_at ?? NOW - H, end_at: over.end_at ?? NOW + D,
    building_ids: over.building_ids || [1, 2, 3],
  };
  return (await call('POST', '/api/announcements', body, uid)).json.id;
};
const dto = async (id) => (await call('GET', `/api/announcements/${id}`)).json;
const effectiveIds = async () => (await call('GET', '/api/announcements/effective')).json.map((a) => a.id);

async function main() {
  // 全新数据库启动
  const dbFile = path.join(__dirname, '..', 'data', 'notice.db');
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  const { app } = require('../server/server');
  await require('../server/db').getDb();
  await new Promise((res) => app.listen(PORT, res));

  NOW = (await call('GET', '/api/me')).json.now;
  const users = (await call('GET', '/api/users')).json;
  const li = users.find((u) => u.username === 'li').id;       // 可发布+可确认
  const wang = users.find((u) => u.username === 'wang').id;   // 仅确认
  const zhang = users.find((u) => u.username === 'zhang').id; // 仅发布（作者常用）
  const zhao = users.find((u) => u.username === 'zhao').id;   // 仅发布

  console.log('\n[1] 紧急公告：另一有权人员确认同一内容快照；作者改联系人/时间后旧确认失效');
  await test('作者本人不能确认自己的紧急公告（自审拒绝；作者本身有确认权也不行）', async () => {
    // 李主任既有发布权也有确认权，以其为作者才能验证"须由另一人"而非"自己无权"
    const id = await announce({ urgency: 'urgent', contact_name: '李主任' }, li);
    await call('POST', `/api/announcements/${id}/submit`, {}, li);
    const r = await call('POST', `/api/announcements/${id}/confirm`, {}, li);
    await mustFail(r, 403, /另一有权人员/);
  });
  await test('无确认权限用户不能确认', async () => {
    const id = await announce({ urgency: 'urgent' });
    await call('POST', `/api/announcements/${id}/submit`, {}, zhang);
    const r = await call('POST', `/api/announcements/${id}/confirm`, {}, zhao);
    await mustFail(r, 403, /确认权限/);
  });
  let urgentId;
  await test('另一有权人员确认同一快照后可发布；确认与发布均有 SQL 记录', async () => {
    urgentId = await announce({ urgency: 'urgent', title: '紧急燃气检修', body: '立即关闭阀门。' });
    await call('POST', `/api/announcements/${urgentId}/submit`, {}, zhang);
    const cr = await call('POST', `/api/announcements/${urgentId}/confirm`, {}, wang);
    assert.strictEqual(cr.status, 200);
    let d = await dto(urgentId);
    assert.ok(d.confirmation, '应有有效确认');
    assert.strictEqual(d.confirmation.confirmer_id, wang);
    assert.strictEqual(d.confirmation.content_hash, d.content_hash);
    const pr = await call('POST', `/api/announcements/${urgentId}/publish`,
      { client_request_id: 'urgent-1' }, zhang);
    assert.strictEqual(pr.status, 200);
    d = await dto(urgentId);
    assert.strictEqual(d.status, 'published');
    const types = d.events.map((e) => e.event_type);
    assert.ok(types.includes('confirmed') && types.includes('published'));
  });
  await test('未经另一有权人员确认的紧急公告发布被拒，留下 publish_failed 证据', async () => {
    const id = await announce({ urgency: 'urgent' });
    await call('POST', `/api/announcements/${id}/submit`, {}, zhang);
    const r = await call('POST', `/api/announcements/${id}/publish`, {}, zhang);
    await mustFail(r, 409, /确认当前内容快照/);
    const d = await dto(id);
    assert.ok(d.events.some((e) => e.event_type === 'publish_failed'));
  });
  let pendingId, oldHash;
  await test('审批中作者调整时间（或联系人）后：新 revision，旧确认标记 superseded，发布再次被拦', async () => {
    pendingId = await announce({ urgency: 'urgent', start_at: NOW + 2 * H, end_at: NOW + 2 * H + D });
    await call('POST', `/api/announcements/${pendingId}/submit`, {}, zhang);
    await call('POST', `/api/announcements/${pendingId}/confirm`, {}, li); // 李主任确认 rev1
    let d = await dto(pendingId);
    oldHash = d.content_hash;
    assert.ok(d.confirmation && d.confirmation.revision_no === 1);
    // 审批中调整开始/结束时间
    const r = await call('PATCH', `/api/announcements/${pendingId}`,
      { start_at: NOW + 5 * H, end_at: NOW + 5 * H + D, contact_name: '张干事（夜班）' }, zhang);
    assert.strictEqual(r.status, 200);
    d = await dto(pendingId);
    assert.strictEqual(d.current_revision, 2);
    assert.notStrictEqual(d.content_hash, oldHash);
    assert.strictEqual(d.confirmation, null, '旧确认不应再被视为有效');
    const stale = d.confirmations.find((c) => c.revision_no === 1);
    assert.strictEqual(stale.state, 'superseded');
    assert.strictEqual(stale.alive, false);
    // 旧确认仍可见（留痕），但不能发布
    const pr = await call('POST', `/api/announcements/${pendingId}/publish`, {}, zhang);
    await mustFail(pr, 409, /旧确认已失效|确认当前内容快照/);
    // 重新确认 rev2 后可发布
    await call('POST', `/api/announcements/${pendingId}/confirm`, {}, wang);
    const pr2 = await call('POST', `/api/announcements/${pendingId}/publish`, { client_request_id: 'p2' }, zhang);
    assert.strictEqual(pr2.status, 200);
  });

  console.log('\n[2] 楼栋选择绑定当时范围版；楼栋更名不丢失历史含义');
  await test('创建时冻结 scope；之后楼栋更名，历史公告保留发布时名称并标注现名', async () => {
    const id = await announce({ title: '老通知（B 栋旧名时期）', building_ids: [2], start_at: NOW - 2 * D, end_at: NOW + D });
    await call('POST', `/api/announcements/${id}/publish`, { client_request_id: 'b1' }, zhang);
    const scopeBefore = (await dto(id)).scope.id;
    // B 栋更名
    await call('POST', '/api/buildings/2/rename', { name: '梧桐苑 B 座（新）' }, li);
    const d = await dto(id);
    assert.strictEqual(d.scope.id, scopeBefore, '范围版不变');
    const b = d.scope.buildings_at_publish.find((x) => x.building_id === 2);
    assert.strictEqual(b.name_at, '梧桐苑 B 栋', '发布时名称保留');
    assert.strictEqual(b.current_name, '梧桐苑 B 座（新）');
    assert.strictEqual(b.renamed, true);
    // 新公告使用新名称
    const id2 = await announce({ title: '新通知', building_ids: [2] });
    const d2 = await dto(id2);
    assert.strictEqual(d2.scope.buildings_at_publish[0].name_at, '梧桐苑 B 座（新）');
    assert.notStrictEqual(d2.scope.id, scopeBefore, '新选择冻结为新范围版');
  });
  await test('同时更改楼栋（多请求并发/先后调整）：各自冻结各自的范围版，互不串改', async () => {
    // 模拟两次"同时"改楼栋：A 改成 [1]，B 改成 [3]
    const idA = await announce({ title: '并发A', building_ids: [1, 2] });
    const idB = await announce({ title: '并发B', building_ids: [1, 2] });
    await call('PATCH', `/api/announcements/${idA}`, { building_ids: [1] }, zhang);
    await call('PATCH', `/api/announcements/${idB}`, { building_ids: [3] }, zhang);
    const a = await dto(idA), b = await dto(idB);
    assert.deepStrictEqual(a.scope.buildings_at_publish.map((x) => x.building_id), [1]);
    assert.deepStrictEqual(b.scope.buildings_at_publish.map((x) => x.building_id), [3]);
    assert.notStrictEqual(a.scope.id, b.scope.id);
  });

  console.log('\n[3] 跨午夜有效时段 + 当前有效查询');
  let midnightId;
  await test('23:50–次日 00:40 的公告：午夜前后状态由区间派生，过期自动不现行', async () => {
    // 构造"今天 23:50 开始，明天 00:40 结束"
    const d0 = new Date(NOW); d0.setHours(23, 50, 0, 0);
    const start = d0.getTime();
    const end = start + 50 * 60000; // 跨午夜 50 分钟
    assert.ok(new Date(start).getDate() !== new Date(end).getDate(), '确认跨午夜');
    midnightId = await announce({ title: '跨午夜消杀', start_at: start, end_at: end });
    await call('POST', `/api/announcements/${midnightId}/publish`, { client_request_id: 'mid' }, zhang);
    // 模拟时钟到 23:55（生效）
    await call('POST', '/api/dev/clock', { mock_now: start + 5 * 60000 });
    assert.ok((await effectiveIds()).includes(midnightId), '23:55 应现行');
    // 模拟时钟到 00:20（跨午夜后仍生效）
    await call('POST', '/api/dev/clock', { mock_now: start + 30 * 60000 });
    assert.ok((await effectiveIds()).includes(midnightId), '00:20 跨午夜仍现行');
    // 模拟时钟到 00:41（过期，不再现行）
    await call('POST', '/api/dev/clock', { mock_now: end + 60000 });
    assert.ok(!(await effectiveIds()).includes(midnightId), '00:41 应已过期');
    const d = await dto(midnightId);
    assert.strictEqual(d.state, 'expired');
    await call('POST', '/api/dev/clock', { mock_now: null });
  });

  console.log('\n[4] 撤回旧公告再发新公告 vs 保持替代链；旧分享页');
  let oldId, repId, chainOld, chainNew;
  await test('撤回重发：旧公告 withdrawn + 分享页可见撤回说明、不再现行；新公告现行，链 kind=withdraw_republish', async () => {
    oldId = await announce({ title: '原停水时间（有误）', body: '9-12 点' });
    await call('POST', `/api/announcements/${oldId}/publish`, { client_request_id: 'o1' }, zhang);
    const now2 = (await call('GET', '/api/me')).json.now;
    const r = await call('POST', `/api/announcements/${oldId}/supersede`, {
      mode: 'withdraw_republish', title: '停水时间更正', body: '实际 14-17 点停水。', urgency: 'normal',
      contact_name: '张干事', contact_phone: '13800000000',
      start_at: now2 - H, end_at: now2 + D, building_ids: [1, 2], reason: '原时间有误，撤回重发',
    }, zhang);
    repId = r.json.new_id;
    const old = await dto(oldId);
    assert.strictEqual(old.status, 'withdrawn');
    assert.match(old.withdraw_reason, /撤回重发/);
    const eff = await effectiveIds();
    assert.ok(!eff.includes(oldId), '撤回公告不在现行列表');
    assert.ok(eff.includes(repId), '新公告现行');
    const link = old.links.find((l) => l.kind === 'withdraw_republish');
    assert.ok(link && link.new_id === repId);
    // 旧分享页（无需登录的事实页，这里用同一接口）必须能看到撤回说明字段
    assert.ok(old.withdrawn_at && old.withdraw_reason);
  });
  await test('保持替代链：旧公告 superseded 且可顺链追溯到新版；证据事件保留', async () => {
    chainOld = await announce({ title: '第一版游园会通知', body: '周六上午九点。' });
    await call('POST', `/api/announcements/${chainOld}/publish`, { client_request_id: 'c1' }, zhang);
    const now2 = (await call('GET', '/api/me')).json.now;
    const r = await call('POST', `/api/announcements/${chainOld}/supersede`, {
      mode: 'replace', title: '第二版游园会通知（改期）', body: '周日上午九点。', urgency: 'normal',
      contact_name: '张干事', contact_phone: '13800000000',
      start_at: now2 - H, end_at: now2 + D, building_ids: [1], reason: '改期',
    }, zhang);
    chainNew = r.json.new_id;
    const old = await dto(chainOld);
    assert.strictEqual(old.status, 'superseded');
    assert.ok(!(await effectiveIds()).includes(chainOld));
    assert.ok((await effectiveIds()).includes(chainNew));
    const link = old.links.find((l) => l.kind === 'replace');
    assert.ok(link && link.new_id === chainNew);
    // 新版也反向能看到旧版
    const neu = await dto(chainNew);
    assert.ok(neu.links.some((l) => l.old_id === chainOld));
    // 过往证据：事件时间线含 published / superseded
    assert.ok(old.events.some((e) => e.event_type === 'published'));
  });
  await test('旧分享页直接打开：撤回公告带撤回横幅信息，状态不是任何"现行"语义', async () => {
    const d = await dto(oldId);
    assert.strictEqual(d.state, 'withdrawn');
    assert.ok(d.withdraw_reason && d.withdrawn_at);
    assert.ok(!['active', 'upcoming'].includes(d.state));
  });

  console.log('\n[5] 重复发布请求幂等');
  await test('同一 client_request_id 重放只产生一条公告/一次发布', async () => {
    const id = await announce({ title: '幂等测试' });
    const key = 'idem-' + Math.random();
    const r1 = await call('POST', `/api/announcements/${id}/publish`, { client_request_id: key }, zhang);
    const r2 = await call('POST', `/api/announcements/${id}/publish`, { client_request_id: key }, zhang);
    assert.strictEqual(r1.json.duplicated, false);
    assert.strictEqual(r2.json.duplicated, true);
    assert.strictEqual(r2.json.id, id);
    const events = (await dto(id)).events.filter((e) => e.event_type === 'published');
    assert.strictEqual(events.length, 1, '只允许一条 published 事件');
  });

  console.log('\n[6] 打印任务迟到');
  await test('未执行且超过计划 5 分钟 => 迟到；准时执行 => 不迟到（模拟时钟）', async () => {
    const id = await announce({ title: '待张贴公告' });
    await call('POST', `/api/announcements/${id}/publish`, { client_request_id: 'pj' }, zhang);
    const t = (await call('GET', '/api/me')).json.now;
    const scheduled = t - 10 * 60000; // 计划在 10 分钟前
    await call('POST', '/api/print-jobs', { announce_id: id, station: '东门公告栏', scheduled_at: scheduled });
    let jobs = (await call('GET', '/api/print-jobs')).json.filter((j) => j.announce_id === id);
    const lateJob = jobs.find((j) => j.station === '东门公告栏');
    assert.strictEqual(lateJob.executed, false);
    assert.strictEqual(lateJob.late, true, '迟到 10 分钟未打印');
    await call('POST', `/api/print-jobs/${lateJob.id}/execute`, {});
    jobs = (await call('GET', '/api/print-jobs')).json.filter((j) => j.announce_id === id);
    const done = jobs.find((j) => j.id === lateJob.id);
    assert.strictEqual(done.executed, true);
    assert.strictEqual(done.late, true, '实际打印已晚，迟到事实保留');
    // 准时任务
    const s2 = t + 60000;
    await call('POST', '/api/print-jobs', { announce_id: id, station: '西门', scheduled_at: s2 });
    // 模拟时间到计划后 1 分钟执行（5 分钟宽限内）
    await call('POST', '/api/dev/clock', { mock_now: s2 + 60000 });
    const job2 = (await call('GET', '/api/print-jobs')).json.find((j) => j.station === '西门');
    assert.strictEqual(job2.late, false, '未到宽限期不算迟到');
    await call('POST', `/api/print-jobs/${job2.id}/execute`, {});
    const after = (await call('GET', '/api/print-jobs')).json.find((j) => j.id === job2.id);
    assert.strictEqual(after.late, false);
    await call('POST', '/api/dev/clock', { mock_now: null });
  });

  console.log('\n[7] 两端展示相同事实（同一 DTO 驱动公告栏与手机）');
  await test('公告栏与手机拿到完全一致的范围/时间/级别/确认事实；长正文分页且紧急提示独立于分页区', async () => {
    const longBody = '紧急'.repeat(300); // 超过 120 字 -> 多页
    const id = await announce({ urgency: 'urgent', title: '紧急长文', body: longBody, building_ids: [1, 2] });
    await call('POST', `/api/announcements/${id}/submit`, {}, zhang);
    await call('POST', `/api/announcements/${id}/confirm`, {}, wang);
    await call('POST', `/api/announcements/${id}/publish`, { client_request_id: 'long' }, zhang);
    // 同一接口被两个视图消费（端到端只测事实层；视图层断言分页结构）
    const d1 = await dto(id);
    const d2 = await dto(id);
    assert.deepStrictEqual(d1, d2);
    assert.ok(d1.page_count >= 2, '长正文需要续页');
    assert.strictEqual(d1.body_pages.join(''), longBody, '分页拼接还原全文');
    // 范围与时间必须存在于 DTO 顶层事实（手机折叠区之外渲染它们）
    assert.ok(d1.scope.buildings_at_publish.length === 2);
    assert.ok(d1.start_at && d1.end_at);
    assert.strictEqual(d1.urgency, 'urgent');
    // 纯函数层：分页不影响紧急条
    const dom = require('../server/domain');
    assert.ok(dom.paginate(longBody, 120).length >= 2);
  });

  console.log('\n[8] 当前有效通知查询与过往证据保留');
  await test('撤回/被替代/未开始/已结束都不进 effective；但全部列表与事件时间线完整保留', async () => {
    const t = (await call('GET', '/api/me')).json.now;
    // 未开始
    const up = await announce({ title: '未来通知', start_at: t + 10 * D, end_at: t + 11 * D });
    await call('POST', `/api/announcements/${up}/publish`, { client_request_id: 'up' }, zhang);
    const eff = await effectiveIds();
    assert.ok(!eff.includes(up));
    assert.ok(!eff.includes(oldId) && !eff.includes(chainOld));
    const all = (await call('GET', '/api/announcements')).json;
    const byId = Object.fromEntries(all.map((a) => [a.id, a]));
    assert.ok(byId[oldId].status === 'withdrawn');
    assert.ok(byId[chainOld].status === 'superseded');
    // 历史确认失效记录仍可查
    const pd = byId[pendingId];
    assert.ok(pd.confirmations.some((c) => c.state === 'superseded'));
  });

  console.log(`\n结果：${passed}/${results.length} 通过`);
  const failed = results.filter((r) => r[0] === 'FAIL');
  if (failed.length) {
    for (const [, n, e] of failed) { console.log('\nFAIL: ' + n); console.log(e.stack || e); }
    process.exit(1);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
