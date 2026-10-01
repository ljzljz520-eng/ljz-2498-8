'use strict';
/* 社区公告排版台前端（Vue 3 global build，无打包步骤） */
const { createApp, reactive, computed, onMounted, watch, h } = Vue;

/* ---------- 工具 ---------- */
const api = async (method, url, body, headers = {}) => {
  const opt = { method, headers: { 'Content-Type': 'application/json',
    'X-User-Id': String(window.__uid || 1), ...headers } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(url, opt);
  const data = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
  return data;
};
const pad = (n) => String(n).padStart(2, '0');
function fmt(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function toLocalInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromInput = (v) => v ? new Date(v).getTime() : NaN;
const LEVELS = [
  { v: 'normal', label: '普通' }, { v: 'important', label: '重要' }, { v: 'urgent', label: '紧急' },
];

/* ============================================================
 * 公告栏布局组件：长正文续页时，紧急提示不随正文丢失（固定在正文区下方）
 * ============================================================ */
const BoardView = {
  props: ['a'],
  template: `
  <div class="board">
    <div class="board-list">
      <div class="board-note" :class="a.urgency">
        <span class="pill" :class="a.urgency">{{ a.urgency_label }}</span>
        <div class="bn-title">{{ a.title }}</div>
        <div class="board-meta">
          <div><b>影响范围：</b><span v-for="b in a.scope.buildings_at_publish" :key="b.building_id">
            <span class="tag" :class="{renamed:b.renamed}">{{ b.name_at_publish || b.name_at }}<span v-if="b.renamed">（现 {{b.current_name}}）</span></span>
          </span></div>
          <div><b>开始：</b>{{ fmt(a.start_at) }}　<b>结束：</b>{{ fmt(a.end_at) }}</div>
          <div><b>联系人：</b>{{ a.contact.name }} {{ a.contact.phone }}</div>
        </div>
        <div class="board-body">{{ pageText }}</div>
        <div v-if="hasMore" class="board-continue">
          ⚠ 紧急提示：本公告续第 {{ page + 1 }}/{{ a.page_count }} 页，请继续阅读完整内容（时间与范围以上方信息为准）
        </div>
        <div class="p-pager" v-if="a.page_count>1" style="display:flex;justify-content:space-between">
          <button :disabled="page===0" @click="page--">上一页</button>
          <span class="muted">{{ page+1 }} / {{ a.page_count }}</span>
          <button :disabled="page===a.page_count-1" @click="page++">下一页</button>
        </div>
      </div>
    </div>
  </div>`,
  setup(props) {
    const page = Vue.ref(0);
    Vue.watch(() => props.a.id, () => (page.value = 0));
    const pageText = computed(() => props.a.body_pages[page.value] || '');
    const hasMore = computed(() => page.value < props.a.body_pages.length - 1);
    return { page, pageText, hasMore, fmt };
  },
};

/* ============================================================
 * 手机布局：折叠/滚动不得藏掉影响范围与开始结束时间；
 * 续页时紧急提示保持可见（正文在独立滚动区，紧急条 sticky 在其外/底部）
 * ============================================================ */
const PhoneView = {
  props: ['a'],
  template: `
  <div class="phone">
    <div class="p-status"><span>9:41</span><span>社区通知</span><span>📶 100%</span></div>
    <div class="p-head">
      <div class="t"><span class="pill" :class="a.urgency">{{ a.urgency_label }}</span> {{ a.title }}</div>
    </div>
    <!-- 关键事实独立于折叠/滚动区域，永远可见 -->
    <div class="p-scope">
      <div class="line"><span class="k">📍影响范围</span>
        <span class="v"><span v-for="b in a.scope.buildings_at_publish" :key="b.building_id">
          {{ b.name_at_publish || b.name_at }}<span v-if="b.renamed" class="muted">（现{{b.current_name}}）</span>；
        </span></span></div>
      <div class="line"><span class="k">🕒开始</span><span class="v">{{ fmt(a.start_at) }}</span></div>
      <div class="line"><span class="k">⏰结束</span><span class="v">{{ fmt(a.end_at) }}</span></div>
    </div>
    <!-- 正文续页：唯一可滚动/折叠的区域 -->
    <div class="p-page" ref="pageEl">{{ currentPage }}</div>
    <!-- 紧急提示在滚动区之外，续页时始终可见 -->
    <div v-if="a.urgency==='urgent'" class="p-urgentbar">🚨 紧急公告 · 请立即查看并相互转告</div>
    <div class="p-pager">
      <button :disabled="page===0" @click="flip(-1)">上一页</button>
      <span>第 {{ page+1 }}/{{ a.page_count }} 页</span>
      <button :disabled="page===a.page_count-1" @click="flip(1)">下一页</button>
    </div>
    <div class="p-contact">联系人：{{ a.contact.name }} {{ a.contact.phone }}　编号 {{ a.code }}</div>
  </div>`,
  setup(props) {
    const page = Vue.ref(0);
    const pageEl = Vue.ref(null);
    Vue.watch(() => props.a.id, () => { page.value = 0; });
    const currentPage = computed(() => props.a.body_pages[page.value] || '');
    function flip(d) { page.value = Math.min(Math.max(0, page.value + d), props.a.body_pages.length - 1); }
    Vue.watch(page, () => { if (pageEl.value) pageEl.value.scrollTop = 0; });
    return { page, pageEl, currentPage, flip, fmt };
  },
};

/* ============================================================
 * 排版台（后台编辑 + 两种布局实时预览）
 * ============================================================ */
const Editor = {
  props: ['ctx'],
  components: { BoardView, PhoneView },
  template: `
  <div class="card">
    <h2>排版台 · 新建公告（后台管理楼栋范围 / 有效时段 / 紧急级别）</h2>
    <div class="stage">
      <div class="editor-pane">
        <label>标题</label><input v-model="f.title" placeholder="如：B 栋供水管抢修通知">
        <label>正文（长文本会自动续页）</label><textarea v-model="f.body" rows="7"></textarea>
        <div class="row">
          <div><label>紧急级别</label>
            <select v-model="f.urgency"><option v-for="l in levels" :key="l.v" :value="l.v">{{l.label}}</option></select></div>
          <div><label>联系人</label><input v-model="f.contact_name"></div>
          <div><label>联系电话</label><input v-model="f.contact_phone"></div>
        </div>
        <div class="row">
          <div><label>开始时间</label><input type="datetime-local" v-model="f.startInput"></div>
          <div><label>结束时间（可跨午夜）</label><input type="datetime-local" v-model="f.endInput"></div>
        </div>
        <label>影响楼栋（选择将冻结为新的"当时范围版"，之后楼栋更名不改变历史含义）</label>
        <div class="checks">
          <label v-for="b in ctx.buildings" :key="b.id">
            <input type="checkbox" :value="b.id" v-model="f.building_ids"> {{b.current_name}}（{{b.code}}）
          </label>
        </div>
        <div class="err" v-if="ctx.err">{{ ctx.err }}</div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" @click="saveDraft">存草稿</button>
          <button class="btn ghost" @click="submitUrgent" v-if="f.urgency==='urgent'">提交紧急确认</button>
          <button class="btn ghost" @click="directPublish" v-if="f.urgency!=='urgent'">直接发布</button>
          <button class="btn ghost" :disabled="!f.urgent" @click="publishUrgent">紧急发布（需他人确认）</button>
        </div>
        <p class="muted" v-if="f.urgent">
          紧急公告须由<b>另一名有确认权限</b>的用户确认同一内容快照；发布前若您修改联系人或时间，
          旧确认将立即失效，需要重新确认。
        </p>
      </div>
      <div class="previews">
        <div class="preview-col">
          <h3>📌 公告栏布局</h3>
          <board-view :a="preview"></board-view>
        </div>
        <div class="preview-col">
          <h3>📱 手机布局</h3>
          <phone-view :a="preview"></phone-view>
        </div>
      </div>
    </div>
  </div>`,
  setup(props) {
    const t = props.ctx.now;
    const f = reactive({
      title: '', body: '', urgency: 'normal',
      contact_name: props.ctx.user.display_name, contact_phone: '13800000000',
      startInput: toLocalInput(t + 3600000), endInput: toLocalInput(t + 3 * 86400000),
      building_ids: props.ctx.buildings.map((b) => b.id),
    });
    const savedId = Vue.ref(null);
    const levels = LEVELS;

    const preview = computed(() => ({
      id: savedId.value || 'preview', code: 'GG-DRAFT',
      urgency: f.urgency, urgency_label: LEVELS.find((x) => x.v === f.urgency).label,
      title: f.title || '（标题预览）', body: f.body || '（正文预览）',
      body_pages: (function () {
        const text = f.body || '（正文预览）'; const size = 120; const out = [];
        for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
        return out.length ? out : [''];
      })(),
      page_count: Math.max(1, Math.ceil((f.body || '（正文预览）').length / 120)),
      contact: { name: f.contact_name || '—', phone: f.contact_phone || '—' },
      start_at: fromInput(f.startInput), end_at: fromInput(f.endInput),
      scope: {
        id: 0,
        buildings_at_publish: props.ctx.buildings.filter((b) => f.building_ids.includes(b.id))
          .map((b) => ({ building_id: b.id, name_at: b.current_name, current_name: b.current_name, renamed: false })),
      },
    }));

    async function saveDraft() {
      props.ctx.err = '';
      const payload = buildPayload();
      const r = await api('POST', '/api/announcements', payload);
      savedId.value = r.id;
      await props.ctx.refresh();
      props.ctx.toast = '草稿已保存 #' + r.id;
    }
    function buildPayload() {
      return {
        title: f.title, body: f.body, urgency: f.urgency,
        contact_name: f.contact_name, contact_phone: f.contact_phone,
        start_at: fromInput(f.startInput), end_at: fromInput(f.endInput),
        building_ids: f.building_ids,
      };
    }
    async function directPublish() {
      props.ctx.err = '';
      try {
        const r = await api('POST', '/api/announcements', buildPayload());
        await api('POST', `/api/announcements/${r.id}/publish`, { client_request_id: cryptoId() });
        await props.ctx.refresh();
        props.ctx.toast = '已发布 #' + r.id;
      } catch (e) { props.ctx.err = e.message; }
    }
    async function submitUrgent() {
      props.ctx.err = '';
      try {
        const r = await api('POST', '/api/announcements', buildPayload());
        await api('POST', `/api/announcements/${r.id}/submit`, {});
        await props.ctx.refresh();
        props.ctx.toast = '紧急公告已提交确认 #' + r.id;
      } catch (e) { props.ctx.err = e.message; }
    }
    async function publishUrgent() {
      props.ctx.err = '';
      if (!savedId.value) return (props.ctx.err = '请先"存草稿/提交紧急确认"，再由另一有权用户确认后发布');
      try {
        await api('POST', `/api/announcements/${savedId.value}/publish`, { client_request_id: cryptoId() });
        await props.ctx.refresh();
        props.ctx.toast = '紧急公告已发布 #' + savedId.value;
      } catch (e) { props.ctx.err = e.message; }
    }
    function cryptoId() { return 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }
    return { f, levels, preview, saveDraft, directPublish, submitUrgent, publishUrgent };
  },
};

/* ============================================================
 * 公告列表 + 审批操作
 * ============================================================ */
const ListView = {
  props: ['ctx'],
  components: { BoardView, PhoneView },
  template: `
  <div class="card">
    <h2>公告管理（当前有效 {{ ctx.effective.length }} 条 · 全部 {{ ctx.all.length }} 条）</h2>
    <div class="row" style="margin-bottom:10px">
      <div><label>按楼栋筛选（现行公告）</label>
        <select @change="filterBuilding=$event.target.value"><option value="">全部楼栋</option>
          <option v-for="b in ctx.buildings" :key="b.id" :value="b.id">{{b.current_name}}</option></select></div>
      <div><label>级别</label><select v-model="filterUrgency">
        <option value="">全部</option><option v-for="l in levels" :key="l.v" :value="l.v">{{l.label}}</option></select></div>
    </div>
    <h3>🕗 当前有效通知</h3>
    <p class="muted" v-if="!filtered.length">当前时段没有现行公告（撤回 / 被替代 / 未开始 / 已结束均不出现）。</p>
    <div v-for="a in filtered" :key="a.id" style="margin-bottom:14px;border-bottom:1px dashed var(--line);padding-bottom:12px">
      <div class="kv"><b>{{a.code}}</b>
        <span class="pill" :class="a.urgency">{{a.urgency_label}}</span>
        <span class="tag">{{ stateLabel(a.state) }}</span>
        <a class="backlink" @click="open(a)">查看/分享</a>
      </div>
      <div class="kv"><b>标题</b>{{a.title}}</div>
      <div class="kv"><b>范围</b><span v-for="b in a.scope.buildings_at_publish" :key="b.building_id">
        <span class="tag" :class="{renamed:b.renamed}">{{b.name_at_publish||b.name_at}}<template v-if="b.renamed">（现{{b.current_name}}）</template></span></span></div>
      <div class="kv"><b>有效时段</b>{{fmt(a.start_at)}} → {{fmt(a.end_at)}}
        <span v-if="crossMidnight(a)" class="tag">跨午夜</span></div>
    </div>

    <h3 style="margin-top:18px">全部公告（含草稿/审批中/撤回/已替代/过往证据）</h3>
    <table>
      <thead><tr><th>编号</th><th>标题</th><th>级别</th><th>状态</th><th>范围版</th><th>有效时段</th><th>确认</th><th>操作</th></tr></thead>
      <tbody><tr v-for="a in ctx.all" :key="a.id">
        <td>{{a.code}}<div class="muted">rev.{{a.current_revision}}</div></td>
        <td>{{a.title}}</td>
        <td><span class="pill" :class="a.urgency">{{a.urgency_label}}</span></td>
        <td>{{ stateLabel(a.state) }}<div v-if="a.withdrawn_at" class="muted">撤回于 {{fmt(a.withdrawn_at)}}</div></td>
        <td>#{{a.scope.id}}<div class="muted">{{a.scope.label}}</div></td>
        <td>{{fmt(a.start_at)}}<br>→ {{fmt(a.end_at)}}</td>
        <td>
          <span v-if="!a.confirmation_required" class="muted">无需确认</span>
          <span v-else-if="a.confirmation" class="ok">✓ {{a.confirmation.confirmer_name}} 已确认 rev{{a.confirmation.revision_no}}</span>
          <span v-else class="late">待确认</span>
          <div v-for="c in a.confirmations.filter(x=>x.state==='superseded')" :key="c.id" class="muted">
            ⌀ {{c.confirmer_name}} 对 rev{{c.revision_no}} 的确认已失效
          </div>
        </td>
        <td>
          <button class="btn mini" @click="open(a)">打开</button>
          <button v-if="canEdit(a)" class="btn mini ghost" @click="edit(a)">改稿</button>
          <button v-if="a.status==='draft'&&a.urgency==='urgent'&&isAuthor(a)" class="btn mini ghost" @click="submit(a)">提交确认</button>
          <button v-if="a.status==='pending_confirm'" class="btn mini ghost" :disabled="!ctx.user.can_confirm||isAuthor(a)" @click="confirm(a)">
            另一有权人确认
          </button>
          <button v-if="canPublish(a)" class="btn mini" @click="publish(a)">发布</button>
          <button v-if="a.status==='published'" class="btn mini ghost" @click="withdraw(a)">撤回</button>
          <button v-if="a.status==='published'" class="btn mini ghost" @click="open(a,true)">替代/重发</button>
        </td>
      </tr></tbody>
    </table>

    <!-- 改稿弹层 -->
    <div v-if="editing" class="card" style="position:fixed;inset:40px;z-index:50;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,.3)">
      <h2>改稿 #{{editing.code}} <button class="btn mini ghost" @click="editing=null">关闭</button></h2>
      <p class="muted">发布前修改联系人/时间/正文/级别/范围都会产生新快照；若已有确认，旧确认将失效。</p>
      <label>标题</label><input v-model="ef.title">
      <label>正文</label><textarea v-model="ef.body"></textarea>
      <div class="row">
        <div><label>级别</label><select v-model="ef.urgency"><option v-for="l in levels" :key="l.v" :value="l.v">{{l.label}}</option></select></div>
        <div><label>联系人</label><input v-model="ef.contact_name"></div>
        <div><label>电话</label><input v-model="ef.contact_phone"></div>
      </div>
      <div class="row">
        <div><label>开始</label><input type="datetime-local" v-model="ef.startInput"></div>
        <div><label>结束</label><input type="datetime-local" v-model="ef.endInput"></div>
      </div>
      <label>影响楼栋（勾选调整将冻结新的范围版）</label>
      <div class="checks">
        <label v-for="b in ctx.buildings" :key="b.id"><input type="checkbox" :value="b.id" v-model="ef.building_ids">{{b.current_name}}</label>
      </div>
      <div class="err" v-if="ctx.err">{{ctx.err}}</div>
      <p style="margin-top:10px"><button class="btn" @click="saveEdit">保存修改（旧确认随之失效）</button></p>
    </div>
  </div>`,
  setup(props) {
    const filterBuilding = Vue.ref('');
    const filterUrgency = Vue.ref('');
    const editing = Vue.ref(null);
    const ef = reactive({});
    const levels = LEVELS;
    const fmt = fmt;
    const filtered = computed(() => {
      let list = props.ctx.effective;
      if (filterBuilding.value) {
        const bid = Number(filterBuilding.value);
        list = list.filter((a) => a.scope.buildings_at_publish.some((b) => b.building_id === bid));
      }
      if (filterUrgency.value) list = list.filter((a) => a.urgency === filterUrgency.value);
      return list;
    });
    function stateLabel(s) {
      return { draft: '草稿', pending_confirm: '审批中', published: '已发布', active: '生效中',
        upcoming: '未开始', expired: '已结束', withdrawn: '已撤回', superseded: '已被替代' }[s] || s;
    }
    function isAuthor(a) { return a.author_id === props.ctx.user.id; }
    function canEdit(a) { return (a.status === 'draft' || a.status === 'pending_confirm') && isAuthor(a); }
    function canPublish(a) {
      if (a.status === 'draft' && a.urgency !== 'urgent') return true;
      if (a.status === 'pending_confirm' && a.confirmation) return true;
      return false;
    }
    function crossMidnight(a) { return new Date(a.start_at).getDate() !== new Date(a.end_at).getDate(); }
    function open(a, replaceMode) {
      location.hash = '#/notice/' + a.id + (replaceMode ? '?mode=replace' : '');
    }
    function edit(a) {
      editing.value = a;
      Object.assign(ef, {
        title: a.title, body: a.body, urgency: a.urgency,
        contact_name: a.contact.name, contact_phone: a.contact.phone,
        startInput: toLocalInput(a.start_at), endInput: toLocalInput(a.end_at),
        building_ids: a.scope.buildings_at_publish.map((b) => b.building_id),
      });
    }
    async function saveEdit() {
      props.ctx.err = '';
      try {
        await api('PATCH', `/api/announcements/${editing.value.id}`, {
          title: ef.title, body: ef.body, urgency: ef.urgency,
          contact_name: ef.contact_name, contact_phone: ef.contact_phone,
          start_at: fromInput(ef.startInput), end_at: fromInput(ef.endInput),
          building_ids: ef.building_ids,
        });
        editing.value = null;
        await props.ctx.refresh();
        props.ctx.toast = '已生成新快照，旧确认（如有）已失效';
      } catch (e) { props.ctx.err = e.message; }
    }
    async function submit(a) {
      await api('POST', `/api/announcements/${a.id}/submit`, {});
      await props.ctx.refresh();
    }
    async function confirm(a) {
      props.ctx.err = '';
      try { await api('POST', `/api/announcements/${a.id}/confirm`, {}); await props.ctx.refresh(); }
      catch (e) { props.ctx.err = e.message; }
    }
    async function publish(a) {
      props.ctx.err = '';
      try {
        await api('POST', `/api/announcements/${a.id}/publish`, { client_request_id: 'req-pub-' + a.id + '-' + Date.now() });
        await props.ctx.refresh();
      } catch (e) { props.ctx.err = e.message; }
    }
    async function withdraw(a) {
      const reason = prompt('撤回原因（将显示在旧分享页）：', '内容有误，撤回处理');
      if (reason === null) return;
      await api('POST', `/api/announcements/${a.id}/withdraw`, { reason });
      await props.ctx.refresh();
    }
    return { filtered, filterBuilding, filterUrgency, editing, ef, levels, fmt, stateLabel,
      isAuthor, canEdit, canPublish, crossMidnight, open, edit, saveEdit, submit, confirm, publish, withdraw };
  },
};

/* ============================================================
 * 公告详情 / 分享页（两端展示相同事实；撤回后显示撤回说明）
 * 支持 ?mode=replace 发起替代或撤回重发
 * ============================================================ */
const NoticePage = {
  props: ['ctx', 'id', 'query'],
  components: { BoardView, PhoneView },
  template: `
  <div v-if="a" class="wrap" style="max-width:980px">
    <p><a class="backlink" @click="location.hash='#/'">← 返回排版台</a>　
       <span class="muted">分享链接：</span><code>{{ shareUrl }}</code>
       <button class="btn mini ghost" @click="copy">复制</button></p>

    <div v-if="a.state==='withdrawn'" class="withdraw-banner">
      本公告已于 {{fmt(a.withdrawn_at)}} 撤回：{{a.withdraw_reason||'不再作为现行公告执行'}}
      <div class="muted" style="font-weight:400;color:#8a1c12;margin-top:4px">
        以下内容仅作为历史证据保留，不再表现为现行公告。</div>
    </div>
    <div v-if="a.state==='superseded'" class="superseded-banner">
      本公告已被新版本替代（替代链可追溯），以下为历史快照。
    </div>

    <div class="stage" style="margin-top:10px">
      <div class="preview-col"><h3>公告栏</h3><board-view :a="a"></board-view></div>
      <div class="preview-col"><h3>手机</h3><phone-view :a="a"></phone-view></div>
    </div>

    <div class="card">
      <h2>事实与证据（两种处置对比）</h2>
      <div class="kv"><b>状态</b>{{stateLabel(a.state)}}（两端一致）</div>
      <div class="kv"><b>绑定范围版</b>#{{a.scope.id}} {{a.scope.label}}
        —— 发布后冻结；楼栋更名不改变其历史含义</div>
      <div class="kv"><b>范围名称</b>
        <span v-for="b in a.scope.buildings_at_publish" :key="b.building_id">
          <span class="tag" :class="{renamed:b.renamed}">{{b.name_at_publish||b.name_at}}
            <template v-if="b.renamed">（发布时名称；现名 {{b.current_name}}）</template></span></span></div>
      <div class="kv"><b>当前快照</b>rev.{{a.current_revision}} <code class="muted">{{a.content_hash.slice(0,12)}}</code></div>
      <div class="kv" v-if="a.confirmation_required"><b>紧急确认</b>
        <template v-if="a.confirmation">✓ {{a.confirmation.confirmer_name}} 确认 rev{{a.confirmation.revision_no}}</template>
        <template v-else><span class="late">缺少与当前快照匹配的有效确认</span></template>
        <div v-for="c in a.confirmations" :key="c.id" class="muted">
          · {{c.confirmer_name}} 对 rev{{c.revision_no}} 的确认：
          <b :class="c.alive?'ok':'late'">{{c.alive?'有效':'已失效（快照已变更）'}}</b>
        </div>
      </div>
      <h3 style="margin-top:14px">替代链</h3>
      <p v-if="!a.links.length" class="muted">无替代记录。</p>
      <div v-for="l in a.links" :key="l.id" class="kv">
        {{l.kind==='replace'?'🔗 保持替代链':'↩️ 撤回旧公告再发新公告'}}：
        <a class="backlink" @click="location.hash='#/notice/'+l.old_id">{{l.old_code}}</a>
        → <a class="backlink" @click="location.hash='#/notice/'+l.new_id">{{l.new_code}}</a>
        <span class="muted">{{l.reason||''}}</span>
      </div>
      <h3>事件时间线（SQL 留痕）</h3>
      <ul class="timeline">
        <li v-for="e in a.events" :key="e.id">
          {{eventLabel(e.event_type)}} <span class="when">{{fmt(e.created_at)}} · {{e.actor_name||'系统'}}</span>
          <div v-if="e.detail" class="muted">{{e.detail}}</div>
        </li>
      </ul>

      <div v-if="a.status==='published'" style="margin-top:14px">
        <h3>处置本公告</h3>
        <div class="row">
          <button class="btn ghost" @click="mode='replace'">保持替代链（新版生效，旧版留痕可追溯）</button>
          <button class="btn ghost" @click="mode='withdraw_republish'">撤回旧公告再发新公告（旧分享页显示撤回说明）</button>
          <button class="btn" @click="doWithdraw">仅撤回</button>
        </div>
      </div>
    </div>

    <!-- 替代/重发表单 -->
    <div v-if="mode&&a.status==='published'" class="card">
      <h2>{{mode==='replace'?'保持替代链 · 新建替代公告':'撤回旧公告并重新发布'}}</h2>
      <label>标题</label><input v-model="nf.title">
      <label>正文</label><textarea v-model="nf.body"></textarea>
      <div class="row">
        <div><label>级别</label><select v-model="nf.urgency"><option v-for="l in levels" :key="l.v" :value="l.v">{{l.label}}</option></select></div>
        <div><label>联系人</label><input v-model="nf.contact_name"></div>
        <div><label>电话</label><input v-model="nf.contact_phone"></div>
      </div>
      <div class="row">
        <div><label>开始</label><input type="datetime-local" v-model="nf.startInput"></div>
        <div><label>结束</label><input type="datetime-local" v-model="nf.endInput"></div>
      </div>
      <label>影响楼栋</label>
      <div class="checks"><label v-for="b in ctx.buildings" :key="b.id">
        <input type="checkbox" :value="b.id" v-model="nf.building_ids">{{b.current_name}}</label></div>
      <label>原因 / 撤回说明</label><input v-model="nf.reason" placeholder="如：抢修时间更新">
      <div class="err" v-if="ctx.err">{{ctx.err}}</div>
      <p style="margin-top:10px"><button class="btn" @click="doSupersede">提交</button>
        <button class="btn ghost" @click="mode=''">取消</button></p>
      <p class="muted" v-if="nf.urgency==='urgent'">紧急替代公告生成后仍须另一有权用户确认同一快照才能发布。</p>
    </div>
  </div>`,
  setup(props) {
    const a = Vue.ref(null);
    const mode = Vue.ref(props.query.mode === 'replace' ? 'replace' : '');
    const nf = reactive({ title: '', body: '', urgency: 'normal', contact_name: '', contact_phone: '',
      startInput: '', endInput: '', building_ids: [], reason: '' });
    const levels = LEVELS;
    const shareUrl = computed(() => location.origin + '/#/notice/' + props.id);
    async function load() {
      a.value = await api('GET', `/api/announcements/${props.id}`);
      if (a.value && !nf.title) {
        Object.assign(nf, {
          title: a.value.title, body: a.value.body, urgency: a.value.urgency,
          contact_name: a.value.contact.name, contact_phone: a.value.contact.phone,
          startInput: toLocalInput(a.value.start_at), endInput: toLocalInput(a.value.end_at),
          building_ids: a.value.scope.buildings_at_publish.map((x) => x.building_id),
          reason: mode.value === 'withdraw_republish' ? '原公告撤回，以本版为准' : '',
        });
      }
    }
    onMounted(load);
    function stateLabel(s) {
      return { draft: '草稿', pending_confirm: '审批中', active: '生效中', upcoming: '未开始',
        expired: '已结束（保留证据）', withdrawn: '已撤回', superseded: '已被替代' }[s] || s;
    }
    function eventLabel(t) {
      return { created: '创建草稿', submitted: '提交紧急确认', confirmed: '紧急确认',
        publish_failed: '发布被拒（缺有效确认）', published: '发布', withdrawn: '撤回',
        superseded: '被替代' }[t] || t;
    }
    function copy() { navigator.clipboard && navigator.clipboard.writeText(shareUrl.value); props.ctx.toast = '链接已复制'; }
    async function doWithdraw() {
      const reason = prompt('撤回原因：', '');
      if (reason === null) return;
      await api('POST', `/api/announcements/${props.id}/withdraw`, { reason });
      await load(); await props.ctx.refresh();
    }
    async function doSupersede() {
      props.ctx.err = '';
      try {
        const r = await api('POST', `/api/announcements/${props.id}/supersede`, {
          mode: mode.value, title: nf.title, body: nf.body, urgency: nf.urgency,
          contact_name: nf.contact_name, contact_phone: nf.contact_phone,
          start_at: fromInput(nf.startInput), end_at: fromInput(nf.endInput),
          building_ids: nf.building_ids, reason: nf.reason,
          client_request_id: 'req-sup-' + Date.now(),
        });
        await props.ctx.refresh();
        location.hash = '#/notice/' + r.new_id;
      } catch (e) { props.ctx.err = e.message; }
    }
    return { a, mode, nf, levels, fmt, stateLabel, eventLabel, shareUrl, copy, doWithdraw, doSupersede, location };
  },
};

/* ============================================================
 * 楼栋与范围版管理
 * ============================================================ */
const BuildingAdmin = {
  props: ['ctx'],
  template: `
  <div class="card">
    <h2>楼栋管理（更名不改 id；历史公告按名称版本解析发布时名称）</h2>
    <table><thead><tr><th>编号</th><th>代码</th><th>当前名称</th><th>更名</th><th>名称史</th></tr></thead>
      <tbody><tr v-for="b in ctx.buildings" :key="b.id">
        <td>{{b.id}}</td><td>{{b.code}}</td><td>{{b.current_name}}</td>
        <td><input :value="renameVal[b.id]" @input="renameVal[b.id]=$event.target.value" style="width:150px">
            <button class="btn mini" @click="rename(b)">更名</button></td>
        <td><div v-for="v in history[b.id]||[]" :key="v.id" class="muted">
          {{v.name}}（{{v.valid_from?fmt(v.valid_from):'起始'}} → {{v.valid_to?fmt(v.valid_to):'至今'}}）</div></td>
      </tr></tbody></table>
    <h2 style="margin-top:18px">范围版本（冻结，不再变更）</h2>
    <table><thead><tr><th>ID</th><th>标签</th><th>创建时间</th><th>楼栋（当前名）</th></tr></thead>
      <tbody><tr v-for="s in ctx.scopes" :key="s.id">
        <td>#{{s.id}}</td><td>{{s.label}}</td><td>{{fmt(s.created_at)}}</td>
        <td><span class="tag" v-for="b in s.buildings" :key="b.building_id">{{b.current_name}}</span></td>
      </tr></tbody></table>
  </div>`,
  setup(props) {
    const renameVal = reactive({});
    const history = reactive({});
    onMounted(async () => {
      for (const b of props.ctx.buildings) {
        history[b.id] = await api('GET', `/api/buildings/${b.id}/history`);
      }
    });
    async function rename(b) {
      const name = (renameVal[b.id] || '').trim();
      if (!name) return;
      await api('POST', `/api/buildings/${b.id}/rename`, { name });
      await props.ctx.refreshMeta();
      history[b.id] = await api('GET', `/api/buildings/${b.id}/history`);
    }
    return { renameVal, history, rename, fmt };
  },
};

/* ============================================================
 * 打印任务（迟到由"计划 vs 实际/当前"派生；模拟时钟可让任务迟到）
 * ============================================================ */
const PrintAdmin = {
  props: ['ctx'],
  template: `
  <div class="card">
    <h2>公告栏打印任务</h2>
    <p class="muted">迟到判定：实际打印时间晚于计划时间 5 分钟以上；未执行且当前已过计划 5 分钟也计为迟到。
      可用下方模拟时钟制造"打印任务迟到"。</p>
    <div class="row">
      <div><label>公告</label><select v-model="j.announce_id">
        <option v-for="a in ctx.all" :key="a.id" :value="a.id">{{a.code}} {{a.title}}</option></select></div>
      <div><label>打印点位</label><input v-model="j.station" placeholder="东门公告栏"></div>
      <div><label>计划打印时间</label><input type="datetime-local" v-model="j.scheduledInput"></div>
      <div style="flex:0"><label>&nbsp;</label><button class="btn" @click="create">建任务</button></div>
    </div>
    <table style="margin-top:12px"><thead><tr><th>公告</th><th>点位</th><th>计划</th><th>实际</th><th>状态</th><th></th></tr></thead>
      <tbody><tr v-for="p in ctx.printJobs" :key="p.id">
        <td><a class="backlink" @click="location.hash='#/notice/'+p.announce_id">{{p.code}}</a><div class="muted">{{p.title}}</div></td>
        <td>{{p.station}}</td><td>{{fmt(p.scheduled_at)}}</td>
        <td>{{p.executed_at?fmt(p.executed_at):'未执行'}}</td>
        <td :class="p.late?'late':'ontime'">
          {{p.executed?(p.late?'⏰ 迟到打印':'✓ 准时打印'):(p.late?'⏰ 已迟到未打印':'等待打印')}}
        </td>
        <td><button class="btn mini" :disabled="!!p.executed_at" @click="exec(p)">标记打印</button></td>
      </tr></tbody></table>
  </div>`,
  setup(props) {
    const j = reactive({ announce_id: '', station: '东门公告栏', scheduledInput: toLocalInput(props.ctx.now + 1800000) });
    async function create() {
      await api('POST', '/api/print-jobs', {
        announce_id: Number(j.announce_id), station: j.station, scheduled_at: fromInput(j.scheduledInput),
      });
      await props.ctx.refresh();
    }
    async function exec(p) { await api('POST', `/api/print-jobs/${p.id}/execute`, {}); await props.ctx.refresh(); }
    return { j, create, exec, fmt };
  },
};

/* ============================================================
 * 根组件：hash 路由 + 全局状态
 * ============================================================ */
const App = {
  components: { Editor, ListView, BuildingAdmin, PrintAdmin, NoticePage },
  template: `
  <div class="topbar">
    <h1>📢 社区公告排版台</h1>
    <div class="tabs">
      <button :class="{active:tab==='desk'}" @click="go('desk')">排版台</button>
      <button :class="{active:tab==='list'}" @click="go('list')">公告管理</button>
      <button :class="{active:tab==='buildings'}" @click="go('buildings')">楼栋/范围</button>
      <button :class="{active:tab==='print'}" @click="go('print')">打印任务</button>
    </div>
    <div class="spacer"></div>
    <div>
      <label style="color:#ffd9d4;margin:0;display:inline">当前操作人</label>
      <select v-model="userId" @change="switchUser" style="width:auto;display:inline-block">
        <option v-for="u in users" :key="u.id" :value="u.id">
          {{u.display_name}}{{u.can_confirm?'（可确认）':''}}{{u.can_publish?'（可发布）':''}}
        </option>
      </select>
    </div>
  </div>

  <!-- 模拟时钟（验收：跨午夜 / 打印迟到） -->
  <div class="wrap" style="padding-bottom:0">
    <div class="card" style="padding:10px 16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span class="muted">🕐 系统时间（可模拟）：</span><b>{{fmt(now)}}</b>
      <input type="datetime-local" v-model="clockInput" style="width:auto">
      <button class="btn mini" @click="setClock">设定模拟时间</button>
      <button class="btn mini ghost" @click="resetClock">恢复真实时间</button>
      <button class="btn mini ghost" @click="jumpMin(-30)">-30分</button>
      <button class="btn mini ghost" @click="jumpMin(30)">+30分</button>
      <button class="btn mini ghost" @click="jumpMin(720)">+12小时（跨午夜）</button>
      <span v-if="toast" class="ok">｜{{toast}}</span>
      <span v-if="err" class="err" style="margin:0">｜{{err}}</span>
    </div>
  </div>

  <div class="wrap">
    <editor v-if="tab==='desk'" :ctx="ctx"></editor>
    <list-view v-if="tab==='list'" :ctx="ctx"></list-view>
    <building-admin v-if="tab==='buildings'" :ctx="ctx"></building-admin>
    <print-admin v-if="tab==='print'" :ctx="ctx"></print-admin>
    <notice-page v-if="noticeId" :ctx="ctx" :id="noticeId" :query="noticeQuery"></notice-page>
  </div>`,
  setup() {
    const users = Vue.ref([]);
    const userId = Vue.ref(1);
    const user = Vue.ref({});
    const now = Vue.ref(Date.now());
    const buildings = Vue.ref([]);
    const scopes = Vue.ref([]);
    const all = Vue.ref([]);
    const effective = Vue.ref([]);
    const printJobs = Vue.ref([]);
    const toast = Vue.ref('');
    const err = Vue.ref('');
    const clockInput = Vue.ref(toLocalInput(Date.now()));
    const tab = Vue.ref('desk');
    const noticeId = Vue.ref(null);
    const noticeQuery = Vue.ref({});

    const ctx = reactive({
      get now() { return now.value; },
      get user() { return user.value; },
      get buildings() { return buildings.value; },
      get scopes() { return scopes.value; },
      get all() { return all.value; },
      get effective() { return effective.value; },
      get printJobs() { return printJobs.value; },
      toast: '', err: '',
      refresh: () => loadData(),
      refreshMeta: () => loadMeta(),
    });
    let toastTimer;
    watch(() => ctx.toast, (v) => {
      toast.value = v;
      clearTimeout(toastTimer);
      if (v) toastTimer = setTimeout(() => { ctx.toast = ''; toast.value = ''; }, 4000);
    });
    watch(() => ctx.err, (v) => { err.value = v; });

    async function loadMeta() {
      const me = await api('GET', '/api/me');
      now.value = me.now;
      users.value = await api('GET', '/api/users');
      buildings.value = await api('GET', '/api/buildings');
      scopes.value = await api('GET', '/api/scopes');
      const u = users.value.find((x) => x.id === userId.value);
      if (u) user.value = u;
    }
    async function loadData() {
      await loadMeta();
      all.value = await api('GET', '/api/announcements');
      effective.value = await api('GET', '/api/announcements/effective');
      printJobs.value = await api('GET', '/api/print-jobs');
    }
    async function switchUser() {
      // 用 header 模拟登录态；api() 会自动带上 X-User-Id
      window.__uid = userId.value;
      await loadData();
    }
    async function setClock() {
      const ts = fromInput(clockInput.value);
      if (!Number.isFinite(ts)) return;
      const r = await api('POST', '/api/dev/clock', { mock_now: ts });
      now.value = r.now;
      await loadData();
    }
    async function resetClock() {
      await api('POST', '/api/dev/clock', { mock_now: null });
      clockInput.value = toLocalInput(Date.now());
      await loadData();
    }
    async function jumpMin(mins) {
      clockInput.value = toLocalInput(new Date(clockInput.value).getTime() + mins * 60000);
      await setClock();
    }
    function go(t) { tab.value = t; noticeId.value = null; location.hash = '#/'; }
    function parseRoute() {
      const hash = location.hash || '#/';
      const m = hash.match(/^#\/notice\/(\d+)(?:\?(.+))?/);
      if (m) { noticeId.value = Number(m[1]); noticeQuery.value = Object.fromEntries(new URLSearchParams(m[2] || '')); tab.value = ''; }
      else {
        noticeId.value = null;
        const t = (hash.match(/^#\/(\w*)/) || [, 'desk'])[1] || 'desk';
        if (['desk', 'list', 'buildings', 'print'].includes(t)) tab.value = t;
      }
    }
    window.addEventListener('hashchange', parseRoute);

    onMounted(async () => {
      window.__uid = userId.value;
      await loadData();
      parseRoute();
    });

    return { users, userId, user, now, buildings, scopes, all, effective, printJobs, toast, err,
      clockInput, tab, noticeId, noticeQuery, ctx, go, switchUser, setClock, resetClock, jumpMin, fmt };
  },
};

createApp(App).mount('#app');
