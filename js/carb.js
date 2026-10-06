// Režim sacharidů — jen fotky. Fotka → AI odhad (s osobní kalibrací) → po 2,5 h ověření
// glykémií z CGM a inzulinem → učení, které zpřesňuje další odhady.
'use strict';
(function () {
  const K = window.KAL;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const MIN = 60000, DAY = 86400000;
  const PRE = 30 * MIN, POST = 150 * MIN;
  const MG = 18.0182;
  const esc = K.esc, r0 = K.r0, dec = K.dec;

  /* ─── Nastavení léčby ─── */
  const defTherapy = () => ({ type: 'aid', insulin: 'rapid', unit: 'mmol', segs: [{ od: '00:00', icr: '', isf: '' }] });
  const therapy = () => K.settings().therapy || defTherapy();
  const isMg = () => therapy().unit === 'mgdl';
  const uLbl = () => isMg() ? 'mg/dl' : 'mmol/l';
  const fmtBG = v => v == null ? '–' : isMg() ? String(Math.round(v * MG)) : dec(K.r1(v));
  const toMmol = v => v == null || v === '' ? null : (isMg() ? K.num(v) / MG : K.num(v));
  const hhmm = t => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const dataAt = () => +(K.store.get('kal.dataAt', 0) || 0);
  const touchData = () => K.store.set('kal.dataAt', Date.now());

  /* ─── Záznamy z fotek ─── */
  function photoEntries() {
    const out = [], D = K.days();
    for (const d of Object.keys(D)) for (const e of D[d].e || []) if (e.cs === 'ai-photo' && e.ts) out.push(e);
    return out.sort((a, b) => a.ts - b.ts);
  }
  function findEntry(id) {
    const D = K.days();
    for (const d of Object.keys(D)) { const e = (D[d].e || []).find(x => x.id === id); if (e) return { e, key: d }; }
    return null;
  }

  /* ─── Učení: osobní kalibrace AI ─── */
  let calCache = null;
  function samples() {
    return photoEntries().filter(e => !e.excl && e.aiRaw).map(e => {
      if (e.conf != null) return { ts: e.ts, kat: e.kat, aiRaw: e.aiRaw, label: e.conf, src: 'confirmed' };
      if (e.ev?.implied && (e.ev.quality === 'good' || e.ev.quality === 'fair')) return { ts: e.ts, kat: e.kat, aiRaw: e.aiRaw, label: e.ev.implied, src: e.ev.quality };
      return null;
    }).filter(Boolean);
  }
  function cal() { if (!calCache) calCache = LEARN.calibrate(samples(), Date.now()); return calCache; }
  const invalidate = () => { calCache = null; };

  // Bez inzulinu: osobní reakce glykémie na 1 g sacharidů (z potvrzených, jinak z AI odhadů → jen relativní).
  function kNone() {
    const ev = photoEntries().filter(e => e.ev?.iauc > 0 && !e.excl);
    const conf = ev.filter(e => e.conf != null);
    const base = conf.length >= 4 ? conf.map(e => ({ iauc: e.ev.iauc, absorbed: e.ev.absorbed, label: e.conf }))
      : ev.map(e => ({ iauc: e.ev.iauc, absorbed: e.ev.absorbed, label: e.aiRaw }));
    return LEARN.estimateKNone(base);
  }

  /* ─── Poměr a citlivost pro daný čas: z pumpy (export CareLinku), jinak ručně ─── */
  function makeSettingsAt(pumpset) {
    const tod = t => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); };
    return ts => {
      const m = tod(ts);
      let best = null, bestScore = Infinity;
      for (const p of pumpset) {
        let d = Math.abs(tod(p.t) - m); d = Math.min(d, 1440 - d);
        const score = d + Math.abs(p.t - ts) / DAY; // stejná denní doba, novější den má přednost
        if (d <= 90 && score < bestScore) { bestScore = score; best = p; }
      }
      if (best) return { icr: best.icr, isf: best.isf, src: 'pump' };
      const seg = LEARN.segmentAt((therapy().segs || []).filter(s => K.num(s.icr) > 0 && K.num(s.isf) > 0), ts);
      return seg ? { icr: K.num(seg.icr), isf: toMmol(seg.isf), src: 'manual' } : null;
    };
  }

  async function loadWindow(e) {
    const [readings, boluses, pumpset] = await Promise.all([
      CGM.range('cgm', e.ts - PRE, e.ts + POST),
      CGM.range('bolus', e.ts - 180 * MIN, e.ts + POST),
      CGM.range('pumpset', e.ts - 30 * DAY, e.ts + 30 * DAY),
    ]);
    return { readings, boluses, pumpset };
  }

  async function evaluate(e, all) {
    const w = await loadWindow(e);
    const manual = {};
    if (e.man?.bg0) manual.bg0 = e.man.bg0;
    if (e.man?.bg2) manual.bg2 = e.man.bg2;
    if (e.units) manual.units = e.units;
    const ev = LEARN.evaluateMeal(
      { ts: e.ts, aiRaw: e.aiRaw, kat: e.kat, fat: e.fat, manual },
      { readings: w.readings, boluses: w.boluses, otherMeals: all.filter(x => x.id !== e.id).map(x => x.ts), settingsAt: makeSettingsAt(w.pumpset) },
      therapy(), therapy().type === 'none' ? kNone() : null);
    e.ev = {
      implied: ev.implied, quality: ev.quality, flags: ev.flags, bg0: ev.bg0, peak: ev.peak, tPeak: ev.tPeak,
      end: ev.end, iauc: ev.iauc, coverage: ev.coverage, units: ev.units, absorbed: ev.absorbed,
      icr: ev.icr, isf: ev.isf, n: w.readings.length, at: Date.now(),
      final: Date.now() > e.ts + POST + 10 * MIN,
    };
    return { ev, ...w };
  }

  /* ─── Průběžná synchronizace a vyhodnocení (bez tlačítek — samo při otevření a každých 5 min) ─── */
  let busy = false;
  async function nsAutoSync() {
    const ns = K.store.get('kal.ns', null);
    if (!ns?.url) return;
    const last = +(K.store.get('kal.nsSync', 0) || 0);
    if (Date.now() - last < 5 * MIN) return;
    const lastR = await CGM.lastKey('cgm').catch(() => null);
    const from = Math.max(Date.now() - 3 * DAY, (lastR?.t || 0) - 60 * MIN);
    try {
      const r = await CGM.nsSync(ns, from, Date.now());
      K.store.set('kal.nsSync', Date.now());
      K.store.set('kal.nsLast', r.last ? { t: r.last.t, v: r.last.v } : K.store.get('kal.nsLast', null));
      if (r.readings || r.boluses) touchData();
    } catch (e) { K.store.set('kal.nsErr', { at: Date.now(), msg: e.message }); }
  }
  async function refresh() {
    if (busy || !K.isCarb()) return;
    busy = true;
    try {
      await nsAutoSync();
      const all = photoEntries(), now = Date.now(), changed = [];
      for (const e of all) {
        if (e.ts > now || now - e.ts > 45 * DAY) continue;
        if (e.ev?.final && e.ev.at >= dataAt()) continue;
        await evaluate(e, all); changed.push(e);
      }
      if (changed.length) { K.saveAll(); invalidate(); }
    } catch (err) { console.warn('refresh', err); }
    finally { busy = false; }
    K.renderDnes();
    if ($('#view-uceni').classList.contains('active')) renderLearn();
  }

  /* ─── Časová osa dne ─── */
  function status(e) {
    if (e.conf != null) return '✓ potvrzeno';
    if (e.excl) return 'vyřazeno z učení';
    if (Date.now() < e.ts + POST) return '⏳ ověření glykémií v ' + hhmm(e.ts + POST);
    if (e.ev?.implied && LEARN.REL_SD[e.ev.quality]) return '📈 podle glykémie ~' + r0(e.ev.implied) + ' g';
    return '— ' + (e.ev?.flags?.[0] || 'zatím bez dat z CGM');
  }
  function renderTimeline() {
    const box = $('#ctimeline');
    if (!box || !K.isCarb()) return;
    const es = [...(K.day().e || [])].sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (!es.length) {
      box.innerHTML = '<div class="result-note">Zatím žádné jídlo. Vyfoťte talíř — AI odhadne sacharidy a glykémie z CGM pak odhad ověří a zpřesní další.</div>';
      return;
    }
    box.innerHTML = es.map(e => {
      const c = K.entryConf(e);
      const sub = (e.ts ? hhmm(e.ts) + ' · ' : '') + (e.cs === 'ai-photo' ? status(e) : 'ruční zápis');
      return `<button class="ctl-row" data-id="${e.id}"><img class="ctl-thumb" data-thumb="${e.id}" alt=""><span class="ctl-mid"><span class="ctl-name">${esc(e.n)}</span><span class="ctl-sub">${sub}</span></span><span class="e-carb"><span class="e-kcal">${K.fmtC(c.C)}</span>${K.badge(c.p)}</span></button>`;
    }).join('');
    $$('#ctimeline .ctl-row').forEach(b => b.addEventListener('click', () => openMeal(b.dataset.id)));
    $$('#ctimeline img[data-thumb]').forEach(img => {
      CGM.get('thumbs', img.dataset.thumb).then(x => { if (x) img.src = x.data; else img.classList.add('empty'); }).catch(() => img.classList.add('empty'));
    });
  }

  /* ─── Nové jídlo z fotky ─── */
  let pending = null;
  $('#cphoto-btn').addEventListener('click', () => {
    if (!K.aiConfig().key) { K.toast('Nejdřív vložte Google API klíč v Nastavení'); K.showView('nastaveni'); return; }
    $('#cphoto-input').value = '';
    $('#cphoto-input').click();
  });
  $('#cphoto-input').addEventListener('change', ev => { const f = ev.target.files[0]; if (f) startPhoto(f); });

  function makeThumb(dataUrl) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const s = 160 / Math.max(img.naturalWidth, img.naturalHeight);
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.naturalWidth * s); cv.height = Math.round(img.naturalHeight * s);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  async function startPhoto(file) {
    const now = Date.now();
    // Fotka z galerie nese čas pořízení — jídlo snědené dřív se tak spáruje se správnou glykémií.
    const ts = file.lastModified && file.lastModified <= now && now - file.lastModified < DAY ? file.lastModified : now;
    let img;
    try { img = await AI.downscale(file); } catch (e) { K.toast('Fotku se nepodařilo načíst'); return; }
    pending = { img, thumb: await makeThumb(img.dataUrl), ts };
    $('#cnew-img').src = img.dataUrl;
    $('#cnew-form').classList.add('hidden');
    $('#cnew-retry').classList.add('hidden');
    K.openSheet('sheet-cnew');
    analyze();
  }
  $('#cnew-retry').addEventListener('click', () => { $('#cnew-retry').classList.add('hidden'); analyze(); });

  // Ověřená jídla uživatele jako kontext pro AI — pomáhá poznat jeho obvyklá jídla a porce.
  function examplesText() {
    const seen = new Set(), ex = [];
    for (const e of photoEntries().reverse()) {
      if (e.conf == null || e.excl) continue;
      const key = e.n.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key); ex.push(`„${e.n}" = ${r0(e.conf)} g`);
      if (ex.length >= 8) break;
    }
    return ex.length ? ' Jídla tohoto uživatele, jejichž skutečné sacharidy byly ověřeny glykémií — použij je k rozpoznání jeho obvyklých jídel a velikostí porcí: ' + ex.join('; ') + '.' : '';
  }

  const RUNS = 5; // nezávislých odhadů na fotku — medián je stabilnější než jeden odhad
  const JIST = ['nízká', 'střední', 'vysoká'];
  // Jedna odpověď modelu → { c, min, max, jist (0–2), kat, j, model }
  function parseRun({ result: j, model }) {
    const jt = String(j.jistota || '').toLowerCase();
    let min = +j.sacharidy_min, max = +j.sacharidy_max;
    if (!(isFinite(min) && isFinite(max)) || min < 0) { min = undefined; max = undefined; }
    else if (min > max) [min, max] = [max, min];
    return { c: Math.max(0, +j.sacharidy || 0), min, max, kat: LEARN.catKey(j.kategorie), j, model,
      jist: /vys|high/.test(jt) ? 2 : /níz|niz|low/.test(jt) ? 0 : 1 };
  }

  async function analyze() {
    const status = (k, n) => { $('#cnew-status').textContent = `Odhaduji sacharidy… ${k}/${n} (pár vteřin)`; };
    status(0, RUNS);
    const res = await AI.callGeminiRuns(
      { imageBase64: pending.img.base64, imageMedia: 'image/jpeg', extra: examplesText() }, RUNS, status);
    if (!pending) return;
    if (res.error) { $('#cnew-status').textContent = AI.errMsg(res); $('#cnew-retry').classList.remove('hidden'); return; }
    const runs = res.runs.map(parseRun);
    const E = LEARN.ensemble(runs);
    const j = E.rep.j;
    const aiRaw = E.c, kat = E.kat;
    const c = LEARN.applyCal(aiRaw, kat, cal());
    const sMin = E.min != null ? E.min * c.factor : undefined, sMax = E.max != null ? E.max * c.factor : undefined;
    const name = (j.nazev || 'Jídlo').trim() + (j.mnozstvi ? ' (' + String(j.mnozstvi).trim() + ')' : '');
    pending.ai = { name, aiRaw, kat, factor: c.factor, jist: JIST[E.jist], sMin, sMax,
      sSd: E.sd != null ? E.sd * c.factor : undefined,
      runs: runs.map(r => ({ m: r.model, c: r.c })), values: E.values, fat: Math.max(0, +j.tuky || 0),
      kcal: Math.round(+j.kcal || 0), b: Math.round(+j.bilkoviny || 0), t: Math.round(+j.tuky || 0) };
    $('#cnew-name').value = name;
    $('#cnew-carbs').value = r0(c.C);
    $('#cnew-time').value = hhmm(pending.ts);
    $('#cnew-units').value = '';
    $$('.cnew-ins').forEach(x => x.classList.toggle('hidden', therapy().type === 'none'));
    const calTxt = Math.abs(c.factor - 1) > 0.02
      ? ` → podle vašich ověřených jídel (${LEARN.CATS[kat].short}) ×${dec(Math.round(c.factor * 100) / 100)} = <b>${r0(c.C)} g</b>` : '';
    const runsTxt = E.n > 1 ? ` <span class="muted">(medián z ${E.n} odhadů: ${E.values.map(r0).join(' · ')} g)</span>` : '';
    $('#cnew-ai').innerHTML = `AI odhad: ${r0(aiRaw)} g${runsTxt}${calTxt}${j.poznamka ? '<br>' + esc(j.poznamka) : ''}`;
    newConf();
    $('#cnew-status').textContent = '';
    $('#cnew-form').classList.remove('hidden');
  }
  function newConf() {
    if (!pending?.ai) return;
    const C = K.num($('#cnew-carbs').value);
    const a = pending.ai;
    const r = CONF.entrySigma({ C, kind: 'ai-photo', jist: a.jist, sMin: a.sMin, sMax: a.sMax, sSd: a.sSd, learnedSd: cal().sd });
    const p = CONF.probWithin(r.sigma, K.TOL());
    $('#cnew-conf').innerHTML = `Jistota na ±${K.TOL()} g: ${K.badge(p)} · nejspíš ${r0(Math.max(0, C - CONF.Z90 * r.sigma))}–${r0(C + CONF.Z90 * r.sigma)} g${K.vjTxt(C)}`
      + (r.driver === 'spread' ? '<br>💡 ' + CONF.TIP.spread
        : cal().sd ? '<br>Počítá s vaší ověřenou přesností AI (±' + r0(cal().sd * 100) + ' %).' : '');
  }
  $('#cnew-carbs').addEventListener('input', newConf);

  function tsFromTime(base, hm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hm || '');
    if (!m) return base;
    const d = new Date(base); d.setHours(+m[1], +m[2], 0, 0);
    let t = d.getTime();
    if (t > Date.now() + 10 * MIN) t -= DAY; // večerní čas zadaný po půlnoci
    return t;
  }

  $('#cnew-save').addEventListener('click', async () => {
    if (!pending?.ai) return;
    if ($('#cnew-carbs').value.trim() === '') { K.toast('Zadejte sacharidy'); return; }
    const a = pending.ai;
    const ts = tsFromTime(pending.ts, $('#cnew-time').value);
    const units = K.num($('#cnew-units').value);
    const id = 'p' + Date.now() + Math.random().toString(36).slice(2, 6);
    const C = K.num($('#cnew-carbs').value);
    const e = { id, n: $('#cnew-name').value.trim() || 'Jídlo', q: 1, s: C, kcal: a.kcal, b: a.b, t: a.t,
      cs: 'ai-photo', jist: a.jist, sMin: a.sMin, sMax: a.sMax, sSd: a.sSd, meal: 'sv', ts, kat: a.kat, fat: a.fat,
      aiRaw: a.aiRaw, calF: a.factor, aiRuns: a.runs };
    if (units > 0) e.units = units;
    K.day(K.dstr(new Date(ts))).e.push(e);
    K.saveAll();
    if (pending.thumb) await CGM.put('thumbs', [{ id, data: pending.thumb }]).catch(() => {});
    pending = null;
    K.closeSheet('sheet-cnew');
    invalidate();
    K.renderDnes();
    K.toast('Uloženo: ' + r0(C) + ' g sacharidů');
  });
  $('#sheet-cnew').addEventListener('click', ev => { if (ev.target.id === 'sheet-cnew') pending = null; });
  $('#sheet-cnew .sheet-close').addEventListener('click', () => { pending = null; });

  /* ─── Detail jídla: graf glykémie, ověření, potvrzení ─── */
  let openId = null;
  async function openMeal(id) {
    const f = findEntry(id);
    if (!f) return;
    openId = id;
    $('#cmeal-title').textContent = f.e.ts ? hhmm(f.e.ts) + ' · ' + K.fmtHuman(f.key) : 'Jídlo';
    $('#cmeal-body').innerHTML = '<div class="result-note">Načítám…</div>';
    K.openSheet('sheet-cmeal');
    let w = { readings: [], boluses: [] };
    if (f.e.cs === 'ai-photo' && f.e.ts) {
      const r = await evaluate(f.e, photoEntries());
      w = r; K.saveAll(); invalidate();
    }
    const thumb = await CGM.get('thumbs', id).catch(() => null);
    if (openId !== id) return;
    renderMeal(f.e, w, thumb);
    K.renderDnes();
  }

  function chartSVG(e, readings, boluses) {
    if (!readings.length) return '';
    const W = 340, H = 150, L = 30, R = 8, T = 8, B = 22;
    const xs = m => L + (W - L - R) * (m + 30) / 180;
    const vals = readings.map(r => r.v);
    const lo = Math.min(3.5, ...vals) - 0.3, hi = Math.max(11, ...vals) + 0.5;
    const ys = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    const pts = readings.map(r => xs((r.t - e.ts) / MIN).toFixed(1) + ',' + ys(r.v).toFixed(1)).join(' ');
    const band = `<rect x="${L}" y="${ys(10).toFixed(1)}" width="${W - L - R}" height="${(ys(3.9) - ys(10)).toFixed(1)}" class="bg-band"/>`;
    const base = e.ev?.bg0 != null ? `<line x1="${L}" x2="${W - R}" y1="${ys(e.ev.bg0).toFixed(1)}" y2="${ys(e.ev.bg0).toFixed(1)}" class="bg-base"/>` : '';
    const meal = `<line x1="${xs(0)}" x2="${xs(0)}" y1="${T}" y2="${H - B}" class="bg-meal"/><text x="${xs(0) + 3}" y="${T + 10}" class="bg-lbl">🍽</text>`;
    const bol = boluses.filter(b => b.t >= e.ts - PRE && b.t <= e.ts + POST).map(b => {
      const x = xs((b.t - e.ts) / MIN);
      return `<path d="M${x - 4},${H - B} L${x + 4},${H - B} L${x},${H - B - 7} Z" class="bg-bolus"/><text x="${x}" y="${H - B - 9}" class="bg-lbl" text-anchor="middle">${dec(K.r1(b.u))} U</text>`;
    }).join('');
    const ticksX = [-30, 0, 60, 120, 150].map(m => `<text x="${xs(m)}" y="${H - 6}" class="bg-tick" text-anchor="${m === 150 ? 'end' : m === -30 ? 'start' : 'middle'}">${m === 0 ? '0' : (m > 0 ? '+' : '') + m}</text>`).join('');
    const ticksY = [4, 7, 10].filter(v => v > lo && v < hi).map(v => `<text x="${L - 4}" y="${ys(v) + 3}" class="bg-tick" text-anchor="end">${fmtBG(v)}</text>`).join('');
    const dots = readings.map(r => `<circle cx="${xs((r.t - e.ts) / MIN).toFixed(1)}" cy="${ys(r.v).toFixed(1)}" r="1.6" class="bg-dot"/>`).join('');
    return `<svg class="bg-chart" viewBox="0 0 ${W} ${H}">${band}${base}${meal}<polyline points="${pts}" class="bg-line"/>${dots}${bol}${ticksX}${ticksY}</svg><div class="muted small-text center">minuty od jídla · glykémie v ${uLbl()} · pás = 3,9–10 mmol/l</div>`;
  }

  const QLBL = { good: 'dobrá', fair: 'střední', poor: 'slabá', none: '—' };
  function renderMeal(e, w, thumb) {
    const c = K.entryConf(e);
    const ev = e.ev;
    let h = '';
    if (thumb) h += `<img class="cmeal-photo" src="${thumb.data}" alt="">`;
    h += `<div class="cmeal-head"><div class="ctl-name">${esc(e.n)}</div><div class="e-carb"><span class="e-kcal">${K.fmtC(c.C)}</span>${K.badge(c.p)}</div></div>`;
    if (e.aiRaw != null) h += `<div class="muted small-text">AI odhad ${r0(e.aiRaw)} g${e.calF && Math.abs(e.calF - 1) > 0.02 ? ' · s vaší kalibrací ×' + dec(Math.round(e.calF * 100) / 100) : ''} · zapsáno ${K.fmtC(e.s)}</div>`;

    if (e.cs === 'ai-photo' && e.ts) {
      h += chartSVG(e, w.readings || [], w.boluses || []);
      if (ev && ev.bg0 != null) {
        const pk = ev.peak != null ? ` · maximum ${fmtBG(ev.peak)}${ev.tPeak ? ' (za ' + r0((ev.tPeak - e.ts) / MIN) + ' min)' : ''}` : '';
        h += `<div class="ev-metrics">Před jídlem ${fmtBG(ev.bg0)}${pk}${ev.end != null ? ' · na konci ' + fmtBG(ev.end) : ''} ${uLbl()}${ev.units != null ? ' · účinný inzulin ' + dec(K.r1(ev.units)) + ' U' : ''}</div>`;
      }
      const pendingWin = Date.now() < e.ts + POST;
      if (ev?.implied && LEARN.REL_SD[ev.quality]) {
        const prior = CONF.entrySigma({ C: e.s, kind: 'ai-photo', jist: e.jist, sMin: e.sMin, sMax: e.sMax, sSd: e.sSd, learnedSd: cal().sd }).sigma;
        const post = LEARN.combine(e.s, prior, ev.implied, ev.quality);
        h += `<div class="ev-box">Podle glykémie a inzulinu mělo jídlo nejspíš <b>~${r0(ev.implied)} g</b> sacharidů (spolehlivost výpočtu: ${QLBL[ev.quality]}).<br>Spojeno s odhadem z fotky: <b>${r0(post.C)} g</b> (±${r0(CONF.Z90 * post.sigma)} g).</div>`;
        if (e.conf == null && !e.excl) h += `<div class="ev-actions"><input id="cm-conf" type="text" inputmode="decimal" value="${r0(post.C)}"><span class="unit">g</span><button id="cm-confirm" class="btn slim">✓ Potvrdit jako skutečnost</button></div>`;
      } else if (pendingWin) {
        h += `<div class="ev-box">Ověření glykémií bude možné po ${hhmm(e.ts + POST)} (2,5 h po jídle). Aplikace si data stáhne sama.</div>`;
      } else {
        h += `<div class="ev-box">Zatím nelze ověřit: ${esc((ev?.flags || ['chybí data z CGM']).join(', '))}.</div>`;
      }
      if (ev?.flags?.length && ev.implied) h += `<div class="muted small-text">Pozn.: ${esc(ev.flags.join(' · '))}</div>`;

      // Ruční doplnění, když CGM data chybí
      if (!pendingWin && !(ev?.n > 0) && e.conf == null) {
        h += `<details class="conf-how"><summary>Doplnit glykémii ručně</summary>
          <div class="tri-row"><label class="field">Před jídlem (${uLbl()})<input id="cm-bg0" type="text" inputmode="decimal" value="${e.man?.bg0 ? fmtBG(e.man.bg0) : ''}"></label>
          <label class="field">2,5 h po (${uLbl()})<input id="cm-bg2" type="text" inputmode="decimal" value="${e.man?.bg2 ? fmtBG(e.man.bg2) : ''}"></label></div>
          <button id="cm-man" class="btn btn-ghost slim">Vyhodnotit</button></details>`;
      }
      if (therapy().type !== 'none' && e.conf == null) {
        h += `<details class="conf-how"${e.units ? ' open' : ''}><summary>Inzulin k jídlu ${e.units ? '(' + dec(e.units) + ' U)' : ''}</summary>
          <p class="muted small-text">Jen pokud ho aplikace nenačte z CareLinku/Nightscoutu.</p>
          <div class="ev-actions"><input id="cm-units" type="text" inputmode="decimal" value="${e.units || ''}"><span class="unit">U</span><button id="cm-units-save" class="btn btn-ghost slim">Uložit</button></div></details>`;
      }
      // Potvrzení / vyřazení
      if (e.conf != null) h += `<div class="ev-box ok">✓ Potvrzeno: ${r0(e.conf)} g — jídlo se používá k učení s plnou vahou.</div><button id="cm-unconf" class="btn btn-ghost slim">Zrušit potvrzení</button>`;
      else if (e.excl) h += `<div class="ev-box">Vyřazeno z učení (${esc(e.excl)}).</div><button id="cm-unexcl" class="btn btn-ghost slim">Vrátit do učení</button>`;
      else h += `<div class="ev-actions excl"><select id="cm-excl-why"><option>pohyb nebo sport</option><option>nemoc nebo stres</option><option>jídlo navíc, které tu není</option><option>chyba senzoru</option><option>jiné</option></select><button id="cm-excl" class="btn btn-ghost slim">Vyřadit z učení</button></div>`;
    }

    h += `<details class="conf-how"><summary>Upravit nebo smazat</summary>
      <label class="field">Název<input id="cm-name" type="text" value="${esc(e.n)}"></label>
      <div class="tri-row"><label class="field">Sacharidy (g)<input id="cm-carbs" type="text" inputmode="decimal" value="${dec(K.r1(e.s))}"></label>
      <label class="field">Čas<input id="cm-time" type="time" value="${e.ts ? hhmm(e.ts) : ''}"></label></div>
      <div class="btn-row"><button id="cm-del" class="btn btn-danger-ghost">Smazat</button><button id="cm-save" class="btn grow">Uložit změny</button></div></details>
      <p class="muted small-text" style="margin-top:10px">Zpětný výpočet z glykémie je orientační (pohyb, stres, tuk a automatika pumpy ho ovlivňují). Nenahrazuje doporučení diabetologa k dávkování inzulinu.</p>`;
    $('#cmeal-body').innerHTML = h;
    bindMeal(e);
  }

  function bindMeal(e) {
    const after = () => { K.saveAll(); invalidate(); touchData(); openMeal(e.id); };
    $('#cm-confirm')?.addEventListener('click', () => { const v = K.num($('#cm-conf').value); if (!(v >= 0)) return; e.conf = v; e.s = v; after(); K.toast('Potvrzeno — aplikace se z toho učí'); });
    $('#cm-unconf')?.addEventListener('click', () => { delete e.conf; after(); });
    $('#cm-excl')?.addEventListener('click', () => { e.excl = $('#cm-excl-why').value; after(); });
    $('#cm-unexcl')?.addEventListener('click', () => { delete e.excl; after(); });
    $('#cm-man')?.addEventListener('click', () => {
      e.man = { bg0: toMmol($('#cm-bg0').value), bg2: toMmol($('#cm-bg2').value) };
      if (!e.man.bg0 || !e.man.bg2) { K.toast('Zadejte obě hodnoty'); return; }
      after();
    });
    $('#cm-units-save')?.addEventListener('click', () => { const u = K.num($('#cm-units').value); if (u > 0) e.units = u; else delete e.units; after(); });
    $('#cm-save')?.addEventListener('click', () => {
      const f = findEntry(e.id);
      e.n = $('#cm-name').value.trim() || e.n;
      e.s = K.num($('#cm-carbs').value);
      if (e.ts && $('#cm-time').value) {
        const nts = tsFromTime(e.ts, $('#cm-time').value);
        if (nts !== e.ts) {
          e.ts = nts; delete e.ev;
          const nk = K.dstr(new Date(nts));
          if (nk !== f.key) { K.days()[f.key].e = K.days()[f.key].e.filter(x => x.id !== e.id); K.day(nk).e.push(e); }
        }
      }
      after(); K.toast('Uloženo');
    });
    $('#cm-del')?.addEventListener('click', async () => {
      if (!confirm('Smazat toto jídlo?')) return;
      const f = findEntry(e.id);
      K.days()[f.key].e = K.days()[f.key].e.filter(x => x.id !== e.id);
      K.saveAll(); invalidate();
      await CGM.del('thumbs', e.id).catch(() => {});
      K.closeSheet('sheet-cmeal'); openId = null; K.renderDnes(); K.toast('Smazáno');
    });
  }

  /* ─── Obrazovka Učení ─── */
  function pctTxt(f) { const p = Math.round((f - 1) * 100); return (p > 0 ? '+' : '') + p + ' %'; }
  function renderLearn() {
    const c = cal(), all = photoEntries(), now = Date.now();
    const pend = all.filter(e => now < e.ts + POST).length;
    const noData = all.filter(e => now >= e.ts + POST && !(e.ev?.implied) && e.conf == null && !e.excl).length;
    let h = '<div class="card"><div class="card-title">Přesnost AI odhadů u vás</div>';
    if (!c.n) {
      h += `<p class="muted">Zatím žádné jídlo ověřené glykémií. Jak učení funguje:</p>
        <ol class="learn-steps"><li>Vyfotíte jídlo — AI odhadne sacharidy.</li>
        <li>Po 2,5 h si aplikace vezme glykémii z CGM (od 30 min před jídlem) a inzulin, a podle vašeho poměru a citlivosti spočítá, kolik sacharidů jídlo skutečně mělo.</li>
        <li>Z rozdílů se učí, jak AI u vás chybuje (celkově i podle druhu jídla), a další odhady opraví. Jistota odhadu se pak počítá z vaší skutečné přesnosti.</li></ol>`;
    } else {
      const g = c.global;
      const dir = g > 1.03 ? `podhodnocuje přibližně o <b>${Math.round((g - 1) * 100)} %</b>` : g < 0.97 ? `nadhodnocuje přibližně o <b>${Math.round((1 - g) * 100)} %</b>` : '<b>odhaduje bez systematické chyby</b>';
      h += `<p>Ověřeno <b>${c.n}</b> ${c.n === 1 ? 'jídlo' : c.n < 5 ? 'jídla' : 'jídel'} (z toho ${c.nConfirmed} ${c.nConfirmed === 1 ? 'potvrzené' : c.nConfirmed >= 2 && c.nConfirmed <= 4 ? 'potvrzená' : 'potvrzených'} vámi).</p><p>AI vaše sacharidy celkově ${dir}.</p>`;
      if (c.mapeBefore != null) h += `<p>Typická chyba AI: <b>${Math.round(c.mapeBefore * 100)} %</b> → po vaší kalibraci <b>${Math.round(c.mapeAfter * 100)} %</b>.</p>`;
      h += c.sd ? `<p class="muted small-text">Jistota u nových fotek teď počítá s vaší ověřenou přesností ±${Math.round(c.sd * 100)} % (místo obecných ±35 %).</p>`
        : `<p class="muted small-text">Vlastní přesnost se začne používat od 5 ověřených jídel.</p>`;
    }
    h += '</div>';
    const cats = Object.entries(c.cats || {}).filter(([, v]) => v.n > 0).sort((a, b) => b[1].n - a[1].n);
    if (cats.length) {
      h += '<div class="card"><div class="card-title">Podle druhu jídla</div>' + cats.map(([k, v]) =>
        `<div class="learn-row"><span>${LEARN.CATS[k].label}<br><span class="muted small-text">${v.n} ověř.</span></span><b>${Math.abs(v.factor - 1) < 0.03 ? 'přesné' : 'korekce ' + pctTxt(v.factor)}</b></div>`).join('') + '</div>';
    }
    const ns = K.store.get('kal.ns', null), nsLast = K.store.get('kal.nsLast', null), cl = K.store.get('kal.clImport', null), nsErr = K.store.get('kal.nsErr', null);
    h += '<div class="card"><div class="card-title">Zdroj glykémie</div>';
    if (ns?.url) h += `<p>Nightscout: ${nsLast ? 'poslední hodnota ' + fmtBG(nsLast.v) + ' ' + uLbl() + ' v ' + hhmm(nsLast.t) + ' (' + K.fmtHuman(K.dstr(new Date(nsLast.t))) + ')' : 'zatím bez dat'}${nsErr && nsErr.at > (K.store.get('kal.nsSync', 0) || 0) ? ' · <span class="warn">chyba spojení</span>' : ''}</p>`;
    if (cl) h += `<p>Export z CareLinku: ${cl.readings} hodnot${cl.first ? ' (' + K.fmtHuman(K.dstr(new Date(cl.first))) + ' – ' + K.fmtHuman(K.dstr(new Date(cl.last))) + ')' : ''}.</p>`;
    if (!ns?.url && !cl) h += `<p class="muted">Není nastavený žádný zdroj. Bez glykémie se aplikace učit nemůže.</p><button class="btn btn-ghost" data-goto="nastaveni">Nastavit zdroj dat</button>`;
    h += `<p class="muted small-text">Čeká na 2,5 h po jídle: ${pend} · bez dat k ověření: ${noData}</p></div>`;
    const recent = all.filter(e => e.ev?.implied || e.conf != null).slice(-10).reverse();
    if (recent.length) {
      h += '<div class="card"><div class="card-title">Naposledy ověřená jídla</div>' + recent.map(e =>
        `<button class="learn-row learn-open" data-id="${e.id}"><span>${esc(e.n)}<br><span class="muted small-text">${K.fmtHuman(K.dstr(new Date(e.ts)))} ${hhmm(e.ts)} · AI ${r0(e.aiRaw)} g</span></span><b>${e.conf != null ? '✓ ' + r0(e.conf) : '~' + r0(e.ev.implied)} g</b></button>`).join('') + '</div>';
    }
    $('#learn-body').innerHTML = h;
    $$('#learn-body .learn-open').forEach(b => b.addEventListener('click', () => openMeal(b.dataset.id)));
  }

  /* ─── Nastavení: léčba a zdroje dat ─── */
  function segRow(s) {
    return `<div class="seg-row"><input type="time" class="sg-od" value="${esc(s.od || '00:00')}"><input type="text" inputmode="decimal" class="sg-icr" value="${esc(s.icr ?? '')}" placeholder="10"><input type="text" inputmode="decimal" class="sg-isf" value="${esc(s.isf ?? '')}" placeholder="${isMg() ? '40' : '2,2'}"><button class="icon-btn sg-del" aria-label="Odebrat">✕</button></div>`;
  }
  function bindSegs() { $$('#th-segs .sg-del').forEach(b => b.addEventListener('click', () => { b.closest('.seg-row').remove(); })); }
  async function fillSettings() {
    const th = therapy();
    $('#th-type').value = th.type; $('#th-insulin').value = th.insulin || 'rapid'; $('#th-unit').value = th.unit || 'mmol';
    $$('.th-ins').forEach(x => x.classList.toggle('hidden', th.type === 'none'));
    $$('.u-lbl').forEach(x => { x.textContent = uLbl(); });
    $('#th-segs').innerHTML = (th.segs?.length ? th.segs : [{ od: '00:00' }]).map(segRow).join('');
    bindSegs();
    const ns = K.store.get('kal.ns', null);
    $('#ns-url').value = ns?.url || ''; $('#ns-token').value = ns?.token || '';
    const cl = K.store.get('kal.clImport', null);
    if (!$('#cl-status').dataset.fresh) $('#cl-status').textContent = cl ? `Naposledy načteno ${K.fmtHuman(K.dstr(new Date(cl.at)))}: glykémie ${cl.readings}×, bolusy ${cl.boluses}×.` : '';
    const last = await CGM.lastKey('pumpset').catch(() => null);
    $('#th-pump-note').textContent = last
      ? `Z exportu CareLinku: poslední poměr ${dec(last.icr)} g/U, citlivost ${fmtBG(last.isf)} ${uLbl()} na 1 U. Pro výpočet se použije nastavení pumpy platné v danou denní dobu; tabulka výše slouží jako záloha.`
      : 'Po nahrání exportu z CareLinku se použije nastavení přímo z pumpy (včetně částí dne).';
    delete $('#cl-status').dataset.fresh;
  }
  $('#th-type').addEventListener('change', () => $$('.th-ins').forEach(x => x.classList.toggle('hidden', $('#th-type').value === 'none')));
  $('#th-unit').addEventListener('change', () => $$('.u-lbl').forEach(x => { x.textContent = $('#th-unit').value === 'mgdl' ? 'mg/dl' : 'mmol/l'; }));
  $('#th-add').addEventListener('click', () => {
    if ($$('#th-segs .seg-row').length >= 6) return;
    $('#th-segs').insertAdjacentHTML('beforeend', segRow({ od: '12:00' }));
    bindSegs();
  });
  $('#th-save').addEventListener('click', () => {
    const segs = $$('#th-segs .seg-row').map(r => ({ od: r.querySelector('.sg-od').value || '00:00', icr: r.querySelector('.sg-icr').value.trim(), isf: r.querySelector('.sg-isf').value.trim() }))
      .filter(s => s.icr || s.isf);
    K.settings().therapy = { type: $('#th-type').value, insulin: $('#th-insulin').value, unit: $('#th-unit').value, segs: segs.length ? segs : [{ od: '00:00', icr: '', isf: '' }] };
    K.saveSettings(); touchData(); invalidate();
    K.toast('Uloženo — jídla se přepočítají');
    refresh();
  });

  $('#ns-test').addEventListener('click', async () => {
    const cfg = { url: CGM.nsBase($('#ns-url').value), token: $('#ns-token').value.trim() || CGM.nsTokenFromUrl($('#ns-url').value) };
    $('#ns-url').value = cfg.url; $('#ns-token').value = cfg.token;
    if (!cfg.url) { $('#ns-status').textContent = 'Zadejte adresu.'; return; }
    $('#ns-status').textContent = 'Zkouším spojení…';
    try {
      const rows = await CGM.nsFetch(cfg, '/api/v1/entries/sgv.json', { count: '1' });
      K.store.set('kal.ns', cfg);
      K.store.set('kal.nsSync', 0);
      const r = rows?.[0];
      $('#ns-status').textContent = r ? `✓ Připojeno — poslední glykémie ${fmtBG(r.sgv / MG)} ${uLbl()} (${hhmm(r.date)}).` : '✓ Připojeno, ale Nightscout zatím nemá žádné hodnoty.';
      refresh();
    } catch (e) {
      $('#ns-status').textContent = e.message === 'auth' ? 'Token nemá oprávnění ke čtení — v Nightscoutu vytvořte token s rolí „readable".'
        : e.message === 'cors' ? 'Nepodařilo se spojit. Zkontrolujte adresu a že je v Nightscoutu v proměnné ENABLE uvedeno „cors".'
          : 'Nightscout odpověděl chybou (' + e.message + ').';
    }
  });

  $('#cl-import').addEventListener('click', () => { $('#cl-file').value = ''; $('#cl-file').click(); });
  $('#cl-file').addEventListener('change', async ev => {
    const f = ev.target.files[0];
    if (!f) return;
    $('#cl-status').textContent = 'Načítám…';
    try {
      const r = await CGM.importCareLink(await f.text());
      if (!r.readings && !r.boluses) { $('#cl-status').textContent = 'V souboru jsem nenašel glykémie ani bolusy. Je to export z CareLinku (Reporty → Export dat)?'; return; }
      K.store.set('kal.clImport', { at: Date.now(), readings: r.readings, boluses: r.boluses, first: r.first, last: r.last });
      touchData(); invalidate();
      await fillSettings();
      $('#cl-status').dataset.fresh = '1';
      $('#cl-status').textContent = `✓ Načteno ${r.readings} hodnot glykémie${r.first ? ' (' + K.fmtHuman(K.dstr(new Date(r.first))) + ' – ' + K.fmtHuman(K.dstr(new Date(r.last))) + ')' : ''}, bolusy ${r.boluses}×${r.lastSet ? `, nastavení pumpy: poměr ${dec(r.lastSet.icr)} g/U, citlivost ${fmtBG(r.lastSet.isf)} ${uLbl()}` : ''}.`;
      refresh();
    } catch (e) { $('#cl-status').textContent = 'Soubor se nepodařilo načíst.'; }
  });

  window.CARB = { cal, renderTimeline, renderLearn, fillSettings, refresh, openMeal };

  renderTimeline();
  refresh();
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 5 * MIN);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
})();
