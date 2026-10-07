// Reads the Kalorie AI log from kalorie-ai /diag and prints a failure summary.
// Usage: cd kalorie/ai-server && railway run --service kalorie-ai node diag-read.mjs [days]
import { createHash } from 'node:crypto';
const days = +(process.argv[2] || 7);
const admin = createHash('sha1').update(process.env.NS_API_SECRET).digest('hex');
const since = new Date(Date.now() - days * 864e5).toISOString();
const r = await fetch(`https://kalorie-ai-production.up.railway.app/diag?since=${since}&limit=20000`, { headers: { 'x-admin': admin } });
if (!r.ok) { console.log('HTTP', r.status, await r.text()); process.exit(1); }
const rows = await r.json();
console.log(`${rows.length} attempts in the last ${days} days`);
const by = {};
for (const x of rows) {
  const k = `${x.mode}/${x.flow}/${x.model || x.vendor}`;
  const b = (by[k] ??= { n: 0, ok: 0, errs: {}, ms: [] });
  b.n++; if (x.ok) b.ok++; else { const e = `${x.err}${x.status ? ' ' + x.status : ''}${x.finish ? ' ' + x.finish : ''}`; b.errs[e] = (b.errs[e] || 0) + 1; }
  if (x.ms) b.ms.push(x.ms);
}
for (const [k, b] of Object.entries(by).sort((a, c) => c[1].n - a[1].n)) {
  const med = b.ms.sort((p, q) => p - q)[b.ms.length >> 1];
  console.log(`${k.padEnd(40)} ${String(Math.round(b.ok / b.n * 100)).padStart(3)} % ok of ${String(b.n).padStart(4)} · median ${med ? (med / 1000).toFixed(1) + ' s' : '-'} · ${Object.entries(b.errs).sort((p, q) => q[1] - p[1]).map(([e, n]) => `${e}×${n}`).join(', ')}`);
}
const fails = rows.filter(x => !x.ok).slice(-8);
if (fails.length) console.log('\nlatest failures:\n' + fails.map(x => `${new Date(x.at).toISOString().slice(5, 16)} ${x.dev} ${x.model || x.vendor} ${x.err} ${x.status || ''} ${x.finish || ''} ${x.tok ? JSON.stringify(x.tok) : ''} ${(x.msg || x.snippet || '').slice(0, 120)}`).join('\n'));
