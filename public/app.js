'use strict';

const $ = (s) => document.querySelector(s);
const CLEAR_KEY = '__CLEAR_KEY__';

let state = { providers: [], channels: [], proxies: [], token: '', port: 8787, proxyOpen: new Set() };
let ui = {}; // providerId -> 该组界面状态（筛选、展开、提示）
let entriesText = '';
let saveTimer = null;
let filterTimer = null;
let loaded = false; // 未成功加载前禁止保存，避免把数据库清空

function esc(v) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(v ?? '').replace(/[&<>"']/g, (c) => map[c]);
}

const DEFAULT_NAME_TEMPLATE = '{provider}·{modelLower}';

// 统一更新片段内容与折叠标题上的条数
function setEntries(arr, expand = false) {
  entriesText = JSON.stringify(arr, null, 2);
  $('#output').textContent = entriesText;
  $('#outputCount').textContent = arr.length ? `${arr.length} 条` : '暂无';
  if (expand) $('#outputWrap').open = true;
}

function showMsg(text, type = '', target = '#msg') {
  const el = $(target);
  el.textContent = text;
  el.className = 'msg ' + type;
}

function showModal(title, bodyHtml) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#modal').hidden = false;
}

function closeModal() {
  $('#modal').hidden = true;
}

function setApplyResult(text, type = '') {
  const el = $('#applyResult');
  el.textContent = text;
  el.className = 'apply-result ' + type;
}

function lastApplySummary(a) {
  if (!a) return '尚未写入过；填入路径点「备份并写入」后会记住路径与结果';
  return `上次写入 ${a.at}（本机时间）· 新增 ${a.added} / 更新 ${a.updated} / 移除 ${a.removed || 0}${a.replaced ? ` / 替换旧名称 ${a.replaced}` : ''} · 备份 ${a.backupName}`;
}

function setStatus(on, count = 0) {
  const el = $('#status');
  el.className = 'status ' + (on ? 'on' : 'off');
  el.textContent = on ? `运行中 · ${count} 个渠道` : '服务未连接';
}

async function api(url, method = 'GET', body) {
  const resp = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || data.message || `HTTP ${resp.status}`);
  return data;
}

function providerById(id) {
  return state.providers.find((p) => p.id === id);
}

function channelById(id) {
  return state.channels.find((c) => c.id === id);
}

function uiFor(id) {
  if (!ui[id]) {
    ui[id] = {
      search: '', chatOnly: true, hideFree: true, imageOnly: false,
      editCid: '', meta: '', syncMsg: '', syncType: '',
      openCard: true, openModels: false, openChannels: false,
      detailModels: new Set(),
    };
  }
  return ui[id];
}

function capBadge(on, text) {
  return `<span class="cap ${on ? 'yes' : ''}">${on ? '✓' : '–'} ${text}</span>`;
}

// ---- 服务商卡片 ----

function providerHtml(p, idx) {
  const u = uiFor(p.id);
  const keyLabel = p.noAuth ? 'API Key（该组设置为无需密钥）'
    : (p.hasKey ? `API Key（已设置 ${esc(p.keyHint)}，留空保持不变）` : 'API Key（未设置）');
  const keyPlaceholder = p.hasKey ? '留空保持不变' : '填写密钥';
  const models = p.models || [];
  const placeholderHint = models.length && models.every((m) => m.placeholder)
    ? '<p class="hint" style="margin:8px 0 0">这是从已有渠道恢复的清单，点「获取模型」可刷新完整模型列表与能力。</p>' : '';
  return `
  <div class="provider-card" data-pid="${esc(p.id)}">
    <div class="provider-head">
      <div class="provider-head-text">
        <button class="fold-btn" data-act="toggle-card" title="展开或收起整组">${u.openCard ? '▾' : '▸'}</button>
        <span class="provider-title">${esc(p.label || '未命名')}</span>
        <span class="provider-sub" data-role="sub"></span>
        <span class="egress-badge ${egressBadge(p).cls}" data-role="egress">${esc(egressBadge(p).text)}</span>
      </div>
      <div class="actions">
        <button class="btn small" data-act="toggle-card">${u.openCard ? '收起' : '展开'}</button>
        <button class="btn small danger" data-act="delete-provider">删除服务商</button>
      </div>
    </div>
    <div class="provider-body" ${u.openCard ? '' : 'hidden'}>
      <div class="discover-grid">
        <div class="field"><label>服务商名字</label><input type="text" data-field="label" value="${esc(p.label)}" placeholder="例如 OpenCode Zen / 硅基流动"></div>
        <div class="field"><label>服务商地址</label><input type="text" data-field="url" value="${esc(p.url)}" placeholder="https://api.example.com/v1 或完整 /v1/chat/completions"></div>
        <div class="field"><label>${esc(keyLabel)}</label><input type="password" data-field="apiKey" value="" placeholder="${esc(keyPlaceholder)}" ${p.noAuth ? 'disabled' : ''}></div>
        <div class="field"><label>本地 / 免鉴权服务</label><label class="inline-check"><input type="checkbox" data-field="noAuth" ${p.noAuth ? 'checked' : ''}>无需密钥</label></div>
      </div>
      <div class="egress-bar">
        <div class="field"><label>网络出口</label><select data-field="egressMode">${egressOptionsHtml(p.egressMode)}</select></div>
        <div class="field"><label>指定代理</label><select data-field="proxyId" ${p.egressMode === 'single' ? '' : 'disabled'}>${proxyOptionsHtml(p.proxyId)}</select></div>
        <span class="hint">该组所有模型共用此出口；添加代理后必须在这里选择才会生效，也可在「网络代理」里一键应用。</span>
      </div>
      <div class="provider-actions">
        <button class="btn primary small" data-act="discover">获取模型</button>
        <span class="provider-meta" data-role="meta">${esc(u.meta)}</span>
      </div>
      <details class="advanced row-toggle">
        <summary>高级选项（自动推导 · 密钥）</summary>
        <div class="discover-grid adv-grid">
          <div class="field"><label>别名前缀 / 本地 ID 前缀</label><input type="text" data-field="prefix" value="${esc(p.prefix)}" placeholder="按服务商名字自动生成"></div>
          <div class="field"><label>对话地址（自动推导，可覆盖）</label><input type="text" data-field="chatUrl" value="${esc(p.chatUrl)}" placeholder="留空自动推导"></div>
          <div class="field"><label>模型列表地址（自动探测，可覆盖）</label><input type="text" data-field="modelsUrl" value="${esc(p.modelsUrl)}" placeholder="留空自动尝试多个地址"></div>
        </div>
        <p class="hint" style="margin:10px 0 0">两个接口不在同一路径时分别填这两项，例如模型列表在 <code>/zen/v1/models</code>、对话在 <code>/inference/openai/v1/chat/completions</code>。</p>
        <div class="adv-actions"><button class="btn small danger" data-act="clear-key">清除密钥</button></div>
      </details>

      <details class="fold row-toggle" data-fold="models" ${u.openModels ? 'open' : ''}>
        <summary>可用模型 <span class="fold-note" data-role="model-count"></span></summary>
        <div class="fold-body">
          <p class="hint" style="margin:0 0 10px">点前面的勾选框启用模型（自动生成渠道，取消勾选即移除）；点模型行整行可展开 / 收起该模型的能力来源与说明。</p>
          <div class="disc-tools">
            <input type="text" data-filter="search" placeholder="搜索模型 ID 或名称" value="${esc(u.search)}">
            <label><input type="checkbox" data-filter="chatOnly" ${u.chatOnly ? 'checked' : ''}>仅对话模型</label>
            <label><input type="checkbox" data-filter="hideFree" ${u.hideFree ? 'checked' : ''}>隐藏零定价模型</label>
            <label><input type="checkbox" data-filter="imageOnly" ${u.imageOnly ? 'checked' : ''}>只看支持图片</label>
            <button class="btn small" data-act="select-all">全选可见</button>
            <button class="btn small" data-act="select-none">清空选择</button>
          </div>
          <div class="disc-list" data-role="models"></div>
          ${placeholderHint}
        </div>
      </details>

      <details class="fold row-toggle" data-fold="channels" ${u.openChannels ? 'open' : ''}>
        <summary>已生成的渠道 <span class="fold-note" data-role="channel-count"></span></summary>
        <div class="fold-body">
          <p class="hint" style="margin:0 0 10px">点渠道整行展开编辑，再点展开后的标题行即可收起。</p>
          <div class="channels" data-role="channels"></div>
        </div>
      </details>

      <div class="sync-bar">
        <span data-role="sync"></span>
        <span data-role="count" class="hint" style="margin:0"></span>
      </div>
    </div>
  </div>`;
}

function renderProviders() {
  $('#providers').innerHTML = state.providers.length
    ? state.providers.map(providerHtml).join('')
    : '<div class="empty">还没有服务商。点右上角「+ 添加服务商」新增一组，填名字 / 地址 / API Key 后点「获取模型」。</div>';
}

function visibleModels(p) {
  const u = uiFor(p.id);
  const q = u.search.trim().toLowerCase();
  return (p.models || []).filter((m) =>
    (!q || m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q))
    && (!u.chatOnly || m.chat)
    && (!u.hideFree || !m.free)
    && (!u.imageOnly || m.capabilities.supportsImages));
}

// 整行展开的模型详情：把原本只能靠悬停 title 看到的信息铺开，移动端也能读
function modelDetailHtml(m) {
  const cap = m.capabilities || {};
  const src = m.sources || {};
  const origin = (k) => (src[k] === 'api' ? '上游接口声明' : '按名称推断');
  const rows = [
    ['上游名称', m.name || m.id],
    ['接口协议', m.protocol && m.protocol !== 'unknown' ? m.protocol : '未声明'],
    ['上下文长度', m.context ? `${Math.round(m.context / 1000)}K tokens` : '未声明'],
    ['图片输入', `${cap.supportsImages ? '支持' : '未支持'} · ${origin('images')}`],
    ['工具调用', `${cap.supportsToolCall ? '支持' : '未支持'} · ${origin('toolCall')}`],
    ['推理模式', `${cap.supportsReasoning ? '支持' : '未支持'} · ${origin('reasoning')}`],
    ['零定价', m.free ? '是 · 部分服务商限制为仅自家客户端可用' : '否'],
  ].map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><code>${esc(v)}</code></div>`).join('');
  return `<div class="model-detail">${rows}${m.description
    ? `<p class="hint" style="margin:8px 0 0">${esc(m.description)}</p>` : ''}</div>`;
}

function modelRowHtml(p, m) {
  const picked = (p.selected || []).includes(m.id);
  const cap = m.capabilities || {};
  const open = uiFor(p.id).detailModels.has(m.id);
  const badge = (on, text, src) => `<span class="cap ${on ? 'yes' : ''}" title="来源：${src === 'api' ? '上游接口声明' : '按名称推断'}">${on ? '✓' : '–'} ${text}${src === 'inferred' ? ' *' : ''}</span>`;
  const meta = [
    m.context ? Math.round(m.context / 1000) + 'K' : '',
    m.protocol && !['chat-completions', 'unknown'].includes(m.protocol) ? esc(m.protocol) : '',
  ].filter(Boolean).join(' · ');
  return `<div class="model-item ${picked ? 'picked' : ''}" data-model-item="${esc(m.id)}">
    <div class="model-row" data-model-id="${esc(m.id)}" title="点击展开 / 收起模型详情">
      <label class="model-check" title="勾选启用该模型"><input type="checkbox" data-model="${esc(m.id)}" ${picked ? 'checked' : ''}></label>
      <span class="model-id">${esc(m.id)}</span>
      <span class="model-caps">
        ${badge(cap.supportsImages, '图片', m.sources?.images)}
        ${badge(cap.supportsToolCall, '工具', m.sources?.toolCall)}
        ${badge(cap.supportsReasoning, '推理', m.sources?.reasoning)}
        ${m.free ? '<span class="cap free" title="上游标价为 0；部分服务商限制为仅自家客户端可用">零定价 · 可能被限</span>' : ''}
      </span>
      <span class="model-meta">${meta}</span>
      <span class="model-caret" aria-hidden="true">${open ? '▴' : '▾'}</span>
    </div>
    ${open ? modelDetailHtml(m) : ''}
  </div>`;
}

function renderModelList(p, card, withRows = true) {
  const visible = visibleModels(p);
  if (withRows) {
    const list = card.querySelector('[data-role="models"]');
    if (!(p.models || []).length) {
      const picked = (p.selected || []).length;
      list.innerHTML = picked
        ? `<div class="empty">已勾选 ${picked} 个模型，但清单尚未缓存。点「获取模型」可刷新完整列表与能力，已有勾选会保留。</div>`
        : '<div class="empty">填写上方服务商信息后点「获取模型」</div>';
    } else if (!visible.length) {
      list.innerHTML = '<div class="empty">没有匹配的模型，试试取消筛选或清空搜索词</div>';
    } else {
      list.innerHTML = visible.map((m) => modelRowHtml(p, m)).join('');
    }
  }
  const u = uiFor(p.id);
  const hiddenFree = u.hideFree ? (p.models || []).filter((m) => m.free).length : 0;
  const pickedFree = (p.models || []).filter((m) => m.free && (p.selected || []).includes(m.id)).length;
  const extra = [
    hiddenFree ? `已隐藏 ${hiddenFree} 个零定价模型` : '',
    pickedFree ? `已选中 ${pickedFree} 个零定价模型` : '',
  ].filter(Boolean).join(' · ');
  card.querySelector('[data-role="count"]').textContent =
    `显示 ${visible.length} / ${(p.models || []).length} 个 · 已选 ${(p.selected || []).length} 个${extra ? ' · ' + extra : ''}`;
}

// ---- 渠道渲染（服务商派生与独立渠道共用） ----

function channelCompactHtml(c) {
  const keyState = c.noAuth ? '免密钥' : (c.hasKey ? '密钥已设' : '密钥未设');
  return `
  <div class="channel compact ${c.enabled ? '' : 'disabled'}" data-cid="${esc(c.id)}">
    <div class="compact-row">
      <label class="checks" style="margin:0"><input type="checkbox" data-ch-field="enabled" ${c.enabled ? 'checked' : ''}>启用</label>
      <span class="compact-name" title="统一名称：${esc(c.displayName || c.label || c.alias)}&#10;真实模型名：${esc(c.upstreamModel)}&#10;别名：${esc(c.alias)}">${esc(c.displayName || c.label || c.alias)}</span>
      <span class="model-caps">
        ${capBadge(c.supportsImages, '图片')}
        ${capBadge(c.supportsToolCall, '工具')}
        ${capBadge(c.supportsReasoning, '推理')}
        <span class="cap ${c.hasKey || c.noAuth ? 'yes' : ''}">${keyState}</span>
      </span>
      <span class="compact-actions">
        <button class="btn small" data-act="test">测试</button>
        <button class="btn small" data-act="edit">编辑</button>
        <button class="btn small danger" data-act="del">删除</button>
      </span>
    </div>
    <div class="msg" data-role="testresult"></div>
  </div>`;
}

function channelFullHtml(c, derived) {
  const keyLabel = c.noAuth ? 'API Key（该渠道设置为无需密钥）'
    : (c.hasKey ? `API Key（已设置 ${esc(c.keyHint)}，留空保持不变）` : 'API Key（未设置）');
  const shared = derived
    ? '<p class="hint" style="margin:0 0 10px">地址、密钥、真实模型名由上方服务商信息统一管理，改卡片顶部即可让整组生效。</p>'
    : '';
  const extraFields = derived ? '' : `
      <div class="field"><label>上游完整地址</label><input type="text" data-ch-field="url" value="${esc(c.url)}"></div>
      <div class="field"><label>${esc(keyLabel)}</label><input type="password" data-ch-field="apiKey" value="" placeholder="留空保持不变"></div>
      <div class="field"><label>真实模型名（发给上游）</label><input type="text" data-ch-field="upstreamModel" value="${esc(c.upstreamModel)}"></div>`;
  const modelReadonly = derived
    ? `<div class="field"><label>真实模型名（发给上游，由服务商管理）</label><input type="text" value="${esc(c.upstreamModel)}" readonly></div>`
    : '';
  return `
  <div class="channel ${c.enabled ? '' : 'disabled'}" data-cid="${esc(c.id)}">
    ${shared}
    <div class="channel-head">
      <span class="channel-title">${esc(c.displayName || c.label || c.alias)}</span>
      <div class="channel-tools">
        <label class="checks" style="margin:0"><input type="checkbox" data-ch-field="enabled" ${c.enabled ? 'checked' : ''}>启用</label>
        <button class="btn small" data-act="save-channel">保存渠道</button>
        <button class="btn small" data-act="edit">收起</button>
        <button class="btn small" data-act="refresh-name">刷新名称</button>
        <button class="btn small danger" data-act="del">删除</button>
      </div>
    </div>
    <div class="grid">
      <div class="field"><label>别名（URL 路径）</label><input type="text" data-ch-field="alias" value="${esc(c.alias)}"></div>
      <div class="field"><label>统一名称（显示名 = 模型 ID，自动生成）</label><input type="text" data-ch-field="label" value="${esc(c.displayName || c.label)}" readonly></div>
      ${modelReadonly}
      ${extraFields}
      ${derived
        ? `<div class="field"><label>网络出口（跟随服务商组）</label><input type="text" value="${esc(egressLabel(c))}" readonly></div>`
        : `<div class="field"><label>网络出口</label><select data-ch-field="egressMode">${egressOptionsHtml(c.egressMode)}</select></div>
           <div class="field"><label>指定代理</label><select data-ch-field="proxyId" ${c.egressMode === 'single' ? '' : 'disabled'}>${proxyOptionsHtml(c.proxyId)}</select></div>`}
    </div>
    <div class="checks">
      <label><input type="checkbox" data-ch-field="supportsToolCall" ${c.supportsToolCall ? 'checked' : ''}>工具调用</label>
      <label><input type="checkbox" data-ch-field="supportsImages" ${c.supportsImages ? 'checked' : ''}>图片输入</label>
      <label><input type="checkbox" data-ch-field="supportsReasoning" ${c.supportsReasoning ? 'checked' : ''}>推理模式</label>
    </div>
    <div class="msg" data-role="testresult"></div>
  </div>`;
}

function renderChannelList(container, list, pid) {
  const u = pid ? uiFor(pid) : { editCid: '' };
  if (!list.length) {
    container.innerHTML = '<div class="empty">这一组还没有渠道，勾选上方模型即可自动生成</div>';
    return;
  }
  container.innerHTML = list.map((c) => (
    u.editCid === c.id ? channelFullHtml(c, Boolean(c.providerId)) : channelCompactHtml(c)
  )).join('');
}

function renderDynamic() {
  state.providers.forEach((p) => {
    const card = document.querySelector(`.provider-card[data-pid="${p.id}"]`);
    if (!card) return;
    const u = uiFor(p.id);
    const mine = state.channels.filter((c) => c.providerId === p.id);
    // 折叠时不生成列表 DOM：单个服务商可能有数百个模型，展开时再补渲染
    const modelsFold = card.querySelector('[data-fold="models"]');
    const channelsFold = card.querySelector('[data-fold="channels"]');
    renderModelList(p, card, modelsFold.open);
    if (channelsFold.open) renderChannelList(card.querySelector('[data-role="channels"]'), mine, p.id);
    card.querySelector('[data-role="sub"]').textContent = `${(p.selected || []).length} 个模型已选 · ${mine.length} 条渠道`;
    card.querySelector('[data-role="model-count"]').textContent = `共 ${(p.models || []).length} 个 · 已选 ${(p.selected || []).length} 个`;
    card.querySelector('[data-role="channel-count"]').textContent = `共 ${mine.length} 条 · 共用上方信息`;
    card.querySelector('[data-role="meta"]').textContent = u.meta;
    const sync = card.querySelector('[data-role="sync"]');
    sync.textContent = u.syncMsg;
    sync.className = u.syncType;
  });
  const standalone = state.channels.filter((c) => !c.providerId);
  $('#standaloneWrap').hidden = standalone.length === 0;
  renderChannelList($('#standalone'), standalone, '');
  const enabled = state.channels.filter((c) => c.enabled).length;
  $('#groupCount').textContent = `${state.providers.length} 组服务商 · ${state.channels.length} 条渠道`;
  // 顶部概览同步刷新，渠道增减后无需重载页面
  $('#statProviders').textContent = state.providers.length;
  $('#statModels').textContent = state.channels.length;
  $('#statEnabled').textContent = enabled;
  $('#statPort').textContent = state.port || 8787;
  $('#statWrite').textContent = state.lastApply ? '已写入' : '待写入';
  $('#statWrite').className = 'stat-value' + (state.lastApply ? ' good' : '');
  setStatus(true, enabled);
}

function updateFoldAllLabel() {
  const anyOpen = state.providers.some((p) => uiFor(p.id).openCard);
  $('#btnFoldAll').textContent = anyOpen ? '全部收起' : '全部展开';
}

// 服务商头部整行与箭头按钮共用同一套折叠逻辑
function toggleCard(card) {
  if (!card) return;
  const pid = card.dataset.pid;
  const u = uiFor(pid);
  u.openCard = !u.openCard;
  card.querySelector('.provider-body').hidden = !u.openCard;
  card.querySelectorAll('[data-act="toggle-card"]').forEach((b) => {
    b.textContent = b.classList.contains('fold-btn')
      ? (u.openCard ? '▾' : '▸') : (u.openCard ? '收起' : '展开');
  });
  card.classList.toggle('collapsed', !u.openCard);
  updateFoldAllLabel();
  if (u.openCard) renderDynamic(); // 折叠期间未生成的列表 DOM，展开时补齐
}

// 整行可点：控件本身仍走各自的逻辑，不连带折叠
function isRowControl(target) {
  return Boolean(target.closest('button, a, input, select, textarea, label, summary, [data-no-fold]'));
}

// details 的 toggle 事件不冒泡，用捕获阶段记下每组的展开状态
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.dataset.fold) return;
  const card = d.closest('.provider-card');
  if (!card) return;
  const pid = card.dataset.pid;
  const u = uiFor(pid);
  if (d.dataset.fold === 'models') {
    u.openModels = d.open;
    if (d.open) { const p = providerById(pid); if (p) renderModelList(p, card); }
  }
  if (d.dataset.fold === 'channels') {
    u.openChannels = d.open;
    if (d.open) renderChannelList(card.querySelector('[data-role="channels"]'),
      state.channels.filter((c) => c.providerId === pid), pid);
  }
}, true);

// ---- 网络代理池 ----

let proxySaveTimer = null;

// 服务商卡片头部常显当前出口，避免「加了代理却仍走直连」而不自知
function egressBadge(p) {
  const m = p.egressMode || 'direct';
  if (m === 'pool') {
    const n = poolMembers().length;
    return { text: `代理池轮询 · ${n} 条`, cls: n ? 'proxy' : 'warn' };
  }
  if (m === 'single') {
    const x = state.proxies.find((v) => v.id === p.proxyId);
    if (!x) return { text: '代理未设置', cls: 'warn' };
    return { text: `代理 · ${x.label || x.host}`, cls: x.enabled ? 'proxy' : 'warn' };
  }
  return { text: '本地直连', cls: 'direct' };
}

function updateEgressBadges() {
  state.providers.forEach((p) => {
    const el = document.querySelector(`.provider-card[data-pid="${p.id}"] [data-role="egress"]`);
    if (!el) return;
    const b = egressBadge(p);
    el.textContent = b.text;
    el.className = `egress-badge ${b.cls}`;
  });
}

function proxyOptionsHtml(keepId = '') {
  const list = state.proxies.filter((x) => (x.enabled && x.host && x.port) || x.id === keepId);
  return '<option value="">请选择代理</option>' + list.map((x) => {
    const name = x.label || `${x.type}://${x.host}:${x.port}`;
    return `<option value="${esc(x.id)}">${esc(name)}（${esc(x.type)}）</option>`;
  }).join('');
}

function egressOptionsHtml(sel) {
  return [
    ['direct', '本地直连（默认）'], ['single', '指定代理'], ['pool', '代理池轮询'],
  ].map(([v, t]) => `<option value="${v}" ${sel === v ? 'selected' : ''}>${t}</option>`).join('');
}

// 代理池 = 标为池内且已启用、主机端口完整的代理；轮询只在这里面轮换
function poolMembers() {
  return state.proxies.filter((x) => x.inPool !== false && x.enabled && x.host && x.port);
}

function renderProxyCount() {
  const usable = state.proxies.filter((x) => x.enabled && x.host && x.port).length;
  const pool = poolMembers().length;
  $('#proxyCount').textContent = state.proxies.length
    ? `${state.proxies.length} 条 · 池内 ${pool} 条 · ${usable} 条可用` : '未添加';
}

function updatePoolSummary() {
  const el = $('#poolSummary');
  if (!el) return;
  const list = poolMembers();
  const users = state.providers.filter((p) => p.egressMode === 'pool').length;
  const names = list.length
    ? list.map((x) => `${x.label || x.host}:${x.port}`).join('、')
    : '暂无（池为空时选「代理池轮询」会返回 502）';
  el.innerHTML = `
    <div class="pool-head">
      <span class="pool-title">代理池</span>
      <span class="proxy-tag ${list.length ? 'on' : 'warn'}">池内 ${list.length} 条</span>
      <span class="hint" style="margin:0">${users} 组服务商正在轮询</span>
    </div>
    <div class="hint" style="margin:0"><strong>池内成员：</strong>${esc(names)}</div>
    <div class="hint" style="margin:0"><strong>怎么加入 / 移出：</strong>点「+ 添加代理」默认即入池；点每条代理摘要上的「池内 · 移出」/「未入池 · 加入」标签即可切换。只有池内且启用的代理参与轮询；「指定代理」不受入池状态影响。</div>`;
}

// 池成员变动后刷新概览、标签、徽章与计数，不重建代理行以免打断输入
function updatePoolUi() {
  updatePoolSummary();
  document.querySelectorAll('#proxyList .proxy-row').forEach((row) => {
    const x = state.proxies.find((v) => v.id === row.dataset.proxyId);
    if (!x) return;
    const tag = row.querySelector('[data-role="pool-tag"]');
    if (tag) {
      tag.textContent = x.inPool !== false ? '池内 · 移出' : '未入池 · 加入';
      tag.className = `proxy-tag pool-tag ${x.inPool !== false ? 'on' : 'off'}`;
    }
    const box = row.querySelector('[data-proxy-field="inPool"]');
    if (box) box.checked = x.inPool !== false;
  });
  renderProxyCount();
  updateEgressBadges();
}

// 哪些服务商在用这条代理，用来提示「加了代理却没应用」
function proxyUsage(x) {
  const names = state.providers
    .filter((p) => p.egressMode === 'single' && p.proxyId === x.id)
    .map((p) => p.label || p.id);
  const pools = state.providers.filter((p) => p.egressMode === 'pool').length;
  return { names, pools, count: names.length + pools };
}

function proxyUsageText(use) {
  return use.count
    ? `使用中 · ${use.names.length} 组指定${use.pools ? ` + ${use.pools} 组轮询` : ''}`
    : '未使用';
}

function proxyRowHtml(x, idx) {
  const use = proxyUsage(x);
  const addr = `${x.type}://${x.host || '未填主机'}:${x.port || '?'}`;
  const open = !x.id || state.proxyOpen.has(x.id);
  const applyOptions = state.providers.length
    ? state.providers.map((p) => `<option value="${esc(p.id)}">${esc(p.label || p.id)}</option>`).join('')
    : '<option value="">请先添加服务商</option>';
  return `
  <details class="proxy-row" data-proxy-id="${esc(x.id)}" ${open ? 'open' : ''}>
    <summary class="proxy-summary">
      <span class="proxy-index">${idx + 1}</span>
      <span class="proxy-name">${esc(x.label || '未命名代理')}</span>
      <span class="proxy-addr">${esc(addr)}</span>
      <span class="proxy-tag ${x.enabled ? 'on' : 'off'}">${x.enabled ? '已启用' : '已停用'}</span>
      <button class="proxy-tag pool-tag ${x.inPool !== false ? 'on' : 'off'}" data-act="toggle-pool" data-role="pool-tag" title="点击加入 / 移出代理池">${x.inPool !== false ? '池内 · 移出' : '未入池 · 加入'}</button>
      <span class="proxy-tag ${use.count ? 'used' : 'warn'}" data-role="proxy-usage">${esc(proxyUsageText(use))}</span>
      <span class="proxy-caret">▾</span>
    </summary>
    <div class="proxy-body">
      <div class="proxy-row-head">
        <label class="inline-check"><input type="checkbox" data-proxy-field="enabled" ${x.enabled ? 'checked' : ''}>启用</label>
        <label class="inline-check"><input type="checkbox" data-proxy-field="inPool" ${x.inPool !== false ? 'checked' : ''}>加入代理池</label>
        <span class="hint" style="margin:0">${x.hasAuth ? '已设置账号密码' : '无认证'}</span>
        <button class="btn small" data-act="test-proxy">测试出口</button>
        <button class="btn small danger" data-act="delete-proxy">删除</button>
      </div>
      <div class="proxy-fields">
        <div class="field"><label>名称</label><input type="text" data-proxy-field="label" value="${esc(x.label)}" placeholder="例如 本地 Clash"></div>
        <div class="field"><label>类型</label><select data-proxy-field="type">
          <option value="http" ${x.type !== 'socks5' ? 'selected' : ''}>HTTP</option>
          <option value="socks5" ${x.type === 'socks5' ? 'selected' : ''}>SOCKS5</option>
        </select></div>
        <div class="field"><label>主机</label><input type="text" data-proxy-field="host" value="${esc(x.host)}" placeholder="127.0.0.1"></div>
        <div class="field"><label>端口</label><input type="text" inputmode="numeric" data-proxy-field="port" value="${esc(x.port)}" placeholder="7890"></div>
        <div class="field"><label>用户名（可选）</label><input type="text" data-proxy-field="username" value="${esc(x.username)}"></div>
        <div class="field"><label>密码（可选）</label><input type="password" data-proxy-field="password" value="" placeholder="${x.hasAuth ? '已设置，留空保持不变' : '留空表示无认证'}"></div>
      </div>
      <div class="proxy-apply">
        <span class="hint" data-role="proxy-used">${esc(use.names.length ? `当前指定使用：${use.names.join('、')}` : '当前没有服务商指定这条代理')}</span>
        <select data-proxy-apply>${applyOptions}</select>
        <button class="btn small primary" data-act="apply-proxy">应用到此组</button>
        <span class="hint" data-role="proxy-test"></span>
      </div>
    </div>
  </details>`;
}

function renderProxies() {
  // 重绘前记住每条的展开状态，避免自动保存后全部弹开或收起
  document.querySelectorAll('#proxyList .proxy-row').forEach((d) => {
    const id = d.dataset.proxyId;
    if (!id) return;
    if (d.open) state.proxyOpen.add(id);
    else state.proxyOpen.delete(id);
  });
  $('#proxyList').innerHTML = state.proxies.length
    ? state.proxies.map(proxyRowHtml).join('')
    : '<div class="empty">还没有代理，所有渠道默认本地直连。点下方「+ 添加代理」即可新增，默认会加入代理池。</div>';
  updatePoolUi();
  updateProxyFoldLabel();
}

// 只更新文字，不重建代理行，避免打断正在输入的内容
function updateProxyUsage() {
  document.querySelectorAll('#proxyList .proxy-row').forEach((row) => {
    const x = state.proxies.find((v) => v.id === row.dataset.proxyId);
    if (!x) return;
    const use = proxyUsage(x);
    const tag = row.querySelector('[data-role="proxy-usage"]');
    if (tag) {
      tag.textContent = proxyUsageText(use);
      tag.className = `proxy-tag ${use.count ? 'used' : 'warn'}`;
    }
    const used = row.querySelector('[data-role="proxy-used"]');
    if (used) used.textContent = use.names.length ? `当前指定使用：${use.names.join('、')}` : '当前没有服务商指定这条代理';
  });
}

function updateProxyFoldLabel() {
  const btn = $('#btnProxyFold');
  if (!btn) return;
  const rows = [...document.querySelectorAll('#proxyList .proxy-row')];
  btn.textContent = rows.length && rows.every((d) => d.open) ? '全部收起' : '全部展开';
}

// 代理池变动后只刷新下拉选项，不重建服务商卡片，避免正在输入的内容丢失
function refreshProxySelects() {
  state.providers.forEach((p) => {
    const card = document.querySelector(`.provider-card[data-pid="${p.id}"]`);
    if (!card) return;
    const mode = card.querySelector('[data-field="egressMode"]');
    const sel = card.querySelector('[data-field="proxyId"]');
    if (mode) mode.value = p.egressMode || 'direct';
    if (sel) {
      sel.innerHTML = proxyOptionsHtml(p.proxyId);
      sel.value = p.proxyId || '';
      sel.disabled = (p.egressMode || 'direct') !== 'single';
      if (!sel.value && p.proxyId) p.proxyId = '';
    }
  });
  document.querySelectorAll('[data-ch-field="proxyId"]').forEach((sel) => {
    const keep = sel.value;
    sel.innerHTML = proxyOptionsHtml(keep);
    sel.value = keep;
  });
}

function egressLabel(c) {
  if (c.egressMode === 'pool') return '代理池轮询';
  if (c.egressMode === 'single') {
    const x = state.proxies.find((v) => v.id === c.proxyId);
    return `指定代理：${x ? (x.label || x.host) : '（已失效）'}`;
  }
  return '本地直连';
}

function proxyPayload() {
  return state.proxies.map((x) => ({
    id: x.id, label: x.label, type: x.type, host: x.host, port: x.port,
    username: x.username, password: x.password || '',
    enabled: x.enabled, inPool: x.inPool !== false,
  }));
}

async function saveProxies(quiet = false) {
  const r = await api('/api/proxies', 'PUT', { proxies: proxyPayload() });
  state.proxies = r.proxies.map((x) => ({ ...x, password: '' }));
  document.querySelectorAll('#proxyList [data-proxy-field="password"]').forEach((inp) => {
    const x = state.proxies.find((v) => v.id === inp.closest('.proxy-row').dataset.proxyId);
    inp.value = '';
    inp.placeholder = x && x.hasAuth ? '已设置，留空保持不变' : '留空表示无认证';
  });
  refreshProxySelects();
  updateEgressBadges();
  updateProxyUsage();
  updatePoolUi();
  if (!quiet) showMsg('代理池已保存', 'ok', '#proxyMsg');
  return r;
}

function scheduleProxySave() {
  clearTimeout(proxySaveTimer);
  showMsg('同步中…', '', '#proxyMsg');
  proxySaveTimer = setTimeout(async () => {
    try {
      await saveProxies(true);
      showMsg('✔ 已自动保存', 'ok', '#proxyMsg');
    } catch (err) {
      showMsg('代理池保存失败：' + err.message, 'err', '#proxyMsg');
    }
  }, 300);
}

// ---- 保存 ----

function providerPayload() {
  return state.providers.map((p) => ({
    id: p.id, label: p.label, url: p.url, apiKey: p.apiKey || '',
    noAuth: p.noAuth, prefix: p.prefix, chatUrl: p.chatUrl,
    modelsUrl: p.modelsUrl, selected: p.selected || [],
    egressMode: p.egressMode || 'direct', proxyId: p.proxyId || '',
  }));
}

async function saveAll(quiet = false) {
  if (!loaded) throw new Error('配置尚未加载完成，请刷新页面后再保存');
  const r = await api('/api/providers', 'PUT', {
    providers: providerPayload(), token: $('#token').value.trim(),
  });
  state.providers = r.providers.map((p) => ({ ...p, apiKey: '' }));
  state.channels = r.channels;
  refreshProxySelects();
  updateEgressBadges();
  updateProxyUsage();
  updatePoolSummary();
  renderDynamic();
  if (!quiet) showMsg('已保存全部服务商配置', 'ok');
  return r;
}

function setAllSync(text, type = '') {
  state.providers.forEach((p) => {
    const u = uiFor(p.id);
    u.syncMsg = text;
    u.syncType = type;
  });
  state.providers.forEach((p) => {
    const el = document.querySelector(`.provider-card[data-pid="${p.id}"] [data-role="sync"]`);
    if (el) { el.textContent = text; el.className = type; }
  });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  setAllSync('同步中…');
  saveTimer = setTimeout(async () => {
    try {
      await saveAll(true);
      setAllSync('✔ 已自动保存', 'ok');
    } catch (err) {
      setAllSync('保存失败：' + err.message, 'err');
      showMsg('保存失败：' + err.message, 'err');
    }
  }, 300);
}

async function load() {
  const data = await api('/api/state');
  state = {
    providers: data.providers.map((p) => ({ ...p, apiKey: '' })),
    channels: data.channels, proxies: data.proxies || [],
    token: data.token, port: data.port, proxyOpen: new Set(),
    targetPath: data.targetPath || '', lastApply: data.lastApply || null,
  };
  $('#token').value = data.token || '';
  $('#nameTemplate').value = data.nameTemplate || DEFAULT_NAME_TEMPLATE;
  $('#targetPath').value = data.targetPath || '';
  const tpHint = $('#targetPathHint');
  if (tpHint) tpHint.textContent = '默认路径：' + (data.defaultModelsPath || '') + '（与 WorkBuddy 安装目录一致，可改）';
  // 直接回填上次生成的片段，不用重新点「生成」
  if (data.lastEntries) {
    try {
      const arr = JSON.parse(data.lastEntries);
      if (Array.isArray(arr)) setEntries(arr);
    } catch { /* 缓存损坏则忽略 */ }
  } else if (!loaded) {
    // 首次使用没有历史片段时，直接生成并显示，不用再点「生成」
    try {
      const p = await api('/api/preview', 'POST', {});
      setEntries(p.entries);
    } catch { /* 生成失败不阻塞页面 */ }
  }
  renderProviders();
  renderProxies();
  refreshProxySelects();
  renderDynamic();
  setApplyResult(lastApplySummary(data.lastApply), 'muted');
  updateFoldAllLabel();
  loaded = true;
}

// ---- 交互 ----

document.addEventListener('input', (e) => {
  const el = e.target;
  const ds = el.dataset || {};
  const val = el.type === 'checkbox' ? el.checked : el.value;
  const card = el.closest('.provider-card');

  const proxyRow = el.closest('.proxy-row');
  if (proxyRow && ds.proxyField) {
    const x = state.proxies.find((v) => v.id === proxyRow.dataset.proxyId);
    if (!x) return;
    x[ds.proxyField] = val;
    // 密码等失焦后再保存，避免输入到一半就整行重绘或写入
    if (ds.proxyField !== 'password') scheduleProxySave();
    updatePoolUi();
    return;
  }

  if (ds.model !== undefined) {
    const p = providerById(card.dataset.pid);
    if (!p) return;
    const set = new Set(p.selected || []);
    if (el.checked) set.add(ds.model); else set.delete(ds.model);
    p.selected = [...set];
    el.closest('.model-item').classList.toggle('picked', el.checked);
    const hiddenFree = uiFor(p.id).hideFree ? (p.models || []).filter((m) => m.free).length : 0;
    const pickedFree = (p.models || []).filter((m) => m.free && p.selected.includes(m.id)).length;
    const visible = visibleModels(p).length;
    card.querySelector('[data-role="count"]').textContent =
      `显示 ${visible} / ${(p.models || []).length} 个 · 已选 ${p.selected.length} 个`
      + (hiddenFree ? ` · 已隐藏 ${hiddenFree} 个零定价模型` : '')
      + (pickedFree ? ` · 已选中 ${pickedFree} 个零定价模型` : '');
    card.querySelector('[data-role="sub"]').textContent =
      `${p.selected.length} 个模型已选 · ${state.channels.filter((c) => c.providerId === p.id).length} 条渠道`;
    scheduleSave();
    return;
  }
  if (ds.filter) {
    if (!card) return;
    const u = uiFor(card.dataset.pid);
    u[ds.filter] = val;
    const p = providerById(card.dataset.pid);
    if (!p) return;
    if (ds.filter === 'search') {
      // 搜索逐字符重绘几百行会卡，稍作防抖
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        const c2 = document.querySelector(`.provider-card[data-pid="${p.id}"]`);
        if (c2) renderModelList(p, c2);
      }, 120);
    } else {
      renderModelList(p, card);
    }
    return;
  }
  if (ds.field) {
    if (!card) return;
    const p = providerById(card.dataset.pid);
    if (!p) return;
    p[ds.field] = val;
    if (ds.field === 'noAuth') {
      const keyInput = card.querySelector('[data-field="apiKey"]');
      if (keyInput) keyInput.disabled = el.checked;
    }
    if (ds.field === 'egressMode') {
      const sel = card.querySelector('[data-field="proxyId"]');
      if (sel) sel.disabled = val !== 'single';
      if (val !== 'single') { p.proxyId = ''; if (sel) sel.value = ''; }
    }
    // 服务商信息改动自动落库；密钥等失焦后再存，避免输入到一半被写入
    if (ds.field !== 'apiKey') scheduleSave();
    return;
  }
  if (ds.chField) {
    const wrap = el.closest('.channel');
    const c = channelById(wrap.dataset.cid);
    if (!c) return;
    c[ds.chField] = val;
    if (ds.chField === 'egressMode') {
      const sel = wrap.querySelector('[data-ch-field="proxyId"]');
      if (sel) sel.disabled = val !== 'single';
      if (val !== 'single') { c.proxyId = ''; if (sel) sel.value = ''; }
    }
    if (ds.chField === 'enabled') wrap.classList.toggle('disabled', !el.checked);
  }
});

// 密钥失焦后再保存，避免输入到一半被写入数据库
document.addEventListener('change', (e) => {
  const ds = e.target.dataset || {};
  if (ds.field === 'apiKey') scheduleSave();
  else if (ds.proxyField === 'password') scheduleProxySave();
  else if (ds.field === 'egressMode' || ds.field === 'proxyId') {
    const card = e.target.closest('.provider-card');
    const p = card ? providerById(card.dataset.pid) : null;
    if (p) { p[ds.field] = e.target.value; scheduleSave(); }
  } else if (ds.chField === 'egressMode' || ds.chField === 'proxyId') {
    const wrap = e.target.closest('.channel');
    const c = wrap ? channelById(wrap.dataset.cid) : null;
    if (c) c[ds.chField] = e.target.value;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
});
document.addEventListener('click', (e) => {
  if (e.target.dataset && e.target.dataset.act === 'close-modal') closeModal();
  // 点空白处收起「更多操作」
  document.querySelectorAll('.more[open]').forEach((d) => {
    if (!d.contains(e.target)) d.open = false;
  });
});
$('#btnCloseModal').addEventListener('click', closeModal);

// 折叠标题里的按钮只执行自身动作，不连带把整块展开 / 收起
document.addEventListener('click', (e) => {
  if (e.target instanceof Element
    && e.target.closest('summary button, summary a, summary input, summary select')) {
    e.preventDefault();
  }
}, true);

// 整行点击：服务商卡片折叠、可用模型详情、已生成渠道编辑
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof Element) || isRowControl(t)) return;

  const head = t.closest('.provider-head');
  if (head) { toggleCard(head.closest('.provider-card')); return; }

  const mRow = t.closest('.model-row');
  if (mRow) {
    const card = mRow.closest('.provider-card');
    const p = card ? providerById(card.dataset.pid) : null;
    if (!p) return;
    const u = uiFor(p.id);
    const mid = mRow.dataset.modelId;
    if (u.detailModels.has(mid)) u.detailModels.delete(mid);
    else u.detailModels.add(mid);
    renderModelList(p, card);
    return;
  }

  const compact = t.closest('.channel.compact .compact-row');
  if (compact) {
    const wrap = compact.closest('.channel');
    const c = channelById(wrap.dataset.cid);
    if (!c) return;
    uiFor(c.providerId || '__standalone__').editCid = c.id;
    renderDynamic();
    return;
  }

  const fullHead = t.closest('.channel:not(.compact) .channel-head');
  if (fullHead) {
    const wrap = fullHead.closest('.channel');
    const c = channelById(wrap.dataset.cid);
    if (!c) return;
    uiFor(c.providerId || '__standalone__').editCid = '';
    renderDynamic();
  }
});

// 路径与令牌改动即时记住，刷新后自动回填
$('#targetPath').addEventListener('change', async () => {
  try {
    await api('/api/prefs', 'POST', { targetPath: $('#targetPath').value.trim() });
  } catch (err) { showMsg('路径记忆失败：' + err.message, 'err', '#exportMsg'); }
});

$('#token').addEventListener('change', async () => {
  try { if (loaded) await saveAll(true); } catch (err) { showMsg(err.message, 'err', '#exportMsg'); }
});

async function saveChannel(cid) {
  const c = channelById(cid);
  if (!c) return;
  const r = await api('/api/channel', 'PATCH', {
    id: c.id, alias: c.alias, label: c.label, localId: c.label,
    url: c.url || '', apiKey: c.apiKey || '', upstreamModel: c.upstreamModel || '',
    noAuth: Boolean(c.noAuth),
    supportsToolCall: c.supportsToolCall, supportsImages: c.supportsImages,
    supportsReasoning: c.supportsReasoning, enabled: c.enabled,
    egressMode: c.egressMode || 'direct', proxyId: c.proxyId || '',
  });
  state.channels = r.channels;
  return r;
}

document.addEventListener('click', async (e) => {
  const menuBtn = e.target.closest('.more-menu button');
  if (menuBtn) menuBtn.closest('.more').open = false;
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const card = btn.closest('.provider-card');
  const pid = card ? card.dataset.pid : '';
  const p = pid ? providerById(pid) : null;
  const wrap = btn.closest('.channel');
  const cid = wrap ? wrap.dataset.cid : '';
  const c = cid ? channelById(cid) : null;
  try {
    if (act === 'toggle-pool') {
      const row = btn.closest('.proxy-row');
      const x = state.proxies.find((v) => v.id === row.dataset.proxyId);
      if (!x) return;
      x.inPool = x.inPool === false;
      await saveProxies(true);
      showMsg(x.inPool
        ? `已把「${x.label || x.host}」加入代理池，轮询会用到它`
        : `已把「${x.label || x.host}」移出代理池，轮询不再使用它`, 'ok', '#proxyMsg');
    } else if (act === 'test-proxy') {
      const row = btn.closest('.proxy-row');
      const out = row.querySelector('[data-role="proxy-test"]');
      if (!row.dataset.proxyId) {
        out.textContent = '代理正在保存，请稍后再试';
        out.className = 'hint err';
        return;
      }
      btn.disabled = true;
      out.textContent = '正在测试出口…';
      out.className = 'hint';
      try {
        const r = await api('/api/proxy-test', 'POST', { id: row.dataset.proxyId });
        out.textContent = r.ok ? `出口 IP ${r.ip} · ${r.target}` : `测试失败：${r.error}`;
        out.className = r.ok ? 'hint ok' : 'hint err';
      } catch (err) {
        out.textContent = '测试失败：' + err.message;
        out.className = 'hint err';
      }
      btn.disabled = false;
    } else if (act === 'apply-proxy') {
      const row = btn.closest('.proxy-row');
      const pid = row.querySelector('[data-proxy-apply]').value;
      const p = state.providers.find((v) => v.id === pid);
      if (!p) { showMsg('请先添加服务商，再应用代理', 'err', '#proxyMsg'); return; }
      if (!row.dataset.proxyId) { showMsg('代理正在保存，请稍后再试', '', '#proxyMsg'); return; }
      p.egressMode = 'single';
      p.proxyId = row.dataset.proxyId;
      await saveAll(true);
      refreshProxySelects();
      updateEgressBadges();
      updateProxyUsage();
      showMsg(`已把「${p.label || p.id}」的网络出口切到这条代理`, 'ok', '#proxyMsg');
    } else if (act === 'delete-proxy') {
      const row = btn.closest('.proxy-row');
      const proxyId = row.dataset.proxyId;
      if (btn.dataset.confirm !== '1') {
        btn.dataset.confirm = '1';
        btn.textContent = '确认删除';
        showMsg('再次点击才会删除这条代理', '', '#proxyMsg');
        return;
      }
      state.proxies = state.proxies.filter((x) => x.id !== proxyId);
      // 引用了被删代理的服务商回退直连，避免留下失效配置
      state.providers.forEach((v) => {
        if (v.proxyId === proxyId) { v.proxyId = ''; v.egressMode = 'direct'; }
      });
      await saveProxies(true);
      await saveAll(true);
      renderProxies();
      refreshProxySelects();
      showMsg('已删除该代理，引用它的服务商已回退为直连', 'ok', '#proxyMsg');
    } else if (act === 'toggle-card') {
      toggleCard(card);
    } else if (act === 'delete-provider') {
      if (btn.dataset.confirm !== '1') {
        btn.dataset.confirm = '1';
        btn.textContent = '确认删除整组';
        showMsg(`再次点击才会删除服务商「${p.label || '未命名'}」及其下所有渠道`, '');
        return;
      }
      state.providers = state.providers.filter((x) => x.id !== pid);
      delete ui[pid];
      await saveAll(true);
      renderProviders();
      renderDynamic();
      showMsg('已删除该服务商及其渠道', 'ok');
    } else if (act === 'clear-key') {
      p.apiKey = CLEAR_KEY;
      await saveAll(true);
      renderProviders();
      renderDynamic();
      showMsg(`已清除服务商「${p.label || '未命名'}」的密钥，整组渠道同步更新`, 'ok');
    } else if (act === 'discover') {
      if (!p.url) return showMsg('请先填写服务商地址', 'err');
      if (!p.noAuth && !p.apiKey && !p.hasKey) return showMsg('请填写 API Key，或勾选「无需密钥」', 'err');
      btn.disabled = true;
      btn.textContent = '探测中…';
      uiFor(pid).meta = '正在自动尝试多个常见模型列表地址…';
      card.querySelector('[data-role="meta"]').textContent = uiFor(pid).meta;
      try {
        await saveAll(true);
        const r = await api('/api/discover', 'POST', { id: pid });
        uiFor(pid).meta = `已找到 ${r.models.length} 个模型（来源 ${r.modelsUrl}，尝试 ${r.attempts} 个地址）`;
        uiFor(pid).openCard = true;
        uiFor(pid).openModels = true;
        await load();
        showMsg(`已获取 ${r.models.length} 个模型，勾选即可自动生成渠道`, 'ok');
      } catch (err) {
        uiFor(pid).meta = '';
        card.querySelector('[data-role="meta"]').textContent = '';
        showMsg('获取模型失败：' + err.message, 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = '获取模型';
      }
    } else if (act === 'select-all' || act === 'select-none') {
      const p2 = providerById(pid);
      if (!p2) return;
      const ids = visibleModels(p2).map((m) => m.id);
      p2.selected = act === 'select-all'
        ? [...new Set([...(p2.selected || []), ...ids])] : [];
      renderModelList(p2, card);
      card.querySelector('[data-role="sub"]').textContent =
        `${p2.selected.length} 个模型已选 · ${state.channels.filter((x) => x.providerId === pid).length} 条渠道`;
      scheduleSave();
    } else if (act === 'edit') {
      const u = uiFor(c.providerId || '__standalone__');
      u.editCid = u.editCid === c.id ? '' : c.id;
      renderDynamic();
    } else if (act === 'save-channel') {
      await saveChannel(c.id);
      uiFor(c.providerId || '__standalone__').editCid = '';
      renderDynamic();
      showMsg('已保存渠道修改', 'ok');
    } else if (act === 'refresh-name') {
      await load();
      showMsg('名称已按统一格式刷新', 'ok');
    } else if (act === 'del') {
      if (btn.dataset.confirm !== '1') {
        btn.dataset.confirm = '1';
        btn.textContent = '确认删除';
        showMsg(`再次点击「确认删除」才会移除渠道「${c.label || c.alias}」`, '');
        return;
      }
      const r = await api('/api/channel', 'DELETE', { id: c.id });
      state.providers = r.providers;
      state.channels = r.channels;
      renderDynamic();
      showMsg('已删除渠道' + (c.providerId ? '，并取消该模型的勾选' : ''), 'ok');
    } else if (act === 'test') {
      const result = wrap.querySelector('[data-role="testresult"]');
      result.textContent = '测试中…';
      result.className = 'msg';
      if (uiFor(c.providerId || '__standalone__').editCid === c.id) await saveChannel(c.id);
      const r = await api('/api/test', 'POST', { id: c.id });
      result.textContent = `${r.ok ? '成功' : '失败'}：${r.message}${r.status ? '（HTTP ' + r.status + '）' : ''}`;
      result.className = 'msg ' + (r.ok ? 'ok' : 'err');
    }
  } catch (err) {
    showMsg(err.message, 'err');
    if (btn.dataset.confirm === '1') {
      btn.dataset.confirm = '';
      btn.textContent = act === 'delete-provider' ? '删除服务商' : '删除';
    }
  }
});

$('#btnAddProxy').addEventListener('click', async () => {
  $('#proxyCard').open = true;
  const before = new Set(state.proxies.map((x) => x.id));
  state.proxies.push({
    id: '', label: '', type: 'http', host: '127.0.0.1', port: 7890,
    username: '', password: '', enabled: true, inPool: true, hasAuth: false,
  });
  renderProxies();
  try {
    await saveProxies(true); // 由服务端分配正式 ID，随后重绘以同步 data-proxy-id
    const fresh = state.proxies.find((x) => !before.has(x.id));
    if (fresh) state.proxyOpen.add(fresh.id); // 新加的一条保持展开，方便立刻填写
    renderProxies();
    showMsg('已添加一条代理，填好主机与端口会自动保存', 'ok', '#proxyMsg');
  } catch (err) {
    showMsg('添加失败：' + err.message, 'err', '#proxyMsg');
  }
});

$('#btnProxyFold').addEventListener('click', () => {
  const rows = [...document.querySelectorAll('#proxyList .proxy-row')];
  const shouldOpen = rows.some((d) => !d.open);
  rows.forEach((d) => { d.open = shouldOpen; });
  updateProxyFoldLabel();
});

// details 的 toggle 不冒泡，用捕获阶段同步「全部展开/收起」按钮文字
document.addEventListener('toggle', (e) => {
  if (e.target.classList && e.target.classList.contains('proxy-row')) updateProxyFoldLabel();
}, true);

$('#btnAddProvider').addEventListener('click', async () => {
  try {
    if (!loaded) throw new Error('配置尚未加载完成，请刷新页面后再添加');
    const fresh = {
      id: '', label: '', url: '', apiKey: '', noAuth: false,
      prefix: '', chatUrl: '', modelsUrl: '', selected: [],
    };
    const body = { providers: [...providerPayload(), fresh], token: $('#token').value.trim() };
    await api('/api/providers', 'PUT', body);
    await load();
    const last = state.providers[state.providers.length - 1];
    if (last) {
      uiFor(last.id).openCard = true;
      renderProviders();
      renderDynamic();
    }
    updateFoldAllLabel();
    showMsg('已新增一组服务商，填好名字 / 地址 / 密钥后点「获取模型」', 'ok');
  } catch (err) { showMsg(err.message, 'err'); }
});

$('#btnAddStandalone').addEventListener('click', async () => {
  try {
    const r = await api('/api/channel', 'POST', { alias: '', label: '自定义渠道', url: '', upstreamModel: '' });
    await load();
    ui.__standalone__ = ui.__standalone__ || uiFor('__standalone__');
    ui.__standalone__.editCid = r.id;
    renderDynamic();
    showMsg('已添加独立渠道，填好字段后点「保存渠道」', 'ok');
  } catch (err) { showMsg(err.message, 'err'); }
});

$('#btnPresets').addEventListener('click', async () => {
  try {
    const r = await api('/api/presets', 'POST', {});
    await load();
    showMsg(r.added ? `已载入 ${r.added} 个示例渠道，密钥需自行填写` : '示例渠道已存在，未重复添加', 'ok');
  } catch (err) { showMsg(err.message, 'err'); }
});

$('#btnSave').addEventListener('click', () => saveAll().catch((e) => showMsg(e.message, 'err')));

$('#btnFoldAll').addEventListener('click', () => {
  const anyOpen = state.providers.some((p) => uiFor(p.id).openCard);
  state.providers.forEach((p) => { uiFor(p.id).openCard = !anyOpen; });
  renderProviders();
  renderDynamic();
  updateFoldAllLabel();
});

async function saveNameTemplate(value, tip) {
  try {
    const r = await api('/api/prefs', 'POST', { nameTemplate: value });
    await load();
    setEntries(r.entries);
    $('#nameTemplate').value = r.nameTemplate;
    showMsg(tip, 'ok', '#exportMsg');
  } catch (err) {
    showMsg(err.message, 'err', '#exportMsg');
    await load();
  }
}

$('#nameTemplate').addEventListener('change', () => {
  saveNameTemplate($('#nameTemplate').value.trim(),
    '统一名称已更新，配置片段已刷新；点「备份并写入」可覆盖客户端里的旧名称');
});

$('#btnNameReset').addEventListener('click', () => {
  saveNameTemplate(DEFAULT_NAME_TEMPLATE, '已恢复默认格式 {provider}·{modelLower}');
});

$('#btnPreview').addEventListener('click', async () => {
  try {
    const r = await api('/api/preview', 'POST', {});
    setEntries(r.entries, true);
    showMsg(r.entries.length
      ? `已生成 ${r.entries.length} 条，本地 ID 互不相同`
      : '还没有已启用的渠道，请先添加渠道', r.entries.length ? 'ok' : 'err', '#exportMsg');
  } catch (err) { showMsg(err.message, 'err', '#exportMsg'); }
});

$('#btnCopy').addEventListener('click', async () => {
  if (!entriesText) return showMsg('请先点「生成」', 'err', '#exportMsg');
  try {
    await navigator.clipboard.writeText(entriesText);
    showMsg('已复制到剪贴板', 'ok', '#exportMsg');
  } catch { showMsg('复制失败，请手动选中代码框内容', 'err', '#exportMsg'); }
});

$('#btnDownload').addEventListener('click', () => {
  if (!entriesText) return showMsg('请先点「生成」', 'err', '#exportMsg');
  const blob = new Blob([entriesText], { type: 'application/json;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'models.snippet.json';
  a.click();
  URL.revokeObjectURL(a.href);
  showMsg('已下载配置片段', 'ok', '#exportMsg');
});

$('#btnApply').addEventListener('click', async () => {
  const target = $('#targetPath').value.trim();
  if (!target) {
    setApplyResult('请填写 models.json 绝对路径', 'err');
    showModal('无法写入', '<p>请先填写 models.json 的绝对路径，填过一次后会自动记住。</p>');
    return;
  }
  const btn = $('#btnApply');
  btn.disabled = true;
  btn.textContent = '写入中…';
  setApplyResult('正在写入并生成备份…', 'pending');
  try {
    await api('/api/prefs', 'POST', { targetPath: target });
    const r = await api('/api/apply', 'POST', { path: target });
    const a = r.lastApply || {};
    state.lastApply = a;
    setApplyResult(`写入完成 ${a.at} · 新增 ${r.added} / 更新 ${r.updated} / 移除 ${r.removed || 0}${r.replaced ? ` / 替换旧名称 ${r.replaced}` : ''} · 备份 ${r.backupName}`, 'ok');
    const rows = [
      ['目标文件', r.file],
      ['备份文件', `${r.backupName}（本机时间命名）`],
      ['写入时间', `${a.at}（本机时间）`],
      ['写入结果', `共 ${r.total} 条：新增 ${r.added} 条、更新 ${r.updated} 条、移除 ${r.removed || 0} 条${r.replaced ? `（其中旧名称替换 ${r.replaced} 条）` : ''}（${r.format === 'array' ? '数组' : '对象'}结构）`],
      ['名称格式', $('#nameTemplate').value || DEFAULT_NAME_TEMPLATE],
    ].map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><code>${esc(v)}</code></div>`).join('');
    showModal('写入成功', `<p>配置已写入并备份完成，id 与 name 相同，设置页、模型下拉、网关页三处名称已统一。已按当前勾选同步，取消勾选或禁用的旧模型已从客户端配置里移除。</p>${rows}<p class="hint" style="margin:12px 0 0">无需重复点击。完全退出并重启客户端后，即可看到新的统一名称。</p>`);
    const p = await api('/api/preview', 'POST', {});
    setEntries(p.entries);
  } catch (err) {
    setApplyResult('写入失败：' + err.message, 'err');
    showModal('写入失败', `<p class="modal-err">${esc(err.message)}</p><p class="hint" style="margin:10px 0 0">请检查路径是否存在、文件是否为合法 JSON，然后重试。</p>`);
  } finally {
    btn.disabled = false;
    btn.textContent = '备份并写入';
  }
});

// ---- 配置导入 / 导出 ----
const CFG_TABLES = ['providers', 'channels', 'proxies', 'settings'];
function setExportHref() {
  $('#btnExportCfg').href = $('#cfgNoSecrets').checked
    ? '/api/config/export?secrets=0' : '/api/config/export?secrets=1';
}
setExportHref();
$('#cfgNoSecrets').addEventListener('change', setExportHref);

$('#btnImportCfg').addEventListener('click', () => {
  const panel = $('#importPanel');
  panel.hidden = !panel.hidden;
});

$('#cfgMode').addEventListener('change', () => {
  $('#cfgConfirmWrap').hidden = $('#cfgMode').value !== 'replace';
});

$('#btnDoImport').addEventListener('click', async () => {
  const fileInput = $('#cfgFile');
  const file = fileInput.files && fileInput.files[0];
  if (!file) return showMsg('请先选择导出的配置文件', 'err', '#cfgMsg');
  const mode = $('#cfgMode').value;
  if (mode === 'replace' && !$('#cfgConfirm').checked) {
    return showMsg('覆盖导入需先勾选确认框', 'err', '#cfgMsg');
  }
  const btn = $('#btnDoImport');
  btn.disabled = true;
  btn.textContent = '导入中…';
  try {
    const text = await file.text();
    const cfg = JSON.parse(text);
    if (mode === 'replace') cfg.__confirmReplace = true;
    const r = await api('/api/config/import?mode=' + mode, 'POST', cfg);
    const sum = CFG_TABLES.map((t) => {
      const imp = (r.imported && r.imported[t]) || 0;
      const skip = (r.skipped && r.skipped[t]) || 0;
      return `${t} 导入 ${imp}${skip ? `、跳过 ${skip}` : ''}`;
    }).join('； ');
    await load();
    showMsg(`导入完成（${mode}${r.includesSecrets ? '，含密钥' : '，已脱敏'}）：${sum}`, 'ok', '#cfgMsg');
    fileInput.value = '';
  } catch (err) {
    showMsg('导入失败：' + err.message, 'err', '#cfgMsg');
  } finally {
    btn.disabled = false;
    btn.textContent = '导入选中的文件';
  }
});

load().catch((err) => {
  setStatus(false);
  showMsg('加载配置失败：' + err.message, 'err');
});
