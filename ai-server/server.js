// Kalorie AI — odhad sacharidů z fotky přes Claude (vaše předplatné Claude, ne placené API).
// Spouští oficiální CLI `claude -p` (Claude Code) přihlášené tokenem z `claude setup-token`
// (proměnná CLAUDE_CODE_OAUTH_TOKEN). Přístup: token Nightscoutu, který už má aplikace
// v telefonu — server ho ověří proti Nightscoutu, takže není potřeba žádné další heslo.
'use strict';
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = +process.env.PORT || 8080;
const NS_URL = (process.env.NIGHTSCOUT_URL || '').replace(/\/+$/, '');
const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.AI_EFFORT || 'medium';
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://tomasjfanta.github.io').split(',').map(s => s.trim()).filter(Boolean);
const DAILY_CAP = +process.env.DAILY_CAP || 150;          // pojistka proti chybě v aplikaci, ne limit předplatného
const MAX_PARALLEL = +process.env.MAX_PARALLEL || 4;
const RUN_TIMEOUT_MS = 150000;
const MAX_BODY = 8 * 1024 * 1024;
// CLAUDE_CMD (JSON pole) jen pro testy — jinak CLI z node_modules.
const CLAUDE_CMD = process.env.CLAUDE_CMD ? JSON.parse(process.env.CLAUDE_CMD) : [path.join(__dirname, 'node_modules', '.bin', 'claude')];

// Tvar odpovědi = stejné pole, jaká aplikace čte od Gemini (CLI ho vynutí přes --json-schema).
const SCHEMA = {
  type: 'object',
  properties: {
    nazev: { type: 'string' },
    mnozstvi: { type: 'string' },
    kcal: { type: 'number' },
    bilkoviny: { type: 'number' },
    sacharidy: { type: 'number' },
    tuky: { type: 'number' },
    sacharidy_min: { type: 'number' },
    sacharidy_max: { type: 'number' },
    jistota: { type: 'string', enum: ['nízká', 'střední', 'vysoká'] },
    kategorie: { type: 'string', enum: ['pecivo', 'prilohy', 'hotove', 'fastfood', 'sladke', 'ovoce', 'mlecne', 'napoje', 'ostatni'] },
    gi: { type: 'string', enum: ['nízký', 'střední', 'vysoký'] },
    poznamka: { type: 'string' },
  },
  required: ['nazev', 'mnozstvi', 'kcal', 'bilkoviny', 'sacharidy', 'tuky', 'sacharidy_min', 'sacharidy_max', 'jistota', 'kategorie', 'gi', 'poznamka'],
  additionalProperties: false,
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ─── Deník AI z aplikace (oba režimy): každý pokus o odhad, bez fotek a klíčů ───
   POST /diag  — pole záznamů z telefonu (bez přihlášení, jen z adresy aplikace, s limity).
   GET  /diag?since=ISO&limit=N — čtení pro rozbor; hlavička x-admin = sha1(API_SECRET Nightscoutu). */
const fs = require('fs');
const crypto = require('crypto');
const DIAG_DIR = process.env.DIAG_DIR || '/data';
const DIAG_FILE = path.join(DIAG_DIR, 'diag.jsonl');
const ADMIN = process.env.NS_API_SECRET ? crypto.createHash('sha1').update(process.env.NS_API_SECRET).digest('hex') : null;
const diagRate = new Map(); // ip → { min, n }
const DIAG_KEYS = ['at', 'dev', 'v', 'mode', 'flow', 'job', 'attempt', 'kb', 'vendor', 'model', 'ok', 'err', 'status', 'msg', 'ms', 'finish', 'tok', 'snippet'];
function cleanDiag(x) {
  if (!x || typeof x !== 'object') return null;
  const o = {};
  for (const k of DIAG_KEYS) {
    const v = x[k];
    if (v == null) continue;
    if (typeof v === 'string') o[k] = v.replace(/AIza[0-9A-Za-z_\-]{20,}|sk-ant-[0-9A-Za-z_\-]+/g, '<key>').slice(0, 400);
    else if (typeof v === 'number' || typeof v === 'boolean') o[k] = v;
    else if (k === 'tok') o[k] = Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === 'number').slice(0, 6));
  }
  return o.at ? o : null;
}

/* ─── Přístup: token Nightscoutu s právem čtení ─── */
const authCache = new Map(); // token → platnost do (ms)
async function authorized(token) {
  if (!token || token.length > 200 || !NS_URL) return false;
  const until = authCache.get(token);
  if (until && until > Date.now()) return true;
  const r = await fetch(`${NS_URL}/api/v1/verifyauth?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(10000) });
  const ok = r.ok && (await r.json().catch(() => ({})))?.message?.canRead === true;
  if (ok) authCache.set(token, Date.now() + 30 * 60 * 1000);
  return ok;
}

/* ─── Denní pojistka a souběh ─── */
let day = '', used = 0, running = 0;
const waiting = [];
function takeQuota() {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== day) { day = d; used = 0; }
  if (used >= DAILY_CAP) return false;
  used++; return true;
}
const acquire = () => running < MAX_PARALLEL ? (running++, Promise.resolve()) : new Promise(r => waiting.push(r));
const release = () => { const next = waiting.shift(); if (next) next(); else running--; };

/* ─── Jeden odhad = jeden běh CLI ─── */
function runClaude({ system, prompt, image, media }) {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', MODEL, '--effort', EFFORT,
    '--system-prompt', system,
    '--tools', '',                       // žádné nástroje — jen se podívat na fotku a odpovědět
    '--json-schema', JSON.stringify(SCHEMA),
    '--no-session-persistence', '--strict-mcp-config', '--setting-sources', 'project',
  ];
  const env = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  delete env.ANTHROPIC_API_KEY;          // vždy předplatné (OAuth token), nikdy placené API
  const message = { type: 'user', message: { role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: media, data: image } },
    { type: 'text', text: prompt },
  ] } };

  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_CMD[0], [...CLAUDE_CMD.slice(1), ...args], { env, cwd: require('os').tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => { proc.kill('SIGKILL'); finish(reject, new Error('timeout')); }, RUN_TIMEOUT_MS);
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('error', e => finish(reject, e));
    proc.on('close', code => {
      const events = out.split('\n').map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
      const res = events.find(e => e.type === 'result');
      const retry = events.filter(e => e.subtype === 'api_retry').pop();
      if (!res) return finish(reject, new Error(`cli exit ${code}${retry ? ' (' + retry.error_status + ' ' + retry.error + ')' : ''}: ${err.slice(0, 200)}`));
      if (res.is_error) return finish(reject, new Error(String(res.result || res.subtype || 'error').slice(0, 300)));
      let result = res.structured_output;
      if (!result) { // záloha: JSON v textu odpovědi
        const t = String(res.result || ''), a = t.indexOf('{'), b = t.lastIndexOf('}');
        try { result = JSON.parse(t.slice(a, b + 1)); } catch (e) { /* níže chyba */ }
      }
      if (!result || typeof result !== 'object') return finish(reject, new Error('no json in answer'));
      finish(resolve, {
        result,
        model: Object.keys(res.modelUsage || {})[0] || MODEL,
        ms: res.duration_ms,
        usage: { in: res.usage?.input_tokens, out: res.usage?.output_tokens },
      });
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(JSON.stringify(message) + '\n');
  });
}

/* ─── HTTP ─── */
function cors(req, res) {
  const o = req.headers.origin;
  if (o && ORIGINS.includes(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}
const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, model: MODEL, effort: EFFORT, loggedIn: !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
      nightscout: !!NS_URL, cli: require('fs').existsSync(CLAUDE_CMD[0]) || !!process.env.CLAUDE_CMD });
  }
  if (url.pathname === '/diag' && req.method === 'POST') {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const m = Math.floor(Date.now() / 60000), r = diagRate.get(ip);
    if (r && r.min === m && r.n > 300) return send(res, 429, { error: 'rate' });
    diagRate.set(ip, r && r.min === m ? { min: m, n: r.n + 1 } : { min: m, n: 1 });
    let arr;
    try { arr = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'body' }); }
    if (!Array.isArray(arr) || arr.length > 100) return send(res, 400, { error: 'body' });
    const rows = arr.map(cleanDiag).filter(Boolean).map(o => JSON.stringify({ ...o, rx: Date.now() }));
    if (rows.length) {
      try { fs.mkdirSync(DIAG_DIR, { recursive: true }); fs.appendFileSync(DIAG_FILE, rows.join('\n') + '\n'); }
      catch (e) { log('diag write failed', e.message); }
      const bad = arr.filter(x => x && x.ok === false).length;
      if (bad) log(`diag ${rows.length} rows, ${bad} failures`);
    }
    return send(res, 200, { ok: true, n: rows.length });
  }
  if (url.pathname === '/diag' && req.method === 'GET') {
    if (!ADMIN || req.headers['x-admin'] !== ADMIN) return send(res, 401, { error: 'auth' });
    const since = Date.parse(url.searchParams.get('since') || '') || 0, limit = Math.min(+url.searchParams.get('limit') || 2000, 20000);
    let lines = [];
    try { lines = fs.readFileSync(DIAG_FILE, 'utf8').trim().split('\n'); } catch (e) { /* zatím prázdné */ }
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try { const o = JSON.parse(lines[i]); if ((o.at || 0) >= since) out.push(o); } catch (e) { /* vadný řádek */ }
    }
    return send(res, 200, out.reverse());
  }
  if (req.method !== 'POST' || url.pathname !== '/estimate') return send(res, 404, { error: 'not found' });

  const t0 = Date.now();
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    let ok = false;
    try { ok = await authorized(token); } catch (e) { return send(res, 503, { error: 'nightscout' }); }
    if (!ok) return send(res, 401, { error: 'auth' });
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) return send(res, 503, { error: 'not-logged-in' });

    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'body' }); }
    const { system, prompt, image } = body || {};
    const media = /^image\/(jpeg|png|webp)$/.test(body?.media) ? body.media : 'image/jpeg';
    if (typeof system !== 'string' || system.length > 30000 || typeof image !== 'string' || !image || image.length > 7e6
      || (prompt != null && (typeof prompt !== 'string' || prompt.length > 2000))) return send(res, 400, { error: 'body' });
    if (!takeQuota()) return send(res, 429, { error: 'daily-cap' });

    await acquire();
    try {
      const r = await runClaude({ system, prompt: prompt || 'Odhadni sacharidy tohoto jídla z fotky.', image, media });
      log('estimate ok', r.model, `${Date.now() - t0}ms`, `in=${r.usage.in} out=${r.usage.out}`, `today=${used}/${DAILY_CAP}`);
      send(res, 200, r);
    } finally { release(); }
  } catch (e) {
    log('estimate failed', `${Date.now() - t0}ms`, e.message);
    const m = e.message || '';
    send(res, /401|authenticat|OAuth|log ?in/i.test(m) ? 503 : /429|rate|limit|usage/i.test(m) ? 429 : 502,
      { error: /401|authenticat|OAuth|log ?in/i.test(m) ? 'not-logged-in' : /429|rate|limit|usage/i.test(m) ? 'quota' : 'claude', detail: m.slice(0, 200) });
  }
}).listen(PORT, '::', () => log(`kalorie-ai on :${PORT} · model ${MODEL} · effort ${EFFORT} · nightscout ${NS_URL || '(not set)'}`));
