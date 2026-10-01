'use strict';
/**
 * 纯领域逻辑（无 DB/HTTP 依赖），手机与公告栏、接口与测试共用同一套事实判定。
 */

const LEVELS = {
  normal: { label: '普通', rank: 0 },
  important: { label: '重要', rank: 1 },
  urgent: { label: '紧急', rank: 2 },
};

const LATE_GRACE_MS = 5 * 60 * 1000; // 计划时间后 5 分钟仍未/才执行 = 迟到

/** 有效状态派生（跨午夜窗口无需定时任务：23:50–00:40 完全由区间比较得出） */
function effectiveState(status, startAt, endAt, now) {
  if (status !== 'published') return status; // draft/pending_confirm/withdrawn/superseded
  if (now < startAt) return 'upcoming';
  if (now >= endAt) return 'expired';
  return 'active';
}

function isValidWindow(startAt, endAt) {
  return Number.isInteger(startAt) && Number.isInteger(endAt) && endAt > startAt;
}

/** 长正文续页：按字符切页（中文友好），紧急提示由前端固定在分页区之外 */
function paginate(body, pageSize) {
  const text = String(body || '');
  if (pageSize <= 0) throw new Error('pageSize must be positive');
  const pages = [];
  for (let i = 0; i < text.length; i += pageSize) pages.push(text.slice(i, i + pageSize));
  if (pages.length === 0) pages.push('');
  return pages;
}

/**
 * 打印迟到判定（纯派生，不存状态）：
 *  - 已执行：实际执行晚于计划 5 分钟以上
 *  - 未执行：当前时间已过计划 5 分钟以上
 */
function printJobState(job, now, grace = LATE_GRACE_MS) {
  if (job.executed_at) {
    return { executed: true, late: job.executed_at > job.scheduled_at + grace };
  }
  return { executed: false, late: now > job.scheduled_at + grace };
}

/** 两个楼栋集合是否相同（用于"同时更改楼栋"冲突/绑定判断） */
function sameBuildingSet(listA, listB) {
  const a = [...listA].map(Number).sort((x, y) => x - y);
  const b = [...listB].map(Number).sort((x, y) => x - y);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 从名称版本中取某时刻的名称；无历史则回退当前名 */
function nameAt(versions, at, fallback) {
  const v = versions.find((x) => at >= x.valid_from && (x.valid_to == null || at < x.valid_to));
  return v ? v.name : fallback;
}

/** 公告确认是否仍然有效：确认者不同、有权、且快照 hash/修订号仍是当前版 */
function confirmationAlive(c, announcement) {
  return c.state === 'valid' &&
    c.content_hash === announcement.content_hash &&
    c.revision_no === announcement.current_revision &&
    c.confirmer_id !== announcement.author_id;
}

module.exports = {
  LEVELS, LATE_GRACE_MS, effectiveState, isValidWindow, paginate,
  printJobState, sameBuildingSet, nameAt, confirmationAlive,
};
