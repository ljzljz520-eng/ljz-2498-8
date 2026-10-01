/* =====================================================================
 * 社区公告排版台 —— 前后端共享领域核心
 * 服务端 Node 直接 require；浏览器由 /shared/core.js 以普通脚本引入，
 * 挂到 window.BulletinCore。两端对"当前状态/快照哈希/续页"算法完全一致，
 * 因此公告栏视图、手机视图、分享页必然展示相同事实。
 * ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BulletinCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 时间 ----------
  // 库内统一使用本地无时区字符串 'YYYY-MM-DD HH:MM:SS'，字典序即可比较；
  // 跨午夜场景天然支持（end 是次日凌晨时字符串仍然更大）。
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function toStamp(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function nowStamp(refNow) {
    return toStamp(new Date(refNow || Date.now()));
  }

  function addMinutes(stamp, minutes) {
    var parts = stamp.split(/[- :]/).map(Number);
    var d = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5] || 0);
    d.setMinutes(d.getMinutes() + minutes);
    return toStamp(d);
  }

  function addDays(stamp, days) { return addMinutes(stamp, days * 24 * 60); }

  // 'YYYY-MM-DDTHH:MM' (datetime-local) -> 'YYYY-MM-DD HH:MM:SS'
  function fromInput(v) {
    if (!v) return v;
    if (v.length === 16) return v.replace('T', ' ') + ':00';
    return v.replace('T', ' ');
  }
  // -> datetime-local
  function toInput(stamp) {
    return stamp && stamp.length >= 16 ? stamp.slice(0, 16).replace(' ', 'T') : stamp;
  }

  function formatDateTime(stamp) {
    if (!stamp) return '—';
    var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(stamp);
    if (!m) return stamp;
    return m[1] + '年' + Number(m[2]) + '月' + Number(m[3]) + '日 ' + m[4] + ':' + m[5];
  }

  // 是否跨午夜（起止不在同一自然日）
  function crossesMidnight(startsAt, endsAt) {
    return startsAt && endsAt && startsAt.slice(0, 10) !== endsAt.slice(0, 10);
  }

  function isEffectiveAt(a, nowStamp) {
    var now = nowStamp || nowStampNow();
    return a.status === 'published' && a.starts_at <= now && now < a.ends_at;
  }
  // 别名，内部用 nowStamp
  function nowStampNow() { return toStamp(new Date()); }

  // 展示态（库内持久化 status 不被改写，避免写入竞态）
  // published 按时窗细分为 scheduled/active/expired；其余沿用持久状态。
  function presentationStatus(a, nowStamp) {
    var now = nowStamp || nowStampNow();
    switch (a.status) {
      case 'published':
        if (now < a.starts_at) return 'scheduled';
        if (now >= a.ends_at) return 'expired';
        return 'active';
      default:
        return a.status; // draft / pending / superseded / withdrawn / cancelled
    }
  }

  var STATUS_TEXT = {
    draft: '草稿', pending: '待紧急确认', published: '已发布',
    scheduled: '未到开始时间', active: '生效中', expired: '已过结束时间',
    superseded: '已被替代', withdrawn: '已撤回', cancelled: '已取消'
  };

  var URGENCY = {
    info:   { text: '知会', rank: 0, cls: 'urg-info' },
    normal: { text: '常规', rank: 1, cls: 'urg-normal' },
    urgent: { text: '紧急', rank: 2, cls: 'urg-urgent' }
  };

  // ---------- 内容快照与哈希 ----------
  // 快照字段 = 所有影响公告含义、且需要被紧急确认覆盖的字段。
  // scope_version_id 入哈希：审批中改楼栋（换新范围版）→ 旧确认失效。
  function snapshotOf(a) {
    return {
      title: (a.title || '').trim(),
      body: a.body || '',
      contact_name: a.contact_name || '',
      contact_phone: a.contact_phone || '',
      urgency: a.urgency || 'normal',
      scope_version_id: a.scope_version_id,
      starts_at: a.starts_at,
      ends_at: a.ends_at
    };
  }
  function canonicalJson(a) { return JSON.stringify(snapshotOf(a)); }

  // cyrb53：纯 JS、Node 与浏览器结果一致的 64 位哈希，输出 16 位 hex。
  // 仅用于"快照是否被改动"的比对，非安全用途；完整快照另存 confirmation.snapshot_json。
  function cyrb53(str, seed) {
    var h1 = 0xdeadbeef ^ (seed || 0), h2 = 0x41c6ce57 ^ (seed || 0);
    for (var i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
  }
  function contentHash(a) { return cyrb53(canonicalJson(a)); }

  // 紧急公告确认是否仍有效：存在 decision=confirmed 且哈希、范围版都与当前一致
  function validConfirmation(a, confirmations) {
    if (!confirmations || !confirmations.length) return null;
    var h = contentHash(a);
    for (var i = confirmations.length - 1; i >= 0; i--) {
      var c = confirmations[i];
      if (c.decision === 'confirmed' &&
          c.content_hash === h &&
          c.scope_version_id === a.scope_version_id) return c;
    }
    return null;
  }

  // ---------- 长正文续页 ----------
  // 按段落贪心装页；单段超长则按字符硬切（对 CJK 友好，不按英文单词断）。
  // 返回 [{ paragraphs:[...], continuedFrom, continuedTo }]。
  // 关键：分页只切正文；影响范围 / 开始结束时间 / 紧急级别由视图层
  // 渲染在每页固定头部，绝不随折叠或翻页消失（见 CSS 与模板）。
  function paginateBody(body, pageChars) {
    pageChars = pageChars || 220;
    var paras = String(body || '').split(/\n+/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
    var hard = [];
    paras.forEach(function (p) {
      if (p.length <= pageChars) { hard.push(p); return; }
      for (var i = 0; i < p.length; i += pageChars) hard.push(p.slice(i, i + pageChars));
    });
    var pages = [[]];
    var used = 0;
    hard.forEach(function (p) {
      if (used > 0 && used + p.length + 2 > pageChars) { pages.push([]); used = 0; }
      pages[pages.length - 1].push(p);
      used += p.length + 2;
    });
    var out = pages.map(function (list, idx) {
      return {
        paragraphs: list,
        pageNo: idx + 1,
        pageCount: pages.length,
        continuedFrom: idx > 0,
        continuedTo: idx < pages.length - 1
      };
    });
    return out.length && out[0].paragraphs.length ? out :
      [{ paragraphs: [''], pageNo: 1, pageCount: 1, continuedFrom: false, continuedTo: false }];
  }

  // 打印任务是否迟到（到了 due_at 仍未打印即迟到；验收可注入 now）
  function printTaskState(task, nowStamp) {
    var now = nowStamp || nowStampNow();
    if (task.status === 'printed') return 'printed';
    if (task.status === 'cancelled') return 'cancelled';
    if (task.due_at <= now) return 'late';
    return 'queued';
  }

  return {
    pad: pad, toStamp: toStamp, nowStamp: nowStamp, addMinutes: addMinutes, addDays: addDays,
    fromInput: fromInput, toInput: toInput, formatDateTime: formatDateTime,
    crossesMidnight: crossesMidnight, isEffectiveAt: isEffectiveAt,
    presentationStatus: presentationStatus, STATUS_TEXT: STATUS_TEXT, URGENCY: URGENCY,
    snapshotOf: snapshotOf, canonicalJson: canonicalJson, cyrb53: cyrb53,
    contentHash: contentHash, validConfirmation: validConfirmation,
    paginateBody: paginateBody, printTaskState: printTaskState
  };
});
