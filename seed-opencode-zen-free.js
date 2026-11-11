#!/usr/bin/env node
// 幂等种子脚本：为 opencode-zen 服务商创建 12 个免费模型代理渠道。
// 用途：opencode.ai 的免费模型（big-pickle 与所有 *-free）受账号级每日配额约束，
//   单个模型撞限额后，网关会在同服务商其它免费模型间自动回退（见 server.js 的 freeRing）。
//   本脚本把这批渠道一次性播种进 channels.db，使「换其他免费模型」能力可复现。
//
// 用法：
//   node seed-opencode-zen-free.js [API_KEY]
//   - 不传参数则读取环境变量 OCZ_API_KEY；仍为空则渠道创建后需到 UI 补填密钥。
//   - 渠道已存在（按 alias 判断）则跳过，可反复执行。
//
// 注意：channels.db 含密钥，已被 .gitignore 忽略，不进仓库；本脚本即其可复现来源。

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const DB = 'channels.db';
const db = new DatabaseSync(DB);

// 确保表结构存在（与 server.js 的 initSchema 保持一致，便于在全新 clone 上直接运行）
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
    provider_id TEXT NOT NULL DEFAULT '',
    egress_mode TEXT NOT NULL DEFAULT 'direct',
    proxy_id TEXT NOT NULL DEFAULT ''
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
    sort_order INTEGER NOT NULL DEFAULT 0,
    egress_mode TEXT NOT NULL DEFAULT 'direct',
    proxy_id TEXT NOT NULL DEFAULT ''
  );
`);

const PROVIDER_LABEL = 'opencode-zen';
const PROVIDER_URL = 'https://opencode.ai/zen/v1/chat/completions';
const apiKey = process.argv[2] || process.env.OCZ_API_KEY || '';

// [上游真实模型名, 中文标签, 渠道别名]（别名与既有库一致，保证幂等不重复）
const FREE = [
  ['beam-free', 'opencode-zen·beam-free', 'opencode-zen-beam-free'],
  ['big-pickle', 'opencode-zen·big-pickle', 'ocz-bigpickle'],
  ['deepseek-v4.1-flash-free', 'opencode-zen·deepseek-v4.1-flash-free', 'ocz-deepseekv41flashfr'],
  ['glm-5.3-flash-free', 'opencode-zen·glm-5.3-flash-free', 'ocz-glm53flashfree'],
  ['iceman-free', 'opencode-zen·iceman-free', 'ocz-icemanfree'],
  ['minimax-m3.1-flash-free', 'opencode-zen·minimax-m3.1-flash-free', 'ocz-minimaxm31flashfre'],
  ['mimo-v2.6-flash-free', 'opencode-zen·mimo-v2.6-flash-free', 'ocz-mimov26flashfree'],
  ['longcat-2.5-free', 'opencode-zen·longcat-2.5-free', 'ocz-longcat25free'],
  ['inkling-2-small-free', 'opencode-zen·inkling-2-small-free', 'ocz-inkling2smallfree'],
  ['flint-40b-free', 'opencode-zen·flint-40b-free', 'ocz-flint40bfree'],
  ['nemotron-3.5-super-vl-free', 'opencode-zen·nemotron-3.5-super-vl-free', 'ocz-nemotron35supervlf'],
  ['nemotron-3.5-lightning-free', 'opencode-zen·nemotron-3.5-lightning-free', 'ocz-nemotron35lightnin'],
];

// 确保服务商存在
let prov = db.prepare('SELECT id FROM providers WHERE label = ?').get(PROVIDER_LABEL);
let providerId;
if (!prov) {
  providerId = crypto.randomUUID();
  db.prepare(`INSERT INTO providers (id,label,url,api_key,no_auth,prefix,chat_url,models_url,models_json,selected_json,sort_order,egress_mode,proxy_id)
    VALUES (?,?,?,?,0,?,?, '','[]','[]',0,'pool','')`)
    .run(providerId, PROVIDER_LABEL, PROVIDER_URL, apiKey, PROVIDER_LABEL, PROVIDER_URL);
  console.log(`已创建服务商 ${PROVIDER_LABEL} (${providerId})`);
} else {
  providerId = prov.id;
  if (apiKey) db.prepare('UPDATE providers SET api_key = ? WHERE id = ?').run(apiKey, providerId);
}

// 创建渠道（按 alias 幂等）
let created = 0, skipped = 0;
const baseSort = 11;
const ins = db.prepare(`INSERT INTO channels (id,alias,label,url,api_key,upstream_model,local_id,supports_tool_call,supports_images,supports_reasoning,enabled,sort_order,provider_id,egress_mode,proxy_id)
  VALUES (?,?,?,?,?,?,?,1,0,1,1,?,?, 'pool','')`);
for (let i = 0; i < FREE.length; i++) {
  const [up, label, alias] = FREE[i];
  if (db.prepare('SELECT id FROM channels WHERE alias = ?').get(alias)) { skipped++; continue; }
  ins.run(crypto.randomUUID(), alias, label, PROVIDER_URL, apiKey, up, label, baseSort + i, providerId);
  created++;
}

console.log(`免费模型渠道：新建 ${created} 个，跳过已存在 ${skipped} 个。`);
if (!apiKey) console.log('提示：未提供 API_KEY，渠道已建但需在 UI 填写 opencode.ai 的 oc_sk_ 密钥后方可代理请求。');
console.log('网关会在同服务商免费模型间自动回退：当 beam-free 撞每日配额时，依次尝试其余免费模型。');
