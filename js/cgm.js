// Data z CGM a pumpy: úložiště (IndexedDB), Nightscout (automaticky) a export z CareLinku (CSV).
// Medtronic nemá veřejné API — automaticky jen přes Nightscout (plněný xDrip+ nebo nightscout-connect).
'use strict';
(function () {
  const DB_NAME = 'kalorie', DB_VER = 1;
  const STORES = { cgm: 't', bolus: 't', pumpset: 't', thumbs: 'id' };
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
  // Stáhne glykémie a bolusy za období a uloží je; vrací počty.
  async function nsSync(cfg, from, to) {
    const sgv = await nsFetch(cfg, '/api/v1/entries/sgv.json', {
      'find[date][$gte]': String(from), 'find[date][$lte]': String(to), count: '2000',
    });
    const readings = (sgv || []).filter(x => x.sgv > 0 && x.date).map(x => ({ t: x.date, v: x.sgv / MG }));
    await put('cgm', readings);
    let boluses = [];
    try {
      const tr = await nsFetch(cfg, '/api/v1/treatments.json', {
        'find[created_at][$gte]': new Date(from).toISOString(), 'find[created_at][$lte]': new Date(to).toISOString(), count: '1000',
      });
      boluses = (tr || []).filter(x => x.insulin > 0).map(x => ({ t: Date.parse(x.created_at), u: +x.insulin, src: 'ns:' + (x.eventType || '') }))
        .filter(b => isFinite(b.t));
      await put('bolus', boluses);
    } catch (e) { /* ošetření nejsou povinná — glykémie stačí pro náhled */ }
    return { readings: readings.length, boluses: boluses.length, last: readings.reduce((a, r) => r.t > (a?.t || 0) ? r : a, null) };
  }

  /* ─── Export z CareLinku ─── */
  async function importCareLink(text) {
    const p = LEARN.parseCareLink(text);
    await put('cgm', p.readings);
    await put('bolus', p.boluses);
    await put('pumpset', p.settings);
    const first = p.readings[0]?.t, last = p.readings[p.readings.length - 1]?.t;
    return { readings: p.readings.length, boluses: p.boluses.length, settings: p.settings.length, first, last,
      lastSet: p.settings[p.settings.length - 1] || null, unit: p.unit };
  }

  window.CGM = { put, range, get, del, lastKey, clearAll, nsSync, nsFetch, nsBase, nsTokenFromUrl, importCareLink, MG };
})();
