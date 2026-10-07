// Data z CGM a pumpy: úložiště (IndexedDB), Nightscout (automaticky) a export z CareLinku (CSV).
// Medtronic nemá veřejné API — automaticky jen přes Nightscout (plněný xDrip+ nebo nightscout-connect).
'use strict';
(function () {
  const DB_NAME = 'kalorie', DB_VER = 4;
  // basal = automatický bazál pumpy (U/h po 5 min), jobs = fotky a popisy čekající na odhad AI,
  // pcarbs = sacharidy zadané do pumpy (bolusový kalkulátor), targets = dočasný cíl pumpy (pohyb).
  const STORES = { cgm: 't', bolus: 't', pumpset: 't', thumbs: 'id', basal: 't', jobs: 'id', pcarbs: 't', targets: 't' };
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const rq = indexedDB.open(DB_NAME, DB_VER);
      rq.onupgradeneeded = () => {
        for (const [name, key] of Object.entries(STORES))
          if (!rq.result.objectStoreNames.contains(name)) rq.result.createObjectStore(name, { keyPath: key });
      };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
    return dbp;
  }
  const done = tx => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
  async function put(store, items) {
    if (!items.length) return;
    const tx = (await db()).transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const it of items) os.put(it);
    await done(tx);
  }
  async function range(store, from, to) {
    const tx = (await db()).transaction(store, 'readonly');
    const rq = tx.objectStore(store).getAll(IDBKeyRange.bound(from, to));
    return new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
  }
  async function get(store, key) {
    const tx = (await db()).transaction(store, 'readonly');
    const rq = tx.objectStore(store).get(key);
    return new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
  }
  async function del(store, key) {
    const tx = (await db()).transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    await done(tx);
  }
  async function lastKey(store) {
    const tx = (await db()).transaction(store, 'readonly');
    const rq = tx.objectStore(store).openCursor(null, 'prev');
    return new Promise((res, rej) => { rq.onsuccess = () => res(rq.result ? rq.result.value : null); rq.onerror = () => rej(rq.error); });
  }
  async function all(store) {
    const tx = (await db()).transaction(store, 'readonly');
    const rq = tx.objectStore(store).getAll();
    return new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
  }
  async function clear(store) {
    const tx = (await db()).transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    await done(tx);
  }
  async function clearAll() {
    const d = await db();
    const tx = d.transaction(Object.keys(STORES), 'readwrite');
    for (const s of Object.keys(STORES)) tx.objectStore(s).clear();
    await done(tx);
  }

  /* ─── Nightscout ─── */
  const MG = 18.0182;
  function nsBase(url) {
    let u = String(url || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
    if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u;
  }
  // Odkaz s tokenem z Admin Tools (…/?token=kalorie-…) — vytáhnout token.
  const nsTokenFromUrl = url => { const m = /[?&]token=([^&#\s]+)/.exec(String(url || '')); return m ? decodeURIComponent(m[1]) : ''; };
  async function nsFetch(cfg, path, params) {
    const qs = new URLSearchParams(params);
    if (cfg.token) qs.set('token', cfg.token);
    let r;
    try { r = await fetch(nsBase(cfg.url) + path + '?' + qs.toString(), { headers: { accept: 'application/json' } }); }
    catch (e) { throw new Error('cors'); }
    if (r.status === 401 || r.status === 403) throw new Error('auth');
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  }
  // Klíče, které slučují duplicity z uploaderu (stejná dávka s časem posunutým o sekundy):
  // bolus = minuta + dávka v setinách U (různé dávky ve stejné minutě zůstanou zvlášť),
  // bazál = 5minutový úsek pumpy.
  const bolusKey = (t, u) => Math.round(t / 60000) * 60000 + Math.round(u * 100) % 1000;
  const basalKey = t => Math.round(t / 300000) * 300000;
  const normBolus = b => ({ ...b, t: bolusKey(b.t, b.u), t0: b.t });

  // Stáhne glykémie, bolusy a automatický bazál za období a uloží je; vrací počty.
  async function nsSync(cfg, from, to) {
    const sgv = await nsFetch(cfg, '/api/v1/entries/sgv.json', {
      'find[date][$gte]': String(from), 'find[date][$lte]': String(to), count: '5000',
    });
    const readings = (sgv || []).filter(x => x.sgv > 0 && x.date).map(x => ({ t: x.date, v: x.sgv / MG }));
    await put('cgm', readings);
    const win = { 'find[created_at][$gte]': new Date(from).toISOString(), 'find[created_at][$lte]': new Date(to).toISOString() };
    let boluses = [], basal = [];
    try {
      const tr = await nsFetch(cfg, '/api/v1/treatments.json', { ...win, 'find[insulin][$gt]': '0', count: '3000' });
      boluses = (tr || []).filter(x => x.insulin > 0).map(x => normBolus({ t: Date.parse(x.created_at), u: +x.insulin, src: 'ns:' + (x.eventType || '') }))
        .filter(b => isFinite(b.t));
      await put('bolus', boluses);
    } catch (e) { /* ošetření nejsou povinná — glykémie stačí pro náhled */ }
    try {
      const tc = await nsFetch(cfg, '/api/v1/treatments.json', { ...win, 'find[carbs][$gt]': '0', count: '2000' });
      await put('pcarbs', (tc || []).filter(x => x.carbs > 0 && isFinite(Date.parse(x.created_at)))
        .map(x => ({ t: Math.round(Date.parse(x.created_at) / 60000) * 60000, g: +x.carbs })));
    } catch (e) { /* sacharidy z pumpy jsou jen doplněk */ }
    try {
      // Dočasný cíl 780G (pohyb) — od začátku 12 h zpět, ať se zachytí i delší aktivita před jídlem.
      const tt = await nsFetch(cfg, '/api/v1/treatments.json', { 'find[created_at][$gte]': new Date(from - 12 * 3600e3).toISOString(),
        'find[created_at][$lte]': new Date(to).toISOString(), 'find[eventType]': 'Temporary Target', count: '500' });
      await put('targets', (tt || []).filter(x => isFinite(Date.parse(x.created_at)))
        .map(x => ({ t: Date.parse(x.created_at), dur: +x.duration || 0 })));
    } catch (e) { /* bez údajů o pohybu se počítá jako dřív */ }
    try {
      const tb = await nsFetch(cfg, '/api/v1/treatments.json', { ...win, 'find[eventType]': 'Temp Basal', count: '5000' });
      basal = (tb || []).filter(x => x.absolute != null && isFinite(Date.parse(x.created_at)))
        .map(x => ({ t: basalKey(Date.parse(x.created_at)), r: +x.absolute }));
      await put('basal', basal);
    } catch (e) { /* bez automatického bazálu se počítá jako dřív */ }
    return { readings: readings.length, boluses: boluses.length, basal: basal.length, last: readings.reduce((a, r) => r.t > (a?.t || 0) ? r : a, null) };
  }

  // Jednorázově: bolusy uložené dřívější verzí (s duplicitami) přeuložit pod nové klíče.
  async function migrateBoluses() {
    const old = await all('bolus');
    const seen = new Map();
    for (const b of old.sort((a, c) => a.t - c.t)) { const n = normBolus({ ...b, t: b.t0 ?? b.t }); if (!seen.has(n.t)) seen.set(n.t, n); }
    await clear('bolus');
    await put('bolus', [...seen.values()]);
    return { before: old.length, after: seen.size };
  }

  /* ─── Export z CareLinku ─── */
  async function importCareLink(text) {
    const p = LEARN.parseCareLink(text);
    await put('cgm', p.readings);
    await put('bolus', p.boluses.map(normBolus));
    await put('pcarbs', (p.carbsEntered || []).map(c => ({ t: Math.round(c.t / 60000) * 60000, g: c.g })));
    await put('pumpset', p.settings);
    const first = p.readings[0]?.t, last = p.readings[p.readings.length - 1]?.t;
    return { readings: p.readings.length, boluses: p.boluses.length, settings: p.settings.length, first, last,
      lastSet: p.settings[p.settings.length - 1] || null, unit: p.unit };
  }

  window.CGM = { put, range, get, del, all, clear, lastKey, clearAll, nsSync, nsFetch, nsBase, nsTokenFromUrl, importCareLink, migrateBoluses, MG };
})();
