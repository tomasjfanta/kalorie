// Removes duplicate treatments the bridge re-uploaded with drifting timestamps (keeps the first copy).
// Duplicate = same uploader, eventType and amounts, within 150 s of an already-kept record.
// Usage (from kalorie/carelink-bridge): railway run --service carelink-bridge node tools/ns-dedupe.mjs [--delete]
import { createHash } from 'node:crypto';
const base = process.env.NIGHTSCOUT_URL.replace(/\/+$/, '');
const headers = { 'api-secret': createHash('sha1').update(process.env.NIGHTSCOUT_API_SECRET).digest('hex') };
const del = process.argv.includes('--delete');
const from = new Date(Date.now() - 4 * 864e5).toISOString();
const q = new URLSearchParams({ 'find[created_at][$gte]': from, 'find[enteredBy]': 'cl2ns-sync-engine/1.0', count: '20000' });
const all = await (await fetch(`${base}/api/v1/treatments.json?${q}`, { headers })).json();
const inserted = x => parseInt(String(x._id).slice(0, 8), 16);
all.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || inserted(a) - inserted(b));
const sig = x => [x.eventType, x.insulin, x.carbs, x.absolute, x.duration, x.glucose].join('|');
const kept = new Map(), dupes = [];
for (const x of all) {
  const t = Date.parse(x.created_at), k = sig(x);
  const list = kept.get(k) || [];
  const twin = list.find(y => Math.abs(Date.parse(y.created_at) - t) <= 150000);
  if (twin) {
    // keep whichever copy was inserted first
    if (inserted(x) < inserted(twin)) { dupes.push(twin); list[list.indexOf(twin)] = x; } else dupes.push(x);
  } else { list.push(x); kept.set(k, list); }
}
const byType = {};
for (const d of dupes) byType[d.eventType] = (byType[d.eventType] || 0) + 1;
console.log(`treatments (4 days): ${all.length} · duplicates: ${dupes.length} ${JSON.stringify(byType)} · would keep ${all.length - dupes.length}`);
if (del && dupes.length) {
  let ok = 0, fail = 0;
  for (const d of dupes) {
    const r = await fetch(`${base}/api/v1/treatments/${d._id}`, { method: 'DELETE', headers });
    if (r.ok) ok++; else fail++;
  }
  console.log(`deleted ${ok}, failed ${fail}`);
}
