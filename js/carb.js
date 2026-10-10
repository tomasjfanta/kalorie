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
      if (e.ev?.implied && (e.ev.quality === 'good' || e.ev.quality === 'fair')) return { ts: e.ts, kat: e.kat, aiRaw: e.aiRaw, label: e.ev.implied, src: e.ev.quality, labSd: e.ev.relSd };
      return null;
    }).filter(Boolean);
  }
  function cal() { if (!calCache) calCache = LEARN.calibrate(samples(), Date.now()); return calCache; }
  const invalidate = () => { calCache = null; vwCache = null; spCache = null; };

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

  // Jídla pro vyhodnocení (všechna s časem — fotky i ruční zápisy) ve tvaru pro LEARN.evaluateMeal.
  // Osobní rychlost vstřebávání: z vlastního proložení křivky, jinak naučená pro druh jídla.
  let spCache = null;
  function spd() {
    if (!spCache) spCache = LEARN.learnSpeed(photoEntries().filter(e => !e.excl && e.ev?.fit?.informative && LEARN.REL_SD[e.ev.quality])
      .map(e => ({ ts: e.ts, kat: e.kat, speed: e.ev.fit.speed })), Date.now());
    return spCache;
  }
  const catSpeed = kat => (spd().n >= 3 ? spd().cats[LEARN.catKey(kat)].factor : 1);
  const asMeal = e => ({ id: e.id, ts: e.ts, aiRaw: e.excl ? 0 : e.aiRaw, s: e.s, conf: e.conf, kat: e.kat, gi: e.gi,
    fat: e.fat ?? e.t, prot: e.b, alc: e.alc, speed: e.ev?.fit?.informative ? e.ev.fit.speed : catSpeed(e.kat) });
  function mealsWithTime() {
    const out = [], D = K.days();
    for (const d of Object.keys(D)) for (const e of D[d].e || []) if (e.ts) out.push(e);
    return out;
  }

  // „Nic jsem nejedl": časy, kdy aplikace navrhla nezapsané jídlo a uživatel ho odmítl (uloženo u dne).
  function noMeals(from, to) {
    const out = [], D = K.days();
    for (const d of Object.keys(D)) for (const x of D[d].nm || []) if (x.t >= from && x.t <= to) out.push(x);
    return out.sort((a, b) => a.t - b.t);
  }

  // „Křivky": jídla dne (zapsaná, z pumpy, odhalená nezapsaná), CGM, inzulin a nastavení pumpy.
  async function dayData(from, to) {
    const W = 6 * 60 * MIN;
    const entries = mealsWithTime().filter(e => e.ts >= from - W && e.ts <= to && (e.s > 0 || e.conf != null));
    const meals = entries.map(e => ({ ...asMeal(e), n: e.n, implied: e.ev?.implied && LEARN.REL_SD[e.ev.quality] ? e.ev.implied : null,
      fitSpeed: e.ev?.fit?.used ? e.ev.fit.speed : null }));
    meals.push(...await pumpMeals(entries, from - W, to));
    for (const e of entries) for (const u of e.ev?.seg?.unlogged || []) {
      if (u.t >= from - W && u.t <= to && !meals.some(m => m.ghost && Math.abs(m.ts - u.t) < 10 * MIN)) meals.push({ id: 'g' + u.t, ts: u.t, g: u.g, gi: 'střední', kat: 'ostatni', ghost: true });
    }
    const [readings, boluses, basal, pumpset, targets] = await Promise.all([
      CGM.range('cgm', from - 60 * MIN, to + 15 * MIN),
      CGM.range('bolus', from - 300 * MIN, to),
      CGM.range('basal', from - DAY, to).catch(() => []),
      CGM.range('pumpset', from - 30 * DAY, to + 30 * DAY),
      CGM.range('targets', from - 14 * 60 * MIN, to).catch(() => []),
    ]);
    const before = basal.filter(r => r.t < from);
    return { readings, boluses, basal, basalBase: before.length >= 96 ? LEARN.basalBaseline(before) : null, targets, meals,
      settingsAt: makeSettingsAt(pumpset), therapy: therapy(), noMeal: noMeals(from - W, to) };
  }

  // Sacharidy zadané do pumpy (bolusový kalkulátor) bez fotky do 30 min → známé jídlo v bilanci
  // (jinak by se jejich vliv na glykémii připsal vyfocenému jídlu).
  async function pumpMeals(entries, from, to) {
    const pc = await CGM.range('pcarbs', from, to).catch(() => []);
    const out = [];
    for (const p of pc.sort((a, b) => a.t - b.t)) {
      if (out.some(o => o.s === p.g && Math.abs(o.ts - p.t) <= 3 * MIN)) continue; // duplicity z uploaderu
      if (entries.some(x => Math.abs(x.ts - p.t) <= 30 * MIN)) continue;           // stejné jídlo jako fotka
      out.push({ id: 'pc' + p.t, ts: p.t, s: p.g, conf: p.g, kat: 'ostatni', pump: true });
    }
    return out;
  }

  // Vyhodnotí celý segment, do kterého jídlo patří (navazující jídla společně), a výsledky zapíše
  // všem jeho jídlům. Bez inzulinu (léčba „bez inzulinu") se jídla vyhodnocují jednotlivě postaru.
  async function evaluate(e) {
    const entries = mealsWithTime().filter(x => Math.abs(x.ts - e.ts) < 2 * DAY);
    const all = [...entries.map(asMeal), ...await pumpMeals(entries, e.ts - 2 * DAY, e.ts + 2 * DAY)];
    const me = all.find(m => m.id === e.id);
    me.speed = catSpeed(e.kat);
    const segMeals = LEARN.segmentOf(me, all);
    const T0 = segMeals[0].ts, END = LEARN.windowEnd(segMeals);
    const [readings, boluses, basal, pumpset, targets] = await Promise.all([
      CGM.range('cgm', T0 - PRE, END),
      CGM.range('bolus', T0 - 300 * MIN, END),
      CGM.range('basal', T0 - DAY, END).catch(() => []),
      CGM.range('pumpset', T0 - 30 * DAY, T0 + 30 * DAY),
      CGM.range('targets', T0 - 14 * 60 * MIN, END).catch(() => []),
    ]);
    const before = basal.filter(r => r.t < T0 - 30 * MIN);
    const basalBase = before.length >= 96 ? LEARN.basalBaseline(before) : null;
    const w = { readings, boluses };
    const byId = Object.fromEntries(entries.map(x => [x.id, x]));
    for (const m of segMeals) {
      const ent = byId[m.id];
      if (!ent) continue;
      const man = {};
      if (ent.man?.bg0) man.bg0 = ent.man.bg0;
      if (ent.man?.bg2) man.bg2 = ent.man.bg2;
      if (ent.units) man.units = ent.units;
      m.manual = man;
    }
    const data = { readings, boluses, basal, basalBase, targets, settingsAt: makeSettingsAt(pumpset),
      prior: all.filter(m => m.ts < T0 && m.ts >= T0 - 300 * MIN), noMeal: noMeals(T0 - 2 * 60 * MIN, END + 2 * 60 * MIN).map(x => x.t) };
    let results;
    if (therapy().type === 'none') {
      results = {};
      for (const m of segMeals) if (byId[m.id]) results[m.id] = LEARN.evaluateMeal(m, { ...data, meals: all.filter(x => x.id !== m.id) }, therapy(), kNone());
    } else {
      results = LEARN.evaluateSegment(segMeals, data, therapy()).results;
    }
    const final = Date.now() > END + 10 * MIN;
    for (const m of segMeals) {
      const ent = byId[m.id], ev = results[m.id];
      if (!ent || !ev) continue;
      ent.ev = {
        implied: ev.implied, relSd: ev.relSd, quality: ev.quality, flags: ev.flags, bg0: ev.bg0, peak: ev.peak, tPeak: ev.tPeak,
        end: ev.end, iauc: ev.iauc, coverage: ev.coverage, units: ev.units, absorbed: ev.absorbed,
        icr: ev.icr, isf: ev.isf, n: readings.length, at: Date.now(),
        del: ev.del, coveredCarbs: ev.coveredCarbs, extraCarbs: ev.extraCarbs, manCarbs: ev.manCarbs, basalOk: ev.basalOk,
        endSlope15: ev.endSlope15, stable: ev.stable, cluster: ev.cluster, share: ev.share, sitting: ev.sitting,
        unlogged: ev.unlogged, noMeal: ev.noMeal, tail: ev.tail, seg: ev.seg, dur: ev.dur, gi: ev.gi, pumpMeals: ev.pumpMeals,
        fit: ev.fit, hypo: ev.hypo, exercise: ev.exercise, alcohol: ev.alcohol, heavy: ev.heavy, fpu: ev.fpu, fpuCarbs: ev.fpuCarbs,
        winEnd: END, rise: ev.rise, tAbove10: ev.tAbove10, bolusLead: ev.bolusLead, final,
      };
    }
    return { ev: e.ev, ...w };
  }

  /* ─── Průběžná synchronizace a vyhodnocení (bez tlačítek — samo při otevření a každých 5 min) ─── */
  let busy = false;
  async function nsAutoSync() {
    // Jednorázově (verze s automatickým bazálem): přeuložit bolusy bez duplicit a stáhnout 3 dny znovu.
    const full = !K.store.get('kal.migr4', false);
    if (full) { await CGM.migrateBoluses().catch(() => {}); touchData(); }
    const ns = K.store.get('kal.ns', null);
    if (!ns?.url) { if (full) K.store.set('kal.migr4', true); return; }
    const last = +(K.store.get('kal.nsSync', 0) || 0);
    if (!full && Date.now() - last < 5 * MIN) return;
    const lastR = await CGM.lastKey('cgm').catch(() => null);
    const from = full ? Date.now() - 3 * DAY : Math.max(Date.now() - 3 * DAY, (lastR?.t || 0) - 60 * MIN);
    try {
      const r = await CGM.nsSync(ns, from, Date.now());
      K.store.set('kal.nsSync', Date.now());
      K.store.set('kal.nsLast', r.last ? { t: r.last.t, v: r.last.v } : K.store.get('kal.nsLast', null));
      if (r.readings || r.boluses || r.basal) touchData();
      if (full) K.store.set('kal.migr4', true);
    } catch (e) { K.store.set('kal.nsErr', { at: Date.now(), msg: e.message }); }
  }
  async function prunePhotos() {
    if (Date.now() - (+(K.store.get('kal.photoPrune', 0) || 0)) < DAY) return;
    K.store.set('kal.photoPrune', Date.now());
    for (const p of await CGM.all('photos').catch(() => [])) if (p.t < Date.now() - 14 * DAY) await CGM.del('photos', p.id).catch(() => {});
  }
  async function refresh() {
    if (busy || !K.isCarb()) return;
    busy = true;
    try {
      prunePhotos();
      await nsAutoSync();
      const all = photoEntries(), now = Date.now(), changed = [], start = Date.now();
      for (const e of all) {
        if (e.ts > now || now - e.ts > 45 * DAY) continue;
        if (e.ev?.final && e.ev.at >= dataAt()) continue;
        if (e.ev?.at >= start) continue; // už spočítáno v rámci segmentu jiného jídla
        await evaluate(e); changed.push(e);
      }
      if (changed.length) { K.saveAll(); invalidate(); }
    } catch (err) { console.warn('refresh', err); }
    finally { busy = false; }
    K.renderDnes();
    if ($('#view-uceni').classList.contains('active')) renderLearn();
    window.CURVES?.refresh();
  }

  /* ─── Časová osa dne ─── */
  function status(e) {
    if (e.conf != null) return '✓ potvrzeno';
    if (e.excl) return 'vyřazeno z učení';
    const wEnd = e.ts + LEARN.postFor(asMeal(e));
    if (Date.now() < wEnd) return '⏳ ověření glykémií v ' + hhmm(wEnd);
    if (e.ev?.implied && LEARN.REL_SD[e.ev.quality]) return '📈 podle glykémie ~' + r0(e.ev.implied) + ' g';
    return '— ' + (e.ev?.flags?.[0] || 'zatím bez dat z CGM');
  }
  // Glykémie přestaly chodit (most k CareLinku se odhlásil, telefon s pumpou mimo dosah…) → upozornit.
  function staleTxt() {
    const ns = K.store.get('kal.ns', null), last = K.store.get('kal.nsLast', null);
    if (!ns?.url || !last?.t || K.viewDate() !== K.todayStr()) return '';
    const age = Date.now() - last.t;
    if (age < 30 * MIN) return '';
    return `<div class="result-note warn-note">⚠️ Poslední glykémie z pumpy je z ${hhmm(last.t)} (${age > DAY ? 'před více než dnem' : 'před ' + Math.round(age / MIN) + ' min'}). Když to trvá, odhlásil se nejspíš most k CareLinku — na počítači spusťte znovu přihlášení, případně zkontrolujte, že je telefon s MiniMed Mobile u pumpy.</div>`;
  }
  function renderTimeline() {
    const box = $('#ctimeline');
    if (!box || !K.isCarb()) return;
    const es = [...(K.day().e || [])].sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (!es.length) {
      box.innerHTML = staleTxt() + '<div class="result-note">Zatím žádné jídlo. Vyfoťte talíř — AI odhadne sacharidy a glykémie z CGM pak odhad ověří a zpřesní další.</div>';
      return;
    }
    box.innerHTML = staleTxt() + es.map(e => {
      const c = K.entryConf(e);
      const sub = (e.ts ? hhmm(e.ts) + ' · ' : '') + (e.auto && e.conf == null ? 'uloženo bez potvrzení · ' : '') + (e.cs === 'ai-photo' ? status(e) : 'ruční zápis');
      return `<button class="ctl-row" data-id="${e.id}"><img class="ctl-thumb" data-thumb="${e.id}" alt=""><span class="ctl-mid"><span class="ctl-name">${esc(e.n)}</span><span class="ctl-sub">${sub}</span></span><span class="e-carb"><span class="e-kcal">${K.fmtC(c.C)}</span>${K.badge(c.p)}</span></button>`;
    }).join('');
    $$('#ctimeline .ctl-row').forEach(b => b.addEventListener('click', () => openMeal(b.dataset.id)));
    $$('#ctimeline img[data-thumb]').forEach(img => {
      CGM.get('thumbs', img.dataset.thumb).then(x => { if (x) img.src = x.data; else img.classList.add('empty'); }).catch(() => img.classList.add('empty'));
    });
  }

  /* ─── Nové jídlo z fotky ───
     Fotka se nejdřív uloží do fronty (jobs.js) a teprve pak jde k AI. Když odhad selže, fronta to
     zkouší znovu, dokud neuspěje; po zavření okna se jídlo s hotovým odhadem uloží samo. */
  let pending = null; // { jobId, ts, thumb, filled, ai }
  const sheetOpen = () => !$('#sheet-cnew').classList.contains('hidden');
  $('#cphoto-btn').addEventListener('click', () => {
    if (!K.aiConfig().key && !AI.claudeReady()) { K.toast('Nejdřív vložte Google API klíč v Nastavení'); K.showView('nastaveni'); return; }
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
    const job = await JOBS.add({ kind: 'carb-photo', ts, img: img.base64, thumb: await makeThumb(img.dataUrl) });
    showJob(job);
  }

  // Otevře okno pro úlohu z fronty (novou i čekající) a podle jejího stavu ukáže formulář nebo průběh.
  function showJob(job) {
    pending = { jobId: job.id, ts: job.ts, thumb: job.thumb, filled: false };
    $('#cnew-img').src = 'data:image/jpeg;base64,' + job.img;
    $('#cnew-form').classList.add('hidden');
    $('#cnew-retry').classList.add('hidden');
    K.openSheet('sheet-cnew');
    if (job.status === 'ready') { fillForm(job); return; }
    progress(0, planFor().gemini + planFor().claude);
    JOBS.attempt(job.id);
  }
  $('#cnew-retry').addEventListener('click', async () => {
    if (!pending) return;
    $('#cnew-retry').classList.add('hidden');
    progress(0, planFor().gemini + planFor().claude);
    JOBS.attempt(pending.jobId);
  });
  $('#cnew-discard').addEventListener('click', async () => {
    if (!pending || !confirm('Zahodit tuto fotku? Odhad se už nedokončí.')) return;
    const id = pending.jobId; pending = null;
    await JOBS.remove(id);
    K.closeSheet('sheet-cnew');
  });
  // Zavření okna nic nezahazuje: hotový odhad se uloží, rozpracovaný doběhne ve frontě.
  async function onClose() {
    if (!pending) return;
    const id = pending.jobId; pending = null;
    const job = await JOBS.get(id);
    if (job?.status === 'ready') { await autoSave(job); await JOBS.remove(id); }
  }
  $('#sheet-cnew').addEventListener('click', ev => { if (ev.target.id === 'sheet-cnew') onClose(); });
  $('#sheet-cnew .sheet-close').addEventListener('click', onClose);

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

  // Nezávislých odhadů na fotku: Gemini (zdarma) 5×, Claude (předplatné, je-li nastavený) 2×.
  const PLAN = { gemini: 5, claude: 2 };
  const planFor = () => ({ gemini: K.aiConfig().key ? PLAN.gemini : 0, claude: AI.claudeReady() ? PLAN.claude : 0 });
  const JIST = ['nízká', 'střední', 'vysoká'];
  let vwCache = null;
  // Váhy AI podle jejich ověřené přesnosti u vás (viz LEARN.vendorWeights).
  function vw() {
    if (!vwCache) vwCache = LEARN.vendorWeights(photoEntries().filter(e => !e.excl && e.aiRuns?.length).map(e => ({
      ts: e.ts, runs: e.aiRuns,
      label: e.conf != null ? e.conf : e.ev?.implied && (e.ev.quality === 'good' || e.ev.quality === 'fair') ? e.ev.implied : null,
    })), Date.now());
    return vwCache;
  }
  // Jedna odpověď modelu → { c, min, max, jist (0–2), kat, gi, j, model }
  function parseRun({ result: j, model }) {
    const jt = String(j.jistota || '').toLowerCase();
    let min = +j.sacharidy_min, max = +j.sacharidy_max;
    if (!(isFinite(min) && isFinite(max)) || min < 0) { min = undefined; max = undefined; }
    else if (min > max) [min, max] = [max, min];
    return { c: Math.max(0, +j.sacharidy || 0), min, max, kat: LEARN.catKey(j.kategorie), gi: j.gi, j, model,
      jist: /vys|high/.test(jt) ? 2 : /níz|niz|low/.test(jt) ? 0 : 1 };
  }
  const progress = (k, n) => {
    if (!pending) return;
    $('#cnew-status').textContent = `Odhaduji sacharidy… ${k}/${n}${planFor().claude ? ' (Claude chvíli přemýšlí)' : ' (pár vteřin)'}`;
  };

  // Výsledek všech odhadů → hodnoty jídla (stejné pro okno i pro automatické uložení).
  function buildAi(res, ts) {
    const runs = res.runs.map(parseRun);
    const E = LEARN.ensemble(runs, vw());
    const j = E.rep.j;
    const c = LEARN.applyCal(E.c, E.kat, cal(), ts);
    const alc = runs.filter(r => r.j.alkohol === true).length > runs.length / 2;
    return {
      E, errors: res.errors || {}, name: (j.nazev || 'Jídlo').trim() + (j.mnozstvi ? ' (' + String(j.mnozstvi).trim() + ')' : ''),
      poznamka: j.poznamka, aiRaw: E.c, C: c.C, kat: E.kat, gi: E.gi, alc, factor: c.factor, blockFactor: c.blockFactor, jist: JIST[E.jist],
      sMin: E.min != null ? E.min * c.factor : undefined, sMax: E.max != null ? E.max * c.factor : undefined,
      sSd: E.sd != null ? E.sd * c.factor : undefined, runs: runs.map(r => ({ m: r.model, c: r.c })),
      fat: Math.max(0, +j.tuky || 0), kcal: Math.round(+j.kcal || 0), b: Math.round(+j.bilkoviny || 0), t: Math.round(+j.tuky || 0),
    };
  }
  const entryFrom = (a, ts, over = {}) => ({
    id: 'p' + Date.now() + Math.random().toString(36).slice(2, 6), n: a.name, q: 1, s: a.C, kcal: a.kcal, b: a.b, t: a.t,
    cs: 'ai-photo', jist: a.jist, sMin: a.sMin, sMax: a.sMax, sSd: a.sSd, meal: 'sv', ts, kat: a.kat, gi: a.gi, fat: a.fat,
    aiRaw: a.aiRaw, calF: a.factor, aiRuns: a.runs, ...(a.alc ? { alc: true } : {}), ...over,
  });
  async function storeEntry(e, thumb, img) {
    K.day(K.dstr(new Date(e.ts))).e.push(e);
    K.saveAll();
    if (thumb) await CGM.put('thumbs', [{ id: e.id, data: thumb }]).catch(() => {});
    // Celá fotka zůstane 14 dní — pro nový odhad, když se název jídla později opraví.
    if (img) await CGM.put('photos', [{ id: e.id, t: e.ts, data: img }]).catch(() => {});
    invalidate(); touchData(); // nové jídlo může patřit do okna jiného → přepočítat
    K.renderDnes();
  }
  async function autoSave(job) {
    const a = buildAi(job.result, job.ts);
    await storeEntry(entryFrom(a, job.ts, { auto: true, ...(job.hint ? { n: job.hint, hint: job.hint } : {}) }), job.thumb, job.img);
    K.toast(`Fotka z ${hhmm(job.ts)}: ${r0(a.C)} g — uloženo s odhadem AI (klepnutím upravíte)`);
  }

  // Uživatel opravil, co na fotce je (název, množství) → jeho popis platí, fotka doplní zbytek.
  const hintPrompt = h => h ? `Uživatel upřesnil, co na fotce je: „${h}". Jeho popis (druh jídla a množství) ber jako správný — `
    + 'pokud uvádí počet kusů, váhu nebo velikost porce, vycházej z ní. Fotku použij jen na to, co popis neříká. '
    + 'Odhadni sacharidy tohoto jídla.' : undefined;
  const runArgs = (job, img) => ({ imageBase64: img, imageMedia: 'image/jpeg', extra: examplesText(), text: hintPrompt(job.hint),
    diag: { flow: job.hint ? 'photo-hint' : 'photo', job: job.id, attempt: job.attempts } });

  JOBS.register('carb-photo', {
    label: j => j.hint ? 'Oprava: ' + j.hint : 'Fotka jídla',
    run: job => {
      const plan = planFor();
      if (!(plan.gemini + plan.claude)) return { error: 'nokey' };
      return AI.callRuns(runArgs(job, job.img), plan, (k, n) => { if (pending?.jobId === job.id) progress(k, n); });
    },
    present: job => {
      if (!pending || pending.jobId !== job.id || !sheetOpen()) return false;
      if (!pending.filled) fillForm(job);
      return true;
    },
    save: autoSave,
    failed: job => {
      if (!pending || pending.jobId !== job.id || !sheetOpen()) return;
      $('#cnew-status').innerHTML = esc(job.lastErr) + `<br><b>📌 Fotka je uložená.</b> Další pokus sám v ${hhmm(job.nextAt)}.`;
      $('#cnew-retry').classList.remove('hidden');
    },
    open: showJob,
  });

  // Uložené jídlo s opraveným názvem: nový odhad z uložené fotky (u starších jídel z náhledu).
  async function applyReest(job) {
    const f = findEntry(job.entryId);
    if (!f) return;
    const e = f.e, a = buildAi(job.result, e.ts);
    Object.assign(e, { aiRaw: a.aiRaw, aiRuns: a.runs, kat: a.kat, fat: a.fat, kcal: a.kcal, b: a.b, t: a.t, jist: a.jist,
      sMin: a.sMin, sMax: a.sMax, sSd: a.sSd, calF: a.factor, hint: job.hint });
    if (!e.giUser && a.gi) e.gi = a.gi;
    if (a.alc) e.alc = true; else delete e.alc;
    if (e.conf == null && !job.keepCarbs) e.s = a.C;
    delete e.ev; delete e.auto;
    K.saveAll(); invalidate(); touchData();
    K.renderDnes();
    K.toast(`Přepočítáno podle „${job.hint}": ${r0(a.C)} g${e.conf != null ? ' (potvrzená hodnota zůstává)' : ''}`);
    if (openId === e.id) openMeal(e.id);
  }
  JOBS.register('carb-reest', {
    label: j => 'Oprava: ' + j.hint,
    run: async job => {
      const photo = await CGM.get('photos', job.entryId).catch(() => null);
      const thumb = photo ? null : await CGM.get('thumbs', job.entryId).catch(() => null);
      const img = photo?.data || (thumb?.data ? thumb.data.split(',')[1] : null);
      const plan = planFor();
      if (!img) plan.claude = 0; // Claude na serveru potřebuje fotku
      if (!(plan.gemini + plan.claude)) return { error: 'nokey' };
      return AI.callRuns(img ? runArgs(job, img) : { text: hintPrompt(job.hint), extra: examplesText(), diag: { flow: 'text-hint', job: job.id, attempt: job.attempts } }, plan);
    },
    present: () => false, // výsledek se rovnou zapíše do jídla
    save: applyReest,
  });

  function fillForm(job) {
    const a = buildAi(job.result, job.ts);
    pending.ai = a; pending.filled = true; pending.hint = job.hint || null;
    pending.shownName = job.hint || a.name;
    $('#cnew-name').value = pending.shownName;
    $('#cnew-carbs').value = r0(a.C);
    $('#cnew-time').value = hhmm(job.ts);
    $('#cnew-units').value = '';
    $('#cnew-gi').value = a.gi || LEARN.giKey(LEARN.CATS[a.kat]?.dur <= 180 ? 'vysoký' : 'střední') || 'stredni';
    $$('.cnew-ins').forEach(x => x.classList.toggle('hidden', therapy().type === 'none'));
    const calTxt = Math.abs(a.factor - 1) > 0.02
      ? ` → podle vašich ověřených jídel (${LEARN.CATS[a.kat].short}${Math.abs(a.blockFactor - 1) > 0.02 ? ', ' + LEARN.BLOCKS[LEARN.blockOf(job.ts)].label.split(' (')[0].toLowerCase() : ''}) ×${dec(Math.round(a.factor * 100) / 100)} = <b>${r0(a.C)} g</b>` : '';
    // Po AI: „Gemini 48 g (5×: 44 · 47 · 48 · 50 · 55)“; u více AI i jejich váha.
    const E = a.E, multi = E.vendors.length > 1;
    const runsTxt = E.n > 1 ? '<br><span class="muted small-text">' + E.vendors.map(x =>
      `${x.label} ${r0(x.c)} g${x.n > 1 ? ` (${x.n}×: ${x.values.map(r0).join(' · ')})` : ''}${multi ? ` · váha ${Math.round(x.share * 100)} %` : ''}`).join('<br>') + '</span>' : '';
    const failTxt = Object.entries(a.errors).map(([v, e]) =>
      `<br><span class="muted small-text">⚠️ ${LEARN.VENDOR_LABEL[v]} tentokrát neodpověděl: ${esc(AI.errMsg(e))}</span>`).join('');
    const alcTxt = a.alc ? '<br>🍷 Alkohol — glykémii ovlivní ještě hodiny, toto jídlo se nepoužije k učení.' : '';
    $('#cnew-ai').innerHTML = `AI odhad: ${r0(a.aiRaw)} g${calTxt}${runsTxt}${failTxt}${alcTxt}${a.poznamka ? '<br>' + esc(a.poznamka) : ''}`;
    newConf();
    $('#cnew-status').textContent = '';
    $('#cnew-retry').classList.add('hidden');
    $('#cnew-form').classList.remove('hidden');
  }
  // Oprava názvu/množství v okně → nový odhad z téže fotky s popisem uživatele.
  async function reestimate() {
    const v = $('#cnew-name').value.trim();
    if (!pending?.filled || !v || v === pending.shownName) return;
    const job = await JOBS.get(pending.jobId);
    if (!job) return;
    Object.assign(job, { hint: v, status: 'pending', result: null, nextAt: Date.now(), attempts: 0 });
    await JOBS.save(job);
    pending.filled = false; pending.ai = null;
    $('#cnew-form').classList.add('hidden');
    $('#cnew-status').textContent = `Přepočítávám podle „${v}"…`;
    JOBS.attempt(job.id);
  }
  $('#cnew-name').addEventListener('change', reestimate);
  $('#cnew-name').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); $('#cnew-name').blur(); } });

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
    const a = pending.ai, id = pending.jobId, thumb = pending.thumb, hint = pending.hint;
    const img = (await JOBS.get(id))?.img;
    const ts = tsFromTime(pending.ts, $('#cnew-time').value);
    const units = K.num($('#cnew-units').value);
    const C = K.num($('#cnew-carbs').value);
    const e = entryFrom(a, ts, { n: $('#cnew-name').value.trim() || 'Jídlo', s: C, gi: $('#cnew-gi').value || a.gi, ...(hint ? { hint } : {}) });
    if (units > 0) e.units = units;
    pending = null;
    K.closeSheet('sheet-cnew');
    await JOBS.remove(id);
    await storeEntry(e, thumb, img);
    K.toast('Uloženo: ' + r0(C) + ' g sacharidů');
  });

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
      const r = await evaluate(f.e);
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
    const span = LEARN.postFor(asMeal(e)) / MIN, WIN = span * MIN;
    const xs = m => L + (W - L - R) * (m + 30) / (span + 30);
    const vals = readings.map(r => r.v);
    const lo = Math.min(3.5, ...vals) - 0.3, hi = Math.max(11, ...vals) + 0.5;
    const ys = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    const pts = readings.map(r => xs((r.t - e.ts) / MIN).toFixed(1) + ',' + ys(r.v).toFixed(1)).join(' ');
    const band = `<rect x="${L}" y="${ys(10).toFixed(1)}" width="${W - L - R}" height="${(ys(3.9) - ys(10)).toFixed(1)}" class="bg-band"/>`;
    const base = e.ev?.bg0 != null ? `<line x1="${L}" x2="${W - R}" y1="${ys(e.ev.bg0).toFixed(1)}" y2="${ys(e.ev.bg0).toFixed(1)}" class="bg-base"/>` : '';
    const meal = `<line x1="${xs(0)}" x2="${xs(0)}" y1="${T}" y2="${H - B}" class="bg-meal"/><text x="${xs(0) + 3}" y="${T + 10}" class="bg-lbl">🍽</text>`;
    const others = (e.ev?.cluster || []).filter(t => t >= e.ts - PRE && t <= e.ts + WIN).map(t =>
      `<line x1="${xs((t - e.ts) / MIN)}" x2="${xs((t - e.ts) / MIN)}" y1="${T}" y2="${H - B}" class="bg-meal bg-meal2"/><text x="${xs((t - e.ts) / MIN) + 3}" y="${T + 10}" class="bg-lbl">🍽</text>`).join('');
    const bol = LEARN.dedupeBoluses(boluses).filter(b => b.t >= e.ts - PRE && b.t <= e.ts + WIN).map(b => {
      const x = xs((b.t - e.ts) / MIN);
      return `<path d="M${x - 4},${H - B} L${x + 4},${H - B} L${x},${H - B - 7} Z" class="bg-bolus"/><text x="${x}" y="${H - B - 9}" class="bg-lbl" text-anchor="middle">${dec(K.r1(b.u))} U</text>`;
    }).join('');
    const ticksX = [-30, 0, 60, 120, ...(span > 150 ? [180] : []), span].map(m => `<text x="${xs(m)}" y="${H - 6}" class="bg-tick" text-anchor="${m === span ? 'end' : m === -30 ? 'start' : 'middle'}">${m === 0 ? '0' : (m > 0 ? '+' : '') + m}</text>`).join('');
    const ticksY = [4, 7, 10].filter(v => v > lo && v < hi).map(v => `<text x="${L - 4}" y="${ys(v) + 3}" class="bg-tick" text-anchor="end">${fmtBG(v)}</text>`).join('');
    const dots = readings.map(r => `<circle cx="${xs((r.t - e.ts) / MIN).toFixed(1)}" cy="${ys(r.v).toFixed(1)}" r="1.6" class="bg-dot"/>`).join('');
    return `<svg class="bg-chart" viewBox="0 0 ${W} ${H}">${band}${base}${meal}${others}<polyline points="${pts}" class="bg-line"/>${dots}${bol}${ticksX}${ticksY}</svg><div class="muted small-text center">minuty od jídla · glykémie v ${uLbl()} · pás = 3,9–10 mmol/l</div>`;
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
      if (ev?.del) {
        const d = ev.del, r1 = K.r1;
        let t = `Inzulin: ${ev.cluster?.length ? 'k jídlům v okně' : 'k jídlu'} <b>${dec(r1(d.meal))} U</b>${ev.coveredCarbs ? ` (pokrývá ~${r0(ev.coveredCarbs)} g)` : ''}`;
        if (d.auto > 0.05) t += ` · automatické korekce pumpy <b>${dec(r1(d.auto))} U</b>`;
        if (d.man > 0.05) t += ` · vaše korekce <b>${dec(r1(d.man))} U</b>`;
        if (ev.basalOk && Math.abs(d.basal) >= 0.1) t += ` · bazál ${d.basal > 0 ? '+' : '−'}${dec(r1(Math.abs(d.basal)))} U oproti obvyklému`;
        h += `<div class="ev-metrics">${t}.</div>`;
        if (ev.extraCarbs > 3) h += `<div class="ev-metrics">➕ Pumpa automaticky dorovnávala ~<b>${r0(ev.extraCarbs)} g</b>.</div>`;
        else if (ev.extraCarbs < -3) h += `<div class="ev-metrics">➖ Pumpa ubírala inzulin (~${r0(-ev.extraCarbs)} g) — dávka k jídlu byla spíš větší, než bylo potřeba.</div>`;
        if (ev.manCarbs > 3) h += `<div class="ev-metrics">🔧 Vaše korekce pokryla dalších ~<b>${r0(ev.manCarbs)} g</b>.</div>`;
        const miss = (ev.extraCarbs || 0) + (ev.manCarbs || 0);
        if (miss > 5 && d.meal > 0) h += `<div class="ev-metrics">Dávce k jídlu tedy chybělo ~<b>${r0(miss)} g</b>. Bilance počítá s veškerým inzulinem, takže výsledek níže to už zahrnuje.</div>`;
      }
      if (ev?.pumpMeals?.length) {
        h += `<div class="ev-metrics">🍞 Započteny sacharidy zadané do pumpy (bez fotky): ${ev.pumpMeals.map(p => `${r0(p.g)} g v ${hhmm(p.ts)}`).join(', ')}.</div>`;
      }
      if (ev?.end != null && ev.endSlope15 != null) {
        h += `<div class="ev-metrics">Na konci okna ${fmtBG(ev.end)} ${uLbl()} — ${ev.stable ? 'ustálená' : ev.endSlope15 > 0 ? 'ještě stoupá' : 'ještě klesá'} (${ev.endSlope15 >= 0 ? '+' : '−'}${fmtBG(Math.abs(ev.endSlope15))} za 15 min).</div>`;
      }
      if (ev?.seg?.n > 1) h += `<div class="ev-metrics">🔗 Vyhodnoceno společně s ${ev.seg.n - 1} navazujícími jídly (celá křivka, každé jídlo od svého času)${ev.relSd != null ? ` — přesnost tohoto jídla ±${Math.round(ev.relSd * 100)} %` : ''}${ev.sitting ? '; fotky do 20 min od sebe se počítají jako jedno sezení' : ''}.</div>`;
      if (ev?.unlogged) {
        h += `<div class="ev-box">🤔 Průběh glykémie naznačuje jídlo, které tu není — kolem <b>${hhmm(ev.unlogged.t)}</b>, asi <b>${r0(ev.unlogged.g)} g</b>. Pokud jste tehdy něco snědli, zapište to — výpočet okolních jídel se zpřesní.
          <div class="ev-actions"><input id="cm-ul-g" type="text" inputmode="decimal" value="${r0(ev.unlogged.g)}"><span class="unit">g v</span><input id="cm-ul-t" type="time" value="${hhmm(ev.unlogged.t)}"><button id="cm-ul-add" class="btn slim">Zapsat</button></div>
          <div class="ev-actions"><button id="cm-ul-no" class="btn btn-ghost slim" style="white-space:nowrap">Nic jsem nejedl</button><span class="muted small-text">— pak to vysvětlí dobíhání jídla nebo bazál</span></div></div>`;
      }
      if (ev?.noMeal) {
        const n = ev.noMeal, prev = n.prevTs ? `jídlo z ${hhmm(n.prevTs)}` : 'předchozí jídlo';
        const why = n.why === 'tail' ? `nejspíš ještě dobíhalo ${prev} (tuk, bílkoviny nebo pomalé sacharidy) a dávka k jídlu ho nepokryla celé${n.tailG >= 3 ? ` — pozdní část ~${r0(n.tailG)} g` : ''}.`
          : n.why === 'basal' ? `nejspíš od ~${hhmm(n.rampFrom || n.t)} nestačil bazál${n.slope > 0.05 ? ` (glykémie stoupala navíc o ~${fmtBG(n.slope)} ${uLbl()} za hodinu)` : ''}.`
            : `buď ještě dobíhalo ${prev} (tuk, bílkoviny, pomalé sacharidy), nebo v tu dobu nestačil bazál. Z jedné křivky se to rozlišit nedá — rozhodne opakování: ve stejnou denní dobu po různých jídlech ukazuje spíš na bazál, po stejném druhu jídla spíš na dobíhání (viz Učení).`;
        h += `<div class="ev-box">🙅 Kolem <b>${hhmm(n.t)}</b> jste podle vás nejedli. Vzestup glykémie v tu dobu: ${why} Okolní jídla s tím počítají a mají menší váhu v učení.
          <div class="ev-actions"><button id="cm-nm-undo" class="btn btn-ghost slim">Zpět — přece jen jsem jedl</button></div></div>`;
      }
      const photoNeighbours = (ev?.cluster || []).filter(t => !(ev.pumpMeals || []).some(p => p.ts === t));
      if (photoNeighbours.length) h += `<div class="ev-metrics">🍽 Vyhodnoceno společně s jídlem v ${photoNeighbours.map(hhmm).join(', ')}${ev.share != null && ev.share < 1 ? ` — podíl tohoto jídla ~${Math.round(ev.share * 100)} %` : ''}.</div>`;
      if (ev?.dur) h += `<div class="ev-metrics">Vstřebávání: ${LEARN.GI_LABEL[ev.gi] || 'podle druhu jídla'}${ev.absorbed != null ? ` — do konce okna ~${Math.round(ev.absorbed * 100)} %` : ''}.</div>`;
      if (ev?.fit?.used) {
        const sp = ev.fit.speed, pct = Math.round(Math.abs(sp - 1) * 100);
        h += `<div class="ev-metrics">📈 Celý průběh glykémie odpovídá modelu (odchylka ±${fmtBG(ev.fit.rmse)} ${uLbl()}); jídlo se u vás vstřebávalo ${sp > 1.08 ? `o ~${pct} % rychleji` : sp < 0.93 ? `o ~${pct} % pomaleji` : 'obvyklou rychlostí'}${ev.fit.informative ? ' — aplikace si to pamatuje pro podobná jídla' : ''}.</div>`;
      }
      if (ev?.heavy) h += `<div class="ev-metrics">🧈 Hodně tuku a bílkovin (~${dec(K.r1(ev.fpu))} FPU) — vyhodnoceno 4 h, jejich pozdní vliv (~${r0(ev.fpuCarbs)} g „sacharidů") je započten zvlášť.</div>`;
      else if (ev?.fpuCarbs > 3) h += `<div class="ev-metrics">🧈 Tuk a bílkoviny přidaly v okně ~${r0(ev.fpuCarbs)} g „sacharidů" — započteno zvlášť.</div>`;
      const wEnd = e.ts + LEARN.postFor(asMeal(e)), pendingWin = Date.now() < wEnd;
      if (ev?.implied && LEARN.REL_SD[ev.quality]) {
        const prior = CONF.entrySigma({ C: e.s, kind: 'ai-photo', jist: e.jist, sMin: e.sMin, sMax: e.sMax, sSd: e.sSd, learnedSd: cal().sd }).sigma;
        const post = LEARN.combine(e.s, prior, ev.implied, ev.quality, ev.relSd);
        h += `<div class="ev-box">Podle glykémie a inzulinu mělo jídlo nejspíš <b>~${r0(ev.implied)} g</b> sacharidů (spolehlivost výpočtu: ${QLBL[ev.quality]}).<br>Spojeno s odhadem z fotky: <b>${r0(post.C)} g</b> (±${r0(CONF.Z90 * post.sigma)} g).</div>`;
        // Potvrzení jen pro známé množství — předvyplněný odhad by učení vracel AI jejím vlastním číslem.
        if (e.conf == null && !e.excl) h += `<div class="muted small-text" style="margin-top:10px">Znám přesné množství (obal, vážení)? Jinak nechte prázdné — odhad z glykémie se do učení započítá sám, s vahou podle své přesnosti.</div>
          <div class="ev-actions" style="margin-top:6px"><input id="cm-conf" type="text" inputmode="decimal" placeholder="g"><span class="unit">g</span><button id="cm-confirm" class="btn slim">✓ Potvrdit skutečnost</button></div>`;
      } else if (pendingWin) {
        h += `<div class="ev-box">Ověření glykémií bude možné po ${hhmm(wEnd)} (${wEnd - e.ts > POST ? '4 h po jídle — hodně tuku a bílkovin' : '2,5 h po jídle'}). Aplikace si data stáhne sama.</div>`;
      } else if (ev?.implied && ev.quality === 'poor') {
        // Výpočet proběhl, ale okno je zatížené (hypoglykémie, pohyb, alkohol…) — jen pro informaci.
        h += `<div class="ev-box">Výpočet z glykémie dává ~${r0(ev.implied)} g, ale k učení se toto jídlo nepoužije: ${esc(ev.flags.filter(f => /nepoužito|rychle měnila|nedají se/.test(f)).join(', ') || ev.flags.join(', '))}.</div>`;
      } else {
        h += `<div class="ev-box">Zatím nelze ověřit: ${esc((ev?.flags || ['chybí data z CGM']).join(', '))}.</div>`;
      }
      if (ev?.flags?.length && ev.implied && ev.quality !== 'poor') h += `<div class="muted small-text">Pozn.: ${esc(ev.flags.join(' · '))}</div>`;

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
      <label class="field">Rychlost vstřebání<select id="cm-gi"><option value="">podle druhu jídla</option>${Object.entries(LEARN.GI_LABEL).map(([k, l]) => `<option value="${k}"${LEARN.giKey(e.gi) === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="btn-row"><button id="cm-del" class="btn btn-danger-ghost">Smazat</button><button id="cm-save" class="btn grow">Uložit změny</button></div></details>
      <p class="muted small-text" style="margin-top:10px">Zpětný výpočet z glykémie je orientační (pohyb, stres, tuk a automatika pumpy ho ovlivňují). Nenahrazuje doporučení diabetologa k dávkování inzulinu.</p>`;
    $('#cmeal-body').innerHTML = h;
    bindMeal(e);
  }

  function bindMeal(e) {
    const after = () => { K.saveAll(); invalidate(); touchData(); openMeal(e.id); };
    $('#cm-confirm')?.addEventListener('click', () => {
      const raw = $('#cm-conf').value.trim(), v = K.num(raw);
      if (!raw || !(v >= 0)) { K.toast('Zadejte skutečné množství z obalu nebo vážení'); return; }
      e.conf = v; e.s = v; delete e.auto; after(); K.toast('Potvrzeno — aplikace se z toho učí');
    });
    $('#cm-unconf')?.addEventListener('click', () => { delete e.conf; after(); });
    $('#cm-excl')?.addEventListener('click', () => { e.excl = $('#cm-excl-why').value; after(); });
    $('#cm-unexcl')?.addEventListener('click', () => { delete e.excl; after(); });
    $('#cm-man')?.addEventListener('click', () => {
      e.man = { bg0: toMmol($('#cm-bg0').value), bg2: toMmol($('#cm-bg2').value) };
      if (!e.man.bg0 || !e.man.bg2) { K.toast('Zadejte obě hodnoty'); return; }
      after();
    });
    // Doplnění nezapsaného jídla (ruční zápis sacharidů) — v dalším výpočtu je to známá hodnota.
    $('#cm-ul-add')?.addEventListener('click', () => {
      const g = K.num($('#cm-ul-g').value);
      if (!(g > 0)) { K.toast('Zadejte sacharidy'); return; }
      const ts = tsFromTime(e.ev.unlogged.t, $('#cm-ul-t').value);
      K.day(K.dstr(new Date(ts))).e.push({ id: 'm' + Date.now(), n: 'Doplněné jídlo', q: 1, s: g, cs: 'manual', ts, meal: 'sv' });
      after(); K.toast(`Zapsáno: ${r0(g)} g v ${hhmm(ts)} — okolní jídla se přepočítají`);
    });
    // „Nic jsem nejedl": navržené jídlo odmítnuto — vzestup vysvětlí dobíhání předchozího jídla nebo bazál.
    $('#cm-ul-no')?.addEventListener('click', () => {
      const t = tsFromTime(e.ev.unlogged.t, $('#cm-ul-t').value), d = K.day(K.dstr(new Date(t)));
      d.nm = [...(d.nm || []).filter(x => Math.abs(x.t - t) > 5 * MIN), { t, g: e.ev.unlogged.g, at: Date.now() }];
      after(); K.toast(`Rozumím — kolem ${hhmm(t)} jste nejedli. Přepočítávám.`);
    });
    $('#cm-nm-undo')?.addEventListener('click', () => {
      const t = e.ev.noMeal.t, d = K.day(K.dstr(new Date(t)));
      d.nm = (d.nm || []).filter(x => Math.abs(x.t - t) > 5 * MIN);
      after();
    });
    $('#cm-units-save')?.addEventListener('click', () => { const u = K.num($('#cm-units').value); if (u > 0) e.units = u; else delete e.units; after(); });
    $('#cm-save')?.addEventListener('click', async () => {
      const f = findEntry(e.id);
      const newName = $('#cm-name').value.trim(), renamed = !!newName && newName !== e.n;
      const carbsEdited = K.num($('#cm-carbs').value) !== K.r1(e.s);
      e.n = newName || e.n;
      e.s = K.num($('#cm-carbs').value);
      if ($('#cm-gi')) { if ($('#cm-gi').value) { if ($('#cm-gi').value !== LEARN.giKey(e.gi)) e.giUser = true; e.gi = $('#cm-gi').value; } else { delete e.gi; delete e.giUser; } }
      if (renamed && e.cs === 'ai-photo') {
        await JOBS.add({ kind: 'carb-reest', ts: e.ts, entryId: e.id, hint: newName, keepCarbs: carbsEdited, thumb: (await CGM.get('thumbs', e.id).catch(() => null))?.data });
        JOBS.tick();
        K.toast('Přepočítávám sacharidy podle nového názvu…');
      }
      delete e.auto;
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
      K.saveAll(); invalidate(); touchData();
      await CGM.del('thumbs', e.id).catch(() => {});
      await CGM.del('photos', e.id).catch(() => {});
      K.closeSheet('sheet-cmeal'); openId = null; K.renderDnes(); K.toast('Smazáno');
    });
  }

  /* ─── Obrazovka Učení ─── */
  function pctTxt(f) { const p = Math.round((f - 1) * 100); return (p > 0 ? '+' : '') + p + ' %'; }
  function renderLearn() {
    const c = cal(), all = photoEntries(), now = Date.now();
    const wEnd = e => e.ts + LEARN.postFor(asMeal(e));
    const pend = all.filter(e => now < wEnd(e)).length;
    const noData = all.filter(e => now >= wEnd(e) && !(e.ev?.implied) && e.conf == null && !e.excl).length;
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
    // Denní doba (zbytková chyba AI po korekci podle druhu jídla)
    const bl = Object.entries(c.blocks || {}).filter(([, v]) => v.n > 0);
    if (bl.length) {
      h += '<div class="card"><div class="card-title">Podle denní doby</div>' + bl.map(([k, v]) =>
        `<div class="learn-row"><span>${LEARN.BLOCKS[k].label}<br><span class="muted small-text">${v.n} ověř.</span></span><b>${Math.abs(v.factor - 1) < 0.03 ? 'bez rozdílu' : 'korekce ' + pctTxt(v.factor)}</b></div>`).join('')
        + '<p class="muted small-text">Co zůstane po korekci podle druhu jídla — např. ranní vyšší inzulinová rezistence.</p></div>';
    }
    // Osobní rychlost vstřebávání (z jídel, kde ji průběh glykémie jasně určil)
    const sp = spd(), spc = Object.entries(sp.cats).filter(([, v]) => v.n > 0);
    if (spc.length) {
      h += '<div class="card"><div class="card-title">Jak rychle se u vás jídlo vstřebává</div>' + spc.map(([k, v]) =>
        `<div class="learn-row"><span>${LEARN.CATS[k].label}<br><span class="muted small-text">${v.n} jídel s jasným průběhem</span></span><b>${v.factor > 1.05 ? 'rychleji o ' + Math.round((v.factor - 1) * 100) + ' %' : v.factor < 0.95 ? 'pomaleji o ' + Math.round((1 - v.factor) * 100) + ' %' : 'obvykle'}</b></div>`).join('')
        + '<p class="muted small-text">Oproti obecnému glykemickému indexu. Používá se při vyhodnocení dalších jídel.</p></div>';
    }
    // Vzestup glykémie podle druhu jídla (bez jídel s pohybem, alkoholem, hypoglykémií)
    const clean = all.filter(e => e.ev?.rise != null && e.ev.final && !e.excl && !e.ev.hypo && e.ev.exercise !== 'during' && !e.ev.alcohol);
    if (clean.length >= 3) {
      const g = {};
      for (const e of clean) (g[LEARN.catKey(e.kat)] ??= []).push(e);
      const med = xs => { const a = [...xs].sort((p, q) => p - q); return a[a.length >> 1]; };
      const rows = Object.entries(g).map(([k, es]) => ({ k, n: es.length, rise: med(es.map(e => e.ev.rise)), above: med(es.map(e => e.ev.tAbove10 || 0)) }))
        .sort((a, b) => b.rise - a.rise);
      h += '<div class="card"><div class="card-title">Které jídlo vás zvedne nejvíc</div>' + rows.map(r =>
        `<div class="learn-row"><span>${LEARN.CATS[r.k].label}<br><span class="muted small-text">${r.n}× · nad 10 mmol/l typicky ${r.above} min</span></span><b>+${fmtBG(r.rise)} ${uLbl()}</b></div>`).join('')
        + '<p class="muted small-text">Typický vzestup glykémie od začátku jídla (medián).</p></div>';
    }
    // Načasování bolusu vůči jídlu — jen popis souvislosti z vašich dat
    const timed = clean.filter(e => e.ev.bolusLead != null);
    const buckets = [['≥ 15 min před jídlem', l => l <= -15], ['3–15 min před', l => l > -15 && l <= -3], ['se začátkem jídla', l => l > -3 && l <= 5], ['po začátku jídla', l => l > 5]]
      .map(([lbl, f]) => ({ lbl, es: timed.filter(e => f(e.ev.bolusLead)) })).filter(b => b.es.length >= 2);
    if (buckets.length >= 2) {
      const med = xs => { const a = [...xs].sort((p, q) => p - q); return a[a.length >> 1]; };
      h += '<div class="card"><div class="card-title">Bolus a vzestup glykémie</div>' + buckets.map(b =>
        `<div class="learn-row"><span>Bolus ${b.lbl}<br><span class="muted small-text">${b.es.length} jídel · nad 10 mmol/l typicky ${med(b.es.map(e => e.ev.tAbove10 || 0))} min</span></span><b>+${fmtBG(med(b.es.map(e => e.ev.rise)))} ${uLbl()}</b></div>`).join('')
        + '<p class="muted small-text">Souvislost z vašich jídel (čas bolusu z pumpy, čas jídla z fotky) — ne doporučení k dávkování; načasování proberte s diabetologem.</p></div>';
    }
    // Vzestupy bez jídla („nic jsem nejedl") — popis opakování, ne doporučení
    const nmEv = {};
    for (const e of all) if (e.ev?.noMeal) nmEv[e.ev.noMeal.t] = e.ev.noMeal;
    const nms = noMeals(now - 60 * DAY, now).map(x => ({ ...x, ...(nmEv[x.t] || {}), block: LEARN.blockOf(x.t) }));
    if (nms.length) {
      const by = (f) => { const o = {}; for (const x of nms) { const k = f(x); if (k) (o[k] ??= []).push(x); } return o; };
      const blocks = by(x => x.block), kats = by(x => (x.prevKat ? LEARN.catKey(x.prevKat) : null));
      const uniq = xs => new Set(xs).size;
      const hints = [];
      for (const [k, xs] of Object.entries(blocks)) if (xs.length >= 3 && uniq(xs.map(x => x.prevKat ? LEARN.catKey(x.prevKat) : '?')) >= 2)
        hints.push(`${LEARN.BLOCKS[k].label}: ${xs.length}× po různých jídlech → ukazuje to spíš na bazál v tuto dobu.`);
      for (const [k, xs] of Object.entries(kats)) if (xs.length >= 3 && uniq(xs.map(x => x.block)) >= 2)
        hints.push(`Po jídle „${LEARN.CATS[k].label}" ${xs.length}× v různou denní dobu → spíš dlouhé dobíhání tohoto druhu jídla.`);
      h += '<div class="card"><div class="card-title">Vzestupy bez jídla</div>'
        + `<p class="muted small-text">Kdy glykémie stoupala, i když jste podle vás nejedli (posledních 60 dní, ${nms.length}×).</p>`
        + Object.entries(blocks).map(([k, xs]) => `<div class="learn-row"><span>${LEARN.BLOCKS[k].label}<br><span class="muted small-text">${xs.map(x => K.fmtHuman(K.dstr(new Date(x.t))) + ' ' + hhmm(x.t)).slice(-4).join(', ')}</span></span><b>${xs.length}×</b></div>`).join('')
        + (Object.keys(kats).length ? '<div class="learn-row"><span>Předchozí jídlo<br><span class="muted small-text">' + Object.entries(kats).sort((a, b) => b[1].length - a[1].length).map(([k, xs]) => `${LEARN.CATS[k].label} ${xs.length}×`).join(' · ') + '</span></span></div>' : '')
        + (hints.length ? hints.map(x => `<p>${esc(x)}</p>`).join('') : '<p class="muted small-text">Zatím bez opakování — vzorec se ukáže po víc případech (ve stejnou denní dobu po různých jídlech → spíš bazál; po stejném druhu jídla → spíš dobíhání).</p>')
        + '<p class="muted small-text">Jen popis z vašich dat, ne doporučení k dávkování. Opakující se vzorec stojí za to probrat s diabetologem.</p></div>';
    }
    const w = vw(), used = [...new Set([...Object.keys(w), ...(K.aiConfig().key ? ['gemini'] : []), ...(AI.claudeReady() ? ['claude'] : [])])];
    if (used.length > 1 || Object.keys(w).length) {
      const sh = LEARN.vendorShares(w, used);
      h += '<div class="card"><div class="card-title">AI modely</div>' + used.map(v =>
        `<div class="learn-row"><span>${LEARN.VENDOR_LABEL[v]}<br><span class="muted small-text">${w[v]
          ? `${w[v].n} ověř. · typická chyba ±${Math.round((Math.exp(w[v].rmse) - 1) * 100)} %` : 'zatím bez ověřených jídel'}</span></span><b>váha ${Math.round(sh[v] * 100)} %</b></div>`).join('')
        + '<p class="muted small-text">Odhad fotky je vážený průměr AI. Váhy se posouvají k té, která u vašich jídel ověřených glykémií chybuje méně; dokud je dat málo, jsou vyrovnané.</p></div>';
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

  window.CARB = { cal, renderTimeline, renderLearn, fillSettings, refresh, openMeal, dayData };

  renderTimeline();
  refresh();
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 5 * MIN);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
})();
