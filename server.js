'use strict';

// 通用模型别名网关：多服务商分组配置 + 按渠道改写 model 名的转发，单进程零第三方依赖
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'channels.db');
const CLEAR_KEY = '__CLEAR_KEY__';
const NO_AUTH_KEY = '__NO_AUTH__'; // 无需密钥的服务商，避免被「未填密钥」拦截

const db = new DatabaseSync(DB_PATH);

function isRealKey(k) {
  return Boolean(k) && !k.startsWith('<');
}

function safeArray(s) {
  try {
    const v = JSON.parse(String(s || ''));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function safeJson(s, fallback = null) {
  try { return JSON.parse(String(s || '')); } catch { return fallback; }
}

// 备份与提示统一用本机时间，避免 UTC 的 T/Z 让人看不出几点
function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function localTime(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function shortModel(model) {
  const parts = String(model || '').split('/');
  return parts[parts.length - 1] || 'model';
}

// 三处统一：id、name、网关页面显示名都用同一个「服务商·模型名」
const DEFAULT_NAME_TEMPLATE = '{provider}·{modelLower}';

function nameTemplate() {
  return String(getSetting('name_template', '') || '').trim() || DEFAULT_NAME_TEMPLATE;
}

function renderName(tpl, ctx) {
  const s = String(tpl).replace(/\{(provider|model|modelLower|fullModel|alias)\}/g,
    (_, k) => String(ctx[k] ?? ''));
  return s.trim() || String(ctx.model || ctx.alias || 'model');
}

function providerOfRow(row) {
  const pid = row.provider_id || row.providerId || '';
  if (pid) {
    const p = db.prepare('SELECT label FROM providers WHERE id = ?').get(pid);
    if (p && String(p.label || '').trim()) return String(p.label).trim();
  }
  // 独立渠道没有服务商分组，固定用域名，避免刷新后名称漂移
  try { return new URL(String(row.url)).hostname; } catch { return row.alias || '服务商'; }
}

function channelName(row, tpl) {
  const model = row.upstream_model || row.upstreamModel || '';
  return renderName(tpl || nameTemplate(), {
    provider: providerOfRow(row),
    model: shortModel(model),
    modelLower: shortModel(model).toLowerCase(),
    fullModel: model,
    alias: row.alias || '',
  });
}

// 同名时自动加 -2/-3，保证 id 全局唯一
function nameMapForRows(rows, tpl) {
  const used = new Set();
  const map = new Map();
  rows.forEach((r) => {
    let n = channelName(r, tpl).slice(0, 120).trim();
    n = pickUnique(n, used, 120);
    used.add(n);
    map.set(r.id, n);
  });
  return map;
}

// 把统一名称回写到渠道，label 与 local_id 始终等于写入客户端的 name/id
function refreshUnifiedNames() {
  const rows = db.prepare('SELECT * FROM channels ORDER BY sort_order, alias').all();
  const names = nameMapForRows(rows, nameTemplate());
  const update = db.prepare('UPDATE channels SET label = ?, local_id = ? WHERE id = ?');
  rows.forEach((r) => update.run(names.get(r.id), names.get(r.id), r.id));
  return rows.length;
}

function defaultLocalId(alias, model) {
  return `${alias}:${shortModel(model)}`;
}

function maskKey(k) {
  return !k ? '' : (k.length <= 4 ? '****' : '****' + k.slice(-4));
}

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '') || 'ch';
}

// 中文服务商名 slug 后会变空，改用域名主体做前缀，避免多家都叫 ch
function prefixFrom(label, url, override) {
  const o = String(override || '').trim();
  if (o) return slug(o);
  const byLabel = slug(String(label || ''));
  if (byLabel && byLabel !== 'ch') return byLabel;
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    const parts = host.split('.').filter((x) => !['api', 'www', 'inference'].includes(x));
    const s = slug(parts[0] || host.replace(/\./g, ''));
    if (s && s !== 'ch') return s;
  } catch { /* 地址非法时用默认值 */ }
  return 'ch';
}

function pickUnique(base, used, maxLen = 64) {
  let v = String(base).slice(0, maxLen);
  let n = 2;
  while (used.has(v)) {
    const s = '-' + n;
    v = String(base).slice(0, maxLen - s.length).replace(/-$/, '') + s;
    n += 1;
  }
  used.add(v);
  return v;
}

// ---- 表结构与迁移 ----

function initSchema() {
  const meta = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channels'").get();
  const legacy = Boolean(meta) && !/\bid\s+TEXT\s+PRIMARY\s+KEY/i.test(String(meta.sql || ''));
  if (legacy) db.exec('ALTER TABLE channels RENAME TO channels_legacy');

  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      alias TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      upstream_model TEXT NOT NULL DEFAULT '',
      local_id TEXT NOT NULL DEFAULT '',
      supports_tool_call INTEGER NOT NULL DEFAULT 1,
      supports_images INTEGER NOT NULL DEFAULT 0,
      supports_reasoning INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      provider_id TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      no_auth INTEGER NOT NULL DEFAULT 0,
      prefix TEXT NOT NULL DEFAULT '',
      chat_url TEXT NOT NULL DEFAULT '',
      models_url TEXT NOT NULL DEFAULT '',
      models_json TEXT NOT NULL DEFAULT '[]',
      selected_json TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  const cols = db.prepare('PRAGMA table_info(channels)').all().map((c) => c.name);
  if (!cols.includes('provider_id')) {
    db.exec("ALTER TABLE channels ADD COLUMN provider_id TEXT NOT NULL DEFAULT ''");
  }

  if (legacy) {
    const rows = db.prepare('SELECT * FROM channels_legacy').all();
    // 旧版自动写入的空密钥示例不迁入，改为零渠道起步
    const onlySamples = rows.length === 3
      && rows.every((r) => ['or', 'oc', 'sf'].includes(r.alias) && !isRealKey(r.api_key));
    if (!onlySamples) {
      const insert = db.prepare(`INSERT OR IGNORE INTO channels
        (id, alias, label, url, api_key, upstream_model, local_id, supports_tool_call, supports_images, supports_reasoning, enabled, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      rows.forEach((r) => insert.run(randomUUID(), r.alias, r.label, r.url, r.api_key,
        r.upstream_model, r.local_id, r.supports_tool_call, r.supports_images,
        r.supports_reasoning, r.enabled, r.sort_order));
    }
    db.exec('DROP TABLE channels_legacy');
  }
  migrateChannelsToProviders();
}

// 旧版渠道按上游地址归并成服务商分组，密钥与勾选状态完整保留
function deriveProviderLabel(label, url) {
  const head = String(label || '').split(' · ')[0].trim();
  if (head) return head;
  try { return new URL(String(url)).hostname; } catch { return '服务商'; }
}

function derivePrefix(localId, label, url) {
  const m = String(localId || '').match(/^([A-Za-z0-9_-]+):/);
  if (m) return m[1];
  return prefixFrom(label, url, '');
}

function migrateChannelsToProviders() {
  // 只执行一次；之后删掉所有服务商也不再把独立渠道重新归组
  if (getSetting('migrated_providers_v1', '') === '1') return;
  const rows = db.prepare("SELECT * FROM channels WHERE provider_id = '' ORDER BY sort_order, alias").all();
  if (!rows.length) {
    setSetting('migrated_providers_v1', '1');
    return;
  }
  const groups = new Map();
  rows.forEach((r) => {
    const k = r.url || '(未填地址)';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });
  const insertP = db.prepare(`INSERT INTO providers
    (id, label, url, api_key, no_auth, prefix, chat_url, models_url, models_json, selected_json, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const attach = db.prepare('UPDATE channels SET provider_id = ? WHERE id = ?');
  let order = 0;
  for (const [url, list] of groups) {
    const id = randomUUID();
    const first = list[0];
    const label = deriveProviderLabel(first.label, url);
    const prefix = derivePrefix(first.local_id, label, url);
    const keyRow = list.find((r) => isRealKey(r.api_key) && r.api_key !== NO_AUTH_KEY);
    const key = keyRow ? keyRow.api_key : '';
    const noAuth = key ? 0 : Number(list.every((r) => r.api_key === NO_AUTH_KEY));
    const selected = [...new Set(list.map((r) => r.upstream_model).filter(Boolean))];
    // 迁移时没有缓存的模型列表，用渠道反推占位条目，保证勾选状态立刻可见
    const models = selected.map((model) => {
      const r = list.find((x) => x.upstream_model === model) || {};
      return {
        id: model, name: model, context: null, protocol: 'chat-completions',
        chat: true, type: 'chat', free: false, placeholder: true, description: '',
        capabilities: {
          supportsToolCall: Boolean(r.supports_tool_call),
          supportsImages: Boolean(r.supports_images),
          supportsReasoning: Boolean(r.supports_reasoning),
        },
        sources: { images: 'api', toolCall: 'api', reasoning: 'api' },
      };
    });
    insertP.run(id, label, url === '(未填地址)' ? '' : url, noAuth ? NO_AUTH_KEY : key,
      noAuth, prefix, url === '(未填地址)' ? '' : url, '', JSON.stringify(models),
      JSON.stringify(selected), order);
    list.forEach((r) => attach.run(id, r.id));
    order += 1;
  }
  setSetting('migrated_providers_v1', '1');
}
initSchema();
refreshUnifiedNames();

// ---- 服务商读写 ----

function loadProviderRow(id) {
  const r = db.prepare('SELECT * FROM providers WHERE id = ?').get(String(id || ''));
  if (!r) return null;
  return {
    id: r.id, label: r.label, url: r.url, apiKey: r.api_key,
    noAuth: Boolean(r.no_auth), prefix: r.prefix, chatUrl: r.chat_url,
    modelsUrl: r.models_url, models: safeArray(r.models_json),
    selected: safeArray(r.selected_json), sortOrder: r.sort_order,
  };
}

function readProviders() {
  return db.prepare('SELECT * FROM providers ORDER BY sort_order, id').all().map((r) => ({
    id: r.id,
    label: r.label,
    url: r.url,
    prefix: r.prefix,
    chatUrl: r.chat_url,
    modelsUrl: r.models_url,
    noAuth: Boolean(r.no_auth),
    hasKey: !r.no_auth && isRealKey(r.api_key),
    keyHint: r.no_auth ? '无需密钥' : maskKey(r.api_key),
    models: safeArray(r.models_json),
    selected: safeArray(r.selected_json),
    channelCount: db.prepare('SELECT COUNT(*) AS n FROM channels WHERE provider_id = ?').get(r.id).n,
  }));
}

function readChannels() {
  const rows = db.prepare('SELECT * FROM channels ORDER BY sort_order, alias').all();
  const names = nameMapForRows(rows, nameTemplate());
  return rows.map((r) => {
    const na = r.api_key === NO_AUTH_KEY;
    return {
      id: r.id,
      providerId: r.provider_id || '',
      alias: r.alias,
      label: r.label,
      displayName: names.get(r.id),
      url: r.url,
      upstreamModel: r.upstream_model,
      localId: r.local_id,
      supportsToolCall: Boolean(r.supports_tool_call),
      supportsImages: Boolean(r.supports_images),
      supportsReasoning: Boolean(r.supports_reasoning),
      enabled: Boolean(r.enabled),
      noAuth: na,
      hasKey: !na && isRealKey(r.api_key),
      keyHint: na ? '无需密钥' : maskKey(r.api_key),
    };
  });
}

// 一个服务商的所有渠道共用同一份地址与密钥；勾选决定有哪些渠道
function syncProvider(p) {
  const selected = [...new Set((p.selected || []).map(String).filter(Boolean))];
  const modelMap = new Map((p.models || []).map((m) => [String(m.id), m]));
  const existing = db.prepare('SELECT * FROM channels WHERE provider_id = ?').all(p.id);
  const byModel = new Map(existing.map((r) => [r.upstream_model, r]));
  let chatUrl = String(p.chatUrl || '').trim();
  if (!chatUrl && p.url && selected.length) chatUrl = normalizeChatUrl(p.url);
  const label = String(p.label || '').trim() || '服务商';
  const prefix = String(p.prefix || '').trim() || prefixFrom(label, p.url, '');
  const key = p.noAuth ? NO_AUTH_KEY : String(p.apiKey || '');

  // 取消勾选：删掉本分组下不再需要的渠道
  existing.forEach((r) => {
    if (!selected.includes(r.upstream_model)) {
      db.prepare('DELETE FROM channels WHERE id = ?').run(r.id);
    }
  });

  const all = db.prepare('SELECT alias, local_id FROM channels').all();
  const usedAlias = new Set(all.map((r) => r.alias));
  const usedLocal = new Set(all.map((r) => r.local_id));
  const insert = db.prepare(`INSERT INTO channels
    (id, alias, label, url, api_key, upstream_model, local_id, supports_tool_call, supports_images, supports_reasoning, enabled, sort_order, provider_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM channels').get().n;

  selected.forEach((model) => {
    const row = byModel.get(model);
    if (row) {
      // 共用字段每次保存都覆盖；别名、能力开关等用户改动保留，统一名称在末尾刷新
      db.prepare('UPDATE channels SET url = ?, api_key = ? WHERE id = ?')
        .run(chatUrl, key, row.id);
      return;
    }
    const alias = pickUnique(slug(`${prefix}-${model}`), usedAlias, 32);
    const localId = pickUnique(`${prefix}:${model}`, usedLocal, 96);
    const cap = modelMap.get(model)?.capabilities || {};
    insert.run(randomUUID(), alias, `${label}·${shortModel(model)}`, chatUrl, key, model, localId,
      Number(cap.supportsToolCall !== false), Number(Boolean(cap.supportsImages)),
      Number(Boolean(cap.supportsReasoning)), 1, order, p.id);
    usedLocal.add(localId);
    usedAlias.add(alias);
    order += 1;
  });
  refreshUnifiedNames();
  return { added: selected.filter((m) => !byModel.has(m)).length, removed: existing.filter((r) => !selected.includes(r.upstream_model)).length };
}

function cleanProvider(p) {
  const id = String(p?.id || '').trim();
  const selected = Array.isArray(p.selected) ? [...new Set(p.selected.map(String).filter(Boolean))] : [];
  return {
    id: /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : randomUUID(),
    label: String(p.label || '').trim(),
    url: String(p.url || '').trim(),
    prefix: String(p.prefix || '').trim(),
    chatUrl: String(p.chatUrl || '').trim(),
    modelsUrl: String(p.modelsUrl || '').trim(),
    noAuth: Boolean(p.noAuth),
    apiKey: String(p.apiKey || '').trim(),
    selected,
  };
}

function saveProviders(list, token) {
  if (!Array.isArray(list)) throw new Error('服务商列表格式错误');
  const clean = list.map(cleanProvider);
  const ids = new Set();
  clean.forEach((p) => {
    if (ids.has(p.id)) throw new Error('服务商标识重复，请刷新页面重试');
    ids.add(p.id);
  });
  const upsert = db.prepare(`INSERT INTO providers
    (id, label, url, api_key, no_auth, prefix, chat_url, models_url, models_json, selected_json, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      label=excluded.label, url=excluded.url, api_key=excluded.api_key,
      no_auth=excluded.no_auth, prefix=excluded.prefix, chat_url=excluded.chat_url,
      models_url=excluded.models_url, selected_json=excluded.selected_json,
      sort_order=excluded.sort_order`);
  db.exec('BEGIN');
  try {
    clean.forEach((p, i) => {
      const old = db.prepare('SELECT api_key FROM providers WHERE id = ?').get(p.id);
      let key;
      if (p.apiKey === CLEAR_KEY) key = '';
      else if (p.apiKey) key = p.apiKey;
      else key = old ? old.api_key : '';
      if (p.noAuth) key = NO_AUTH_KEY;
      upsert.run(p.id, p.label, p.url, key, Number(p.noAuth), p.prefix,
        p.chatUrl, p.modelsUrl, JSON.stringify(p.selected), i);
    });
    // 删除前端已移除的分组及其渠道
    const keep = [...ids];
    const stale = db.prepare('SELECT id FROM providers').all().map((r) => r.id).filter((id) => !keep.includes(id));
    stale.forEach((id) => {
      db.prepare('DELETE FROM channels WHERE provider_id = ?').run(id);
      db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    });
    keep.forEach((id) => syncProvider(loadProviderRow(id)));
    if (token !== undefined && token !== null) setSetting('proxy_token', String(token));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return clean.map((p) => p.id);
}

// ---- 通用服务商：地址推导与模型列表探测 ----

function normalizeChatUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new Error('服务商地址不是合法 URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('服务商地址仅支持 http(s)');
  u.hash = '';
  let p = u.pathname.replace(/\/+$/, '');
  p = p.replace(/\/chat\/completions\/?$/i, '').replace(/\/completions\/?$/i, '')
    .replace(/\/models\/?$/i, '');
  if (!p || p === '/') p = '/v1';
  u.pathname = p.replace(/\/+$/, '') + '/chat/completions';
  u.search = '';
  return u.toString();
}

function modelUrlCandidates(rawUrl, override) {
  const raw = String(override || '').trim();
  if (raw) {
    if (!/^https?:\/\//i.test(raw)) throw new Error('模型列表地址必须是完整 http(s) URL');
    return [raw];
  }
  let u;
  try { u = new URL(String(rawUrl || '').trim()); } catch { throw new Error('服务商地址不是合法 URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('服务商地址仅支持 http(s)');
  const origin = u.origin;
  let p = u.pathname.replace(/\/+$/, '');
  p = p.replace(/\/chat\/completions\/?$/i, '').replace(/\/completions\/?$/i, '')
    .replace(/\/models\/?$/i, '');
  const bases = [];
  const add = (b) => {
    const v = b.replace(/\/+$/, '');
    if (v && !bases.includes(v) && !/\/v1\/v1(\/|$)/i.test(v)) bases.push(v);
  };
  if (p && p !== '/') add(origin + p);
  add(origin + p.replace(/\/$/, '') + '/v1');
  add(origin + '/v1');
  add(origin + '/api/v1');
  const cands = bases.map((b) => b + '/models');
  if (cands[0]) cands.push(cands[0] + '?type=text&sub_type=chat');
  return [...new Set(cands)];
}

function parseErrorDetail(text) {
  let detail = String(text || '').slice(0, 160);
  try {
    const j = JSON.parse(text);
    detail = String(j.error?.message || j.message || detail).slice(0, 160);
  } catch { /* 保留原文 */ }
  return detail;
}

async function fetchModelList(url, key, noAuth) {
  const headers = { accept: 'application/json' };
  if (!noAuth && isRealKey(key)) headers.authorization = `Bearer ${key}`;
  const resp = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(12000) });
  const text = await resp.text();
  if (!resp.ok) return { ok: false, status: resp.status, detail: parseErrorDetail(text) };
  let payload;
  try { payload = JSON.parse(text); } catch { return { ok: false, detail: '返回的不是 JSON' }; }
  const rawList = extractRawList(payload);
  if (!rawList.length) return { ok: false, detail: '模型列表为空' };
  return { ok: true, rawList };
}

// 兼容 {data:[]}、{models:[]}、纯数组及一层嵌套
function extractRawList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.models)) return payload.models;
  if (Array.isArray(payload.data?.data)) return payload.data.data;
  if (Array.isArray(payload.data?.models)) return payload.data.models;
  return [];
}

const NON_CHAT = /(embedding|embed-v|rerank|whisper|speech|tts|stable-diffusion|sdxl|dall-?e|flux|moderation|text-to-image|image-gen|audio|realtime|transcribe)/i;

// 仅当上游明确给出输入/输出单价且都为 0 时，才判定为零定价模型
function zeroPriced(raw) {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const pairs = [
    [raw.cost?.text?.input?.price, raw.cost?.text?.output?.price],
    [raw.cost?.input?.price, raw.cost?.output?.price],
    [raw.cost?.input, raw.cost?.output],
    [raw.pricing?.prompt, raw.pricing?.completion],
    [raw.pricing?.input, raw.pricing?.output],
    [raw.input_price, raw.output_price],
  ];
  for (const [a, b] of pairs) {
    const x = num(a);
    const y = num(b);
    if (x !== null && y !== null) return { known: true, free: x === 0 && y === 0 };
  }
  return { known: false, free: false };
}

// 统一解析各平台元数据；接口没给的字段才按名称推断
function parseDiscoveredModel(raw) {
  let id = String(raw.id ?? raw.model ?? raw.name ?? raw.modelId ?? '').trim();
  if (!id) return null;
  id = id.replace(/^models\//, '');
  const name = String(raw.name || '').trim() || id;

  const mods = [];
  const pushMods = (v) => {
    if (Array.isArray(v)) mods.push(...v.map(String));
    else if (typeof v === 'string') mods.push(v);
  };
  [raw.architecture?.input_modalities, raw.input_modalities, raw.modalities?.input,
    raw.features, raw.tags].forEach(pushMods);
  const modalityText = [raw.architecture?.modality, raw.modality, raw.input_modality]
    .filter(Boolean).map(String).join(' ');
  const params = [raw.supported_parameters, raw.supported_features, raw.features, raw.tags]
    .filter(Array.isArray).flat().map((x) => String(x).toLowerCase());

  const caps = raw.capabilities || {};
  const bool = (v) => (typeof v === 'boolean' ? v : undefined);
  const firstBool = (...vals) => {
    for (const v of vals) { const b = bool(v); if (b !== undefined) return b; }
    return undefined;
  };
  let toolCall = firstBool(caps.tools?.supported ?? caps.tools, raw.supports_tools, raw.supportsToolCall);
  let reasoning = firstBool(caps.reasoning?.supported ?? caps.reasoning, raw.reasoning, raw.supportsReasoning);
  let images = firstBool(caps.vision?.supported ?? caps.vision, caps.images?.supported ?? caps.images,
    raw.supports_images, raw.supportsImages);
  if (toolCall === undefined && params.some((p) => /tool|function_call/.test(p))) toolCall = true;
  if (reasoning === undefined && params.some((p) => /reason|thinking/.test(p))) reasoning = true;
  if (images === undefined && (mods.some((m) => /image|vision/i.test(m))
    || /image|vision/i.test(modalityText) || params.some((p) => /vision|image/.test(p)))) images = true;

  const text = `${id} ${name} ${raw.description || ''}`.toLowerCase();
  const inferred = {
    images: /vision|\bvl\b|vlm|omni|multimodal|gpt-4o|claude-3|gemini|pixtral|qwen-vl|internvl|llava|glm-4v|image/i.test(text),
    toolCall: true,
    reasoning: /reason|think|\br1\b|\bo[134]\b|qwq|deepseek-r/i.test(text),
  };
  const values = { images, toolCall, reasoning };
  const sources = {};
  Object.keys(values).forEach((k) => {
    if (values[k] === undefined) { values[k] = inferred[k]; sources[k] = 'inferred'; }
    else sources[k] = 'api';
  });

  const type = String(raw.type || '').toLowerCase();
  const api = raw.api || {};
  let protocol = 'unknown';
  if (api['chat-completions'] || api.chat_completions || api.chatCompletions) protocol = 'chat-completions';
  else if (api.responses) protocol = 'responses';
  else if (api.messages) protocol = 'messages';
  else if (Object.keys(api).length) protocol = 'other';
  if (Array.isArray(raw.supportedGenerationMethods)
    && raw.supportedGenerationMethods.includes('generateContent') && protocol === 'unknown') protocol = 'other';
  const chat = (type ? type === 'chat' : true)
    && !['responses', 'messages', 'other'].includes(protocol)
    && !NON_CHAT.test(id);
  const context = Number(raw.limit?.context || raw.context_length || raw.context_window
    || raw.max_context_length || raw.maxModelLen || raw.top_provider?.context_length || 0) || null;
  const price = zeroPriced(raw);

  return {
    id, name, context, protocol, chat,
    type: type || null,
    free: price.known && price.free,
    capabilities: {
      supportsToolCall: Boolean(values.toolCall),
      supportsImages: Boolean(values.images),
      supportsReasoning: Boolean(values.reasoning),
    },
    sources,
    description: String(raw.description || '').slice(0, 160),
  };
}

async function discoverForProvider(id) {
  const p = loadProviderRow(id);
  if (!p) throw new Error('服务商不存在，请先保存');
  if (!p.url) throw new Error('请先填写服务商地址');
  if (!p.noAuth && !isRealKey(p.apiKey)) throw new Error('请填写 API Key，或勾选「该服务商无需密钥」');
  const chatUrl = p.chatUrl || normalizeChatUrl(p.url);
  const prefix = p.prefix || prefixFrom(p.label, p.url, '');
  const candidates = modelUrlCandidates(p.url, p.modelsUrl);
  const results = await Promise.all(candidates.map(async (u) => {
    try { return { url: u, ...(await fetchModelList(u, p.apiKey, p.noAuth)) }; }
    catch (err) { return { url: u, ok: false, detail: err.message }; }
  }));
  const hit = results.find((r) => r.ok && r.rawList.length);
  if (!hit) {
    const denied = results.find((r) => [401, 403].includes(r.status));
    if (denied) throw new Error(`模型列表需要有效 API Key（HTTP ${denied.status}）：${denied.detail}`);
    const brief = results.slice(0, 3).map((r) => `${new URL(r.url).pathname}:${r.status || r.detail}`).join('；');
    throw new Error(`未能找到可用的模型列表端点（已自动尝试 ${candidates.length} 个地址）：${brief}。可在「高级选项」手动填写模型列表地址`);
  }
  const seen = new Set();
  const models = [];
  hit.rawList.forEach((raw) => {
    const m = raw && typeof raw === 'object' ? parseDiscoveredModel(raw) : null;
    if (!m || seen.has(m.id)) return;
    seen.add(m.id);
    models.push(m);
  });
  if (!models.length) throw new Error('模型列表中没有可识别的模型条目');

  const trimmed = models.slice(0, 800);
  // 刷新列表后保留仍存在的勾选
  const valid = new Set(trimmed.map((m) => m.id));
  const selected = (p.selected || []).filter((m) => valid.has(m));
  db.prepare('UPDATE providers SET models_json = ?, selected_json = ?, chat_url = ?, prefix = ? WHERE id = ?')
    .run(JSON.stringify(trimmed), JSON.stringify(selected), chatUrl, prefix, p.id);
  syncProvider(loadProviderRow(p.id));
  return {
    providerId: p.id, modelsUrl: hit.url, chatUrl, prefix,
    total: hit.rawList.length, models: trimmed, attempts: candidates.length,
  };
}

// ---- 单条渠道编辑（服务商派生的渠道不允改地址/密钥/模型名，保证共用） ----

function patchChannel(body) {
  const id = String(body.id || '');
  const row = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  if (!row) throw new Error('渠道不存在');
  const alias = String(body.alias ?? row.alias).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(alias)) throw new Error('别名不合法：仅允许字母、数字、短横线、下划线');
  if (['api', 'health'].includes(alias)) throw new Error('别名是保留字');
  const dup = db.prepare('SELECT id FROM channels WHERE alias = ? AND id <> ?').get(alias, id);
  if (dup) throw new Error(`别名重复：${alias}`);
  const localId = String(body.localId ?? row.local_id).trim() || defaultLocalId(alias, row.upstream_model);
  const dupLocal = db.prepare('SELECT id FROM channels WHERE local_id = ? AND id <> ?').get(localId, id);
  if (dupLocal) throw new Error(`本地模型 ID 重复：${localId}`);
  const derived = Boolean(row.provider_id);
  const url = derived ? row.url : String(body.url ?? row.url).trim();
  const model = derived ? row.upstream_model : String(body.upstreamModel ?? row.upstream_model).trim();
  let key = row.api_key;
  if (!derived) {
    if (body.apiKey === CLEAR_KEY) key = '';
    else if (body.apiKey) key = String(body.apiKey).trim();
    if (body.noAuth) key = NO_AUTH_KEY;
  }
  const num = (v, old) => (v === undefined ? old : Number(Boolean(v)));
  db.prepare(`UPDATE channels SET alias=?, label=?, local_id=?, url=?, upstream_model=?, api_key=?,
    supports_tool_call=?, supports_images=?, supports_reasoning=?, enabled=? WHERE id=?`)
    .run(alias, String(body.label ?? row.label).trim() || alias, localId, url, model, key,
      num(body.supportsToolCall, row.supports_tool_call), num(body.supportsImages, row.supports_images),
      num(body.supportsReasoning, row.supports_reasoning), num(body.enabled, row.enabled), id);
  refreshUnifiedNames();
  return { ok: true };
}

function deleteChannel(id) {
  const row = db.prepare('SELECT * FROM channels WHERE id = ?').get(String(id || ''));
  if (!row) throw new Error('渠道不存在');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM channels WHERE id = ?').run(row.id);
    if (row.provider_id) {
      const p = loadProviderRow(row.provider_id);
      if (p) {
        db.prepare('UPDATE providers SET selected_json = ? WHERE id = ?')
          .run(JSON.stringify(p.selected.filter((m) => m !== row.upstream_model)), p.id);
      }
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  refreshUnifiedNames();
  return { ok: true };
}

function addManualChannel(body) {
  const n = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM channels').get().n;
  const alias = String(body.alias || '').trim().toLowerCase() || `ch${Date.now().toString(36)}`;
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(alias)) throw new Error('别名不合法');
  if (db.prepare('SELECT id FROM channels WHERE alias = ?').get(alias)) throw new Error(`别名重复：${alias}`);
  const model = String(body.upstreamModel || '').trim();
  const localId = String(body.localId || '').trim() || defaultLocalId(alias, model);
  if (db.prepare('SELECT id FROM channels WHERE local_id = ?').get(localId)) throw new Error(`本地模型 ID 重复：${localId}`);
  const id = randomUUID();
  db.prepare(`INSERT INTO channels
    (id, alias, label, url, api_key, upstream_model, local_id, supports_tool_call, supports_images, supports_reasoning, enabled, sort_order, provider_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`)
    .run(id, alias, String(body.label || '').trim() || '自定义渠道', String(body.url || '').trim(),
      String(body.apiKey || '').trim(), model, localId, 1, 0, 0, 1, n);
  refreshUnifiedNames();
  return { ok: true, id };
}

const PRESETS = [
  { alias: 'or', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'deepseek/deepseek-v4.1-flash', images: 1 },
  { alias: 'oc', label: 'OpenCode Zen', url: 'https://opencode.ai/inference/openai/v1/chat/completions', model: 'deepseek-v4.1-flash', images: 0 },
  { alias: 'sf', label: '硅基流动', url: 'https://api.siliconflow.cn/v1/chat/completions', model: 'deepseek-ai/DeepSeek-V4-Flash', images: 0 },
];

function loadPresets() {
  return PRESETS.reduce((n, p) => {
    try {
      const r = addManualChannel({ alias: p.alias, label: p.label, url: p.url, upstreamModel: p.model });
      if (p.images) db.prepare('UPDATE channels SET supports_images = 1 WHERE id = ?').run(r.id);
      return n + 1;
    } catch { return n; }
  }, 0);
}

// 客户端对自定义模型：name 与 id 相同才只显示一次，不同则拼成 name:id
function buildEntries() {
  const token = getSetting('proxy_token', '');
  const rows = readChannels().filter((c) => c.enabled);
  return rows.map((c) => ({
    id: c.displayName,
    name: c.displayName,
    vendor: 'Custom',
    url: `http://${HOST}:${PORT}/${c.alias}/v1/chat/completions`,
    apiKey: token || 'local-proxy',
    supportsToolCall: c.supportsToolCall,
    supportsImages: c.supportsImages,
    supportsReasoning: c.supportsReasoning,
    useCustomProtocol: false,
  }));
}

function json(res, status, obj, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, 'index.html')) {
    return json(res, 403, { error: '禁止访问' });
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return json(res, 404, { error: '文件不存在' });
  }
  const mime = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.png': 'image/png', '.webp': 'image/webp',
  };
  res.writeHead(200, {
    'content-type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store, must-revalidate',
  });
  fs.createReadStream(file).pipe(res);
}

function upstreamHeaders(row, extra = {}) {
  const headers = { 'content-type': 'application/json', ...extra };
  if (isRealKey(row.api_key) && row.api_key !== NO_AUTH_KEY) {
    headers.authorization = `Bearer ${row.api_key}`;
  }
  return headers;
}

// 直接向上游发最小请求，用于验证地址、密钥与真实模型名
async function testChannel(key) {
  const k = String(key || '');
  const row = db.prepare('SELECT * FROM channels WHERE id = ?').get(k)
    || db.prepare('SELECT * FROM channels WHERE alias = ?').get(k);
  if (!row) return { ok: false, message: '渠道不存在' };
  if (!isRealKey(row.api_key)) return { ok: false, message: '未填写 API Key' };
  if (!row.url || !row.upstream_model) return { ok: false, message: '接口地址或真实模型名为空' };
  try {
    const resp = await fetch(row.url, {
      method: 'POST',
      headers: upstreamHeaders(row),
      body: JSON.stringify({
        model: row.upstream_model,
        messages: [{ role: 'user', content: '只回复 OK' }],
        max_tokens: 8,
        stream: false,
      }),
    });
    const text = await resp.text();
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      if (parsed.choices && parsed.choices[0]) detail = `返回模型 ${parsed.model || row.upstream_model}`;
      else if (parsed.error) detail = String(parsed.error.message || JSON.stringify(parsed.error)).slice(0, 300);
    } catch { /* 非 JSON 响应保留原文 */ }
    return { ok: resp.ok, status: resp.status, message: detail };
  } catch (err) {
    return { ok: false, message: '请求失败: ' + err.message };
  }
}

// 把生成的条目合并进用户指定的 models.json，先备份，保留原有条目
function applyModelsFile(target) {
  const targetStr = String(target || '').trim();
  if (!path.isAbsolute(targetStr)) throw new Error('请填写绝对路径');
  const file = path.resolve(targetStr);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('文件不存在: ' + file);
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('目标文件不是合法 JSON'); }
  const entries = buildEntries();
  if (!entries.length) throw new Error('没有已启用的渠道，请先添加渠道');

  const now = new Date();
  const base = file + '.bak-' + localStamp(now);
  let backup = base;
  let n = 2;
  // 同一秒重复写入时不覆盖已有备份
  while (fs.existsSync(backup)) { backup = `${base}-${n}`; n += 1; }
  fs.writeFileSync(backup, raw, 'utf8');

  let added = 0;
  let updated = 0;
  let replaced = 0;
  const entryIds = new Set(entries.map((e) => e.id));
  const entryUrls = new Set(entries.map((e) => e.url));
  const staleIds = new Set();
  const merge = (arr) => {
    // 名称改版后 id 会变：按同一个网关地址认领旧条目并删掉，避免列表出现重复模型
    const keep = arr.filter((x) => {
      if (!x || !entryUrls.has(x.url) || entryIds.has(x.id)) return true;
      staleIds.add(x.id);
      return false;
    });
    replaced += arr.length - keep.length;
    arr.splice(0, arr.length, ...keep);
    entries.forEach((e) => {
      const idx = arr.findIndex((x) => x && x.id === e.id);
      if (idx >= 0) { arr[idx] = e; updated += 1; } else { arr.push(e); added += 1; }
    });
  };
  if (Array.isArray(data)) {
    merge(data);
  } else if (data && Array.isArray(data.models)) {
    merge(data.models);
    if (Array.isArray(data.availableModels)) {
      data.availableModels = data.availableModels.filter((id) => !staleIds.has(id));
      entries.forEach((e) => { if (!data.availableModels.includes(e.id)) data.availableModels.push(e.id); });
    }
  } else {
    throw new Error('无法识别结构：根节点应为数组或含 models 数组的对象');
  }
  const output = JSON.stringify(data, null, 2) + '\n';
  JSON.parse(output);
  fs.writeFileSync(file, output, 'utf8');
  // 认领旧条目算「更新」，避免同时显示新增和替换造成误解
  if (replaced) {
    const n = Math.min(added, replaced);
    added -= n;
    updated += n;
  }
  return {
    backup, backupName: path.basename(backup), file, at: localTime(now),
    added, updated, replaced, total: entries.length,
    format: Array.isArray(data) ? 'array' : 'object',
  };
}

async function handleApi(req, res, pathname) {
  const method = req.method;
  if (pathname === '/api/state' && method === 'GET') {
    return json(res, 200, {
      providers: readProviders(), channels: readChannels(),
      token: getSetting('proxy_token', ''), nameTemplate: nameTemplate(), port: PORT,
      targetPath: getSetting('target_path', ''), lastEntries: getSetting('last_entries', ''),
      lastApply: safeJson(getSetting('last_apply', ''), null),
    });
  }
  if (pathname === '/api/prefs' && method === 'POST') {
    const body = JSON.parse(await readBody(req));
    if (body.nameTemplate !== undefined) {
      const t = String(body.nameTemplate).trim();
      if (t.length > 120) return json(res, 400, { error: '显示名格式最长 120 个字符' });
      if (t && !/\{(model|modelLower|fullModel|alias)\}/.test(t)) {
        return json(res, 400, { error: '格式需包含 {model}、{modelLower}、{fullModel} 或 {alias}，保证每条名称唯一' });
      }
      setSetting('name_template', t);
      refreshUnifiedNames();
    }
    if (body.targetPath !== undefined) setSetting('target_path', String(body.targetPath).trim());
    if (body.token !== undefined) setSetting('proxy_token', String(body.token));
    return json(res, 200, {
      ok: true, nameTemplate: nameTemplate(),
      targetPath: getSetting('target_path', ''), entries: buildEntries(),
    });
  }
  if (pathname === '/api/providers' && method === 'PUT') {
    const body = JSON.parse(await readBody(req));
    const ids = saveProviders(body.providers, body.token);
    return json(res, 200, { ok: true, ids, providers: readProviders(), channels: readChannels() });
  }
  if (pathname === '/api/discover' && method === 'POST') {
    const body = JSON.parse(await readBody(req));
    return json(res, 200, { ok: true, ...(await discoverForProvider(body.id)) });
  }
  if (pathname === '/api/channel' && method === 'PATCH') {
    const body = JSON.parse(await readBody(req));
    return json(res, 200, { ...patchChannel(body), channels: readChannels() });
  }
  if (pathname === '/api/channel' && method === 'DELETE') {
    const body = JSON.parse(await readBody(req));
    return json(res, 200, { ...deleteChannel(body.id), providers: readProviders(), channels: readChannels() });
  }
  if (pathname === '/api/channel' && method === 'POST') {
    const body = JSON.parse(await readBody(req));
    return json(res, 200, { ...addManualChannel(body), channels: readChannels() });
  }
  if (pathname === '/api/presets' && method === 'POST') {
    return json(res, 200, { ok: true, added: loadPresets(), channels: readChannels() });
  }
  if (pathname === '/api/test' && method === 'POST') {
    const body = JSON.parse(await readBody(req));
    return json(res, 200, await testChannel(body.id || body.alias));
  }
  if (pathname === '/api/preview' && method === 'POST') {
    const entries = buildEntries();
    setSetting('last_entries', JSON.stringify(entries));
    return json(res, 200, { entries, port: PORT });
  }
  if (pathname === '/api/apply' && method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const result = applyModelsFile(body.path);
    setSetting('target_path', String(body.path || '').trim());
    setSetting('last_entries', JSON.stringify(buildEntries()));
    const lastApply = {
      at: result.at, file: result.file, backupName: result.backupName,
      added: result.added, updated: result.updated, replaced: result.replaced,
      total: result.total, format: result.format,
    };
    setSetting('last_apply', JSON.stringify(lastApply));
    return json(res, 200, { ok: true, ...result, lastApply });
  }
  return json(res, 404, { error: '未知接口' });
}

// 网关：本地唯一 id -> 该渠道真实 model 名，并换成该渠道的地址与密钥
async function proxy(req, res, pathname) {
  const alias = pathname.split('/').filter(Boolean)[0];
  const row = alias ? db.prepare('SELECT * FROM channels WHERE alias = ? AND enabled = 1').get(alias) : null;
  if (!row) return json(res, 404, { error: { message: `未知渠道别名: ${alias || '(空)'}`, type: 'proxy_error' } });
  const token = getSetting('proxy_token', '');
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    return json(res, 401, { error: { message: '本地访问令牌不匹配', type: 'proxy_error' } });
  }
  if (!isRealKey(row.api_key)) {
    return json(res, 502, { error: { message: `渠道 ${alias} 未填写 API Key`, type: 'proxy_error' } });
  }
  if (!row.url || !row.upstream_model) {
    return json(res, 502, { error: { message: `渠道 ${alias} 的接口地址或真实模型名为空`, type: 'proxy_error' } });
  }

  let body;
  try { body = JSON.parse(await readBody(req)); } catch {
    return json(res, 400, { error: { message: '请求体不是合法 JSON', type: 'proxy_error' } });
  }
  const localId = body.model;
  body.model = row.upstream_model;

  const headers = upstreamHeaders(row);
  if (req.headers['http-referer']) headers['http-referer'] = req.headers['http-referer'];
  if (req.headers['x-title']) headers['x-title'] = req.headers['x-title'];

  const upstream = await fetch(row.url, { method: 'POST', headers, body: JSON.stringify(body) });
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') || 'application/json',
    'x-upstream': row.alias,
    'x-upstream-model': row.upstream_model,
  });
  if (upstream.body) {
    for await (const chunk of upstream.body) {
      if (!res.write(Buffer.from(chunk))) await new Promise((r) => res.once('drain', r));
    }
  }
  res.end();
  console.log(`[${row.alias}] ${localId} -> ${row.upstream_model} | ${upstream.status}`);
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  try {
    const staticExt = ['.html', '.js', '.css', '.svg', '.ico', '.png', '.webp'];
    if (req.method === 'GET' && (pathname === '/' || staticExt.includes(path.extname(pathname).toLowerCase()))) {
      return serveStatic(pathname, res);
    }
    if (pathname === '/health' && req.method === 'GET') {
      return json(res, 200, { ok: true, enabled: readChannels().filter((c) => c.enabled).length });
    }
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    if (req.method === 'POST') return await proxy(req, res, pathname);
    return json(res, 405, { error: '仅支持 POST 请求与配置页 GET' });
  } catch (err) {
    console.error('[error]', err.message);
    if (!res.headersSent) json(res, 400, { error: err.message });
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[workbuddy-model-hub] 别名网关已启动: http://${HOST}:${PORT}`);
  console.log(`配置页面: http://${HOST}:${PORT}/`);
  console.log(`服务商 ${readProviders().length} 组 | 已启用渠道 ${readChannels().filter((c) => c.enabled).length} 个 | 数据库: ${DB_PATH}`);
});

module.exports = { server, db };
