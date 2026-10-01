/* 演示种子：三个角色账号 + 楼栋 + 含撤回/替代/紧急/跨午夜的示例公告。 */
const core = require('../shared/core');

module.exports = async function seed(store) {
  if (store.listUsers().length) return;
  const now = core.nowStamp();

  store.runForSeed('INSERT INTO user (id, username, display_name, role) VALUES (1,?,?,?)',
    ['wang', '王主任', 'admin']);
  store.runForSeed('INSERT INTO user (id, username, display_name, role) VALUES (2,?,?,?)',
    ['chen', '陈干事', 'confirmer']);
  store.runForSeed('INSERT INTO user (id, username, display_name, role) VALUES (3,?,?,?)',
    ['zhao', '赵网格员', 'author']);

  [['A', '1号楼'], ['B', '2号楼'], ['C', '3号楼'], ['D', '4号楼']].forEach(([code, name]) =>
    store.runForSeed('INSERT INTO building (code, name) VALUES (?,?)', [code, name]));

  // 范围版本
  const allScope = store.resolveScopeVersion([1, 2, 3, 4], 1);
  const abScope = store.resolveScopeVersion([1, 2], 1);

  // 1) 常规公告：生效中（1、2号楼）
  store.createAnnouncement({
    title: '秋季消防演练通知',
    body: '本周六下午15:00在1号楼与2号楼之间广场进行消防演练，请各位住户提前关好门窗，配合工作人员疏散。\n演练内容包括灭火器使用、浓烟逃生与集合点名，全程约90分钟。\n演练期间广场临时封闭，电动车请停放到北侧车棚。',
    contact_name: '物业前台', contact_phone: '0571-88880001',
    urgency: 'normal', building_ids: [1, 2],
    starts_at: core.addMinutes(now, -60), ends_at: core.addMinutes(now, 60 * 26)
  }, 1, 'seed-fire-drill');
  const drill = store.listAnnouncements()[0];
  store.publishAnnouncement(drill.id, 1, 'seed-fire-drill');

  // 2) 紧急公告：跨午夜停水，需要双人确认（已确认）
  store.createAnnouncement({
    title: '紧急停水：供水管线抢修',
    body: '因市政主管线突发渗漏，今晚23:00至次日凌晨4:00停水，影响期间请提前储备生活用水。\n抢修完成后将逐单元排气，恢复供水初期可能出现短时浑浊，放水片刻即可。\n给您带来不便深表歉意，24小时抢修电话见下方联系人。',
    contact_name: '水务抢修班', contact_phone: '96055',
    urgency: 'urgent', building_ids: [1, 2, 3, 4],
    starts_at: core.addMinutes(now, -30), ends_at: core.addMinutes(now, 60 * 3)
  }, 3, 'seed-water');
  const water = store.listAnnouncements()[0];
  store.submitForConfirmation(water.id, 3);
  store.confirmAnnouncement(water.id, 2, 'confirmed', '已核实抢修工单');
  store.publishAnnouncement(water.id, 3, 'seed-water');
  // 配一个打印任务（已按时打印）
  store.createPrintTask(water.id, core.addMinutes(now, -10), 1, '大堂公告栏');
  const pt = store.listPrintTasks()[0];
  store.markPrinted(pt.id, 1);

  // 3) 一条旧公告：已撤回，重发为新链 —— 分享页应显示撤回说明
  store.createAnnouncement({
    title: '国庆花坛摆放位置（初版）',
    body: '初版方案为东门入口。后因施工占道，本公告撤回，改以新公告发布最终位置。',
    contact_name: '居委会', contact_phone: '0571-88880002',
    urgency: 'info', building_ids: [1, 2, 3, 4],
    starts_at: core.addMinutes(now, -60 * 48), ends_at: core.addMinutes(now, -60 * 24)
  }, 1, 'seed-flower-old');
  const oldFlower = store.listAnnouncements()[0];
  store.publishAnnouncement(oldFlower.id, 1, 'seed-flower-old');

  const re = store.withdrawAndReissue(oldFlower.id, {
    title: '国庆花坛摆放位置（最终版）',
    body: '花坛最终确定摆放于中心花园圆形广场两侧，节日期间欢迎住户前往观赏，请看护好儿童勿攀爬花坛。',
    starts_at: core.addMinutes(now, -60 * 2), ends_at: core.addMinutes(now, 60 * 72),
    reason: '东门施工占道，移至中心花园'
  }, 1, 'seed-flower-new');

  // 4) 替代链演示：同链上 v1 被 v2 替代（v1 已过窗口，仍可替代）
  // 直接做一条发布后替代
  store.createAnnouncement({
    title: '垃圾分类督导时间表 v1',
    body: '督导时间：每日18:00-20:00。',
    contact_name: '环卫站', contact_phone: '0571-88880003',
    urgency: 'normal', building_ids: [3, 4],
    starts_at: core.addMinutes(now, -60 * 200), ends_at: core.addMinutes(now, 60 * 200)
  }, 3, 'seed-garbage-v1');
  const v1 = store.listAnnouncements()[0];
  store.publishAnnouncement(v1.id, 3, 'seed-garbage-v1');
  store.supersedeAnnouncement(v1.id, {
    title: '垃圾分类督导时间表 v2（延长时段）',
    body: '督导时间调整为每日17:30-20:30，节假日照常，感谢配合。',
    starts_at: core.addMinutes(now, -60), ends_at: core.addMinutes(now, 60 * 200),
    reason: '居民建议延长半小时'
  }, 3, 'seed-garbage-v2');
};
