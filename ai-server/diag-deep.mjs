// Deeper read of the Kalorie AI log: per model reliability, error types, latency, thinking tokens,
// per photo job how many runs of each vendor succeeded. Usage: railway run --service kalorie-ai node diag-deep.mjs [days]
import { createHash } from 'node:crypto';
const days = +(process.argv[2] || 30);
const admin = createHash('sha1').update(process.env.NS_API_SECRET).digest('hex');
const since = new Date(Date.now() - days * 864e5).toISOString();
const r = await fetch(`https://kalorie-ai-production.up.railway.app/diag?since=${since}&limit=50000`, { headers: { 'x-admin': admin } });
if (!r.ok) { console.log('HTTP', r.status); process.exit(1); }
const rows = await r.json();
const first = Math.min(...rows.map(x => x.at)), last = Math.max(...rows.map(x => x.at));
console.log(`${rows.length} calls, ${new Date(first).toISOString().slice(0, 16)} → ${new Date(last).toISOString().slice(0, 16)}; app versions: ${[...new Set(rows.map(x => x.v))].join(', ')}`);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const group = (f) => { const g = {}; for (const x of rows) (g[f(x)] ??= []).push(x); return g; };
console.log('\n== per mode / vendor / model ==');
for (const [k, xs] of Object.entries(group(x => `${x.mode}/${x.flow}/${x.vendor}/${x.model || '-'}`)).sort((a, b) => b[1].length - a[1].length)) {
  const ok = xs.filter(x => x.ok), ms = ok.map(x => x.ms).filter(Boolean), th = ok.map(x => x.tok?.think).filter(n => n != null), out = ok.map(x => x.tok?.out).filter(n => n != null);
  const errs = {}; for (const x of xs.filter(x => !x.ok)) { const e = `${x.err}${x.status ? ' ' + x.status : ''}${x.finish ? ' ' + x.finish : ''}`; errs[e] = (errs[e] || 0) + 1; }
  console.log(`${k.padEnd(44)} n=${String(xs.length).padStart(4)} ok=${String(Math.round(ok.length / xs.length * 100)).padStart(3)}% · latency p50 ${ms.length ? (q(ms, .5) / 1000).toFixed(1) : '-'}s p90 ${ms.length ? (q(ms, .9) / 1000).toFixed(1) : '-'}s · think p50 ${q(th, .5) ?? '-'} · out p50 ${q(out, .5) ?? '-'} · ${Object.entries(errs).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e}×${n}`).join(', ')}`);
}
console.log('\n== failures by day (gemini) ==');
const byDay = group(x => new Date(x.at).toISOString().slice(0, 10));
for (const [d, xs] of Object.entries(byDay).sort()) {
  const g = xs.filter(x => x.vendor === 'gemini'), c = xs.filter(x => x.vendor === 'claude');
  console.log(`${d} gemini ${g.filter(x => x.ok).length}/${g.length} ok · claude ${c.filter(x => x.ok).length}/${c.length} ok`);
}
console.log('\n== per photo job (carb mode): successful runs per vendor ==');
const jobs = group(x => x.job ? `${x.mode}|${x.job}` : 'nojob');
delete jobs.nojob;
const dist = {};
for (const [k, xs] of Object.entries(jobs)) {
  if (!k.startsWith('carb|')) continue;
  const lastAttempt = Math.max(...xs.map(x => x.attempt || 0));
  const fin = xs.filter(x => (x.attempt || 0) === lastAttempt);
  const key = `gemini ${fin.filter(x => x.vendor === 'gemini' && x.ok).length}/${fin.filter(x => x.vendor === 'gemini').length} · claude ${fin.filter(x => x.vendor === 'claude' && x.ok).length}/${fin.filter(x => x.vendor === 'claude').length}${lastAttempt ? ' (after ' + lastAttempt + ' retries)' : ''}`;
  dist[key] = (dist[key] || 0) + 1;
}
for (const [k, n] of Object.entries(dist).sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(4)} × ${k}`);
console.log('\n== sample gemini failure messages ==');
const seen = new Set();
for (const x of rows.filter(x => x.vendor === 'gemini' && !x.ok).reverse()) { const m = `${x.model} ${x.err} ${x.status || ''} ${x.finish || ''} ${(x.msg || x.snippet || '').slice(0, 160)}`; if (!seen.has(m.slice(0, 60))) { seen.add(m.slice(0, 60)); console.log(new Date(x.at).toISOString().slice(5, 16), m, x.tok ? JSON.stringify(x.tok) : ''); } if (seen.size >= 12) break; }

// ── Accuracy per AI (from verified meals the app reports once: label + per-AI medians) and run-to-run spread ──
const labels = rows.filter(x => x.flow === 'label' && x.label > 0 && x.per);
console.log(`\n== accuracy vs glucose-verified / confirmed meals (${labels.length}) ==`);
const acc = {};
for (const l of labels) for (const [v, c] of Object.entries(l.per)) if (c > 0) (acc[`${v} (prompt v${l.pv || 1})`] ??= []).push({ e: c - l.label, r: Math.log(c / l.label), big: l.label >= 60 });
for (const [k, es] of Object.entries(acc)) {
  const mae = es.reduce((a, x) => a + Math.abs(x.e), 0) / es.length, bias = es.reduce((a, x) => a + x.r, 0) / es.length;
  const big = es.filter(x => x.big), bigBias = big.length ? big.reduce((a, x) => a + x.r, 0) / big.length : null;
  console.log(`${k.padEnd(24)} n=${es.length} · MAE ${mae.toFixed(1)} g · typical error ±${Math.round((Math.exp(Math.sqrt(es.reduce((a, x) => a + x.r * x.r, 0) / es.length)) - 1) * 100)} % · bias ${bias >= 0 ? '+' : ''}${Math.round((Math.exp(bias) - 1) * 100)} %${bigBias != null ? ` · on meals ≥60 g ${bigBias >= 0 ? '+' : ''}${Math.round((Math.exp(bigBias) - 1) * 100)} % (${big.length})` : ''}`);
}
const spread = {};
for (const [, xs] of Object.entries(group(x => x.job && x.ok && x.carbs != null ? `${x.job}|${x.vendor}|${x.pv || 1}` : 'no'))) {
  if (xs[0]?.job == null || xs.length < 2) continue;
  const cs = xs.map(x => x.carbs).filter(c => c > 0), m = cs.reduce((a, c) => a + c, 0) / cs.length;
  if (cs.length < 2 || !(m > 0)) continue;
  (spread[`${xs[0].vendor} (prompt v${xs[0].pv || 1})`] ??= []).push(Math.sqrt(cs.reduce((a, c) => a + (c - m) ** 2, 0) / (cs.length - 1)) / m);
}
console.log('\n== run-to-run spread on the same photo (coefficient of variation) ==');
for (const [k, cvs] of Object.entries(spread)) console.log(`${k.padEnd(24)} photos ${cvs.length} · median CV ${Math.round(q(cvs, 0.5) * 100)} % · p90 ${Math.round(q(cvs, 0.9) * 100)} %`);
