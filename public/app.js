'use strict';

const $ = (s) => document.querySelector(s);
const CLEAR_KEY = '__CLEAR_KEY__';

let state = { providers: [], channels: [], token: '', port: 8787 };
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
  return `上次写入 ${a.at}（本机时间）· 新增 ${a.added} / 更新 ${a.updated}${a.replaced ? ` / 替换旧名称 ${a.replaced}` : ''} · 备份 ${a.backupName}`;
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
      <div class="provider-actions">
        <button class="btn primary small" data-act="discover">获取模型</button>
        <span class="provider-meta" data-role="meta">${esc(u.meta)}</span>
      </div>
      <details class="advanced">
        <summary>高级选项（自动推导失败时才需要）</summary>
        <div class="discover-grid adv-grid">
          <div class="field"><label>别名前缀 / 本地 ID 前缀</label><input type="text" data-field="prefix" value="${esc(p.prefix)}" placeholder="按服务商名字自动生成"></div>
          <div class="field"><label>对话地址（自动推导，可覆盖）</label><input type="text" data-field="chatUrl" value="${esc(p.chatUrl)}" placeholder="留空自动推导"></div>
          <div class="field"><label>模型列表地址（自动探测，可覆盖）</label><input type="text" data-field="modelsUrl" value="${esc(p.modelsUrl)}" placeholder="留空自动尝试多个地址"></div>
        </div>
        <p class="hint" style="margin:10px 0 0">两个接口不在同一路径时分别填这两项，例如模型列表在 <code>/zen/v1/models</code>、对话在 <code>/inference/openai/v1/chat/completions</code>。</p>
        <div class="adv-actions"><button class="btn small danger" data-act="clear-key">清除密钥</button></div>
      </details>

      <details class="fold" data-fold="models" ${u.openModels ? 'open' : ''}>
        <summary>可用模型 <span class="fold-note" data-role="model-count"></span></summary>
        <div class="fold-body">
          <p class="hint" style="margin:0 0 10px">勾选即自动生成渠道，取消勾选即移除。</p>
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

      <details class="fold" data-fold="channels" ${u.openChannels ? 'open' : ''}>
        <summary>已生成的渠道 <span class="fold-note" data-role="channel-count"></span></summary>
        <div class="fold-body">
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

function modelRowHtml(p, m) {
  const picked = (p.selected || []).includes(m.id);
  const cap = m.capabilities || {};
  const badge = (on, text, src) => `<span class="cap ${on ? 'yes' : ''}" title="来源：${src === 'api' ? '上游接口声明' : '按名称推断'}">${on ? '✓' : '–'} ${text}${src === 'inferred' ? ' *' : ''}</span>`;
  const meta = [
    m.context ? Math.round(m.context / 1000) + 'K' : '',
    m.protocol && !['chat-completions', 'unknown'].includes(m.protocol) ? esc(m.protocol) : '',
  ].filter(Boolean).join(' · ');
  return `<label class="model-row ${picked ? 'picked' : ''}">
    <input type="checkbox" data-model="${esc(m.id)}" ${picked ? 'checked' : ''}>
    <span class="model-id" title="${esc(m.name)}${m.description ? ' — ' + esc(m.description) : ''}">${esc(m.id)}</span>
    <span class="model-caps">
      ${badge(cap.supportsImages, '图片', m.sources?.images)}
      ${badge(cap.supportsToolCall, '工具', m.sources?.toolCall)}
      ${badge(cap.supportsReasoning, '推理', m.sources?.reasoning)}
      ${m.free ? '<span class="cap free" title="上游标价为 0；部分服务商限制为仅自家客户端可用">零定价 · 可能被限</span>' : ''}
    </span>
    <span class="model-meta">${meta}</span>
  </label>`;
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

// ---- 保存 ----

function providerPayload() {
  return state.providers.map((p) => ({
    id: p.id, label: p.label, url: p.url, apiKey: p.apiKey || '',
    noAuth: p.noAuth, prefix: p.prefix, chatUrl: p.chatUrl,
    modelsUrl: p.modelsUrl, selected: p.selected || [],
  }));
}

async function saveAll(quiet = false) {
  if (!loaded) throw new Error('配置尚未加载完成，请刷新页面后再保存');
  const r = await api('/api/providers', 'PUT', {
    providers: providerPayload(), token: $('#token').value.trim(),
  });
  state.providers = r.providers.map((p) => ({ ...p, apiKey: '' }));
  state.channels = r.channels;
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
    channels: data.channels, token: data.token, port: data.port,
    targetPath: data.targetPath || '', lastApply: data.lastApply || null,
  };
  $('#token').value = data.token || '';
  $('#nameTemplate').value = data.nameTemplate || DEFAULT_NAME_TEMPLATE;
  $('#targetPath').value = data.targetPath || '';
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

  if (ds.model !== undefined) {
    const p = providerById(card.dataset.pid);
    if (!p) return;
    const set = new Set(p.selected || []);
    if (el.checked) set.add(ds.model); else set.delete(ds.model);
    p.selected = [...set];
    el.closest('.model-row').classList.toggle('picked', el.checked);
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
    // 服务商信息改动自动落库；密钥等失焦后再存，避免输入到一半被写入
    if (ds.field !== 'apiKey') scheduleSave();
    return;
  }
  if (ds.chField) {
    const wrap = el.closest('.channel');
    const c = channelById(wrap.dataset.cid);
    if (!c) return;
    c[ds.chField] = val;
    if (ds.chField === 'enabled') wrap.classList.toggle('disabled', !el.checked);
  }
});

// 密钥失焦后再保存，避免输入到一半被写入数据库
document.addEventListener('change', (e) => {
  if (e.target.dataset && e.target.dataset.field === 'apiKey') scheduleSave();
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
    if (act === 'toggle-card') {
      const u = uiFor(pid);
      u.openCard = !u.openCard;
      card.querySelector('.provider-body').hidden = !u.openCard;
      card.querySelectorAll('[data-act="toggle-card"]').forEach((b) => {
        b.textContent = b.classList.contains('fold-btn')
          ? (u.openCard ? '▾' : '▸') : (u.openCard ? '收起' : '展开');
      });
      updateFoldAllLabel();
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
    setApplyResult(`写入完成 ${a.at} · 新增 ${r.added} / 更新 ${r.updated}${r.replaced ? ` / 替换旧名称 ${r.replaced}` : ''} · 备份 ${r.backupName}`, 'ok');
    const rows = [
      ['目标文件', r.file],
      ['备份文件', `${r.backupName}（本机时间命名）`],
      ['写入时间', `${a.at}（本机时间）`],
      ['写入结果', `共 ${r.total} 条：新增 ${r.added} 条、更新 ${r.updated} 条${r.replaced ? `、替换旧名称 ${r.replaced} 条` : ''}（${r.format === 'array' ? '数组' : '对象'}结构）`],
      ['名称格式', $('#nameTemplate').value || DEFAULT_NAME_TEMPLATE],
    ].map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><code>${esc(v)}</code></div>`).join('');
    showModal('写入成功', `<p>配置已写入并备份完成，id 与 name 相同，设置页、模型下拉、网关页三处名称已统一。</p>${rows}<p class="hint" style="margin:12px 0 0">无需重复点击。完全退出并重启客户端后，即可看到新的统一名称。</p>`);
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

load().catch((err) => {
  setStatus(false);
  showMsg('加载配置失败：' + err.message, 'err');
});
