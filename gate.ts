#!/usr/bin/env bun

/**
 * kilocode-free-gate — Kilo 免费模型反代网关
 *
 * 维持 2 个可用代理轮换使用，失败重试 3 次后换 IP
 * 候选池每 5 分钟刷新一次，新代理先探活再启用
 * 兼容 OpenAI 和 Anthropic 格式
 *
 * 使用:
 *   bun run gate.ts
 *   PORT=8080 bun run gate.ts
 */

import https from 'node:https';
import { HttpsProxyAgent } from 'hpagent';
import { SocksProxyAgent } from 'socks-proxy-agent';

interface ProxyItem {
  address: string;
  protocol: string;
  latency: number;
  quality_grade: string;
}

interface Slot {
  addr: string;
  url: string;
  proto: 'http' | 'socks5';
}

const PROXY_API = 'https://proxy.amux.ai/api/proxies';
const UPSTREAM = 'https://api.kilo.ai/api/gateway';
const PORT = parseInt(process.env.PORT || '13339');
const MAX_RETRIES = 3;
const TIMEOUT = 120000;
const STREAM_TIMEOUT = 300000;
const SLOT_COUNT = 2;                               // 轮换代理数
const PROXY_PROBE_TIMEOUT = parseInt(process.env.PROXY_PROBE_TIMEOUT || '8000');
const PROXY_REFRESH_MS = parseInt(process.env.PROXY_REFRESH_MS || '300000');

// –– 全局状态 ––
let candidates: ProxyItem[] = [];
let slots: Slot[] = [];          // 当前 2 个可用代理
let rrCursor = 0;
let refreshing = false;

/** 转发到上游时保留的请求头 */
const FORWARD = [
  'content-type',
  'accept',
  'anthropic-version',
  'anthropic-beta',
];

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  候选池
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

async function loadCandidates(): Promise<void> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(PROXY_API, { signal: ctl.signal });
    const all: any[] = await res.json();
    candidates = all
      .filter((p) => p.quality_grade === 'S' && p.status === 'active')
      .sort((a, b) => a.latency - b.latency);
    console.log(`[选] ${candidates.length} S-grade candidates`);
  } catch (e: any) {
    candidates = [];
    console.warn(`[选] load failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 从候选池取下一个（跳过当前已占用的） */
function nextCandidate(used: Set<string>): ProxyItem | null {
  while (candidates.length > 0) {
    const item = candidates.shift()!;
    if (!used.has(item.address)) return item;
  }
  return null;
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  探活
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

function makeAgent(proxyUrl: string, proto: 'http' | 'socks5'): https.Agent {
  if (proto === 'socks5') {
    return new SocksProxyAgent(proxyUrl, { timeout: 10000 }) as unknown as https.Agent;
  }
  return new HttpsProxyAgent({
    proxy: proxyUrl,
    keepAlive: false,
    timeout: 10000,
  }) as unknown as https.Agent;
}

async function probe(item: ProxyItem): Promise<{ ok: boolean; latencyMs?: number }> {
  const url = item.protocol === 'socks5' ? `socks5h://${item.address}` : `http://${item.address}`;
  const agent = makeAgent(url, item.protocol as 'http' | 'socks5');
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<{ status: number }>((resolve, reject) => {
      const req = https.request(
        `${UPSTREAM}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'content-type': 'application/json',
          },
          agent,
          rejectUnauthorized: false,
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => {
            if (timer) clearTimeout(timer);
            resolve({ status: res.statusCode || 0 });
          });
          res.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
        },
      );
      req.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
      timer = setTimeout(() => { req.destroy(new Error('probe-timeout')); reject(new Error('probe-timeout')); }, PROXY_PROBE_TIMEOUT);
      // 发送一个最小请求来探活
      req.write(JSON.stringify({
        model: 'kilo-auto/free',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }));
      req.end();
    });
    return { ok: result.status >= 200 && result.status < 400, latencyMs: Date.now() - start };
  } catch {
    return { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
    try { agent.destroy(); } catch {}
  }
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  Slot 管理：探活 → 填充 → 刷新
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

/** 探活并填充 slot 到 SLOT_COUNT 个 */
async function fillSlots(): Promise<void> {
  if (slots.length >= SLOT_COUNT) return;
  const used = new Set(slots.map((s) => s.addr));
  const needed = SLOT_COUNT - slots.length;

  // 并行探活
  const batch: ProxyItem[] = [];
  while (batch.length < needed + 3) {  // 多取几个备选
    const c = nextCandidate(used);
    if (!c) {
      if (candidates.length === 0) await loadCandidates();
      const c2 = nextCandidate(used);
      if (!c2) break;
      batch.push(c2);
      used.add(c2.address);
      continue;
    }
    batch.push(c);
    used.add(c.address);
  }
  if (batch.length === 0) return;

  const results = await Promise.all(batch.map(async (item) => {
    const r = await probe(item);
    return { item, ...r };
  }));

  let added = 0;
  for (const r of results) {
    if (!r.ok || slots.length >= SLOT_COUNT) continue;
    const url = r.item.protocol === 'socks5' ? `socks5h://${r.item.address}` : `http://${r.item.address}`;
    slots.push({ addr: r.item.address, url, proto: r.item.protocol as 'http' | 'socks5' });
    console.log(`[探+] ${r.item.address} (${r.latencyMs}ms)`);
    added++;
  }
  console.log(`[槽] ${slots.length}/${SLOT_COUNT} ready (added ${added})`);
}

/** 失败时丢弃一个 slot */
function dropSlot(addr: string): void {
  const idx = slots.findIndex((s) => s.addr === addr);
  if (idx >= 0) {
    slots.splice(idx, 1);
    console.log(`[弃] ${addr} → ${slots.length}/${SLOT_COUNT}`);
  }
  // 异步补位
  fillSlots().catch((e) => console.error('[槽] fill error:', e.message));
}

/** 定期刷新候选 + 补位 */
async function refreshSlots(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    await loadCandidates();
    await fillSlots();
  } catch (e: any) {
    console.error('[刷新] error:', e.message);
  } finally {
    refreshing = false;
  }
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  请求处理
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

function collectHeaders(req: Request): Record<string, string> {
  const h: Record<string, string> = {};
  for (const k of FORWARD) {
    const v = req.headers.get(k);
    if (v) h[k] = v;
  }
  if (!h['content-type']) h['content-type'] = 'application/json';
  return h;
}

function doHttps(
  path: string, method: string, headers: Record<string, string>,
  body: string | undefined, agent: https.Agent,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${UPSTREAM}${path}`,
      { method, headers, agent, timeout: TIMEOUT, rejectUnauthorized: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 200, body: Buffer.concat(chunks).toString('utf-8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('超时')));
    if (body) req.write(body);
    req.end();
  });
}

function doHttpsStream(
  path: string, method: string, headers: Record<string, string>,
  body: string | undefined, agent: https.Agent,
): Promise<{ status: number; stream: ReadableStream<Uint8Array> }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${UPSTREAM}${path}`,
      { method, headers, agent, timeout: STREAM_TIMEOUT, rejectUnauthorized: false },
      (res) => {
        res.on('end', () => { try { agent.destroy(); } catch {} });
        res.on('error', () => { try { agent.destroy(); } catch {} });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
            res.on('end', () => controller.close());
            res.on('error', (err) => controller.error(err));
          },
          cancel() { res.destroy(); },
        });
        resolve({ status: res.statusCode || 200, stream });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 核心：轮询选 slot，失败重试，全部失败返回错误 */
async function dispatch(
  path: string, method: string, headers: Record<string, string>,
  body: string | undefined, retry = 0, triedAddrs = new Set<string>(),
): Promise<Response> {
  // 没有 slot 尝试填充
  if (slots.length === 0) await fillSlots();

  // 选一个没试过的 slot
  const available = slots.filter((s) => !triedAddrs.has(s.addr));
  const slot = available[rrCursor % available.length] || available[0] || null;
  rrCursor++;

  if (!slot) {
    // 所有 slot 都试过了，直接连接
    console.log(`[直连] 无可用代理，直接连接上游`);
    const agent = makeAgent('', 'http'); // 不使用代理
    try {
      const isStream = (headers['accept'] || '').includes('event-stream');
      if (isStream) {
        const { stream } = await doHttpsStream(path, method, headers, body, agent);
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
        });
      }
      const { status, body: respBody } = await doHttps(path, method, headers, body, agent);
      return new Response(respBody, { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: `连接失败: ${e.message}` }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    }
  }

  triedAddrs.add(slot.addr);
  console.log(`[取] ${slot.addr} (retry=${retry})`);

  const isStream = (headers['accept'] || '').includes('event-stream');
  const agent = makeAgent(slot.url, slot.proto);

  try {
    if (isStream) {
      const { stream } = await doHttpsStream(path, method, headers, body, agent);
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }

    const { status, body: respBody } = await doHttps(path, method, headers, body, agent);
    try { agent.destroy(); } catch {}

    // 上游 5xx：代理没毛病，不丢弃，直接返回
    if (status >= 500) {
      return new Response(respBody, { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }

    return new Response(respBody, { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  } catch (e: any) {
    console.error(`[错] ${slot.addr}: ${e.message}`);
    try { agent.destroy(); } catch {}

    // 代理连接失败 → 丢弃该 slot
    dropSlot(slot.addr);

    if (retry < MAX_RETRIES) {
      return dispatch(path, method, headers, body, retry + 1, triedAddrs);
    }
    return new Response(JSON.stringify({ error: `所有代理失败: ${e.message}` }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  路由
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

function normalize(raw: string): string | null {
  // 支持 OpenAI 格式: /openai/v1/xxx 或 /v1/xxx
  const m1 = raw.match(/^\/openai(\/v1\/.+)$/);
  if (m1) return m1[1];

  // 支持直接格式: /v1/xxx
  const m2 = raw.match(/^(\/v1\/.+)$/);
  if (m2) return m2[1];

  // 支持 Anthropic 格式: /anthropic/v1/xxx
  const m3 = raw.match(/^\/anthropic(\/v1\/.+)$/);
  if (m3) return m3[1];

  return null;
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  服务
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

console.log(`[门] http://localhost:${PORT}`);
console.log(`[门] OpenAI:    /openai/v1/chat/completions | /openai/v1/models`);
console.log(`[门] 直接:      /v1/chat/completions | /v1/models`);
console.log(`[门] 策略:      ${SLOT_COUNT} slot 轮换, MAX_RETRIES=${MAX_RETRIES}`);

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const { pathname: raw, search } = new URL(req.url);
    const method = req.method;
    const pathname = normalize(raw);
    console.log(`[>] ${method} ${raw}`);

    if (!pathname) {
      if (raw === '/' || raw === '/v1') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            service: 'kilocode-free-gate',
            upstream: UPSTREAM,
            slots: slots.map((s) => s.addr),
            free_models: [
              'kilo-auto/free',
              'nvidia/nemotron-3-ultra-550b-a55b:free',
              'nvidia/nemotron-3-super-120b-a12b:free',
              'poolside/laguna-m.1:free',
              'poolside/laguna-xs.2:free',
              'stepfun/step-3.7-flash:free',
              'nex-agi/nex-n2-pro:free',
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{"error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
    }

    if (pathname === '/v1/models' && method === 'GET') {
      // 返回 Kilo 免费模型列表
      return new Response(JSON.stringify({
        object: 'list',
        data: [
          { id: 'kilo-auto/free', object: 'model', owned_by: 'kilo' },
          { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', object: 'model', owned_by: 'nvidia' },
          { id: 'nvidia/nemotron-3-super-120b-a12b:free', object: 'model', owned_by: 'nvidia' },
          { id: 'poolside/laguna-m.1:free', object: 'model', owned_by: 'poolside' },
          { id: 'poolside/laguna-xs.2:free', object: 'model', owned_by: 'poolside' },
          { id: 'stepfun/step-3.7-flash:free', object: 'model', owned_by: 'stepfun' },
          { id: 'nex-agi/nex-n2-pro:free', object: 'model', owned_by: 'nex-agi' },
        ],
      }), { headers: { 'content-type': 'application/json' } });
    }

    if ((pathname === '/v1/chat/completions' || pathname === '/v1/messages') && method === 'POST') {
      let body = await req.text();
      const h = collectHeaders(req);
      const isStream =
        h['accept']?.includes('event-stream') ||
        (() => { try { return JSON.parse(body).stream; } catch { return false; } })();
      if (isStream) {
        h['accept'] = 'text/event-stream';
        try {
          const json = JSON.parse(body);
          if (!json.stream) { json.stream = true; body = JSON.stringify(json); }
        } catch {}
      }
      return dispatch(pathname, 'POST', h, body);
    }

    return new Response('{"error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
  },
});

// 启动：加载候选 + 探活填充 slot
loadCandidates()
  .then(() => fillSlots())
  .catch((e) => console.error('[门] initial fill failed:', e));

// 定期刷新
const refreshTimer = setInterval(() => {
  refreshSlots().catch((e) => console.error('[门] refresh failed:', e));
}, PROXY_REFRESH_MS);

// 优雅退出
process.on('SIGTERM', () => { clearInterval(refreshTimer); process.exit(0); });
process.on('SIGINT', () => { clearInterval(refreshTimer); process.exit(0); });
