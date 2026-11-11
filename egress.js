'use strict';

// 零依赖出站通道：直连 / HTTP CONNECT / SOCKS5（含账号密码认证）
// 对外提供与 fetch 用法兼容的轻量响应对象，便于网关、探测、测试三处复用
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');

const CONNECT_TIMEOUT = 15000;

function connectNet(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    sock.setTimeout(CONNECT_TIMEOUT, () => sock.destroy(new Error(`连接 ${host}:${port} 超时`)));
    sock.once('connect', () => { sock.setTimeout(0); resolve(sock); });
    sock.once('error', reject);
  });
}

// 从 socket 读定长数据，多余的字节交还调用方继续解析
function readN(sock, n, carry = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    let buf = carry;
    const done = (err, value) => {
      sock.removeListener('data', onData);
      sock.removeListener('error', onErr);
      sock.removeListener('close', onClose);
      if (err) reject(err); else resolve(value);
    };
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= n) done(null, { head: buf.subarray(0, n), rest: buf.subarray(n) });
    };
    const onErr = (e) => done(e);
    const onClose = () => done(new Error('代理连接提前关闭'));
    sock.on('data', onData);
    sock.on('error', onErr);
    sock.on('close', onClose);
    if (buf.length >= n) onData(Buffer.alloc(0));
  });
}

// HTTP 代理的 CONNECT 响应以空行结束
function readHeader(sock, carry = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    let buf = carry;
    const marker = Buffer.from('\r\n\r\n');
    const done = (err, value) => {
      sock.removeListener('data', onData);
      sock.removeListener('error', onErr);
      sock.removeListener('close', onClose);
      if (err) reject(err); else resolve(value);
    };
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf(marker);
      if (i >= 0) done(null, { head: buf.subarray(0, i + marker.length), rest: buf.subarray(i + marker.length) });
    };
    const onErr = (e) => done(e);
    const onClose = () => done(new Error('代理连接提前关闭'));
    sock.on('data', onData);
    sock.on('error', onErr);
    sock.on('close', onClose);
    const i = buf.indexOf(marker);
    if (i >= 0) onData(Buffer.alloc(0));
  });
}

async function httpConnect(sock, host, port, proxy) {
  const target = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  let auth = '';
  if (proxy.username) {
    const token = Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
    auth = `proxy-authorization: Basic ${token}\r\n`;
  }
  sock.write(`CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n${auth}proxy-connection: keep-alive\r\n\r\n`);
  const { head, rest } = await readHeader(sock);
  const first = head.toString('latin1').split('\r\n')[0];
  if (!/^HTTP\/1\.[01] 2\d\d\b/.test(first)) throw new Error(`HTTP 代理 CONNECT 失败：${first}`);
  return rest;
}

async function socks5Connect(sock, host, port, proxy) {
  const hasAuth = Boolean(proxy.username);
  const methods = hasAuth ? [0x00, 0x02] : [0x00];
  sock.write(Buffer.from([0x05, methods.length, ...methods]));
  let r = await readN(sock, 2);
  if (r.head[0] !== 0x05) throw new Error('不是 SOCKS5 代理');
  const method = r.head[1];
  if (method === 0xff) throw new Error('SOCKS5 代理不接受可用的认证方式');
  if (method === 0x02) {
    const u = Buffer.from(proxy.username || '', 'utf8');
    const p = Buffer.from(proxy.password || '', 'utf8');
    if (u.length > 255 || p.length > 255) throw new Error('代理账号或密码过长');
    sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
    r = await readN(sock, 2, r.rest);
    if (r.head[1] !== 0x00) throw new Error('SOCKS5 代理账号或密码错误');
  } else if (method !== 0x00) {
    throw new Error(`SOCKS5 代理要求不支持的认证方式 ${method}`);
  }

  const hostBuf = Buffer.from(host, 'utf8');
  if (hostBuf.length > 255) throw new Error('目标域名过长');
  sock.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
  ]));
  r = await readN(sock, 4, r.rest);
  const [ver, rep, , atyp] = r.head;
  if (ver !== 0x05 || rep !== 0x00) throw new Error(`SOCKS5 CONNECT 失败（REP=${rep}）`);
  let addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : 0;
  if (atyp === 0x03) {
    const len = await readN(sock, 1, r.rest);
    addrLen = len.head[0];
    r = len;
  }
  const tail = await readN(sock, addrLen + 2, r.rest);
  return tail.rest;
}

function tlsWrap(sock, host) {
  return new Promise((resolve, reject) => {
    // IP 地址不设 servername，避免 RFC 6066 告警
    const opts = { socket: sock };
    if (!net.isIP(host)) opts.servername = host;
    const t = tls.connect(opts, () => resolve(t));
    t.once('error', reject);
  });
}

// 返回可直接承载 HTTP 报文的 socket（https 目标已完成 TLS 握手）
async function openSocket(urlStr, proxy) {
  const u = new URL(urlStr);
  if (!/^https?:$/.test(u.protocol)) throw new Error('上游地址仅支持 http(s)');
  const isTls = u.protocol === 'https:';
  const host = u.hostname;
  const port = Number(u.port) || (isTls ? 443 : 80);
  let sock;
  let rest = Buffer.alloc(0);
  if (!proxy) {
    sock = await connectNet(host, port);
  } else {
    sock = await connectNet(proxy.host, Number(proxy.port));
    try {
      if (proxy.type === 'socks5') rest = await socks5Connect(sock, host, port, proxy);
      else if (proxy.type === 'http') rest = await httpConnect(sock, host, port, proxy);
      else throw new Error(`不支持的代理类型 ${proxy.type}`);
    } catch (err) {
      sock.destroy();
      throw new Error(`${proxy.label || proxy.type} 代理连接失败：${err.message}`);
    }
  }
  if (rest.length) sock.unshift(rest);
  return isTls ? tlsWrap(sock, host) : sock;
}

function collectBody(res) {
  return new Promise((resolve, reject) => {
    const parts = [];
    res.on('data', (c) => parts.push(c));
    res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    res.on('error', reject);
  });
}

function makeAgent(isTls, factory) {
  const Base = isTls ? https.Agent : http.Agent;
  const Custom = class extends Base {
    createConnection(options, cb) {
      factory().then((sock) => cb(null, sock), cb);
    }
  };
  return new Custom({ keepAlive: false });
}

// 与 fetch 兼容的最小子集：ok / status / headers.get / text() / body(可异步迭代)
function egressFetch(urlStr, options = {}, proxy = null) {
  const u = new URL(urlStr);
  const isTls = u.protocol === 'https:';
  const method = options.method || 'GET';
  const headers = { ...(options.headers || {}) };
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'host')) headers.host = u.host;
  const payload = options.body === undefined ? null : String(options.body);
  if (payload && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  const agent = makeAgent(isTls, () => openSocket(urlStr, proxy));
  const transport = isTls ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(u, { method, headers, agent }, (res) => {
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        headers: {
          get: (k) => {
            const v = res.headers[String(k).toLowerCase()];
            return v === undefined ? null : (Array.isArray(v) ? v.join(', ') : String(v));
          },
        },
        text: () => collectBody(res),
        body: res,
      });
    });
    req.on('error', reject);
    if (options.signal) {
      if (options.signal.aborted) { req.destroy(new Error('请求已取消')); return; }
      const onAbort = () => req.destroy(new Error('请求超时或已取消'));
      options.signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => options.signal.removeEventListener('abort', onAbort));
    }
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { egressFetch, openSocket };
