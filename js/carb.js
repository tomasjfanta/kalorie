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
  // Zvážené jídlo jako štítek pro opravy AI: jen celé jídlo zvážené, AI naslepo (od v29) a zapsané sacharidy
  // nepřepsané daleko od hodnoty z váhy. Do kalibrace z fotek nejde (ta nese i vyrovnání poměru v pumpě).
  // (zapsané se porovná bez opravy podle stejného jídla — dishF; weighed.c zůstává hodnota z váhy a hustoty od AI)
  const weighedLabel = e => (e.weighed?.blind && !e.weighed.what && !e.weighed.disagree?.length && e.weighed.c > 0 && Math.abs(e.s / (e.dishF || 1) - e.weighed.c) <= Math.max(3, 0.1 * e.weighed.c) ? e.weighed.c : null);
  // Jídla z dotazu jiné verze se učí se čtvrtinovou vahou (změna dotazu posouvá odhady).
  const pvW = e => ((e.pv || 1) === LEARN.PROMPT_V ? 1 : 0.25);
  function samples() {
    const V = vw();
    // Zvážená jídla jen celá a naslepo (src 'weighed'): v kalibraci zpřesní rozdíly mezi druhy jídla, celkovou
    // úroveň (s vyrovnáním poměru v pumpě) dál určuje glykémie — viz LEARN.calibrate.
    return photoEntries().filter(e => !e.excl && e.aiRaw && (!e.weighed || weighedLabel(e))).map(e => {
      // AI hodnota z uložených běhů s dnešní opravou jednotlivých AI → kalibrace se učí jen to, co zbude
      const aiRaw = e.aiRuns?.length ? (LEARN.ensemble(e.aiRuns.map(r => ({ c: r.c, model: r.m })), V).c || e.aiRaw) : e.aiRaw;
      if (e.weighed) return { ts: e.ts, kat: e.kat, aiRaw, label: weighedLabel(e), src: 'weighed', w: 1 };
      if (e.conf != null) return { ts: e.ts, kat: e.kat, aiRaw, label: e.conf, src: 'confirmed', w: pvW(e) };
      if (e.ev?.implied && (e.ev.quality === 'good' || e.ev.quality === 'fair')) return { ts: e.ts, kat: e.kat, aiRaw, label: e.ev.implied, src: e.ev.quality, labSd: e.ev.relSd, w: pvW(e) };
      return null;
    }).filter(Boolean);
  }
  function cal() { if (!calCache) calCache = LEARN.calibrate(samples(), Date.now()); return calCache; }
  let dishCache = null;
  const invalidate = () => { calCache = null; vwCache = null; spCache = null; tailCache = null; dishCache = null; };
  // Pozdní vlna podle druhu jídla (LEARN.learnTail) z jídel, kde ji sonda změřila: dobře vysvětlená
  // jídla a ta s odpovědí „nic zvláštního". Do výpočtu jde až změna o ≥ 0,07 proti použité hodnotě
  // (kal.tails), aby se vyhodnocení při drobných posunech pořád nepřepočítávala.
  let tailCache = null;
  function tails() {
    if (!tailCache) tailCache = LEARN.learnTail(photoEntries().filter(e => e.ev?.tailProbe && !e.excl && !e.ev.unlogged && !e.ev.hypo
      && e.ev.exercise !== 'during' && !e.ev.alcohol && (e.why === 'nic' || LEARN.REL_SD[e.ev.quality]))
      .map(e => ({ ts: e.ts, kat: e.kat, f: e.ev.tailProbe.f, sd: e.ev.tailProbe.sd })), Date.now());
    return tailCache;
  }
  const catTail = kat => +(K.store.get('kal.tails', {})[LEARN.catKey(kat)] || 0);
  function updateTails() {
    const used = K.store.get('kal.tails', {});
    let changed = false;
    for (const [k, x] of Object.entries(tails().cats)) {
      const v = x.f >= 0.05 ? Math.round(x.f * 20) / 20 : 0;
      if (Math.abs(v - (used[k] || 0)) >= 0.07) { if (v) used[k] = v; else delete used[k]; changed = true; }
    }
    if (changed) { K.store.set('kal.tails', used); touchData(); }
    return changed;
  }
  // „Co se stalo?" u jídla, které model nevysvětlil.
  const WHY = {
    snack: { lbl: '🍪 něco jsem snědl' },
    pohyb: { lbl: '🏃 pohyb', excl: 'pohyb nebo sport' },
    stres: { lbl: '🤒 stres / nemoc', excl: 'nemoc nebo stres' },
    senzor: { lbl: '📉 chyba senzoru', excl: 'chyba senzoru' },
    nic: { lbl: '🤷 nic zvláštního' },
  };

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
    // Rychlost z jídel, kde ji průběh jasně určil, a z jídel bez jiného jídla v okně, u kterých uživatel řekl
    // „nic zvláštního" — i když průběh nesedí (typicky rychlejší vrchol), je to přesně to, co se má naučit.
    if (!spCache) spCache = LEARN.learnSpeed(photoEntries().filter(e => !e.excl && e.ev?.fit?.speed > 0
      && ((e.ev.fit.informative && LEARN.REL_SD[e.ev.quality]) || (e.why === 'nic' && e.ev.seg?.n === 1)))
      .map(e => ({ ts: e.ts, kat: e.kat, speed: e.ev.fit.speed })), Date.now());
    return spCache;
  }
  const catSpeed = kat => (spd().n >= 3 ? spd().cats[LEARN.catKey(kat)].factor : 1);
  // Propojené stejné jídlo: rychlost a pozdní vlna z jeho ostatních výskytů (smrštěné k druhu jídla).
  const asMeal = e => { const ds = dishShapeOf(e); return { id: e.id, ts: e.ts, aiRaw: e.excl ? 0 : e.aiRaw, s: e.s, conf: e.conf, kat: e.kat, gi: e.gi,
    fat: e.fat ?? e.t, prot: e.b, alc: e.alc, speed: e.ev?.fit?.informative ? e.ev.fit.speed : ds?.speed ?? catSpeed(e.kat), tail: ds?.tail ?? catTail(e.kat), weighed: !!e.weighed }; };
  function mealsWithTime() {
    const out = [], D = K.days();
    for (const d of Object.keys(D)) for (const e of D[d].e || []) if (e.ts) out.push(e);
    return out;
  }

  /* ─── Opakovaná jídla: stejné jídlo z historie (často ze stejné restaurace) ───
     Jídla, která uživatel označí za stejná (potvrdí návrh, nebo jídlo pojmenuje stejně jako dřív), sdílí e.dish.
     Z jejich výskytů ověřených glykémií se učí, o kolik se skutečnost u tohoto jídla liší od odhadu AI po vaší
     kalibraci, a tím se upraví další odhad; z jejich křivek rychlost a pozdní vlna. Návrh podle podobnosti
     sám nic nemění — teprve potvrzené propojení. */
  const DISH_MIN = 0.55; // od jaké podobnosti jídlo navrhnout (0,5 = např. „rizoto" k „rýži s kuřetem")
  // Místo jídla: pojmenovaný podnik, restaurace bez názvu, doma, neznámé.
  const locOf = (place, facts) => place ? 'r:' + LEARN.placeKey(place) : (facts || []).includes(PLACE.doma) ? 'doma' : (facts || []).includes(PLACE.restaurace) ? 'r:' : '';
  const carbKeys = items => [...new Set((items || []).filter(i => i.c >= 3 && i.k !== 'jine').map(i => i.k))];
  function dishIdx() {
    if (!dishCache) {
      const by = {};
      for (const e of photoEntries()) if (e.dish) (by[e.dish] ??= []).push(e);
      dishCache = { by, desc: new Map(), shape: new Map() };
    }
    return dishCache;
  }
  const dishMembers = id => (id && dishIdx().by[id]) || [];
  function dishDesc(e) {
    const c = dishIdx().desc;
    let d = c.get(e.id);
    if (!d) { d = { n: e.n, w: LEARN.dishWords(e.n), keys: carbKeys(e.items), loc: locOf(e.place, e.facts) }; c.set(e.id, d); }
    return d;
  }
  // Propojení: { id } = existující skupina, { with, withAll } = dřívější nepropojená jídla se stejným názvem
  // (skupina vznikne při uložení).
  function linkInfo(link) {
    const members = link?.id ? dishMembers(link.id) : link?.with ? (link.withAll || [link.with]).map(id => findEntry(id)?.e).filter(Boolean).sort((p, q) => p.ts - q.ts) : [];
    const last = members[members.length - 1];
    return { members, last, n: members.length, label: last?.n || '', place: last?.place || '' };
  }
  const linkOk = link => !!link && linkInfo(link).n > 0;
  function commitLink(e, link) {
    if (!linkOk(link)) return;
    if (link.id) { e.dish = link.id; return; }
    const os = linkInfo(link).members;
    const id = os.find(o => o.dish)?.dish || 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    for (const o of os) o.dish = id;
    e.dish = id;
  }
  // Návrhy „stejné jako…": skupiny (propojená jídla jako jedna, jinak jednotlivá jídla) z posledních 180 dní,
  // podle podobnosti; before = jen jídla před tímto časem, skipDish = skupina, do které jídlo už patří.
  function dishCands(desc, skip, { max = 3, before = Infinity, skipDish = null } = {}) {
    const now = Date.now(), best = {};
    for (const e of photoEntries()) {
      if (e.id === skip || e.ts >= before || now - e.ts > 180 * DAY || (skipDish && e.dish === skipDish)) continue;
      const sc = LEARN.dishSim(desc, dishDesc(e));
      if (sc < DISH_MIN) continue;
      // nepropojená jídla se stejným názvem a místem = jeden návrh (propojí se všechna)
      const dd = dishDesc(e), k = e.dish || 'n:' + dd.w.join(' ') + '|' + dd.loc;
      const g = (best[k] ??= { score: 0, id: e.dish || null, with: null, withAll: e.dish ? undefined : [] });
      g.score = Math.max(g.score, sc);
      if (!e.dish) { g.withAll.push(e.id); g.with = e.id; }
    }
    return Object.values(best).sort((a, b) => b.score - a.score).slice(0, max).map(g => ({ ...g, ...linkInfo(g) }));
  }
  // Stejný název, jaký uživatel dal dřívějšímu jídlu (ne obecný) → propojit bez ptaní; přednost má
  // existující skupina (největší), jinak nejnovější takové jídlo.
  function dishByName(desc, skip) {
    if (LEARN.genericName(desc.n)) return null;
    const hits = photoEntries().filter(e => e.id !== skip && e.hint && LEARN.sameName(desc, dishDesc(e)));
    if (!hits.length) return null;
    const grp = hits.filter(e => e.dish).sort((p, q) => dishMembers(q.dish).length - dishMembers(p.dish).length || q.ts - p.ts)[0];
    return grp ? { id: grp.dish, with: null, auto: true } : { id: null, with: hits[hits.length - 1].id, withAll: hits.map(e => e.id), auto: true };
  }
  const jobLink = (job, a0) => {
    if (job.dishNo) return null;
    if (linkOk(job.dishLink)) return job.dishLink;
    return job.hint ? dishByName({ n: job.hint, keys: carbKeys(a0.items), loc: locOf(job.placeName, job.facts) }) : null;
  };
  // Výskyt jídla → o kolik se jeho skutečnost lišila od dnešního odhadu (AI s opravami × kalibrace), v log.
  // Zvážené s kontrolou z glykémie jako ostatní (glykémie nese i vyrovnání poměru v pumpě); bez ní zvážená
  // hmotnost proti úrovni zvážených jídel v kalibraci (to je jen chyba odhadu porce).
  const qOk = q => q === 'good' || q === 'fair';
  function dishResid(e) {
    if (e.excl || e.alc || e.ev?.alcohol || !e.aiRuns?.length) return null;
    const c = cal(), ai = LEARN.ensemble(e.aiRuns.map(r => ({ c: r.c, model: r.m })), vw()).c || e.aiRaw;
    if (!(ai >= 3)) return null;
    const gF = LEARN.applyCal(ai, e.kat, c, e.ts).factor, N2 = LEARN.AI_NOISE ** 2, sd = (x, q) => Math.min(1, x > 0 ? x : LEARN.REL_SD[q]) ** 2;
    if (e.weighed) {
      const ck = e.ev?.check;
      if (e.weighed.blind && ck?.implied > 0 && qOk(ck.quality)) return { ts: e.ts, y: Math.log(ck.implied / (ai * gF)), v: sd(ck.relSd, ck.quality) + N2 };
      const lab = weighedLabel(e);
      if (!lab) return null;
      const k = LEARN.catKey(e.kat), wF = Math.min(1.6, Math.max(0.6, Math.exp((c.qW ?? 0) + (c.cats?.[k]?.mu ?? 0) - (c.mu ?? 0))));
      return { ts: e.ts, y: Math.log(lab / (ai * wF)), v: LEARN.REL_SD.weighed ** 2 + N2 };
    }
    if (e.conf > 0) return { ts: e.ts, y: Math.log(e.conf / (ai * gF)), v: LEARN.REL_SD.confirmed ** 2 + N2 };
    if (e.ev?.implied > 0 && qOk(e.ev.quality)) return { ts: e.ts, y: Math.log(e.ev.implied / (ai * gF)), v: sd(e.ev.relSd, e.ev.quality) + N2 };
    return null;
  }
  // Zvážené celé jídlo: sacharidy na gram podle glykémie u jeho dřívějších zvážených výskytů (kontrola inzulinu
  // ÷ hodnota z váhy), očištěné o obvyklý rozdíl glykémie proti známému množství v tu denní dobu (ten patří
  // poměru v pumpě, ne jídlu — s malým množstvím dat se smrští k nule).
  function ratioOffset(ts) {
    const now = Date.now(), lr = photoEntries().filter(e => e.ts >= now - 90 * DAY && (e.conf != null || e.weighed) && e.ev?.check?.ratio > 0 && LEARN.REL_SD[e.ev.check.quality])
      .map(e => ({ b: LEARN.blockOf(e.ts), y: Math.log(e.ev.check.ratio) }));
    const all = lr.reduce((a, x) => a + x.y, 0) / (lr.length + 2), bs = lr.filter(x => x.b === LEARN.blockOf(ts));
    return (bs.reduce((a, x) => a + x.y, 0) + 2 * all) / (bs.length + 2);
  }
  function densResid(e) {
    const ck = e.ev?.check;
    if (e.excl || !e.weighed?.blind || e.weighed.what || !(e.weighed.c > 0) || !(ck?.implied > 0) || !qOk(ck.quality)) return null;
    // nejistota kontroly aspoň ±15 % (jedno jídlo), recept se mezi výskyty liší ±10 %
    return { ts: e.ts, y: Math.log(ck.implied / e.weighed.c) - ratioOffset(e.ts), v: Math.min(1, Math.max(0.15, ck.relSd || 0)) ** 2 + 0.1 ** 2 };
  }
  // Odhad + propojené stejné jídlo (skip = jídlo samo, nepočítá se do vlastní opravy) → upravené sacharidy.
  function withDish(a, link, skip) {
    if (!linkOk(link)) return { ...a, dishF: 1, dishInfo: null };
    const li = linkInfo(link), others = li.members.filter(e => e.id !== skip), base = { label: li.label, place: li.place, n: others.length };
    if (a.weighed) {
      if (a.weighed.what) return { ...a, dishF: 1, dishInfo: { ...base, kind: 'part', k: 0, f: 1 } };
      const d = LEARN.dishFactor(others.map(densResid).filter(Boolean), Date.now());
      return { ...a, C: a.C * d.f, dishF: d.f, dishInfo: { ...base, kind: 'dens', k: d.n, f: d.f } };
    }
    const d = LEARN.dishFactor(others.map(dishResid).filter(Boolean), Date.now());
    const tot = Math.min(1.6, Math.max(0.6, (a.factor || 1) * d.f)), f = tot / (a.factor || 1), sc = x => (x != null ? x * f : x);
    return { ...a, C: a.aiRaw * tot, sMin: sc(a.sMin), sMax: sc(a.sMax), sSd: sc(a.sSd), dishF: f, dishInfo: { ...base, kind: 'photo', k: d.n, f } };
  }
  // Tvar křivky z ostatních výskytů jídla (kde ho průběh jasně určil — stejné podmínky jako u druhu jídla).
  function dishShapeOf(e) {
    if (!e.dish) return null;
    const c = dishIdx().shape;
    if (c.has(e.id)) return c.get(e.id);
    const occ = [];
    for (const x of dishMembers(e.dish)) {
      const ev = x.ev;
      if (x.id === e.id || x.excl || !ev || ev.hypo || ev.exercise === 'during' || ev.alcohol) continue;
      occ.push({ speed: ev.fit?.speed > 0 && ((ev.fit.informative && LEARN.REL_SD[ev.quality]) || (x.why === 'nic' && ev.seg?.n === 1)) ? ev.fit.speed : null,
        tail: ev.tailProbe && !ev.unlogged && (x.why === 'nic' || LEARN.REL_SD[ev.quality]) ? ev.tailProbe : null });
    }
    const r = occ.length ? LEARN.dishShape(occ, { speed: catSpeed(e.kat), tail: catTail(e.kat) }) : null;
    c.set(e.id, r);
    return r;
  }
  function fillPlaces() {
    const seen = new Set(), out = [];
    for (const e of photoEntries().reverse()) {
      if (!e.place || seen.has(e.place.toLowerCase())) continue;
      seen.add(e.place.toLowerCase()); out.push(e.place);
      if (out.length >= 30) break;
    }
    const dl = $('#place-list');
    if (dl) dl.innerHTML = out.map(p => `<option value="${esc(p)}">`).join('');
  }
  const dmy = t => { const d = new Date(t); return `${d.getDate()}. ${d.getMonth() + 1}.`; };
  const candLbl = g => `${esc(g.label)}${g.place ? ' · ' + esc(g.place) : ''} · ${g.n > 1 ? g.n + '×, naposledy ' : ''}${dmy(g.last.ts)}`;
  // Co propojení s jídlem udělá s odhadem (text do okna a detailu).
  function dishTxt(d, C) {
    if (!d) return '';
    if (d.kind === 'part') return ' — zváženou složku počítá váha, odhad beze změny.';
    const pct = Math.round(Math.abs(d.f - 1) * 100), more = d.f > 1 ? 'víc' : 'méně';
    if (!d.k) return d.kind === 'dens' ? ' — sacharidy z vaší váhy; na gram se upraví, až glykémie ověří zvážený výskyt.' : ' — zatím bez výskytu ověřeného glykémií, odhad beze změny.';
    if (pct < 2) return ` — minule to sedělo, odhad beze změny (${d.k}× ověřeno).`;
    return d.kind === 'dens' ? ` — glykémie u jeho zvážených výskytů ukázala o ~${pct} % ${more} sacharidů na gram, než počítá AI: ×${dec(Math.round(d.f * 100) / 100)} → <b>${r0(C)} g</b> (${d.k}× ověřeno).`
      : ` — glykémie u něj ukázala o ~${pct} % ${more} sacharidů, než AI s vaší kalibrací odhaduje: ×${dec(Math.round(d.f * 100) / 100)} → <b>${r0(C)} g</b> (${d.k}× ověřeno).`;
  }

  // „Nic jsem nejedl": časy, kdy aplikace navrhla nezapsané jídlo a uživatel ho odmítl (uloženo u dne).
  function noMeals(from, to) {
    const out = [], D = K.days();
    for (const d of Object.keys(D)) for (const x of D[d].nm || []) if (x.t >= from && x.t <= to) out.push(x);
    return out.sort((a, b) => a.t - b.t);
  }

  // „Křivky": jídla dne (zapsaná, z pumpy, odhalená nezapsaná), CGM, inzulin a nastavení pumpy.
  async function dayData(from, to) {
    const W = 6 * 60 * MIN, A = 3 * 60 * MIN;
    const entries = mealsWithTime().filter(e => e.ts >= from - W && e.ts <= to + A && (e.s > 0 || e.conf != null));
    const meals = entries.map(e => ({ ...asMeal(e), n: e.n, implied: e.ev?.implied && LEARN.REL_SD[e.ev.quality] ? e.ev.implied : null,
      fitSpeed: e.ev?.fit?.used ? e.ev.fit.speed : null }));
    meals.push(...await pumpMeals(entries, from - W, to + A));
    for (const e of entries) for (const u of e.ev?.seg?.unlogged || []) {
      if (u.t >= from - W && u.t <= to + A && !meals.some(m => m.ghost && Math.abs(m.ts - u.t) < 10 * MIN)) meals.push({ id: 'g' + u.t, ts: u.t, g: u.g, gi: 'střední', kat: 'ostatni', ghost: true });
    }
    const [readings, boluses, basal, pumpset, targets] = await Promise.all([
      CGM.range('cgm', from - 90 * MIN, to + A + 15 * MIN),
      CGM.range('bolus', from - 300 * MIN, to + A),
      CGM.range('basal', from - DAY, to + A).catch(() => []),
      CGM.range('pumpset', from - 30 * DAY, to + 30 * DAY),
      CGM.range('targets', from - 14 * 60 * MIN, to).catch(() => []),
    ]);
    const meter = await CGM.range('bgm', from - 90 * MIN, to + A).catch(() => []);
    const before = basal.filter(r => r.t < from);
    return { readings, boluses, basal, basalBase: before.length >= 96 ? LEARN.basalBaseline(before) : null, targets, meals, meter,
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
      out.push({ id: 'pc' + p.t, ts: p.t, s: p.g, conf: p.g, kat: 'ostatni', pump: true, tail: catTail('ostatni') });
    }
    return out;
  }

  // Vyhodnotí celý segment, do kterého jídlo patří (navazující jídla společně), a výsledky zapíše
  // všem jeho jídlům. Bez inzulinu (léčba „bez inzulinu") se jídla vyhodnocují jednotlivě postaru.
  async function evaluate(e) {
    const entries = mealsWithTime().filter(x => Math.abs(x.ts - e.ts) < 2 * DAY);
    const all = [...entries.map(asMeal), ...await pumpMeals(entries, e.ts - 2 * DAY, e.ts + 2 * DAY)];
    const me = all.find(m => m.id === e.id);
    me.speed = dishShapeOf(e)?.speed ?? catSpeed(e.kat);
    const segMeals = LEARN.segmentOf(me, all);
    const T0 = segMeals[0].ts, END = LEARN.windowEnd(segMeals);
    const [readings, boluses, basal, pumpset, targets] = await Promise.all([
      CGM.range('cgm', T0 - PRE, END),
      CGM.range('bolus', T0 - 300 * MIN, END),
      CGM.range('basal', T0 - DAY, END).catch(() => []),
      CGM.range('pumpset', T0 - 30 * DAY, T0 + 30 * DAY),
      CGM.range('targets', T0 - 14 * 60 * MIN, END).catch(() => []),
    ]);
    const meter = await CGM.range('bgm', T0 - PRE - 30 * MIN, END + 60 * MIN).catch(() => []);
    const before = basal.filter(r => r.t < T0 - 30 * MIN);
    const basalBase = before.length >= 96 ? LEARN.basalBaseline(before) : null;
    const w = { readings, boluses, meter };
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
    const data = { readings, boluses, basal, basalBase, targets, meter, settingsAt: makeSettingsAt(pumpset),
      prior: all.filter(m => m.ts < T0 && m.ts >= T0 - 300 * MIN), noMeal: noMeals(T0 - 2 * 60 * MIN, END + 2 * 60 * MIN).map(x => x.t) };
    let results;
    if (therapy().type === 'none') {
      results = {};
      for (const m of segMeals) if (byId[m.id]) results[m.id] = LEARN.evaluateMeal(m, { ...data, meals: all.filter(x => x.id !== m.id) }, therapy(), kNone());
    } else {
      results = LEARN.evaluateSegment(segMeals, data, therapy()).results;
    }
    // Jídla se známým množstvím (potvrzená): kolik by „ukázala" glykémie, kdyby množství neznala.
    // Poměr ke skutečnosti vypovídá o inzulinu k jídlu (sacharidy jsou známé), ne o odhadu AI.
    const knownIds = therapy().type === 'none' ? [] : segMeals.filter(m => byId[m.id]?.cs === 'ai-photo' && (byId[m.id].conf != null || byId[m.id].weighed)).map(m => m.id);
    const checks = knownIds.length ? LEARN.evaluateSegment(segMeals.map(m => (knownIds.includes(m.id) ? { ...m, conf: undefined, weighed: false, aiRaw: m.conf ?? m.s } : m)), data, therapy()).results : {};
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
        winEnd: END, rise: ev.rise, tAbove10: ev.tAbove10, bolusLead: ev.bolusLead, final, tailProbe: ev.tailProbe, misfit: ev.misfit, meter: ev.meter,
      };
      const ck = checks[m.id];
      const known = ent.conf ?? (ent.weighed ? ent.s : null);
      if (ck?.implied > 0 && known > 0) ent.ev.check = { implied: ck.implied, relSd: ck.relSd, quality: ck.quality, ratio: ck.implied / known, icr: ck.icr };
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
      if (r.status) K.store.set('kal.nsStatus', r.status);
      if (r.readings || r.boluses || r.basal || r.bgm) touchData();
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
      for (const j of await JOBS.list()) {
        if (j.status === 'draft' && Date.now() - (j.created || 0) > 3 * MIN && pending?.jobId !== j.id) { j.status = 'pending'; j.nextAt = Date.now(); await JOBS.save(j); }
      }
      if (!K.store.get('kal.migr5', false)) { touchData(); K.store.set('kal.migr5', true); } // vše jednou přepočítat (v22)
      await nsAutoSync();
      const all = photoEntries(), now = Date.now(), changed = [], start = Date.now();
      for (const e of all) {
        if (e.ts > now || now - e.ts > 45 * DAY) continue;
        if (e.ev?.final && e.ev.at >= dataAt()) continue;
        if (e.ev?.at >= start) continue; // už spočítáno v rámci segmentu jiného jídla
        await evaluate(e); changed.push(e);
      }
      if (changed.length) { K.saveAll(); invalidate(); }
      updateTails(); // změna naučené pozdní vlny → příští průchod jídla přepočítá
      let sent = false;
      for (const e of all) {
        if (e.weighed?.blind && e.weighed.per && !e.weighed.disagree?.length && e.portionSent !== e.weighed.g) {
          JOBS.logAi({ flow: 'portion', vendor: 'all', ok: true, job: e.id, label: e.weighed.g, per: e.weighed.per, msg: e.weighed.what || '', kat: e.kat });
          e.portionSent = e.weighed.g; sent = true;
        }
        const lab = e.conf != null ? { label: e.conf, src: 'confirmed' } : weighedLabel(e) ? { label: weighedLabel(e), src: 'weighed' }
          : e.ev?.final && e.ev.implied && (e.ev.quality === 'good' || e.ev.quality === 'fair') ? { label: e.ev.implied, src: e.ev.quality } : null;
        if (!lab || !e.aiRuns?.length || e.excl) continue;
        const key = `${lab.src}:${Math.round(lab.label)}`;
        if (e.lblSent === key) continue;
        const per = {};
        for (const v of new Set(e.aiRuns.map(r => LEARN.vendorOf(r.m)))) { const xs = e.aiRuns.filter(r => LEARN.vendorOf(r.m) === v).map(r => r.c).sort((p, q) => p - q); per[v] = xs[xs.length >> 1]; }
        JOBS.logAi({ flow: 'label', vendor: 'all', ok: true, job: e.id, label: Math.round(lab.label * 10) / 10, src: lab.src, per, carbs: Math.round(e.aiRaw), pv: (e.weighed ? 'w' : '') + (e.pv || 1), kat: e.kat,
          q: e.ev?.relSd != null ? Math.round(e.ev.relSd * 100) / 100 : undefined });
        e.lblSent = key; sent = true;
      }
      if (sent) K.saveAll();
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
  // Glykémie ze senzoru nechodí: podle stavu pumpy (devicestatus) rozlišit senzor od mostu k CareLinku.
  const SENSOR_TXT = { CHANGE_SENSOR: 'pumpa hlásí výměnu senzoru', NO_DATA_FROM_PUMP: 'pumpa ze senzoru nemá data', SENSOR_OFF: 'senzor je vypnutý',
    WARM_UP: 'nový senzor se zahřívá', CALIBRATION_REQUIRED: 'senzor potřebuje kalibraci', LOST_SENSOR_SIGNAL: 'pumpa ztratila signál senzoru', UNKNOWN: 'stav senzoru je neznámý' };
  function staleTxt() {
    const ns = K.store.get('kal.ns', null), last = K.store.get('kal.nsLast', null), st = K.store.get('kal.nsStatus', null);
    if (!ns?.url || !last?.t || K.viewDate() !== K.todayStr()) return '';
    const age = Date.now() - last.t;
    if (age < 30 * MIN) return '';
    const ago = age > DAY ? 'před více než dnem' : age >= 120 * MIN ? `před ${dec(K.r1(age / 3600e3))} h` : `před ${Math.round(age / MIN)} min`;
    const when = `Poslední glykémie ze senzoru je z ${hhmm(last.t)} (${ago}).`;
    const tip = 'Aby šla jídla ověřit i bez senzoru, změřte glukometrem glykémii těsně před jídlem a asi 2 a 3 h po něm — hodnoty z glukometru propojeného s pumpou se načtou samy, ostatní zapište tlačítkem 🩸 níže.';
    const pumpFresh = st?.t && Date.now() - st.t < 30 * MIN;
    const bad = s => s && s !== 'NO_ERROR_MESSAGE';
    if (pumpFresh && (bad(st.sensor) || bad(st.pump))) {
      const what = SENSOR_TXT[st.sensor] || SENSOR_TXT[st.pump] || `pumpa hlásí ${esc(st.sensor || st.pump)}`;
      return `<div class="result-note warn-note">🩸 Senzor neposílá data — ${what}. ${when} Bez senzoru je pumpa nejspíš v manuálním režimu (bez automatiky); jídla z této doby aplikace vyhodnotí jen hruběji. ${tip}</div>`;
    }
    if (pumpFresh) return `<div class="result-note warn-note">🩸 Pumpa data posílá, ale glykémie ze senzoru ne. ${when} Zkontrolujte senzor v pumpě. ${tip}</div>`;
    return `<div class="result-note warn-note">⚠️ ${when} Z pumpy nepřichází nic — když to trvá, odhlásil se nejspíš most k CareLinku (na počítači spusťte znovu přihlášení), případně není telefon s MiniMed Mobile u pumpy.</div>`;
  }
  // Měření z glukometru zobrazeného dne (načtou se z IndexedDB; po načtení se časová osa překreslí).
  let meterDay = { key: null, rows: [] };
  const dayBounds = key => { const [y, m, d] = key.split('-').map(Number); return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()]; };
  async function loadMeterDay() {
    const key = K.viewDate(), [a, b] = dayBounds(key);
    const rows = await CGM.range('bgm', a, b - 1).catch(() => []);
    const sig = rows.map(r => r.t + ':' + r.v).join('|');
    if (meterDay.key !== key || meterDay.sig !== sig) { meterDay = { key, rows, sig }; renderTimeline(true); }
  }
  const meterForm = () => `<div class="meter-row"><button type="button" id="meter-btn" class="btn btn-ghost slim">🩸 Glykémie z glukometru</button>
    <span id="meter-form" class="ev-actions hidden"><input id="meter-v" type="text" inputmode="decimal" placeholder="${uLbl()}"><input id="meter-t" type="time"><button type="button" id="meter-save" class="btn slim">Uložit</button></span></div>`;
  async function saveMeter(v, ts) {
    const mmol = toMmol(v);
    if (!(mmol > 1 && mmol < 35)) { K.toast('Zadejte glykémii'); return false; }
    await CGM.put('bgm', [{ t: Math.round(ts / 60000) * 60000, v: mmol, src: 'ruka' }]);
    touchData(); invalidate();
    K.toast(`Uloženo: ${fmtBG(mmol)} ${uLbl()} v ${hhmm(ts)} — jídla kolem se přepočítají`);
    refresh();
    return true;
  }
  function renderTimeline(fromLoad) {
    const box = $('#ctimeline');
    if (!box || !K.isCarb()) return;
    if (!fromLoad) loadMeterDay();
    const es = [...(K.day().e || [])].sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const mrows = meterDay.key === K.viewDate() ? meterDay.rows : [];
    if (!es.length && !mrows.length) {
      box.innerHTML = staleTxt() + meterForm() + '<div class="result-note">Zatím žádné jídlo. Vyfoťte talíř — AI odhadne sacharidy a glykémie z CGM pak odhad ověří a zpřesní další.</div>';
      bindMeterForm();
      return;
    }
    const items = [...es.map(e => ({ t: e.ts || 0, e })), ...mrows.map(r => ({ t: r.t, r }))].sort((a, b) => b.t - a.t);
    box.innerHTML = staleTxt() + meterForm() + items.map(({ e, r }) => {
      if (r) return `<button class="ctl-row ctl-bgm" data-bgm="${r.t}"><span class="ctl-thumb bgm-ico">🩸</span><span class="ctl-mid"><span class="ctl-name">Glukometr ${fmtBG(r.v)} ${uLbl()}</span><span class="ctl-sub">${hhmm(r.t)} · ${r.src === 'pumpa' ? 'z pumpy' : 'zapsáno ručně'}</span></span></button>`;
      const c = K.entryConf(e);
      const sub = (e.ts ? hhmm(e.ts) + ' · ' : '') + (e.auto && e.conf == null ? 'uloženo bez potvrzení · ' : '') + (e.cs === 'ai-photo' ? status(e) : 'ruční zápis');
      return `<button class="ctl-row" data-id="${e.id}"><img class="ctl-thumb" data-thumb="${e.id}" alt=""><span class="ctl-mid"><span class="ctl-name">${esc(e.n)}</span><span class="ctl-sub">${sub}</span></span><span class="e-carb"><span class="e-kcal">${K.fmtC(c.C)}</span>${K.badge(c.p)}</span></button>`;
    }).join('');
    bindMeterForm();
    $$('#ctimeline .ctl-bgm').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Smazat toto měření z glukometru?')) return;
      await CGM.del('bgm', +b.dataset.bgm).catch(() => {});
      touchData(); invalidate(); meterDay.key = null; loadMeterDay(); refresh();
    }));
    $$('#ctimeline .ctl-row[data-id]').forEach(b => b.addEventListener('click', () => openMeal(b.dataset.id)));
    $$('#ctimeline img[data-thumb]').forEach(img => {
      CGM.get('thumbs', img.dataset.thumb).then(x => { if (x) img.src = x.data; else img.classList.add('empty'); }).catch(() => img.classList.add('empty'));
    });
  }

  function bindMeterForm() {
    $('#meter-btn')?.addEventListener('click', () => {
      $('#meter-form').classList.toggle('hidden');
      $('#meter-t').value = hhmm(Date.now()); $('#meter-v').focus();
    });
    $('#meter-save')?.addEventListener('click', async () => {
      const [a] = dayBounds(K.viewDate()), m = /^(\d{1,2}):(\d{2})$/.exec($('#meter-t').value || '');
      const ts = m ? a + (+m[1] * 60 + +m[2]) * MIN : Date.now();
      if (ts > Date.now() + 5 * MIN) { K.toast('Čas je v budoucnosti'); return; }
      if (await saveMeter($('#meter-v').value, ts)) { meterDay.key = null; loadMeterDay(); }
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
    // Koncept: fotka je hned uložená ve frontě (neztratí se), AI se spustí až po „Odhadnout" (nebo po zavření okna).
    const job = await JOBS.add({ kind: 'carb-photo', ts, img: img.base64, thumb: await makeThumb(img.dataUrl), status: 'draft' });
    showJob(job);
  }
  const planTotal = job => { const p = planFor(job); return p.gemini + p.claude; };
  // Koncept → do fronty s upřesněním z okna (místo, zvážená hmotnost, počet kusů).
  async function startDraft(id, place) {
    const job = await JOBS.get(id);
    if (!job || job.status !== 'draft') return job;
    const g = K.num($('#cnew-w-g').value), what = $('#cnew-w-what').value.trim(), pcs = $('#cnew-pcs').value.trim();
    const pn = place === 'restaurace' ? $('#cnew-place').value.trim().slice(0, 60) : '';
    const facts = [...(place ? [PLACE[place]] : []), ...(pn ? ['podnik: ' + pn] : []), ...(pcs ? ['počet kusů: ' + pcs.slice(0, 80)] : [])];
    Object.assign(job, { status: 'pending', nextAt: Date.now(), facts, ...(pn ? { placeName: pn } : {}), ...(g > 0 ? { weighed: { g: Math.round(g), what: what.slice(0, 60) } } : {}) });
    await JOBS.save(job);
    return job;
  }
  $$('#cnew-pre-place .chip').forEach(b => b.addEventListener('click', () => {
    if (!pending) return;
    pending.place = pending.place === b.dataset.place ? null : b.dataset.place;
    $$('#cnew-pre-place .chip').forEach(x => x.classList.toggle('on', x.dataset.place === pending.place));
    $('#cnew-place-wrap').classList.toggle('hidden', pending.place !== 'restaurace');
    if (pending.place === 'restaurace') { fillPlaces(); $('#cnew-place').focus(); }
  }));
  $('#cnew-go').addEventListener('click', async () => {
    if (!pending) return;
    const job = await startDraft(pending.jobId, pending.place);
    if (!job) return;
    $('#cnew-pre').classList.add('hidden');
    progress(0, planTotal(job));
    JOBS.attempt(job.id);
  });

  // Otevře okno pro úlohu z fronty (novou i čekající) a podle jejího stavu ukáže formulář nebo průběh.
  function showJob(job) {
    pending = { jobId: job.id, ts: job.ts, thumb: job.thumb, filled: false, place: null };
    $('#cnew-img').src = 'data:image/jpeg;base64,' + job.img;
    $('#cnew-form').classList.add('hidden');
    $('#cnew-retry').classList.add('hidden');
    $('#cnew-pre').classList.toggle('hidden', job.status !== 'draft');
    K.openSheet('sheet-cnew');
    if (job.status === 'draft') {
      for (const id of ['#cnew-w-g', '#cnew-w-what', '#cnew-pcs', '#cnew-place']) $(id).value = '';
      $$('#cnew-pre-place .chip').forEach(x => x.classList.remove('on'));
      $('#cnew-place-wrap').classList.add('hidden');
      $('#cnew-status').textContent = 'Upřesněte, nebo rovnou Odhadnout:';
      return;
    }
    if (job.status === 'ready') { fillForm(job); return; }
    progress(0, planTotal(job));
    JOBS.attempt(job.id);
  }
  $('#cnew-retry').addEventListener('click', async () => {
    if (!pending) return;
    $('#cnew-retry').classList.add('hidden');
    const job = await JOBS.get(pending.jobId);
    progress(0, job ? planTotal(job) : 0);
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
    const id = pending.jobId, place = pending.place; pending = null;
    const job = await JOBS.get(id);
    // Okno zavřené bez „Odhadnout": odhad se spustí s tím, co je vyplněné (bez upřesnění = běžný odhad).
    if (job?.status === 'draft') { await startDraft(id, place); JOBS.attempt(id); return; }
    if (job?.status === 'ready') { await autoSave(job); await JOBS.remove(id); }
  }
  $('#sheet-cnew').addEventListener('click', ev => { if (ev.target.id === 'sheet-cnew') onClose(); });
  $('#sheet-cnew .sheet-close').addEventListener('click', onClose);

  // Jídla, která uživatel jí opakovaně nebo sám pojmenoval — AI jen k rozpoznání. Bez gramů: porci odhaduje
  // AI z fotky nezávisle (i naslepo u zvážených), zkušenost se stejným jídlem započte aplikace sama (withDish)
  // — jinak by se započetla dvakrát a odhady AI by přestaly být nezávislé na dřívějších štítcích.
  function examplesText() {
    const seen = new Set(), ex = [];
    for (const e of photoEntries().reverse()) {
      if (e.excl || !(e.hint || e.dish) || LEARN.genericName(e.n)) continue;
      const key = LEARN.dishWords(e.n).join(' ');
      if (seen.has(key)) continue;
      seen.add(key); ex.push(`„${e.n}"${e.place ? ' (' + e.place + ')' : ''}`);
      if (ex.length >= 10) break;
    }
    return ex.length ? ' Jídla, která tento uživatel jí opakovaně — jen pro rozpoznání, množství odhadni z fotky: ' + ex.join('; ') + '.' : '';
  }

  // Nezávislých odhadů na fotku: Gemini (zdarma) 4× — nejvýš 2 najednou kvůli minutovému limitu
  // bezplatného klíče — a Claude (předplatné, je-li nastavený) 2×.
  const PLAN = { gemini: 4, claude: 2 };
  const planFor = job => {
    const g = !!K.aiConfig().key, c = AI.claudeReady();
    // zvážené jídlo: hmotnost je známá, AI jen rozpozná složky → 1 + 1 (je-li jen jedna AI, 2 běhy té)
    if (job?.weighed?.g > 0) return g && c ? { gemini: 1, claude: 1 } : { gemini: g ? 2 : 0, claude: c ? 2 : 0 };
    return { gemini: g ? PLAN.gemini : 0, claude: c ? PLAN.claude : 0 };
  };
  const JIST = ['nízká', 'střední', 'vysoká'];
  let vwCache = null;
  // Váhy AI podle jejich ověřené přesnosti u vás (viz LEARN.vendorWeights).
  function vw() {
    if (!vwCache) vwCache = LEARN.vendorWeights(photoEntries().filter(e => !e.excl && e.aiRuns?.length && (!e.weighed || weighedLabel(e))).map(e => e.weighed ? ({
      ts: e.ts, runs: e.aiRuns, w: 1, labSd: LEARN.REL_SD.weighed, label: weighedLabel(e),
    }) : ({
      ts: e.ts, runs: e.aiRuns, w: pvW(e), labSd: e.conf != null ? 0.1 : e.ev?.relSd,
      label: e.conf != null ? e.conf : e.ev?.implied && (e.ev.quality === 'good' || e.ev.quality === 'fair') ? e.ev.implied : null,
    })), Date.now());
    return vwCache;
  }
  // Jedna odpověď modelu → { c, min, max, jist (0–2), kat, gi, j, model }
  function parseRun({ result: j, model }, weighed) {
    const jt = String(j.jistota || '').toLowerCase();
    // dotaz v2: součet složek (sacharidy z tabulky / od modelu); u zváženého jídla platí zvážená hmotnost
    const t0 = LEARN.v2Totals(j), t = weighed ? LEARN.applyWeight(t0, weighed) : t0;
    let min = t ? t.min : +j.sacharidy_min, max = t ? t.max : +j.sacharidy_max;
    if (!(isFinite(min) && isFinite(max)) || min < 0) { min = undefined; max = undefined; }
    else if (min > max) [min, max] = [max, min];
    return { c: t ? t.c : Math.max(0, +j.sacharidy || 0), cBlind: t0 ? t0.c : undefined, aiG: t?.aiG, items: t?.items, weighMiss: !!(weighed && (!t || t.weighMiss)), min, max, kat: LEARN.catKey(j.kategorie), gi: j.gi, j, model,
      jist: /vys|high/.test(jt) ? 2 : /níz|niz|low/.test(jt) ? 0 : 1 };
  }
  const progress = (k, n) => {
    if (!pending) return;
    $('#cnew-status').textContent = `Odhaduji sacharidy… ${k}/${n}${planFor().claude ? ' (Claude chvíli přemýšlí)' : ' (pár vteřin)'}`;
  };

  // Výsledek všech odhadů → hodnoty jídla (stejné pro okno i pro automatické uložení).
  function buildAi(res, ts, weighOrig) {
    let runs = res.runs.map(r => parseRun(r, weighOrig));
    // Zvážená složka, kterou žádný odhad mezi složkami nemá → hmotnost nepoužít (běžný odhad + upozornění);
    // když ji mají jen některé odhady, počítá se jen s nimi.
    const hit = runs.filter(r => !r.weighMiss), weighMiss = weighOrig?.g > 0 && !hit.length ? weighOrig : null;
    const weighed = weighOrig?.g > 0 && hit.length ? weighOrig : null;
    if (weighed) runs = hit; else if (weighMiss) runs = res.runs.map(r => parseRun(r, null));
    // Shoda složek: položka, kterou uvede méně než polovina odhadů, se nepočítá (vymyšlená);
    // chybí-li v některém odhadu složka, kterou mají ostatní, doplní se jejich mediánem.
    const cons = LEARN.itemConsensus(runs);
    if (cons) { let k = 0; for (const r of runs) if (r.items) r.c = cons.perRun[k++]; }
    // Zvážené jídlo: opravy AI a kalibrace z fotek opravují hlavně odhad porce — tady by „opravily" známou hmotnost.
    const V = weighed ? Object.fromEntries(Object.entries(vw()).map(([k, x]) => [k, { weight: x.weight }])) : vw();
    const E = LEARN.ensemble(runs, V);
    const j = E.rep.j;
    const c = weighed ? { C: E.c, factor: 1, blockFactor: 1 } : LEARN.applyCal(E.c, E.kat, cal(), ts);
    const alc = runs.filter(r => r.j.alkohol === true).length > runs.length / 2;
    // Zvážené: co AI odhadla naslepo (sacharidy i hmotnost porce) — z porovnání s váhou se učí opravy AI.
    let wInfo;
    if (weighed) {
      const blind = runs.filter(r => r.cBlind > 0), Eb = blind.length ? LEARN.ensemble(blind.map(r => ({ ...r, c: r.cBlind })), vw()) : null, per = {};
      for (const v of new Set(runs.map(r => LEARN.vendorOf(r.model)))) { const gs = runs.filter(r => LEARN.vendorOf(r.model) === v && r.aiG > 0).map(r => r.aiG).sort((p, q) => p - q); if (gs.length) per[v] = Math.round(gs[gs.length >> 1]); }
      const all = Object.values(per).sort((p, q) => p - q);
      // Se 2 běhy nejde hlasovat o vymyšlených složkách — aspoň poznat neshodu: složky se sacharidy (≥ 3 g),
      // které uvedl jen jeden běh. Takové jídlo neučí (štítek ani porce) a uživatel ho má zkontrolovat.
      const keySets = runs.filter(r => r.items).map(r => new Set(r.items.filter(i => i.c >= 3).map(i => i.k)));
      const disagree = [];
      if (keySets.length >= 2) for (const r of runs.filter(x => x.items)) for (const i of r.items) {
        if (i.c >= 3 && keySets.some(ks => !ks.has(i.k)) && !disagree.includes(i.n)) disagree.push(i.n);
      }
      wInfo = { ...weighed, blind: true, c: Math.round(E.c * 10) / 10, aiC: Eb ? Math.round(Eb.c * 10) / 10 : undefined, ai: all.length ? all[all.length >> 1] : undefined, per,
        ...(disagree.length ? { disagree } : {}) };
    }
    return {
      E, errors: res.errors || {}, name: (j.nazev || 'Jídlo').trim() + (j.mnozstvi ? ' (' + String(j.mnozstvi).trim() + ')' : ''),
      poznamka: j.poznamka, aiRaw: wInfo?.aiC ?? E.c, C: c.C, kat: E.kat, gi: E.gi, alc, factor: c.factor, blockFactor: c.blockFactor, jist: JIST[E.jist],
      sMin: E.min != null ? E.min * c.factor : undefined, sMax: E.max != null ? E.max * c.factor : undefined,
      sSd: E.sd != null ? E.sd * c.factor : undefined, runs: runs.map(r => ({ m: r.model, c: Math.round((weighed && r.cBlind > 0 ? r.cBlind : r.c) * 10) / 10 })),
      items: (cons ? cons.items : E.rep.items || []).map(i => ({ k: i.k, n: i.n, g: Math.round(i.g), c: Math.round(i.c * 10) / 10, vis: i.vis })),
      dropped: cons?.dropped || [], pv: runs.some(r => r.items) ? LEARN.PROMPT_V : 1, weighed: wInfo, weighMiss,
      fat: Math.max(0, +j.tuky || 0), kcal: Math.round(+j.kcal || 0), b: Math.round(+j.bilkoviny || 0), t: Math.round(+j.tuky || 0),
    };
  }
  const entryFrom = (a, ts, over = {}) => ({
    id: 'p' + Date.now() + Math.random().toString(36).slice(2, 6), n: a.name, q: 1, s: a.C, kcal: a.kcal, b: a.b, t: a.t,
    cs: 'ai-photo', jist: a.jist, sMin: a.sMin, sMax: a.sMax, sSd: a.sSd, meal: 'sv', ts, kat: a.kat, gi: a.gi, fat: a.fat,
    aiRaw: a.aiRaw, calF: a.factor, aiRuns: a.runs, pv: a.pv, ...(a.dishF && Math.abs(a.dishF - 1) > 0.005 ? { dishF: Math.round(a.dishF * 1000) / 1000 } : {}), ...(a.items?.length ? { items: a.items } : {}), ...(a.weighed ? { weighed: a.weighed } : {}), ...(a.alc ? { alc: true } : {}), ...over,
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
    const a0 = buildAi(job.result, job.ts, job.weighed), link = jobLink(job, a0), a = withDish(a0, link);
    const e = entryFrom(a, job.ts, { auto: true, ...(job.hint ? { n: job.hint, hint: job.hint } : {}), ...(job.facts?.length ? { facts: job.facts } : {}), ...(job.placeName ? { place: job.placeName } : {}) });
    commitLink(e, link);
    await storeEntry(e, job.thumb, job.img);
    K.toast(`Fotka z ${hhmm(job.ts)}: ${r0(a.C)} g — uloženo s odhadem AI${a.dishInfo ? ' a stejného jídla' : ''} (klepnutím upravíte)`);
  }

  // Uživatel opravil, co na fotce je (název, množství) → jeho popis platí, fotka doplní zbytek.
  // Upřesnění od uživatele (název, počet kusů, zvážená hmotnost, doma/restaurace) má přednost před fotkou —
  // přidané údaje mimo fotku chybu odhadu ve studiích snižují nejvíc.
  // Zvážené jídlo: AI hmotnost NEDOSTANE — odhadne porci naslepo (z toho se učí, jak u vás odhaduje porce),
  // zváženou hmotnost dosadí aplikace sama (LEARN.applyWeight).
  const hintPrompt = (h, facts, weighed) => (h || facts?.length || weighed?.what) ? [
    h ? `Uživatel upřesnil, co na fotce je: „${h}".` : '',
    weighed?.what ? `Uživatel zvážil složku „${weighed.what}" — hmotnost ti neříkáme, odhadni ji z fotky sám jako obvykle a uveď ji jako samostatnou složku.` : '',
    facts?.length ? `Doplňující údaje od uživatele: ${facts.join('; ')}.` : '',
    `Jeho údaje (druh jídla, počet kusů${(facts || []).some(f => /zváženo/.test(f)) ? ', hmotnost' : ''}, kde se jídlo připravovalo) ber jako přesné a vycházej z nich; fotku použij jen na to, co neříkají. Rozepiš jídlo na složky.`,
  ].filter(Boolean).join(' ') : undefined;
  const runArgs = (job, img) => ({ imageBase64: img, imageMedia: 'image/jpeg', extra: examplesText(), text: hintPrompt(job.hint, job.facts, job.weighed), pv: LEARN.PROMPT_V,
    diag: { flow: job.weighed ? 'photo-weighed' : job.hint || job.facts?.length ? 'photo-hint' : 'photo', job: job.id, attempt: job.attempts } });
  // Odpovědi, které nejdou přečíst (ani složky, ani součet), se nepočítají; když nezbude žádná, úloha se zopakuje.
  const usable = res => {
    if (!res?.runs) return res;
    const runs = res.runs.filter(r => LEARN.v2Totals(r.result) || isFinite(+r.result?.sacharidy));
    return runs.length ? { ...res, runs } : { error: 'parse' };
  };

  JOBS.register('carb-photo', {
    label: j => j.hint ? 'Oprava: ' + j.hint : 'Fotka jídla',
    run: job => {
      const plan = planFor(job);
      if (!(plan.gemini + plan.claude)) return { error: 'nokey' };
      return AI.callRuns(runArgs(job, job.img), plan, (k, n) => { if (pending?.jobId === job.id) progress(k, n); }).then(usable);
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
    const e = f.e, a0 = buildAi(job.result, e.ts, job.weighed);
    const link = e.dish ? { id: e.dish } : dishByName({ n: job.hint, keys: carbKeys(a0.items), loc: locOf(e.place, e.facts) }, e.id), a = withDish(a0, link, e.id);
    if (!e.dish) commitLink(e, link);
    Object.assign(e, { aiRaw: a.aiRaw, aiRuns: a.runs, kat: a.kat, fat: a.fat, kcal: a.kcal, b: a.b, t: a.t, jist: a.jist,
      sMin: a.sMin, sMax: a.sMax, sSd: a.sSd, calF: a.factor, hint: job.hint, pv: a.pv });
    if (a.weighed) e.weighed = a.weighed; else delete e.weighed;
    if (a.items?.length) e.items = a.items; else delete e.items;
    if (!e.giUser && a.gi) e.gi = a.gi;
    if (a.alc) e.alc = true; else delete e.alc;
    if (e.conf == null && !job.keepCarbs) {
      e.s = a.C;
      if (a.dishF && Math.abs(a.dishF - 1) > 0.005) e.dishF = Math.round(a.dishF * 1000) / 1000; else delete e.dishF;
    }
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
      const plan = planFor(job);
      if (!img) plan.claude = 0; // Claude na serveru potřebuje fotku
      if (!(plan.gemini + plan.claude)) return { error: 'nokey' };
      return AI.callRuns(img ? runArgs(job, img) : { text: hintPrompt(job.hint, job.facts, job.weighed), extra: examplesText(), pv: LEARN.PROMPT_V, diag: { flow: 'text-hint', job: job.id, attempt: job.attempts } }, plan).then(usable);
    },
    present: () => false, // výsledek se rovnou zapíše do jídla
    save: applyReest,
  });

  function fillForm(job) {
    const a0 = buildAi(job.result, job.ts, job.weighed), link = jobLink(job, a0), a = withDish(a0, link);
    pending.ai0 = a0; pending.link = link; pending.carbsTouched = false; pending.placeName = job.placeName || null;
    pending.ai = a; pending.filled = true; pending.hint = job.hint || null; pending.facts = job.facts || []; pending.weighed = job.weighed || null;
    renderFacts();
    pending.shownName = job.hint || a.name;
    $('#cnew-name').value = pending.shownName;
    $('#cnew-carbs').value = r0(a.C);
    $('#cnew-time').value = hhmm(job.ts);
    $('#cnew-units').value = '';
    $('#cnew-gi').value = a.gi || LEARN.giKey(LEARN.CATS[a.kat]?.dur <= 180 ? 'vysoký' : 'střední') || 'stredni';
    $$('.cnew-ins').forEach(x => x.classList.toggle('hidden', therapy().type === 'none'));
    $('#cnew-ai').innerHTML = aiHtml(a, job.ts);
    renderDishSheet();
    newConf();
    $('#cnew-status').textContent = '';
    $('#cnew-retry').classList.add('hidden');
    $('#cnew-form').classList.remove('hidden');
  }
  // Text pod odhadem: AI, kalibrace, jednotlivé běhy, složky, zvážení.
  function aiHtml(a, ts) {
    const calTxt = Math.abs(a.factor - 1) > 0.02
      ? ` → podle vašich ověřených jídel (${LEARN.CATS[a.kat].short}${Math.abs(a.blockFactor - 1) > 0.02 ? ', ' + LEARN.BLOCKS[LEARN.blockOf(ts)].label.split(' (')[0].toLowerCase() : ''}) ×${dec(Math.round(a.factor * 100) / 100)} = <b>${r0(a.aiRaw * a.factor)} g</b>` : '';
    // Po AI: „Gemini 48 g (5×: 44 · 47 · 48 · 50 · 55)“; u více AI i jejich váha.
    const E = a.E, multi = E.vendors.length > 1;
    const runsTxt = E.n > 1 || E.vendors.some(x => Math.abs(x.fix - 1) > 0.03) ? '<br><span class="muted small-text">' + E.vendors.map(x =>
      `${x.label} ${Math.abs(x.fix - 1) > 0.03 ? `${r0(x.raw)} → ${r0(x.c)} g (oprava podle vašich jídel)` : r0(x.c) + ' g'}${x.n > 1 ? ` (${x.n}×: ${x.values.map(r0).join(' · ')})` : ''}${multi ? ` · váha ${Math.round(x.share * 100)} %` : ''}`).join('<br>') + '</span>' : '';
    const itemsTxt = a.items?.length ? '<br><span class="muted small-text">Složky: ' + a.items.map(i => `${esc(i.n)} ~${i.g} g${i.c >= 1 ? ` (${r0(i.c)} g)` : ''}${i.vis ? '' : ' — nevidět, předpoklad'}`).join(' · ')
      + (a.dropped.length ? `<br>Nezapočteno (uvedl to jen menšinový odhad): ${a.dropped.map(d => esc(d.n)).join(', ')}` : '') + '</span>' : '';
    const failTxt = Object.entries(a.errors).map(([v, e]) =>
      `<br><span class="muted small-text">⚠️ ${LEARN.VENDOR_LABEL[v]} tentokrát neodpověděl: ${esc(AI.errMsg(e))}</span>`).join('');
    const alcTxt = a.alc ? '<br>🍷 Alkohol — glykémii ovlivní ještě hodiny, toto jídlo se nepoužije k učení.' : '';
    const wd = a.weighed, wPct = wd?.ai > 0 ? Math.round((wd.ai / wd.g - 1) * 100) : null;
    const wTxt = wd ? ` <b>· ⚖️ zváženo ${wd.g} g${wd.what ? ' (' + esc(wd.what) + ')' : ''} → ${r0(wd.c)} g sacharidů</b> (z váhy, bez kalibrace z fotek)`
      + (wd.disagree?.length ? `<br><b>⚠️ Claude a Gemini se neshodují na složkách: ${wd.disagree.map(esc).join(', ')} — zkontrolujte, co na talíři opravdu je (část vaší hmotnosti připadla i na ně).</b> Pokud tam nejsou, opravte název jídla; toto jídlo se k učení nepoužije.` : '')
      + (wd.ai > 0 ? `<br><span class="muted small-text">AI naslepo odhadla ${wd.what ? 'tuto složku' : 'porci'} na ~${wd.ai} g${Object.keys(wd.per).length > 1 ? ` (${Object.entries(wd.per).map(([v, g]) => `${LEARN.VENDOR_LABEL[v]} ${g} g`).join(' · ')})` : ''} — ${Math.abs(wPct) < 5 ? 'skoro přesně' : `o ${Math.abs(wPct)} % ${wPct < 0 ? 'méně' : 'víc'}`}.${wd.disagree?.length ? '' : ' Z porovnání s váhou se učí opravy jednotlivých AI.'}</span>` : '')
      : a.weighMiss ? `<br><b>⚠️ „${esc(a.weighMiss.what)}" není mezi složkami, které AI na fotce našla — hmotnost ${a.weighMiss.g} g nepoužita.</b> Upřesněte název (např. jak je v seznamu složek níže) přes „⚖️ zvážil jsem…", nebo zadejte hmotnost celého jídla.` : '';
    return `AI odhad: ${r0(a.aiRaw)} g${wTxt}${calTxt}${runsTxt}${itemsTxt}${failTxt}${alcTxt}${a.poznamka ? '<br>' + esc(a.poznamka) : ''}`;
  }
  // Stejné jídlo v okně: propojené (s tím, co to udělalo s odhadem), jinak návrhy k potvrzení.
  function renderDishSheet() {
    const box = $('#cnew-dish'), a = pending?.ai;
    if (!box || !a) return;
    if (pending.link) {
      const li = linkInfo(pending.link);
      box.innerHTML = `🔁 <b>Stejné jídlo jako „${esc(li.label)}"</b>${li.place ? ' · ' + esc(li.place) : ''} (${li.n}× dřív${pending.link.auto ? ', podle vašeho názvu' : ''})${dishTxt(a.dishInfo, a.C)} <button type="button" id="cnew-dish-off" class="linklike">není to ono</button>`;
      $('#cnew-dish-off').addEventListener('click', () => setDishLink(null));
      return;
    }
    const c = dishCands({ n: pending.shownName || a.name, keys: carbKeys(a.items), loc: locOf(pending.placeName, pending.facts) });
    box.innerHTML = c.length ? `🔁 Jedli jste už stejné jídlo? Propojené se porovná s minulými výskyty:<div class="chips">${c.map((g, i) => `<button type="button" class="chip" data-dish="${i}">${candLbl(g)}</button>`).join('')}</div>` : '';
    $$('#cnew-dish [data-dish]').forEach(b => b.addEventListener('click', () => { const g = c[+b.dataset.dish]; setDishLink({ id: g.id, with: g.with, ...(g.withAll ? { withAll: g.withAll } : {}) }); }));
  }
  async function setDishLink(link) {
    if (!pending?.ai0) return;
    pending.link = link;
    pending.ai = withDish(pending.ai0, link);
    if (!pending.carbsTouched) $('#cnew-carbs').value = r0(pending.ai.C);
    renderDishSheet(); newConf();
    const job = await JOBS.get(pending.jobId); // zavření okna uloží jídlo z úlohy → propojení musí být i v ní
    if (job) { job.dishLink = link; job.dishNo = !link; await JOBS.save(job); }
  }
  // Oprava názvu/množství nebo rychlé upřesnění v okně → nový odhad z téže fotky s údaji uživatele.
  async function rerun(changes, label) {
    if (!pending?.filled) return;
    const job = await JOBS.get(pending.jobId);
    if (!job) return;
    Object.assign(job, changes, { status: 'pending', result: null, nextAt: Date.now(), attempts: 0 });
    await JOBS.save(job);
    pending.filled = false; pending.ai = null;
    $('#cnew-form').classList.add('hidden');
    $('#cnew-status').textContent = `Přepočítávám podle „${label}"…`;
    JOBS.attempt(job.id);
  }
  async function reestimate() {
    const v = $('#cnew-name').value.trim();
    if (!pending?.filled || !v || v === pending.shownName) return;
    rerun({ hint: v }, v);
  }
  // Rychlá upřesnění: doma / restaurace, počet kusů, zvážená hmotnost.
  const PLACE = { doma: 'připraveno doma', restaurace: 'z restaurace nebo jídelny' };
  function renderFacts() {
    const f = pending?.facts || [], w = pending?.weighed;
    const shown = [...(w?.g > 0 ? [`zváženo ${w.g} g${w.what ? ' ' + w.what : ''}`] : []), ...f];
    $$('#cnew-facts .chip').forEach(b => b.classList.toggle('on', (!!PLACE[b.dataset.fact] && f.includes(PLACE[b.dataset.fact])) || (b.dataset.fact === 'vaha' && w?.g > 0)));
    $('#cnew-facts-list').innerHTML = shown.length ? `Upřesněno: ${shown.map(esc).join(' · ')} <button type="button" id="cnew-facts-clear" class="linklike">zrušit</button>` : '';
    $('#cnew-facts-clear')?.addEventListener('click', () => rerun({ facts: [], weighed: null, placeName: null }, 'bez upřesnění'));
  }
  $$('#cnew-facts .chip').forEach(b => b.addEventListener('click', () => {
    if (!pending?.filled) return;
    const k = b.dataset.fact, f = (pending.facts || []).filter(x => !PLACE[k] || (!Object.values(PLACE).includes(x) && !/^podnik: /.test(x)));
    if (PLACE[k]) {
      if ((pending.facts || []).includes(PLACE[k])) return rerun({ facts: f, placeName: null }, 'bez místa');
      f.push(PLACE[k]);
      // název podniku: podle něj se příště pozná stejné jídlo (a AI ví, odkud jídlo je)
      const pn = k === 'restaurace' ? (prompt('Název podniku? (nepovinné — podle něj se příště pozná stejné jídlo)', pending.placeName || '') || '').trim().slice(0, 60) : '';
      if (pn) f.push('podnik: ' + pn);
      return rerun({ facts: f, placeName: pn || null }, f.join('; '));
    }
    else if (k === 'vaha') {
      const t = prompt('Kolik gramů? Jen číslo = vše na fotce (bez talíře), nebo i čeho, např. „rýže 200“.');
      const m = /(\d+(?:[.,]\d+)?)/.exec(t || '');
      if (!m) return;
      const g = Math.round(K.num(m[1])), what = (t || '').replace(m[0], '').replace(/\bg\b/i, '').trim().slice(0, 60);
      return rerun({ weighed: { g, what } }, `zváženo ${g} g${what ? ' ' + what : ''}`);
    } else {
      const t = prompt('Kolik kusů čeho? (např. „4 plátky knedlíku“, „2 krajíce chleba“)');
      if (!t || !t.trim()) return;
      f.push('počet kusů: ' + t.trim().slice(0, 80));
    }
    rerun({ facts: f }, f.join('; '));
  }));
  $('#cnew-name').addEventListener('change', reestimate);
  $('#cnew-name').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); $('#cnew-name').blur(); } });

  function newConf() {
    if (!pending?.ai) return;
    const C = K.num($('#cnew-carbs').value);
    const a = pending.ai;
    const r = CONF.entrySigma({ C, kind: a.weighed ? 'ai-weighed' : 'ai-photo', jist: a.jist, sMin: a.sMin, sMax: a.sMax, sSd: a.sSd, learnedSd: cal().sd });
    const p = CONF.probWithin(r.sigma, K.TOL());
    $('#cnew-conf').innerHTML = `Jistota na ±${K.TOL()} g: ${K.badge(p)} · nejspíš ${r0(Math.max(0, C - CONF.Z90 * r.sigma))}–${r0(C + CONF.Z90 * r.sigma)} g${K.vjTxt(C)}`
      + (r.driver === 'spread' ? '<br>💡 ' + CONF.TIP.spread
        : cal().sd ? '<br>Počítá s vaší ověřenou přesností AI (±' + r0(cal().sd * 100) + ' %).' : '');
  }
  $('#cnew-carbs').addEventListener('input', () => { if (pending) pending.carbsTouched = true; newConf(); });

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
    const a = pending.ai, id = pending.jobId, thumb = pending.thumb, hint = pending.hint, link = pending.link, place = pending.placeName;
    const img = (await JOBS.get(id))?.img;
    const ts = tsFromTime(pending.ts, $('#cnew-time').value);
    const units = K.num($('#cnew-units').value);
    const C = K.num($('#cnew-carbs').value);
    const e = entryFrom(a, ts, { n: $('#cnew-name').value.trim() || 'Jídlo', s: C, gi: $('#cnew-gi').value || a.gi, ...(hint ? { hint } : {}), ...(pending.facts?.length ? { facts: pending.facts } : {}), ...(place ? { place } : {}) });
    if (units > 0) e.units = units;
    commitLink(e, link);
    if (Math.abs(C - a.C) > 0.5) delete e.dishF; // přepsané číslo platí, jak je
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

  function chartSVG(e, readings, boluses, meter = []) {
    if (!readings.length && !meter.length) return '';
    const W = 340, H = 150, L = 30, R = 8, T = 8, B = 22;
    const span = LEARN.postFor(asMeal(e)) / MIN, WIN = span * MIN;
    const xs = m => L + (W - L - R) * (m + 30) / (span + 30);
    const vals = [...readings.map(r => r.v), ...meter.map(r => r.v)];
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
    const mdots = meter.filter(r => r.t >= e.ts - PRE && r.t <= e.ts + WIN).map(r => `<circle cx="${xs((r.t - e.ts) / MIN).toFixed(1)}" cy="${ys(r.v).toFixed(1)}" r="3.6" class="bg-meter"/>`).join('');
    return `<svg class="bg-chart" viewBox="0 0 ${W} ${H}">${band}${base}${meal}${others}<polyline points="${pts}" class="bg-line"/>${dots}${mdots}${bol}${ticksX}${ticksY}</svg><div class="muted small-text center">minuty od jídla · glykémie v ${uLbl()} · pás = 3,9–10 mmol/l</div>`;
  }

  const QLBL = { good: 'dobrá', fair: 'střední', poor: 'slabá', none: '—' };
  // Kde průběh glykémie nesedí s modelem (LEARN: misfit = { kind, t, d } v mmol/l, d > 0 = výš než model).
  function misfitTxt(m) {
    const v = x => `${fmtBG(Math.abs(x))} ${uLbl()}`;
    switch (m.kind) {
      case 'late-rise': return `glykémie znovu stoupla kolem ${hhmm(m.t)} — o ~${v(m.d)} víc, než model čekal (pozdní vlna: tuk, bílkoviny, pomalé sacharidy — nebo jídlo, které tu není)`;
      case 'early-high': return `vrchol kolem ${hhmm(m.t)} byl o ~${v(m.d)} vyšší, než model čekal (rychlejší vstřebání, nebo víc sacharidů)`;
      case 'early-low': return `vzestup kolem ${hhmm(m.t)} byl o ~${v(m.d)} menší, než model čekal (pomalejší vstřebání, nebo méně sacharidů)`;
      case 'late-low': return `kolem ${hhmm(m.t)} glykémie klesla o ~${v(m.d)} víc, než model čekal (víc účinného inzulinu, nebo pohyb)`;
      case 'jump': return `kolem ${hhmm(m.t)} hodnota senzoru skočila o ${v(m.d)} během pár minut (spíš chyba senzoru — stlačení, kalibrace)`;
      default: return `největší odchylka ~${v(m.d)} kolem ${hhmm(m.t)}`;
    }
  }
  function renderMeal(e, w, thumb) {
    const c = K.entryConf(e);
    const ev = e.ev;
    let h = '';
    if (thumb) h += `<img class="cmeal-photo" src="${thumb.data}" alt="">`;
    h += `<div class="cmeal-head"><div class="ctl-name">${esc(e.n)}</div><div class="e-carb"><span class="e-kcal">${K.fmtC(c.C)}</span>${K.badge(c.p)}</div></div>`;
    if (e.aiRaw != null) h += `<div class="muted small-text">AI odhad ${r0(e.aiRaw)} g${e.calF && Math.abs(e.calF - 1) > 0.02 ? ' · s vaší kalibrací ×' + dec(Math.round(e.calF * 100) / 100) : ''}${e.dishF ? ' · podle stejného jídla ×' + dec(Math.round(e.dishF * 100) / 100) : ''} · zapsáno ${K.fmtC(e.s)}${e.place ? ' · ' + esc(e.place) : ''}</div>`;
    if (e.items?.length) h += `<div class="muted small-text">Složky: ${e.items.map(i => `${esc(i.n)} ~${i.g} g${i.c >= 1 ? ` (${r0(i.c)} g)` : ''}${i.vis ? '' : ' — předpoklad'}`).join(' · ')}${e.facts?.length ? `<br>Upřesněno: ${e.facts.map(esc).join(' · ')}` : ''}</div>`;

    if (e.cs === 'ai-photo' && e.ts) {
      h += chartSVG(e, w.readings || [], w.boluses || [], w.meter || []);
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
      if (ev?.dur) h += `<div class="ev-metrics">Vstřebávání: ${LEARN.GI_LABEL[ev.gi] || 'podle druhu jídla'}${catTail(e.kat) ? ` + pozdní vlna ~${Math.round(catTail(e.kat) * 100)} % (naučeno pro ${LEARN.CATS[LEARN.catKey(e.kat)].short})` : ''}${ev.absorbed != null ? ` — do konce okna ~${Math.round(ev.absorbed * 100)} %` : ''}.</div>`;
      if (ev?.fit?.used) {
        const sp = ev.fit.speed, pct = Math.round(Math.abs(sp - 1) * 100);
        h += `<div class="ev-metrics">📈 Průběh glykémie u tohoto jídla odpovídá modelu (odchylka ±${fmtBG(ev.fit.rmse)} ${uLbl()}); jídlo se u vás vstřebávalo ${sp > 1.08 ? `o ~${pct} % rychleji` : sp < 0.93 ? `o ~${pct} % pomaleji` : 'obvyklou rychlostí'}${ev.fit.informative ? ' — aplikace si to pamatuje pro podobná jídla' : ''}.</div>`;
      }
      if (ev?.heavy) h += `<div class="ev-metrics">🧈 Hodně tuku a bílkovin (~${dec(K.r1(ev.fpu))} FPU) — vyhodnoceno 4 h, jejich pozdní vliv (~${r0(ev.fpuCarbs)} g „sacharidů") je započten zvlášť.</div>`;
      else if (ev?.fpuCarbs > 3) h += `<div class="ev-metrics">🧈 Tuk a bílkoviny přidaly v okně ~${r0(ev.fpuCarbs)} g „sacharidů" — započteno zvlášť.</div>`;
      const wEnd = e.ts + LEARN.postFor(asMeal(e)), pendingWin = Date.now() < wEnd;
      if (e.weighed && !pendingWin) {
        const dF = e.dishF && e.weighed.c > 0 ? `z váhy ~${r0(e.weighed.c)} g, podle dřívějších výskytů stejného jídla ×${dec(Math.round(e.dishF * 100) / 100)} = ${r0(e.s)} g` : `${r0(e.s)} g`;
        h += `<div class="ev-box">⚖️ Zváženo ${e.weighed.g} g${e.weighed.what ? ' (' + esc(e.weighed.what) + ')' : ''} → ${dF} sacharidů. Slouží jako známé množství — glykémie ho neopravuje, ale ukáže, jak k němu sedí inzulin.</div>`;
        const ck = ev?.check;
        if (ck && LEARN.REL_SD[ck.quality]) {
          const p = Math.round(Math.abs(ck.ratio - 1) * 100);
          h += `<div class="ev-metrics">💉 Kontrola inzulinu: se ${e.dishF ? 'zapsanými' : 'zváženými'} ${r0(e.s)} g se glykémie chovala jako u ~${r0(ck.implied)} g (±${Math.round(ck.relSd * 100)} %) — ${ck.ratio > 1.1 ? `inzulin k jídlu pokryl o ~${p} % méně, než počítá nastavení pumpy` : ck.ratio < 0.9 ? `inzulin k jídlu pokryl o ~${p} % víc, než počítá nastavení pumpy` : 'inzulin k jídlu odpovídal nastavení pumpy'}.</div>`;
        } else if (ev && !ev.check) h += `<div class="muted small-text">Kontrola inzulinu: ${esc((ev.flags || []).filter(f => !/zvážené/.test(f)).join(', ') || 'zatím bez dat')}.</div>`;
      } else if (ev?.implied && LEARN.REL_SD[ev.quality]) {
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
        h += `<div class="ev-box">Výpočet z glykémie dává ~${r0(ev.implied)} g, ale k učení sacharidů se toto jídlo nepoužije: ${esc(ev.flags.filter(f => /nepoužito|rychle měnila|nedají se/.test(f)).join(', ') || ev.flags.join(', '))}.${ev.misfit ? `<br>Kde to nesedí: ${misfitTxt(ev.misfit)}.` : ''}</div>`;
      } else {
        h += `<div class="ev-box">Zatím nelze ověřit: ${esc((ev?.flags || ['chybí data z CGM']).join(', '))}.</div>`;
      }
      if (ev?.flags?.length && ev.implied && ev.quality !== 'poor') h += `<div class="muted small-text">Pozn.: ${esc(ev.flags.join(' · '))}</div>`;
      // Model průběh nevysvětlil → zeptat se proč: odpověď rozhodne, čemu se model naučí
      if (ev?.misfit && ev.final && e.conf == null && !pendingWin) {
        if (e.why) {
          h += `<div class="ev-metrics">Co se stalo: ${WHY[e.why]?.lbl || e.why}${e.why === 'nic' ? ' — model se z jídla učí, jak rychle a v jakém tvaru se tento druh jídla u vás vstřebává' : e.why === 'snack' ? ' — doplněné jídlo se započítá' : ' — jídlo je vyřazené z učení'} · <button type="button" id="cm-why-undo" class="linklike">změnit</button></div>`;
        } else if (!e.excl) {
          const st = ev.unlogged ? ev.unlogged.t : ev.misfit.t - (ev.misfit.kind === 'late-rise' ? 60 : 30) * MIN;
          h += `<div class="ev-box">Co se stalo? Odpověď pomůže modelu učit se správnou věc.
            <div class="chips">${Object.entries(WHY).map(([k, w]) => `<button type="button" class="chip" data-why="${k}">${w.lbl}</button>`).join('')}</div>
            <div id="cm-why-snack" class="ev-actions hidden"><input id="cm-ws-g" type="text" inputmode="decimal" placeholder="g"><span class="unit">g v</span><input id="cm-ws-t" type="time" value="${hhmm(Math.max(e.ts, st))}"><button id="cm-ws-add" class="btn slim">Zapsat</button></div></div>`;
        }
      }

      // Výpadek senzoru: měření z glukometru u jídla (stačí před jídlem a 2–3 h po posledním jídle)
      const cgmGap = ev?.meter || /glukometr|málo hodnot z CGM|málo měření|chybí glykémie/.test((ev?.flags || []).join(' '));
      if (therapy().type !== 'none' && e.conf == null && cgmGap) {
        const near = (w.meter || []).filter(r => r.t >= e.ts - 45 * MIN && r.t <= e.ts + 5 * 60 * MIN).sort((a, b) => a.t - b.t);
        const hasPre = near.some(r => r.t <= e.ts + 10 * MIN), hasPost = near.some(r => r.t >= e.ts + 100 * MIN);
        const sug = !hasPre ? e.ts - 5 * MIN : !hasPost ? e.ts + 120 * MIN : e.ts + 180 * MIN;
        h += `<div class="ev-box">🩸 Glukometr u tohoto jídla: ${near.length ? near.map(r => `<b>${fmtBG(r.v)}</b> v ${hhmm(r.t)}`).join(' · ') : 'zatím nic'}.
          <div class="ev-actions"><input id="cm-m-v" type="text" inputmode="decimal" placeholder="${uLbl()}"><input id="cm-m-t" type="time" value="${hhmm(sug)}"><button id="cm-m-add" class="btn slim">Přidat</button></div>
          <div class="muted small-text">Senzor tehdy nesnímal. K vyhodnocení stačí hodnota těsně před jídlem a aspoň jedna 2–3 h po posledním jídle (lepší dvě) — výsledek je hrubší než z CGM.</div></div>`;
      }
      // Ruční doplnění, když CGM data chybí (léčba bez inzulinu — jednoduchý výpočet z rozdílu)
      if (!pendingWin && !(ev?.n > 0) && e.conf == null && therapy().type === 'none') {
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
      if (e.conf != null) {
        h += `<div class="ev-box ok">✓ Potvrzeno: ${r0(e.conf)} g — jídlo se používá k učení s plnou vahou.</div>`;
        const ck = ev?.check;
        if (ck && LEARN.REL_SD[ck.quality]) {
          const p = Math.round(Math.abs(ck.ratio - 1) * 100);
          h += `<div class="ev-metrics">💉 Kontrola inzulinu: se známými ${r0(e.conf)} g se glykémie chovala jako u ~${r0(ck.implied)} g (±${Math.round(ck.relSd * 100)} %) — ${ck.ratio > 1.1 ? `inzulin k jídlu pokryl o ~${p} % méně, než počítá nastavení pumpy` : ck.ratio < 0.9 ? `inzulin k jídlu pokryl o ~${p} % víc, než počítá nastavení pumpy` : 'inzulin k jídlu odpovídal nastavení pumpy'}. Souhrn podle denní doby je v Učení.</div>`;
        }
        h += `<button id="cm-unconf" class="btn btn-ghost slim">Zrušit potvrzení</button>`;
      }
      else if (e.excl) h += `<div class="ev-box">Vyřazeno z učení (${esc(e.excl)}).</div><button id="cm-unexcl" class="btn btn-ghost slim">Vrátit do učení</button>`;
      else h += `<div class="ev-actions excl"><select id="cm-excl-why"><option>pohyb nebo sport</option><option>nemoc nebo stres</option><option>jídlo navíc, které tu není</option><option>chyba senzoru</option><option>jiné</option></select><button id="cm-excl" class="btn btn-ghost slim">Vyřadit z učení</button></div>`;
      h += '<div id="cm-dish"></div>';
    }

    h += `<details class="conf-how"><summary>Upravit nebo smazat</summary>
      <label class="field">Název<input id="cm-name" type="text" value="${esc(e.n)}"></label>
      ${e.cs === 'ai-photo' ? `<label class="field">Podnik <span class="muted">— nepovinné, podle něj se pozná stejné jídlo</span><input id="cm-place" type="text" list="place-list" value="${esc(e.place || '')}"></label>` : ''}
      <div class="tri-row"><label class="field">Sacharidy (g)<input id="cm-carbs" type="text" inputmode="decimal" value="${dec(K.r1(e.s))}"></label>
      <label class="field">Čas<input id="cm-time" type="time" value="${e.ts ? hhmm(e.ts) : ''}"></label></div>
      <label class="field">Rychlost vstřebání<select id="cm-gi"><option value="">podle druhu jídla</option>${Object.entries(LEARN.GI_LABEL).map(([k, l]) => `<option value="${k}"${LEARN.giKey(e.gi) === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="btn-row"><button id="cm-del" class="btn btn-danger-ghost">Smazat</button><button id="cm-save" class="btn grow">Uložit změny</button></div></details>
      <p class="muted small-text" style="margin-top:10px">Zpětný výpočet z glykémie je orientační (pohyb, stres, tuk a automatika pumpy ho ovlivňují). Nenahrazuje doporučení diabetologa k dávkování inzulinu.</p>`;
    $('#cmeal-body').innerHTML = h;
    bindMeal(e);
    fillPlaces();
    renderDishPanel(e);
  }

  // Detail jídla: dřívější výskyty stejného jídla — jejich křivky přes sebe a čísla (jen popis, ne dávkování);
  // nepropojené jídlo → návrhy k propojení.
  function dishChartSVG(rows0, selfId) {
    const rows = rows0.filter(r => r.readings.length), vals = rows.flatMap(r => r.readings.map(x => x.v));
    if (!vals.length) return '';
    const W = 340, H = 150, L = 30, R = 8, T = 8, B = 22;
    const span = Math.max(...rows.map(r => LEARN.postFor(asMeal(r.e)) / MIN));
    const xs = m => L + (W - L - R) * (m + 30) / (span + 30);
    const lo = Math.min(3.5, ...vals) - 0.3, hi = Math.max(11, ...vals) + 0.5;
    const ys = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    const band = `<rect x="${L}" y="${ys(10).toFixed(1)}" width="${W - L - R}" height="${(ys(3.9) - ys(10)).toFixed(1)}" class="bg-band"/>`;
    const meal = `<line x1="${xs(0)}" x2="${xs(0)}" y1="${T}" y2="${H - B}" class="bg-meal"/>`;
    const cls = (r, i) => (r.e.id === selfId ? 'dl0' : 'dl' + Math.min(4, i + (rows[0].e.id === selfId ? 0 : 1)));
    const lines = rows.map((r, i) => `<polyline points="${r.readings.filter(x => x.t <= r.e.ts + span * MIN).map(x => xs((x.t - r.e.ts) / MIN).toFixed(1) + ',' + ys(x.v).toFixed(1)).join(' ')}" class="bg-line ${cls(r, i)}"/>`).reverse().join('');
    const ticksX = [-30, 0, 60, 120, ...(span > 150 ? [180] : []), span].map(m => `<text x="${xs(m)}" y="${H - 6}" class="bg-tick" text-anchor="${m === span ? 'end' : m === -30 ? 'start' : 'middle'}">${m === 0 ? '0' : (m > 0 ? '+' : '') + m}</text>`).join('');
    const ticksY = [4, 7, 10].filter(v => v > lo && v < hi).map(v => `<text x="${L - 4}" y="${ys(v) + 3}" class="bg-tick" text-anchor="end">${fmtBG(v)}</text>`).join('');
    const legend = rows.map((r, i) => `<span><i class="dl-key ${cls(r, i)}"></i>${r.e.id === selfId ? 'toto jídlo' : dmy(r.e.ts) + ' ' + hhmm(r.e.ts)}</span>`).join('');
    return `<svg class="bg-chart" viewBox="0 0 ${W} ${H}">${band}${meal}${lines}${ticksX}${ticksY}</svg><div class="cv-legend">${legend}</div>`;
  }
  function occRow(x) {
    const ev = x.ev, lab = x.conf != null ? `✓ ${r0(x.conf)} g` : x.weighed ? `⚖️ ${r0(x.s)} g${ev?.check?.implied && qOk(ev.check.quality) ? `, glykémie ~${r0(ev.check.implied)} g` : ''}`
      : ev?.implied && qOk(ev.quality) ? `glykémie ~${r0(ev.implied)} g` : 'bez ověření';
    const ins = ev?.del?.meal > 0.05 ? ` · bolus ${dec(K.r1(ev.del.meal))} U` : ev?.units > 0 ? ` · inzulin ${dec(K.r1(ev.units))} U` : '';
    return `<button class="learn-row learn-open" data-id="${x.id}"><span>${dmy(x.ts)} ${hhmm(x.ts)}${x.place ? ' · ' + esc(x.place) : ''}<br><span class="muted small-text">zapsáno ${r0(x.s)} g${ins}${ev?.peak != null ? ` · max ${fmtBG(ev.peak)}` : ''}${ev?.tAbove10 ? ` · nad 10 ${ev.tAbove10} min` : ''}${x.excl ? ' · vyřazeno z učení' : ''}</span></span><b>${lab}</b></button>`;
  }
  async function renderDishPanel(e) {
    const box = $('#cm-dish');
    if (!box) return;
    const after = () => { K.saveAll(); invalidate(); touchData(); openMeal(e.id); };
    const all = dishMembers(e.dish), others = all.filter(x => x.id !== e.id).sort((p, q) => q.ts - p.ts);
    if (!others.length) {
      const c = dishCands(dishDesc(e), e.id);
      box.innerHTML = c.length ? `<div class="ev-box">🔁 Je to stejné jídlo jako dřív? Propojená jídla se porovnávají — další odhad se upraví podle toho, jak u vás dopadla minule.<div class="chips">${c.map((g, i) => `<button type="button" class="chip" data-dl="${i}">${candLbl(g)}</button>`).join('')}</div></div>` : '';
      $$('#cm-dish [data-dl]').forEach(b => b.addEventListener('click', () => { const g = c[+b.dataset.dl]; commitLink(e, { id: g.id, with: g.with, withAll: g.withAll }); after(); K.toast('Propojeno — porovná se s minulými výskyty'); }));
      return;
    }
    const d = LEARN.dishFactor(all.map(dishResid).filter(Boolean), Date.now()), pct = Math.round(Math.abs(d.f - 1) * 100);
    const dd = e.weighed && !e.weighed.what ? LEARN.dishFactor(all.map(densResid).filter(Boolean), Date.now()) : null;
    const next = !d.n ? 'Zatím žádný výskyt ověřený glykémií — oprava se začne učit s prvním ověřeným.'
      : pct < 2 ? `Podle ${d.n} ${d.n === 1 ? 'ověřeného výskytu' : 'ověřených výskytů'} AI s vaší kalibrací u tohoto jídla odhaduje správně.`
        : `Podle ${d.n} ${d.n === 1 ? 'ověřeného výskytu' : 'ověřených výskytů'} má toto jídlo o ~${pct} % ${d.f > 1 ? 'víc' : 'méně'} sacharidů, než AI s vaší kalibrací odhaduje — příští fotka se upraví ×${dec(Math.round(d.f * 100) / 100)}.`;
    const dens = dd?.n ? ` Zvážené: na gram o ~${Math.round(Math.abs(dd.f - 1) * 100)} % ${dd.f > 1 ? 'víc' : 'méně'} sacharidů, než počítá AI (${dd.n}×).` : '';
    const sh = dishShapeOf(e), shTxt = sh && (sh.nSpeed || sh.nTail) ? ` Křivka: ${sh.nSpeed ? (sh.speed > 1.05 ? `vstřebává se rychleji (×${dec(sh.speed)})` : sh.speed < 0.95 ? `vstřebává se pomaleji (×${dec(sh.speed)})` : 'obvyklá rychlost') : ''}${sh.nTail && sh.tail >= 0.05 ? `${sh.nSpeed ? ', ' : ''}pozdní vlna ~${Math.round(sh.tail * 100)} %` : ''} — počítá se při vyhodnocení.` : '';
    const more = dishCands(dishDesc(e), e.id, { skipDish: e.dish }); // podobná jídla mimo skupinu → sloučit
    box.innerHTML = `<div class="ev-box">🔁 <b>Stejné jídlo — ${others.length}× dřív</b><br>${next}${dens}${shTxt}<div id="cm-dish-chart" class="muted small-text">Načítám křivky…</div>
      ${others.slice(0, 6).map(occRow).join('')}
      ${more.length ? `<div class="muted small-text" style="margin-top:8px">Podobná jídla zatím mimo — jsou taky stejná?</div><div class="chips">${more.map((g, i) => `<button type="button" class="chip" data-dm="${i}">${candLbl(g)}</button>`).join('')}</div>` : ''}
      <div class="ev-actions"><button type="button" id="cm-dish-off" class="btn btn-ghost slim">Není to stejné jídlo</button></div>
      <div class="muted small-text">Jen srovnání z vašich dat — ne doporučení k dávkování.</div></div>`;
    $('#cm-dish-off').addEventListener('click', () => { delete e.dish; after(); }); // dishF zůstává: popisuje, co je v zapsaném čísle
    $$('#cm-dish [data-dm]').forEach(b => b.addEventListener('click', () => { for (const x of more[+b.dataset.dm].members) x.dish = e.dish; after(); K.toast('Propojeno se stejným jídlem'); }));
    $$('#cm-dish .learn-open').forEach(b => b.addEventListener('click', () => openMeal(b.dataset.id)));
    const show = [e, ...others.filter(x => x.ts < Date.now() - 30 * MIN).slice(0, 4)];
    const rows = await Promise.all(show.map(async x => ({ e: x, readings: await CGM.range('cgm', x.ts - PRE, x.ts + LEARN.postFor(asMeal(x))).catch(() => []) })));
    if (openId !== e.id || !$('#cm-dish-chart')) return;
    $('#cm-dish-chart').outerHTML = dishChartSVG(rows, e.id) || '<div class="muted small-text">Křivky z CGM k těmto jídlům chybí.</div>';
  }

  function bindMeal(e) {
    const after = () => { K.saveAll(); invalidate(); touchData(); openMeal(e.id); };
    $('#cm-confirm')?.addEventListener('click', () => {
      const raw = $('#cm-conf').value.trim(), v = K.num(raw);
      if (!raw || !(v >= 0)) { K.toast('Zadejte skutečné množství z obalu nebo vážení'); return; }
      if (e.sPre == null) e.sPre = e.s; // co bylo zapsané (a šlo do pumpy) před potvrzením
      e.conf = v; e.s = v; delete e.auto; after(); K.toast('Potvrzeno — aplikace se z toho učí');
    });
    $('#cm-unconf')?.addEventListener('click', () => { delete e.conf; after(); });
    $('#cm-excl')?.addEventListener('click', () => { e.excl = $('#cm-excl-why').value; after(); });
    $('#cm-unexcl')?.addEventListener('click', () => { delete e.excl; if (WHY[e.why]?.excl) delete e.why; after(); });
    // „Co se stalo?"
    $$('#cmeal-body [data-why]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.why;
      if (k === 'snack') { $('#cm-why-snack').classList.remove('hidden'); $('#cm-ws-g').focus(); return; }
      e.why = k;
      if (WHY[k].excl) e.excl = WHY[k].excl;
      after();
    }));
    $('#cm-ws-add')?.addEventListener('click', () => {
      const g = K.num($('#cm-ws-g').value);
      if (!(g > 0)) { K.toast('Zadejte sacharidy'); return; }
      const ts = tsFromTime(e.ts, $('#cm-ws-t').value);
      K.day(K.dstr(new Date(ts))).e.push({ id: 'm' + Date.now(), n: 'Doplněné jídlo', q: 1, s: g, cs: 'manual', ts, meal: 'sv' });
      e.why = 'snack';
      after(); K.toast(`Zapsáno: ${r0(g)} g v ${hhmm(ts)} — jídla kolem se přepočítají`);
    });
    $('#cm-why-undo')?.addEventListener('click', () => { if (WHY[e.why]?.excl && e.excl === WHY[e.why].excl) delete e.excl; delete e.why; after(); });
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
    $('#cm-m-add')?.addEventListener('click', async () => {
      const ts = tsFromTime(e.ts, $('#cm-m-t').value);
      if (ts > Date.now() + 5 * MIN) { K.toast('Čas je v budoucnosti'); return; }
      if (await saveMeter($('#cm-m-v').value, ts)) { delete e.ev; K.saveAll(); openMeal(e.id); }
    });
    $('#cm-units-save')?.addEventListener('click', () => { const u = K.num($('#cm-units').value); if (u > 0) e.units = u; else delete e.units; after(); });
    $('#cm-save')?.addEventListener('click', async () => {
      const f = findEntry(e.id);
      const newName = $('#cm-name').value.trim(), renamed = !!newName && newName !== e.n;
      const carbsEdited = K.num($('#cm-carbs').value) !== K.r1(e.s);
      e.n = newName || e.n;
      e.s = K.num($('#cm-carbs').value);
      if (carbsEdited) delete e.dishF;
      if ($('#cm-place')) { const p = $('#cm-place').value.trim().slice(0, 60); if (p) e.place = p; else delete e.place; }
      if ($('#cm-gi')) { if ($('#cm-gi').value) { if ($('#cm-gi').value !== LEARN.giKey(e.gi)) e.giUser = true; e.gi = $('#cm-gi').value; } else { delete e.gi; delete e.giUser; } }
      if (renamed && e.cs === 'ai-photo') {
        await JOBS.add({ kind: 'carb-reest', ts: e.ts, entryId: e.id, hint: newName, keepCarbs: carbsEdited, facts: e.facts, weighed: e.weighed, thumb: (await CGM.get('thumbs', e.id).catch(() => null))?.data });
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

  /* ─── Souhrny dnů pro „Vývoj po týdnech" a „Co chybuje podle denní doby" (cache kal.cvStats) ─── */
  const STATS_V = 2; // v23: + korekce nalačno (citlivost)
  let statsBusy = false;
  const midnight = ds => { const [y, m, d] = ds.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
  async function ensureDayStats(days = 56) {
    if (statsBusy || !K.isCarb()) return 0;
    statsBusy = true;
    let made = 0;
    try {
      let st = K.store.get('kal.cvStats', null);
      if (!st || st.v !== STATS_V) st = { v: STATS_V, days: {} };
      const t0 = midnight(K.todayStr()), clAt = K.store.get('kal.clImport', null)?.at || 0, all = mealsWithTime();
      const thSig = JSON.stringify([therapy().segs || [], therapy().insulin]);
      for (let i = 1; i <= days; i++) {
        const ds = K.dstr(new Date(t0 - i * DAY + 12 * 3600e3)), from = midnight(ds);
        const [y, mo, d] = ds.split('-').map(Number), to = new Date(y, mo - 1, d + 1).getTime();
        const sig = all.filter(e => e.ts >= from - 6 * 3600e3 && e.ts < to).map(e => `${e.id}:${r0(e.s)}:${e.conf ?? ''}:${e.ev?.implied ? r0(e.ev.implied) : ''}`).join('|') + '#' + clAt + '#' + thSig;
        const old = st.days[ds];
        if (old && old.sig === sig && (i > 2 || Date.now() - old.at < 60 * MIN)) continue;
        const dd = await dayData(from, to);
        if (dd.readings.filter(r => r.t >= from && r.t < to).length < 72) st.days[ds] = { sig, at: Date.now(), none: true };
        else {
          const corr = LEARN.correctionEpisodes({ from, to, ...dd, tp: therapy().insulin === 'ultra' ? 55 : 75 })
            .map(e => ({ t: e.t, own: e.own, dose: e.dose, bg0: e.bg0, dBG: e.dBG, E: e.E, isf: e.isf }));
          st.days[ds] = { sig, at: Date.now(), from, ...LEARN.dayStatsOf(LEARN.dayCurves({ from, to, ...dd }), dd.readings, from, to, dd.targets), corr };
        }
        made++;
      }
      for (const k of Object.keys(st.days)) if (midnight(k) < t0 - (days + 7) * DAY) delete st.days[k];
      const ps = await CGM.range('pumpset', Date.now() - 60 * DAY, Date.now() + DAY).catch(() => []);
      const sa = makeSettingsAt(ps);
      st.set = {};
      for (const [k, hr] of [['rano', 7], ['den', 13], ['vecer', 20]]) { const x = sa(t0 + hr * 3600e3); if (x) st.set[k] = x; }
      const isfs = [3, 7, 13, 20].map(hr => sa(t0 + hr * 3600e3)?.isf).filter(x => x > 0);
      st.isfSet = isfs.length ? isfs.sort((a, b) => a - b)[isfs.length >> 1] : null;
      K.store.set('kal.cvStats', st);
    } catch (err) { console.warn('dayStats', err); }
    finally { statsBusy = false; }
    return made;
  }
  const weekLbl = start => { const a = new Date(start), b = new Date(start + 6.5 * DAY); return `${a.getDate()}. ${a.getMonth() + 1}. – ${b.getDate()}. ${b.getMonth() + 1}.`; };
  function trendCards(all, now) {
    const st = K.store.get('kal.cvStats', null);
    const ds = st?.v === STATS_V ? Object.values(st.days).filter(d => !d.none) : [];
    let h = '<div class="card"><div class="card-title">Vývoj po týdnech</div>';
    const wk = LEARN.weeklyTrend(ds).slice(0, 8);
    if (!wk.length) h += `<p class="muted">${st ? 'Zatím málo dní s daty z CGM.' : 'Počítám z uložených dat…'}</p>`;
    else {
      const withM = wk.filter(w => w.mae != null);
      if (withM.length >= 2) {
        const [a, b] = withM, d = a.mae - b.mae;
        h += `<p>Předpověď ze zápisu: ±${fmtBG(b.mae)} → <b>±${fmtBG(a.mae)} ${uLbl()}</b> (${Math.abs(d) < 0.1 ? 'beze změny' : d < 0 ? 'zlepšení' : 'zhoršení'} proti předchozímu týdnu) · v rozmezí ${Math.round(b.tir * 100)} → <b>${Math.round(a.tir * 100)} %</b>.</p>`;
      }
      h += wk.map(w => `<div class="learn-row"><span>${weekLbl(w.start)}<br><span class="muted small-text">${w.days} ${w.days === 1 ? 'den' : w.days < 5 ? 'dny' : 'dní'} · v rozmezí ${Math.round(w.tir * 100)} % · pod 3,9: ${Math.round(w.low * 100)} % · variabilita ${Math.round(w.cv * 100)} %</span></span><b>${w.mae != null ? `±${fmtBG(w.mae)} → ±${fmtBG(w.maeFit)}` : '—'}</b></div>`).join('');
      h += `<p class="muted small-text">Vpravo: o kolik se u jídel lišila předpověď ze zapsaných sacharidů a inzulinu od CGM → po přepočtu sacharidů z glykémie (${uLbl()}). Učení stahuje první číslo k druhému; druhé je to, co model zatím nevysvětlí (inzulin, bazál, pohyb, náhoda). Obvyklé cíle: v rozmezí 3,9–10 přes 70 % času, pod 3,9 méně než 4 %, variabilita (CV) do 36 %.</p>`;
    }
    h += '</div>';

    // Co chybuje podle denní doby (posledních 28 dní)
    const since = now - 28 * DAY;
    const meals = all.filter(e => e.ts >= since && !e.excl && e.aiRaw && !e.weighed).map(e => {
      if (e.conf != null) return { ts: e.ts, logged: e.sPre ?? e.aiRaw * (e.calF || 1), label: e.conf };
      if (e.ev?.implied && (e.ev.quality === 'good' || e.ev.quality === 'fair')) return { ts: e.ts, logged: e.s, label: e.ev.implied };
      return null;
    }).filter(Boolean);
    const checks = all.filter(e => e.ts >= since && (e.conf != null || e.weighed) && e.ev?.check && LEARN.REL_SD[e.ev.check.quality]).map(e => ({ ts: e.ts, ratio: e.ev.check.ratio }));
    const gaps = ds.filter(d => d.from >= since).flatMap(d => d.gaps || []);
    const tod = LEARN.timeOfDay({ meals, checks, gaps });
    const pct = r => Math.round(Math.abs(r - 1) * 100);
    h += '<div class="card"><div class="card-title">Co chybuje podle denní doby</div><p class="muted small-text">Posledních 28 dní. Odděluje, jestli se liší počet sacharidů, inzulin k jídlu, nebo glykémie bez jídla.</p>';
    for (const [k, o] of Object.entries(tod)) {
      const set = st?.set?.[k];
      const carb = o.carb.n ? (Math.abs(o.carb.ratio - 1) < 0.07 ? 'odpovídají skutečnosti' : `jídla měla o ~${pct(o.carb.ratio)} % ${o.carb.ratio > 1 ? 'víc' : 'méně'}, než bylo zadáno`) + ` (${o.carb.n} ${o.carb.n === 1 ? 'jídlo' : o.carb.n < 5 ? 'jídla' : 'jídel'})` : 'zatím žádné ověřené jídlo';
      const ins = o.ins.n ? (Math.abs(o.ins.ratio - 1) < 0.08 ? 'odpovídá nastavení pumpy' : `glykémie se chovala, jako by jídla měla o ~${pct(o.ins.ratio)} % ${o.ins.ratio > 1 ? 'víc' : 'méně'} sacharidů, než měla`) + ` (${o.ins.n}×)` : 'potřebuje jídla se známým množstvím (obal, vážení) potvrzená v detailu jídla';
      const bas = o.basal.hours ? `glykémie ${o.basal.rate > 0.15 ? 'stoupala' : o.basal.rate < -0.15 ? 'klesala' : 'se držela'}${Math.abs(o.basal.rate) > 0.15 ? ` o ~${fmtBG(Math.abs(o.basal.rate))} ${uLbl()} za hodinu` : ''} oproti předpovědi (${Math.round(o.basal.hours)} h dat)` : 'zatím žádný úsek nalačno';
      const f = o.flags;
      const verdict = f.includes('ins') ? 'Rozdíl je hlavně v inzulinu k jídlu, ne v počítání — poměr sacharidů k inzulinu v tuto dobu stojí za to probrat s diabetologem.'
        : f.includes('basal') ? `Glykémie se ${o.basal.rate > 0 ? 'zvedá' : 'snižuje'} i bez jídla — automatika pumpy to v tuto dobu nedorovná; stojí za to probrat s diabetologem.`
          : f.includes('carb') ? 'Liší se hlavně počet sacharidů — to aplikace opravuje sama (kalibrace odhadů z fotek).'
            : (o.carb.n >= 3 || o.ins.n >= 2 || o.basal.hours >= 6) ? 'Zatím bez výrazné odchylky.' : 'Zatím málo dat.';
      h += `<div class="tod-block"><div class="tod-head">${LEARN.BLOCKS[k].label}${set ? `<span class="muted small-text"> · ${set.src === 'pump' ? 'pumpa' : 'nastavení'}: ${dec(K.r1(set.icr))} g/U, ${fmtBG(set.isf)} ${uLbl()}/U</span>` : ''}</div>
        <div class="tod-line">🍞 Zadané sacharidy: ${carb}</div><div class="tod-line">💉 Inzulin k jídlu: ${ins}</div><div class="tod-line">🌙 Bez jídla (5 h+ po jídle): ${bas}</div>
        <div class="tod-verdict${f.length ? ' warn-note' : ''}">${verdict}</div></div>`;
    }
    h += '<p class="muted small-text">Jen popis z vašich dat ve srovnání s nastavením pumpy, ne doporučení k dávkování. Rozlišit počítání od inzulinu umí jen jídla se známým množstvím — stačí 2–3 v každé denní době.</p></div>';
    h += settingsCard(all, now, st, ds, tod);
    return h;
  }

  // Kontrola nastavení pumpy: sacharidový poměr z jídel se známým množstvím (spolehlivé),
  // citlivost z korekcí nalačno (u uzavřené smyčky jen orientačně — do výpočtů se nepoužívá), bazál.
  function settingsCard(all, now, st, ds, tod) {
    const fmtI = v => dec(K.r1(v));
    const plural = (n, a, b, c) => (n === 1 ? a : n < 5 ? b : c);
    const checks = all.filter(e => e.ts >= now - 90 * DAY && (e.conf != null || e.weighed) && e.ev?.check && LEARN.REL_SD[e.ev.check.quality])
      .map(e => ({ ts: e.ts, ratio: e.ev.check.ratio, icr: e.ev.check.icr ?? e.ev.icr }));
    const rc = LEARN.ratioCheck(checks);
    let h = '<div class="card"><div class="card-title">Kontrola nastavení pumpy</div><p class="muted small-text">Z chvil ve vašich datech, které odpovídají běžným testům nastavení. Popis pro diabetologa, ne doporučení ke změně.</p>';
    h += '<div class="tod-head">Sacharidový poměr (g na 1 U)</div>';
    for (const [k, o] of Object.entries(rc)) {
      const set = o.set ?? st?.set?.[k]?.icr;
      let main = set ? fmtI(set) : '—', sub = 'potřebuje jídla se známým množstvím (obal, vážení)';
      if (o.n) {
        main = `${set ? fmtI(set) + ' → ' : ''}~${fmtI(o.eff)}`;
        const v = o.n < 3 ? 'předběžné, chce to aspoň 3 jídla' : o.eff < 0.9 * o.set ? 'na 1 U připadá méně sacharidů, než počítá pumpa — jídla dostávala méně inzulinu, než potřebovala'
          : o.eff > 1.1 * o.set ? 'na 1 U připadá víc sacharidů, než počítá pumpa — jídla dostávala víc inzulinu, než potřebovala' : 'sedí s nastavením';
        sub = `${o.n} ${plural(o.n, 'jídlo', 'jídla', 'jídel')}${o.n > 1 ? ` · rozpětí ${fmtI(o.lo)}–${fmtI(o.hi)}` : ''} · ${v}`;
      }
      h += `<div class="learn-row"><span>${LEARN.BLOCKS[k].label}<br><span class="muted small-text">${sub}</span></span><b>${main}</b></div>`;
    }
    h += '<p class="muted small-text">Z jídel se známým množstvím: všechen inzulin, který jídlo nakonec potřebovalo (bolus + co pumpa sama přidala nebo ubrala + co zbylo v glykémii), proti známým gramům. Vlevo pumpa, vpravo data.</p>';

    const eps = ds.filter(d => d.from >= now - 90 * DAY).flatMap(d => d.corr || []).sort((a, b) => b.t - a.t);
    const est = LEARN.estimateISF(eps, st?.isfSet);
    h += `<div class="tod-head">Citlivost na inzulin (${uLbl()} na 1 U)</div>`;
    if (!est.n) h += '<p class="muted small-text">Zatím žádná korekce nalačno (vaše ≥ 1 U mimo jídlo nebo shluk korekcí pumpy ≥ 1 U; glykémie ≥ 8 a ustálená, 4 h po jídle, 3 h bez jídla po ní).</p>';
    else {
      h += `<div class="learn-row"><span>Korekce nalačno<br><span class="muted small-text">${est.n} ${plural(est.n, 'korekce', 'korekce', 'korekcí')} (${est.own} vašich)${est.n > 1 ? ` · rozpětí ${fmtBG(est.lo)}–${fmtBG(est.hi)}` : ''} · jen orientačně</span></span><b>${est.set ? fmtBG(est.set) + ' → ' : ''}~${fmtBG(est.isf)}</b></div>`;
      h += eps.slice(0, 5).map(e => `<div class="tod-line small-text">${K.fmtHuman(K.dstr(new Date(e.t)))} ${hhmm(e.t)} · ${e.own ? 'vaše korekce' : 'korekce pumpy'} ${fmtI(e.dose)} U při ${fmtBG(e.bg0)} · za 3 h ${e.dBG > 0 ? '+' : '−'}${fmtBG(Math.abs(e.dBG))} · celkem zapůsobilo ${fmtI(e.E)} U → ${fmtBG(e.isf)}</div>`).join('');
    }
    h += `<p class="muted small-text">U 780G jen orientačně: po korekci pumpa sama přidává nebo ubírá inzulin podle toho, jak glykémie klesá, a v noci se mění i potřeba bazálu. Výsledek proto míchá citlivost s automatikou a vychází spíš nižší, než je skutečnost — aplikace ho do svých výpočtů nepoužívá. Spolehlivě citlivost změří řízený test korekce domluvený s diabetologem. V režimu SmartGuard pumpa podle všeho nastavenou citlivost pro automatické korekce nepoužívá (ověřte v manuálu).</p>`;

    h += '<div class="tod-head">Bazál (nalačno, 5 h+ po jídle)</div>';
    h += Object.entries(tod).map(([k, o]) => `<div class="tod-line">${LEARN.BLOCKS[k].label}: ${o.basal.hours ? `${o.basal.rate > 0.15 ? 'stoupá' : o.basal.rate < -0.15 ? 'klesá' : 'drží'}${Math.abs(o.basal.rate) > 0.15 ? ` ~${fmtBG(Math.abs(o.basal.rate))} ${uLbl()} za h` : ''} (${Math.round(o.basal.hours)} h dat)` : 'zatím bez úseku nalačno'}</div>`).join('');
    h += '<p class="muted small-text">Proč poměr jen z jídel se známým množstvím: aplikace se učí sacharidy z glykémie podle poměru v pumpě. Když poměr nesedí, její čísla to částečně vyrovnají (zadáte víc nebo méně sacharidů) a odchylka poměru se schová. Známé množství ji odhalí.</p></div>';
    return h;
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
    h += trendCards(all, now);
    const cats = Object.entries(c.cats || {}).filter(([, v]) => v.n > 0 || v.nW > 0).sort((a, b) => (b[1].n + b[1].nW) - (a[1].n + a[1].nW));
    if (cats.length && c.n) {
      h += '<div class="card"><div class="card-title">Podle druhu jídla</div>' + cats.map(([k, v]) =>
        `<div class="learn-row"><span>${LEARN.CATS[k].label}<br><span class="muted small-text">${v.n} ověř.${v.nW ? ` · ${v.nW} zvážených` : ''}</span></span><b>${Math.abs(v.factor - 1) < 0.03 ? 'přesné' : 'korekce ' + pctTxt(v.factor)}</b></div>`).join('')
        + (c.nWeighed ? '<p class="muted small-text">Zvážená jídla zpřesňují, jak se druhy jídla liší od sebe; celkovou úroveň dál určuje glykémie (zahrnuje i to, jak k vám sedí poměr v pumpě).</p>' : '') + '</div>';
    }
    // Opakovaná jídla: kolik jídel se opakuje a co se z nich aplikace naučila
    const recentP = all.filter(e => now - e.ts <= 30 * DAY && !e.excl);
    if (recentP.length) {
      let linked = 0, likely = 0;
      for (const e of recentP) {
        if (dishMembers(e.dish).some(x => x.ts < e.ts)) linked++;
        else if (dishCands(dishDesc(e), e.id, { max: 1, before: e.ts, skipDish: e.dish }).length) likely++;
      }
      const groups = Object.entries(dishIdx().by).filter(([, ms]) => ms.length >= 2).sort((p, q) => q[1].length - p[1].length).slice(0, 12);
      h += `<div class="card"><div class="card-title">Opakovaná jídla</div><p>Z ${recentP.length} jídel za 30 dní: <b>${linked}</b> propojeno s dřívějším stejným jídlem${likely ? `, <b>${likely}</b> dalších nejspíš stejných (nepropojeno — potvrďte v detailu jídla)` : ''}.</p>`
        + groups.map(([, ms]) => {
          const last = ms[ms.length - 1], d = LEARN.dishFactor(ms.map(dishResid).filter(Boolean), now), p = Math.round((d.f - 1) * 100);
          return `<button class="learn-row learn-open" data-id="${last.id}"><span>${esc(last.n)}<br><span class="muted small-text">${ms.length}×${last.place ? ' · ' + esc(last.place) : ''} · ${d.n} ověř.</span></span><b>${!d.n ? '—' : Math.abs(p) < 2 ? 'sedí' : 'oprava ' + (p > 0 ? '+' : '') + p + ' %'}</b></button>`;
        }).join('')
        + '<p class="muted small-text">U propojeného jídla se další odhad upraví podle toho, o kolik se glykémie u jeho dřívějších výskytů lišila od odhadu AI po vaší kalibraci (navíc ke korekci podle druhu jídla, smrštěno: jeden výskyt posune opravu zhruba o třetinu, tři shodné o dvě třetiny). Propojí se jen to, co potvrdíte nebo pojmenujete stejně.</p></div>';
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
    // Odhad porcí: AI naslepo vs. váha (zvážená jídla)
    const wm = all.filter(e => e.weighed?.blind && e.weighed.per && !e.weighed.disagree?.length && Object.keys(e.weighed.per).length);
    if (wm.length) {
      const byV = {};
      for (const e of wm) for (const [v, g] of Object.entries(e.weighed.per)) if (g > 0) (byV[v] ??= []).push(Math.log(g / e.weighed.g));
      const vwx = vw();
      h += `<div class="card"><div class="card-title">Odhad porcí: AI vs. váha</div><p class="muted small-text">Z ${wm.length} ${wm.length === 1 ? 'zváženého jídla' : 'zvážených jídel'} — AI porci odhadla naslepo, pak se porovnala s váhou.</p>`
        + Object.entries(byV).map(([v, ls]) => {
          const m = Math.exp(ls.sort((p, q) => p - q)[ls.length >> 1]), pct = Math.round((m - 1) * 100), fx = vwx[v];
          return `<div class="learn-row"><span>${LEARN.VENDOR_LABEL[v]}<br><span class="muted small-text">${ls.length}× · ${fx ? `oprava teď ×${dec(Math.round(Math.exp(fx.a) * 100) / 100)}` : 'oprava zatím žádná'}</span></span><b>${Math.abs(pct) < 5 ? 'skoro přesně' : `porce o ~${Math.abs(pct)} % ${pct < 0 ? 'menší' : 'větší'}`}</b></div>`;
        }).join('')
        + '<p class="muted small-text">Projeví se samo: AI, která porce odhaduje líp, dostane větší váhu, a typická chyba každé AI (i u velkých porcí) se v dalších odhadech opravuje — znatelně zhruba po 5–10 zvážených jídlech na každou AI. Zvážená jídla navíc zpřesní korekci podle druhu jídla (karta Podle druhu jídla) — jen rozdíly mezi druhy; celkovou úroveň a denní dobu dál určuje glykémie, protože zahrnuje i to, jak k vám sedí poměr v pumpě.</p></div>';
    }
    // Pozdní vlna po jídle (naučená) a odpovědi na „Co se stalo?"
    const tl = Object.entries(tails().cats).filter(([, x]) => x.n > 0), usedT = K.store.get('kal.tails', {});
    const misfits = all.filter(e => e.ev?.misfit && e.ev.final), whys = {};
    for (const e of misfits) if (e.why) whys[e.why] = (whys[e.why] || 0) + 1;
    if (tl.length || misfits.length) {
      h += '<div class="card"><div class="card-title">Pozdní vlna po jídle</div>' + tl.map(([k, x]) =>
        `<div class="learn-row"><span>${LEARN.CATS[k].label}<br><span class="muted small-text">${x.n} ${x.n === 1 ? 'jídlo' : x.n < 5 ? 'jídla' : 'jídel'}${usedT[k] ? ' · používá se ve výpočtu' : ''}</span></span><b>${x.f >= 0.05 ? `~${Math.round(x.f * 100)} % pozdě` : 'bez pozdní vlny'}</b></div>`).join('')
        + '<p class="muted small-text">Podíl sacharidů, který u vás přichází pomalu 1–5 h po jídle („pizza efekt" — tuk a bílkoviny zdrží část sacharidů). Navíc k tomu, co se počítá z tuku a bílkovin v odhadu AI. Učí se z dobře vysvětlených jídel a z jídel s odpovědí „nic zvláštního"; mění se, až se shodne víc jídel.</p>'
        + (misfits.length ? `<p class="muted small-text">Jídla, která model nevysvětlil: ${misfits.length}${Object.keys(whys).length ? ' — vaše odpovědi: ' + Object.entries(whys).map(([k, n]) => `${WHY[k]?.lbl || k} ${n}×`).join(' · ') : ' — odpovězte v detailu jídla „Co se stalo?"'}.</p>` : '') + '</div>';
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
    ensureDayStats().then(n => { if (n && $('#view-uceni').classList.contains('active')) renderLearn(); });
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
