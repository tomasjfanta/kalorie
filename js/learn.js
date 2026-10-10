// Zpětná vazba z glykémie: z průběhu CGM kolem jídla (−30 až +150 min) a podaného inzulinu
// odvodí, kolik sacharidů jídlo nejspíš mělo, a z toho se učí osobní korekci AI odhadů.
// Čistě výpočetní modul (bez DOM) — testovatelný v Node.
'use strict';
(function (root) {
  const MIN = 60000;
  const PRE = 30 * MIN, POST = 150 * MIN;

  // Kategorie jídla (vrací je AI) → výchozí délka vstřebávání sacharidů (min), když AI neuvede
  // glykemický index. Odpovídá dřívějším podílům vstřebaným do 150 min (pečivo ~90 %, pizza ~65 %).
  const CATS = {
    pecivo: { label: 'Pečivo', short: 'pečivo', dur: 195 },
    prilohy: { label: 'Přílohy (rýže, těstoviny, brambory, knedlíky)', short: 'přílohy', dur: 205 },
    hotove: { label: 'Hotová jídla s omáčkou / masem', short: 'hotová jídla', dur: 220 },
    fastfood: { label: 'Pizza, burger, smažené', short: 'pizza a fast food', dur: 260 },
    sladke: { label: 'Sladké a dezerty', short: 'sladké', dur: 180 },
    ovoce: { label: 'Ovoce', short: 'ovoce', dur: 180 },
    mlecne: { label: 'Mléčné', short: 'mléčné', dur: 195 },
    napoje: { label: 'Slazené nápoje', short: 'nápoje', dur: 150 },
    ostatni: { label: 'Ostatní', short: 'ostatní', dur: 205 },
  };
  const catKey = k => CATS[k] ? k : 'ostatni';

  // Glykemický index celého jídla (s ohledem na tuk, bílkoviny a vlákninu) → délka vstřebávání.
  // Vysoký GI: do 2,5 h se vstřebá ~98 %, střední ~84 %, nízký ~60 %.
  const GI_DUR = { vysoky: 165, stredni: 210, nizky: 270 };
  const GI_LABEL = { vysoky: 'rychlé (vysoký GI)', stredni: 'střední GI', nizky: 'pomalé (nízký GI)' };
  const giKey = s => { const t = String(s || '').toLowerCase(); return /vys|high/.test(t) ? 'vysoky' : /níz|niz|low/.test(t) ? 'nizky' : /stř|str|med/.test(t) ? 'stredni' : null; };
  // m.speed = osobní rychlost vstřebávání (naučená z průběhu glykémie; >1 = rychleji než obvykle).
  function absDuration(m) {
    let D = GI_DUR[giKey(m.gi)] ?? CATS[catKey(m.kat)].dur;
    const fat = m.fat || 0;
    if (fat >= 40) D += 75; else if (fat >= 25) D += 45; // tuk vyprazdňování žaludku zpomaluje
    return D / (m.speed > 0 ? m.speed : 1);
  }

  // Tuk a bílkoviny: zvyšují glykémii později a déle (Warsaw/FPU, Pańkowska; Smart 2013; Bell 2015).
  // 1 FPU = 100 kcal z tuku a bílkovin; počítá se jako 5 g „sacharidů" (polovina původní Warsaw
  // metody — plná hodnota u pump vede k hypoglykémiím), vstřebaných od 1 h po jídle po 3–8 h.
  const FPU_G = 5;
  const fpu = m => ((m.fat || 0) * 9 + (m.prot || 0) * 4) / 100;
  const fpuDur = f => (f < 1.5 ? 180 : f < 2.5 ? 240 : f < 3.5 ? 300 : 480);
  const fpuAbs = (m, t) => { const f = fpu(m); return f < 1 ? 0 : FPU_G * f * absorbedFrac(t - 60, fpuDur(f) - 60); };
  // Těžké jídlo (hodně tuku/bílkovin) se vyhodnocuje 4 h místo 2,5 h — jinak by okno skončilo
  // dřív, než se pozdní vzestup projeví.
  const isHeavy = m => fpu(m) >= 4 || (m.fat || 0) >= 35 || (m.prot || 0) >= 50;
  const postFor = m => (isHeavy(m) ? 240 : 150) * MIN;
  // Podíl sacharidů vstřebaný do t minut — parabolická křivka délky D (Scheiner; používá i Loop).
  function absorbedFrac(t, D) {
    if (t <= 0) return 0;
    if (t >= D) return 1;
    const x = t / D;
    return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
  }

  // Podíl účinku bolusu po t minutách — exponenciální model inzulinu (jako Loop/OpenAPS).
  // tp = vrchol účinku (min), td = celková doba působení (min).
  function insulinActed(t, tp = 75, td = 360) {
    if (t <= 0) return 0;
    if (t >= td) return 1;
    const tau = tp * (1 - tp / td) / (1 - 2 * tp / td);
    const a = 2 * tau / td;
    const S = 1 / (1 - a + (1 + a) * Math.exp(-td / tau));
    const iob = 1 - S * (1 - a) * ((t * t / (tau * td * (1 - a)) - t / tau - 1) * Math.exp(-t / tau) + 1);
    return Math.min(1, Math.max(0, 1 - iob));
  }

  // Úsek nastavení (poměr, citlivost) platný v daný čas dne.
  function segmentAt(segments, ts) {
    if (!segments || !segments.length) return null;
    const d = new Date(ts);
    const m = d.getHours() * 60 + d.getMinutes();
    const toMin = s => { const [h, mi] = String(s.od || '00:00').split(':').map(Number); return h * 60 + (mi || 0); };
    const sorted = [...segments].sort((a, b) => toMin(a) - toMin(b));
    let cur = sorted[sorted.length - 1];
    for (const s of sorted) if (toMin(s) <= m) cur = s;
    return cur;
  }

  const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };

  const PRIOR_WIN = 300 * MIN;  // jak daleko před jídlem hledat předchozí jídla a inzulin
  const CLUSTER_MAX = 240 * MIN; // delší „uzobávání" už se rozumně rozdělit nedá
  const CGM_LAG = 10 * MIN;      // senzor v podkoží měří s ~10min zpožděním za krví
  const SPEED_GRID = [0.5, 0.56, 0.63, 0.71, 0.8, 0.9, 1, 1.12, 1.25, 1.4, 1.6, 1.8, 2];

  // Duplicity z uploaderu (stejná dávka s časem posunutým o sekundy) → jedna dávka.
  function dedupeBoluses(boluses) {
    const out = [];
    for (const b of [...(boluses || [])].sort((a, c) => a.t - c.t)) {
      const prev = out.find(x => Math.abs(x.u - b.u) < 1e-6 && Math.abs(x.t - b.t) <= 3 * MIN);
      if (!prev) out.push(b);
    }
    return out;
  }
  // Obvyklý automatický bazál (U/h): medián za uplynulých 24 h — 780G se kolem něj pohybuje.
  const basalBaseline = recs => median((recs || []).map(r => r.r).filter(r => r >= 0));

  // Jídla, jejichž okna se překrývají, se vyhodnocují společně (jinak by si „kradla" glykémii).
  // Okno jídla je 2,5 h, u těžkého jídla 4 h. Vrací seřazené členy shluku včetně `meal`.
  function clusterOf(meal, meals) {
    const all = [meal, ...(meals || []).filter(m => m.id !== meal.id)];
    const set = [meal];
    const overlaps = (a, b) => (a.ts <= b.ts ? b.ts - a.ts <= postFor(a) : a.ts - b.ts <= postFor(b));
    for (let grew = true; grew;) {
      grew = false;
      for (const m of all) {
        if (set.includes(m)) continue;
        if (set.some(c => overlaps(c, m))) { set.push(m); grew = true; }
      }
    }
    return set.sort((a, b) => a.ts - b.ts);
  }
  const windowEnd = cluster => Math.max(...cluster.map(m => m.ts + postFor(m)));

  // meal: { id, ts, aiRaw, s, kat, gi, fat, prot, alc, speed, manual: {bg0, bg2, units} }
  // data: { readings: [{t, v mmol/L}], boluses: [{t, u, src}], basal: [{t, r U/h}] | null, basalBase,
  //         targets: [{t, dur min}] (dočasný cíl pumpy = pohyb), cgmLag (ms, výchozí 10 min),
  //         meals: ostatní jídla [{ id, ts, aiRaw, s, conf, kat, gi, fat, prot, alc, speed, pump }],
  //         settingsAt: ts → {icr, isf} }
  // therapy: { type: 'aid'|'insulin'|'none', insulin: 'rapid'|'ultra' }
  // Model glykémie od prvního jídla shluku:
  //   G(t) = G0 + citlivost × (vstřebané sacharidy(t) / poměr − účinný inzulin(t))
  // Jídla s ověřenou hodnotou, sacharidy zadané do pumpy, dovstřebávání předchozích jídel a pozdní
  // „sacharidy" z tuku a bílkovin jsou známé; neznámá jídla mají sacharidy k × odhad AI (společné k).
  // k se určí (1) z bilance na konci okna a (2) proložením celé křivky glykémie, které zároveň
  // najde, jak rychle se jídlo u vás skutečně vstřebávalo.
  function evaluateMeal(meal, data, therapy, kNone) {
    const T = meal.ts;
    const flags = [];
    const others = (data.meals || []).filter(m => m.id !== meal.id);
    const cluster = clusterOf(meal, others);
    const T0 = cluster[0].ts, winEnd = windowEnd(cluster);
    const lag = data.cgmLag ?? CGM_LAG;
    const rd = (data.readings || []).filter(r => r.t >= T0 - PRE && r.t <= winEnd).sort((a, b) => a.t - b.t);
    const pre = rd.filter(r => r.t <= T0 + 5 * MIN);
    const post = rd.filter(r => r.t > T0);
    const coverage = Math.min(1, post.length / ((winEnd - T0) / (5 * MIN)));
    // Glykémie přesně v čase jídla: přímka přes hodnoty z půlhodiny před ním (medián by ji při
    // klesající nebo stoupající glykémii posunul o ~12 min dřív, než od kdy se počítá inzulin).
    let bg0 = median(pre.map(r => r.v));
    if (pre.length >= 3) {
      const mt = pre.reduce((a, r) => a + r.t, 0) / pre.length, mv = pre.reduce((a, r) => a + r.v, 0) / pre.length;
      const sxx = pre.reduce((a, r) => a + (r.t - mt) ** 2, 0);
      if (sxx > 0) bg0 = mv + pre.reduce((a, r) => a + (r.t - mt) * (r.v - mv), 0) / sxx * (T0 - mt);
    }
    if (bg0 == null && meal.manual?.bg0) bg0 = meal.manual.bg0;
    const res = { ts: T, readings: rd, coverage, bg0, flags, quality: 'none', implied: null, winEnd,
      dur: absDuration(meal), gi: giKey(meal.gi), heavy: isHeavy(meal), fpu: fpu(meal),
      cluster: cluster.filter(m => m !== meal).map(m => m.ts),
      // sacharidy zadané do pumpy (bez fotky) v okně nebo ještě se vstřebávající
      pumpMeals: others.filter(m => m.pump && m.ts <= winEnd && m.ts >= T0 - PRIOR_WIN).map(m => ({ ts: m.ts, g: m.s })) };
    if (bg0 == null) { flags.push('chybí glykémie před jídlem'); return res; }

    // Ukazatele pro toto jídlo (graf, vrchol, čas nad 10 mmol/l); bilance se počítá za celé okno.
    let peak = null, tPeak = null, iauc = 0, above = 0;
    const own = rd.filter(r => r.t > T && r.t <= T + postFor(meal));
    for (const r of own) { if (peak == null || r.v > peak) { peak = r.v; tPeak = r.t; } if (r.v > 10) above += 5; }
    let prev = { t: T, v: bg0 };
    for (const r of own) { iauc += ((Math.max(0, prev.v - bg0) + Math.max(0, r.v - bg0)) / 2) * (r.t - prev.t) / MIN; prev = r; }
    let end = null, tEnd = winEnd;
    const tail = post.filter(r => r.t >= winEnd - 15 * MIN);
    if (tail.length) {
      end = tail.reduce((a, r) => a + r.v, 0) / tail.length;
      tEnd = tail.reduce((a, r) => a + r.t, 0) / tail.length; // inzulin hodnotit ve stejném čase jako glykémii
    }
    if (end == null && meal.manual?.bg2 && cluster.length === 1) { end = meal.manual.bg2; flags.push('ruční glykémie po jídle'); }
    Object.assign(res, { peak, tPeak, end, iauc, tAbove10: own.length ? above : null, rise: peak != null ? peak - bg0 : null, delta: end != null ? end - bg0 : null });

    if (end == null) { flags.push(post.length ? 'chybí hodnoty ke konci okna' : 'chybí glykémie po jídle'); return res; }
    if (!meal.manual?.bg2 && coverage < 0.6) { flags.push('málo hodnot z CGM'); return res; }
    if (bg0 < 3.9) { flags.push('hypoglykémie před jídlem'); return res; }

    let quality = 'good';
    const down = q => { const order = ['good', 'fair', 'poor']; if (order.indexOf(q) > order.indexOf(quality)) quality = q; };
    if (pre.length >= 3) {
      const slope = (pre[pre.length - 1].v - pre[0].v) / Math.max(1, (pre[pre.length - 1].t - pre[0].t) / MIN);
      res.preSlope = slope;
      if (Math.abs(slope) > 0.04) { flags.push('glykémie se před jídlem rychle měnila'); down('poor'); }
    }
    // Hypoglykémie v okně: skoro jistě nezapsané sacharidy na její řešení + protiregulace těla.
    if (post.some(r => r.t <= tEnd && r.v < 3.9)) { res.hypo = true; flags.push('hypoglykémie v okně — nejspíš nezapsané sacharidy na její řešení, nepoužito k učení'); down('poor'); }
    // Pohyb (dočasný cíl pumpy): zvyšuje citlivost na inzulin ještě hodiny po skončení.
    for (const g of data.targets || []) {
      const gEnd = g.t + (g.dur || 0) * MIN;
      if (g.t <= tEnd && gEnd >= T0 - 60 * MIN) { res.exercise = 'during'; break; }
      if (gEnd < T0 - 60 * MIN && gEnd >= T0 - 12 * 60 * MIN) res.exercise = res.exercise || 'after';
    }
    if (res.exercise === 'during') { flags.push('dočasný cíl pumpy (pohyb) v okně — nepoužito k učení'); down('poor'); }
    else if (res.exercise === 'after') { flags.push('pohyb během posledních 12 h — citlivost na inzulin může být vyšší'); down('fair'); }
    // Alkohol: tlumí tvorbu glukózy v játrech ještě hodiny.
    if (meal.alc) { res.alcohol = true; flags.push('alkohol — ovlivňuje glykémii ještě hodiny, nepoužito k učení'); down('poor'); }
    else if ([...cluster, ...others].some(m => m !== meal && m.alc && m.ts <= tEnd && m.ts >= T0 - 6 * 60 * MIN)) { flags.push('alkohol v posledních hodinách'); down('fair'); }
    // Ustálení na konci okna: sklon za posledních 30 min (mmol/l za 15 min).
    const last = post.filter(r => r.t >= tEnd - 30 * MIN);
    if (last.length >= 3) {
      const mt = last.reduce((a, r) => a + r.t, 0) / last.length, mv = last.reduce((a, r) => a + r.v, 0) / last.length;
      const sxx = last.reduce((a, r) => a + (r.t - mt) ** 2, 0), sxy = last.reduce((a, r) => a + (r.t - mt) * (r.v - mv), 0);
      res.endSlope15 = sxx > 0 ? sxy / sxx * 15 * MIN : 0;
      res.stable = Math.abs(res.endSlope15) <= 0.5;
      if (Math.abs(res.endSlope15) > 1.0) { flags.push(res.endSlope15 > 0 ? 'na konci okna glykémie ještě stoupá' : 'na konci okna glykémie ještě klesá'); down('fair'); }
    }
    if (cluster[cluster.length - 1].ts - T0 > CLUSTER_MAX) { flags.push('jídla na sebe navazují déle než 4 h — nedají se spolehlivě rozdělit'); down('poor'); }

    // ── Sacharidy: známé části a neznámé (k × odhad AI), jako funkce času ──
    const est = m => m.aiRaw > 0 ? m.aiRaw : (m.s > 0 ? m.s : 0);
    const absIn = (m, t, sp = 1) => { const D = absDuration(m) / sp; return absorbedFrac((t - m.ts) / MIN, D) - absorbedFrac(Math.max(0, T0 - m.ts) / MIN, D); };
    const known = [], unknown = [];
    for (const m of cluster) {
      if (m !== meal && (m.conf != null || !(m.aiRaw > 0))) known.push({ m, c: m.conf != null ? m.conf : est(m) });
      else if (est(m) > 0) unknown.push(m);
    }
    const prior = others.filter(m => !cluster.includes(m) && m.ts < T0 && m.ts >= T0 - PRIOR_WIN);
    for (const m of prior) known.push({ m, c: m.conf != null ? m.conf : est(m) });
    const fpuMeals = [...cluster, ...prior];
    const knownAt = t => known.reduce((a, x) => a + x.c * absIn(x.m, t), 0)
      + fpuMeals.reduce((a, m) => a + fpuAbs(m, (t - m.ts) / MIN) - fpuAbs(m, Math.max(0, T0 - m.ts) / MIN), 0);
    const unknownAt = (t, sp) => unknown.reduce((a, m) => a + est(m) * absIn(m, t, sp), 0);
    const priorC = prior.reduce((a, m) => a + (m.conf != null ? m.conf : est(m)) * absIn(m, tEnd), 0);
    res.absorbed = absIn(meal, tEnd);
    res.priorCarbs = priorC;
    res.fpuCarbs = fpuMeals.reduce((a, m) => a + fpuAbs(m, (tEnd - m.ts) / MIN) - fpuAbs(m, Math.max(0, T0 - m.ts) / MIN), 0);
    if (priorC > 5) { flags.push(`započteno dovstřebávání dřívějšího jídla (~${Math.round(priorC)} g)`); if (priorC > 15) down('fair'); }
    if (unknown.length > 1) { flags.push('vyhodnoceno společně s dalším jídlem v okně — rozděleno podle odhadů AI'); down('fair'); }
    else if (cluster.some(m => m !== meal && m.pump)) { flags.push('v okně jsou sacharidy zadané do pumpy — počítám s nimi, jak jsou zadané'); down('fair'); }
    else if (cluster.length > 1) flags.push('v okně je i jiné, už ověřené jídlo — započteno');
    if (res.absorbed < 0.7) { flags.push(`pomalé jídlo — do konce okna se vstřebá jen ~${Math.round(res.absorbed * 100)} %`); down('fair'); }
    if (res.heavy) flags.push(`hodně tuku a bílkovin — okno prodlouženo na 4 h, pozdní vzestup započten (~${Math.round(res.fpuCarbs)} g)`);

    if (therapy.type === 'none') {
      // Bez inzulinu: sacharidy z plochy pod křivkou přes osobní citlivost k (mmol/L·min na 1 g).
      if (cluster.length > 1 || priorC > 5) { flags.push('bez inzulinu umím vyhodnotit jen samostatné jídlo'); return res; }
      if (!kNone) { flags.push('učím se osobní reakci — potřebuji ještě pár jídel'); res.quality = 'none'; return res; }
      res.implied = iauc / kNone / res.absorbed;
    } else {
      const set = data.settingsAt ? data.settingsAt(T0) : null;
      if (!set || !set.icr || !set.isf) { flags.push('chybí sacharidový poměr nebo citlivost v nastavení léčby'); return res; }
      const tp = therapy.insulin === 'ultra' ? 55 : 75;
      // Všechny dávky jako {t, u}: bolusy + odchylky automatického bazálu od obvyklé úrovně.
      // Inzulin podle původu: k jídlu / automatické korekce pumpy / ruční korekce pumpou /
      // dřív podaný. Pro bilanci je to jedno (všechen inzulin snižuje glykémii stejně) — rozdělení
      // slouží k vysvětlení, kolik sacharidů musela dorovnat pumpa a kolik vy.
      const doses = [];
      const ins = { meal: 0, auto: 0, man: 0, pre: 0, basal: 0 }, del = { meal: 0, auto: 0, man: 0, basal: 0 };
      const actedIn = (d, t) => d.u * (insulinActed((t - d.t) / MIN, tp) - insulinActed(Math.max(0, T0 - d.t) / MIN, tp));
      let any = false;
      for (const b of dedupeBoluses(data.boluses)) {
        if (b.t < T0 - PRIOR_WIN || b.t > tEnd) continue;
        // Dávka k jídlu = do 20 min od jídla a aspoň 1 U. Automatické korekce 780G jsou skoro vždy
        // pod 1 U (uploader je od ručních bolusů neodliší, export z CareLinku ano — podle „src");
        // větší dávka později je ruční korekce.
        const auto = /auto|closed_loop|micro/i.test(b.src || '');
        const manual = !auto && b.u >= 1;
        const near = cluster.filter(m => Math.abs(b.t - m.ts) <= 20 * MIN);
        const cls = !auto && b.u >= 1 && near.length ? 'meal' : b.t < T0 - 20 * MIN ? 'pre' : manual ? 'man' : 'auto';
        const d = { t: b.t, u: b.u, cls };
        doses.push(d);
        if (cls !== 'pre') del[cls] += b.u;
        if (cls === 'meal' && near.includes(meal) && res.bolusLead == null) res.bolusLead = (b.t - T) / MIN;
        any = true;
      }
      if (!any && meal.manual?.units) { doses.push({ t: T, u: meal.manual.units, cls: 'meal' }); del.meal = meal.manual.units; any = true; flags.push('inzulin zadaný ručně'); }
      if (!any) { flags.push('chybí údaj o inzulinu k jídlu'); return res; }
      // Automatický bazál nad obvyklou úroveň (nebo pod ni) působí jako korekce.
      let basalOk = false;
      if (data.basal && data.basal.length && data.basalBase != null) {
        const slot = 5 * MIN, from = T0 - PRIOR_WIN;
        const recs = data.basal.filter(r => r.t >= from - 20 * MIN && r.t <= tEnd + 20 * MIN).sort((a, b) => a.t - b.t);
        // CareLink nevrací všechny 5minutové záznamy (mezery jsou i při normální glykémii — nejde
        // o nulové dávky), takže chybějící úsek dostane sazbu nejbližšího záznamu do 15 min,
        // jinak obvyklý bazál. Nulové dávky (pozastavení) posílá upravený uploader jako r = 0.
        const rateAt = t => {
          let best = null;
          for (const r of recs) if (Math.abs(r.t - t) <= 15 * MIN && (!best || Math.abs(r.t - t) < Math.abs(best.t - t))) best = r;
          return best ? best.r : null;
        };
        let covered = 0, total = 0;
        for (let t = T0 - 60 * MIN; t < tEnd; t += slot) { total++; if (rateAt(t) != null) covered++; }
        if (total && covered / total >= 0.6) {
          basalOk = true;
          for (let t = from; t < tEnd; t += slot) {
            const r = rateAt(t);
            if (r == null) continue; // bez dat — počítat jako obvyklý bazál
            const dose = (r - data.basalBase) * slot / (60 * MIN);
            doses.push({ t: t + slot / 2, u: dose, cls: 'basal' });
            if (t >= T0 - 20 * MIN) del.basal += dose;
          }
        }
      }
      if (therapy.type === 'aid' && !basalOk) { flags.push('chybí údaje o automatickém bazálu — v bilanci chybí'); down('fair'); }
      for (const d of doses) ins[d.cls] += actedIn(d, tEnd);
      const insulinAt = t => doses.reduce((a, d) => a + actedIn(d, t), 0);
      const units = ins.meal + ins.auto + ins.man + ins.pre + ins.basal;
      Object.assign(res, { units, ins, del, icr: set.icr, isf: set.isf, basalOk });
      // Kolik sacharidů dávka k jídlu „předpokládala", kolik dorovnala pumpa sama a kolik vy korekcí.
      res.coveredCarbs = set.icr * del.meal;
      res.extraCarbs = set.icr * (del.auto + del.basal);
      res.manCarbs = set.icr * del.man;
      if (!(unknownAt(tEnd, 1) > 0)) { flags.push('chybí odhad sacharidů jídla'); return res; }

      // (1) Bilance na konci okna.
      const kEnd = (set.icr * (units + (end - bg0) / set.isf) - knownAt(tEnd)) / unknownAt(tEnd, 1);
      res.impliedEnd = kEnd * est(meal);
      // (2) Proložení celé křivky: pro každou rychlost vstřebávání nejlepší k (nejmenší čtverce).
      //     Množství a rychlost se u pomalého jídla v krátkém okně navzájem zastoupí (víc sacharidů
      //     pomaleji ≈ míň rychleji), proto se rychlosti nevybírají, ale váží: podle shody s křivkou
      //     a podle předpokladu, že rychlost je obvyklá (σ = 0,3 v log). Když křivka rychlost
      //     neurčí, výsledek zůstane u obvyklé rychlosti. Model se porovnává s CGM o zpoždění senzoru dřív.
      const pts = post.filter(r => r.t <= tEnd + 5 * MIN && r.t - lag > T0).map(r => ({ v: r.v, t: r.t - lag }));
      if (pts.length >= 18 && !meal.manual?.bg2) {
        const base = pts.map(p => bg0 + set.isf * (knownAt(p.t) / set.icr - insulinAt(p.t)));
        const grid = [];
        for (const sp of SPEED_GRID) {
          const xs = pts.map(p => set.isf * unknownAt(p.t, sp) / set.icr);
          const sxx = xs.reduce((a, x) => a + x * x, 0);
          if (!(sxx > 0)) continue;
          const k = Math.max(0, xs.reduce((a, x, i) => a + x * (pts[i].v - base[i]), 0) / sxx);
          grid.push({ sp, k, sse: pts.reduce((a, p, i) => a + (p.v - base[i] - k * xs[i]) ** 2, 0) });
        }
        if (grid.length) {
          const minSse = Math.min(...grid.map(g => g.sse));
          // Šum CGM ~0,35 mmol/l; sousední hodnoty senzoru nejsou nezávislé (×1,7).
          const sig = Math.max(0.35, Math.sqrt(minSse / pts.length)) * 1.7;
          for (const g of grid) g.J = g.sse / sig ** 2 + (Math.log(g.sp) / 0.3) ** 2;
          const Jmin = Math.min(...grid.map(g => g.J));
          for (const g of grid) g.w = Math.exp(-(g.J - Jmin) / 2);
          const W = grid.reduce((a, g) => a + g.w, 0);
          // Výsledek = nejpravděpodobnější rychlost (shoda + předpoklad) a její k. Průměrovat k přes
          // rychlosti nejde — pomalejší rychlosti dávají nepřiměřeně velké k (k ~ 1/rychlost²).
          const map = grid.reduce((a, g) => (g.J < a.J ? g : a));
          const kPost = map.k, lnS = Math.log(map.sp);
          // Rozptyl vah říká, jak dobře křivka rychlost určila.
          const lnMean = grid.reduce((a, g) => a + g.w * Math.log(g.sp), 0) / W;
          const lnSd = Math.sqrt(grid.reduce((a, g) => a + g.w * (Math.log(g.sp) - lnMean) ** 2, 0) / W);
          const mv = pts.reduce((a, p) => a + p.v, 0) / pts.length;
          const sst = pts.reduce((a, p) => a + (p.v - mv) ** 2, 0);
          const rmse = Math.sqrt(minSse / pts.length), r2 = sst > 0 ? 1 - minSse / sst : 0;
          res.fit = { k: kPost, rel: Math.exp(lnS), speed: (meal.speed > 0 ? meal.speed : 1) * Math.exp(lnS), lnSd, rmse, r2, n: pts.length };
          // Křivka sedí → její odhad je spolehlivější než jediný bod na konci okna.
          res.fit.used = kPost > 0 && rmse <= 0.9 && r2 >= 0.5;
          // Rychlost se učí jen z jídel, kde ji křivka opravdu určila (úzké rozdělení vah).
          res.fit.informative = res.fit.used && lnSd < 0.18 && unknown.length === 1;
        }
      }
      res.k = res.fit?.used ? res.fit.k : kEnd;
      res.implied = res.k * est(meal);
      res.share = unknown.length > 1 ? est(meal) * absIn(meal, tEnd) / unknownAt(tEnd, 1) : 1;
    }
    if (!(res.implied > 0)) { flags.push('bilance nedává smysl (záporné sacharidy)'); res.implied = null; return res; }
    res.quality = quality;
    return res;
  }

  /* ─── Společné vyhodnocení navazujících jídel (segment) ───
     Jídla, jejichž okna na sebe navazují, tvoří segment (bez omezení délky). Celá křivka glykémie
     segmentu se proloží modelem, kde má každé „sezení" (fotky do 20 min od sebe) vlastní neznámé
     množství sacharidů s vlastní křivkou vstřebávání od svého času — jídla s odstupem se tak dají
     oddělit. Řešení je bayesovské (vážené nejmenší čtverce s předpokladem kolem odhadu AI), takže
     každé jídlo dostane i vlastní nejistotu: dobře určené učí hodně, špatně určené málo.
     Odolnost: odlehlé hodnoty (nezapsaná svačina, tlak na senzor) mají menší váhu (Huber), úseky
     s hypoglykémií a s pohybem se z dat vynechají, pomalý posun glykémie (bazál mimo) má vlastní člen. */
  const SITTING_GAP = 20 * MIN;
  const LOOSE = 1.0;     // předpoklad pro „štítek" k učení: ±100 % kolem odhadu AI (data rozhodují)
  const DRIFT_SD = 0.4;  // mmol/l za hodinu
  const SPEEDS = [0.71, 0.8, 0.9, 1, 1.12, 1.25, 1.4];
  const TAIL_D = 240;    // min — pozdní dobíhání předchozího jídla (pomalá složka)
  const RAMP_SD = 1.0;   // mmol/l za hodinu — chybějící bazál od určité chvíle

  // Gaussova eliminace: inverze malé symetrické matice.
  function invert(M) {
    const n = M.length, A = M.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-12) return null;
      [A[c], A[p]] = [A[p], A[c]];
      const d = A[c][c];
      for (let j = 0; j < 2 * n; j++) A[c][j] /= d;
      for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c]; if (f) for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j]; }
    }
    return A.map(r => r.slice(n));
  }

  // Segment, do kterého jídlo patří (řetěz překrývajících se oken, bez omezení délky).
  const segmentOf = (meal, meals) => clusterOf(meal, meals);

  // meals: všechna jídla segmentu (seřazená); data jako u evaluateMeal + prior (dřívější jídla).
  // Vrací { results: {id → výsledek jídla}, seg: souhrn segmentu }.
  function evaluateSegment(meals, data, therapy) {
    const out = { results: {}, seg: null };
    const T0 = meals[0].ts, Tend = windowEnd(meals);
    const lag = data.cgmLag ?? CGM_LAG;
    const rd = (data.readings || []).filter(r => r.t >= T0 - PRE && r.t <= Tend).sort((a, b) => a.t - b.t);
    const pre = rd.filter(r => r.t <= T0 + 5 * MIN), post = rd.filter(r => r.t > T0);
    const base = m => ({ ts: m.ts, readings: rd, flags: [], quality: 'none', implied: null, winEnd: Tend,
      dur: absDuration(m), gi: giKey(m.gi), heavy: isHeavy(m), fpu: fpu(m),
      cluster: meals.filter(x => x !== m).map(x => x.ts) });
    const fail = msg => { for (const m of meals) { const r = base(m); r.flags.push(msg); out.results[m.id] = r; } return out; };
    // Glykémie v čase prvního jídla: přímka přes půlhodinu před ním.
    let bg0 = median(pre.map(r => r.v));
    if (pre.length >= 3) {
      const mt = pre.reduce((a, r) => a + r.t, 0) / pre.length, mv = pre.reduce((a, r) => a + r.v, 0) / pre.length;
      const sxx = pre.reduce((a, r) => a + (r.t - mt) ** 2, 0);
      if (sxx > 0) bg0 = mv + pre.reduce((a, r) => a + (r.t - mt) * (r.v - mv), 0) / sxx * (T0 - mt);
    }
    if (bg0 == null) return fail('chybí glykémie před jídlem');
    if (post.length < ((Tend - T0) / (5 * MIN)) * 0.6) return fail('málo hodnot z CGM');
    if (bg0 < 3.9) return fail('hypoglykémie před jídlem');
    if (therapy.type === 'none') return fail('bez inzulinu umím vyhodnotit jen samostatné jídlo');
    const setAt = t => (data.settingsAt ? data.settingsAt(t) : null);
    const s0 = setAt(T0);
    if (!s0 || !s0.icr || !s0.isf) return fail('chybí sacharidový poměr nebo citlivost v nastavení léčby');
    const scale = t => { const s = setAt(t) || s0; return (s.isf || s0.isf) / (s.icr || s0.icr); }; // mmol/l na 1 g
    const isfAt = t => (setAt(t) || s0).isf || s0.isf;
    const tp = therapy.insulin === 'ultra' ? 55 : 75;

    // Vynechané úseky: hypoglykémie (a 90 min po ní — nezapsané sacharidy na řešení) a pohyb.
    const excl = [];
    for (const r of post) if (r.v < 3.9) excl.push([r.t - 10 * MIN, r.t + 90 * MIN, 'hypo']);
    for (const g of data.targets || []) excl.push([g.t, g.t + ((g.dur || 0) + 120) * MIN, 'exercise']);
    const excluded = t => excl.find(x => t >= x[0] && t <= x[1]);

    // Inzulin: bolusy (rozdělené podle původu) + odchylky automatického bazálu.
    const doses = [], del = { meal: 0, auto: 0, man: 0, basal: 0 };
    let anyIns = false;
    for (const b of dedupeBoluses(data.boluses)) {
      if (b.t < T0 - PRIOR_WIN || b.t > Tend) continue;
      const auto = /auto|closed_loop|micro/i.test(b.src || '');
      const near = meals.some(m => Math.abs(b.t - m.ts) <= 20 * MIN);
      const cls = !auto && b.u >= 1 && near ? 'meal' : b.t < T0 - 20 * MIN ? 'pre' : (!auto && b.u >= 1) ? 'man' : 'auto';
      doses.push({ t: b.t, u: b.u, cls });
      if (cls !== 'pre') del[cls] += b.u;
      anyIns = true;
    }
    const self1 = meals.find(m => m.manual?.units);
    if (!anyIns && self1) { doses.push({ t: self1.ts, u: self1.manual.units, cls: 'meal' }); del.meal += self1.manual.units; anyIns = true; }
    if (!anyIns) return fail('chybí údaj o inzulinu k jídlu');
    let basalOk = false;
    if (data.basal && data.basal.length && data.basalBase != null) {
      const slot = 5 * MIN, from = T0 - PRIOR_WIN;
      const recs = data.basal.filter(r => r.t >= from - 20 * MIN && r.t <= Tend + 20 * MIN).sort((a, b) => a.t - b.t);
      const rateAt = t => { let best = null; for (const r of recs) if (Math.abs(r.t - t) <= 15 * MIN && (!best || Math.abs(r.t - t) < Math.abs(best.t - t))) best = r; return best ? best.r : null; };
      let covered = 0, total = 0;
      for (let t = T0 - 60 * MIN; t < Tend; t += slot) { total++; if (rateAt(t) != null) covered++; }
      if (total && covered / total >= 0.6) {
        basalOk = true;
        for (let t = from; t < Tend; t += slot) {
          const r = rateAt(t);
          if (r == null) continue;
          const dose = (r - data.basalBase) * slot / (60 * MIN);
          doses.push({ t: t + slot / 2, u: dose, cls: 'basal' });
          if (t >= T0 - 20 * MIN) del.basal += dose;
        }
      }
    }
    const insulinAt = t => doses.reduce((a, d) => a + isfAt(d.t) * d.u * (insulinActed((t - d.t) / MIN, tp) - insulinActed(Math.max(0, T0 - d.t) / MIN, tp)), 0);

    // Sacharidy: známé (ověřené, zadané do pumpy, dřívější jídla, tuk a bílkoviny) a neznámá sezení.
    const est = m => m.aiRaw > 0 ? m.aiRaw : (m.s > 0 ? m.s : 0);
    const absIn = (m, t, sp = 1) => { const D = absDuration(m) / sp; return absorbedFrac((t - m.ts) / MIN, D) - absorbedFrac(Math.max(0, T0 - m.ts) / MIN, D); };
    const isUnknown = m => m.conf == null && !m.pump && m.aiRaw > 0;
    const known = [...meals.filter(m => !isUnknown(m)), ...(data.prior || []).filter(m => m.ts < T0 && m.ts >= T0 - PRIOR_WIN)];
    const fpuMeals = [...meals, ...(data.prior || []).filter(m => m.ts < T0 && m.ts >= T0 - PRIOR_WIN)];
    const knownAt = t => known.reduce((a, m) => a + scale(m.ts) * (m.conf != null ? m.conf : est(m)) * absIn(m, t), 0)
      + fpuMeals.reduce((a, m) => a + scale(m.ts) * (fpuAbs(m, (t - m.ts) / MIN) - fpuAbs(m, Math.max(0, T0 - m.ts) / MIN)), 0);
    const sittings = [];
    for (const m of meals.filter(isUnknown)) {
      const last = sittings[sittings.length - 1];
      if (last && m.ts - last.members[last.members.length - 1].ts <= SITTING_GAP) last.members.push(m);
      else sittings.push({ members: [m] });
    }
    for (const S of sittings) S.E = S.members.reduce((a, m) => a + est(m), 0);
    if (!sittings.length) return fail('v okně není jídlo s odhadem AI');

    // Body k proložení (CGM o zpoždění senzoru dřív), bez vynechaných úseků.
    const pts = post.filter(r => r.t - lag > T0 && !excluded(r.t)).map(r => ({ t: r.t - lag, v: r.v }));
    const nParam = sittings.length + 1;
    if (pts.length < Math.max(12, 3 * nParam)) return fail('málo použitelných hodnot z CGM (hypoglykémie nebo pohyb)');
    const yBase = pts.map(p => p.v - bg0 - knownAt(p.t) + insulinAt(p.t));
    const tau = pts.map(p => (p.t - T0) / (60 * MIN));

    // Jedno řešení pro danou rychlost: Huber-vážené nejmenší čtverce s předpokladem (3 iterace).
    // extra = další (nejisté) vstupy modelu { f: t → vliv jedné jednotky na glykémii, mu, sd }:
    // nezapsané jídlo (g), pozdní dobíhání předchozího jídla (g), chybějící bazál (mmol/l za hodinu).
    const ghostMeal = t => ({ ts: t, gi: 'střední', kat: 'ostatni' });
    const ghostTerm = g => ({ f: t => scale(g.t) * absIn(ghostMeal(g.t), t), mu: g.g, sd: 12 });
    const tailTerm = (m, start, sd) => ({ f: t => scale(m.ts) * (absorbedFrac((t - start) / MIN, TAIL_D) - absorbedFrac(Math.max(0, T0 - start) / MIN, TAIL_D)), mu: 0, sd });
    const rampTerm = start => ({ f: t => Math.max(0, t - start) / (60 * MIN), mu: 0, sd: RAMP_SD });
    function solve(sp, sigFix, extra = []) {
      const X = pts.map((p, k) => [...sittings.map(S => S.members.reduce((a, m) => a + scale(m.ts) * est(m) / S.E * absIn(m, p.t, sp), 0)), tau[k],
        ...extra.map(e => e.f(p.t))]);
      const mu0 = [...sittings.map(S => S.E), 0, ...extra.map(e => e.mu)];
      const prec0 = [...sittings.map(S => 1 / (LOOSE * S.E) ** 2), 1 / DRIFT_SD ** 2, ...extra.map(e => 1 / e.sd ** 2)];
      const nParam = mu0.length;
      let w = pts.map(() => 1), sig = sigFix || 0.6, beta = mu0, cov = null;
      for (let it = 0; it < 4; it++) {
        const A = Array.from({ length: nParam }, (_, i) => Array.from({ length: nParam }, (_, j) => (i === j ? prec0[i] : 0)));
        const b = mu0.map((m, i) => prec0[i] * m);
        for (let k = 0; k < pts.length; k++) {
          const wk = w[k] / sig ** 2;
          for (let i = 0; i < nParam; i++) { b[i] += wk * X[k][i] * yBase[k]; for (let j = 0; j < nParam; j++) A[i][j] += wk * X[k][i] * X[k][j]; }
        }
        cov = invert(A);
        if (!cov) return null;
        beta = cov.map(r => r.reduce((a, v, j) => a + v * b[j], 0));
        const res = yBase.map((y, k) => y - X[k].reduce((a, x, i) => a + x * beta[i], 0));
        const rms = Math.sqrt(res.reduce((a, r, k) => a + w[k] * r * r, 0) / w.reduce((a, x) => a + x, 0));
        // šum CGM ~0,35 mmol/l, sousední hodnoty nejsou nezávislé (×1,7)
        if (!sigFix) sig = Math.max(0.35, rms) * 1.7;
        w = res.map(r => { const z = Math.abs(r) / (sig / 1.7); return z <= 1.5 ? 1 : 1.5 / z; });
        if (it === 3) {
          const sse = res.reduce((a, r, k) => a + w[k] * r * r, 0);
          const prior = beta.reduce((a, v, i) => a + prec0[i] * (v - mu0[i]) ** 2, 0);
          return { beta, cov, sig, sse, rms, res, w, J: sse / sig ** 2 + prior + (Math.log(sp) / 0.3) ** 2, sp };
        }
      }
    }
    const first = solve(1);
    if (!first) return fail('výpočet se nepodařil');
    const bestOf = (terms, sig) => {
      let b = null;
      for (const sp of SPEEDS) { const r = solve(sp, sig, terms); if (r && (!b || r.J < b.J)) b = r; }
      return b;
    };
    let best = first;
    { const g = bestOf([], first.sig); if (g && g.J < best.J) best = g; }
    const mv = pts.reduce((a, p) => a + p.v, 0) / pts.length;
    const sst = pts.reduce((a, p) => a + (p.v - mv) ** 2, 0);
    const r2 = sst > 0 ? 1 - best.res.reduce((a, r) => a + r * r, 0) / sst : 0;
    const outliers = best.w.filter(x => x < 0.6).length;

    // ── „Nic jsem nejedl" ──
    // U navrženého nezapsaného jídla uživatel potvrdil, že tehdy nejedl. Vzestup pak musí vysvětlit
    // něco jiného: (a) předchozí jídlo dobíhalo déle, než model čekal (tuk, bílkoviny, pomalé sacharidy —
    // dávka k jídlu ho nepokryla celé), nebo (b) bazál od určité chvíle nestačil (stálý tlak nahoru).
    // Obě vysvětlení jsou v modelu jako nejisté vstupy; které z nich samo sedí výrazně lépe, to se
    // uživateli řekne. Když se nedají rozlišit, zůstanou v modelu obě a nejistota jídel kolem vzroste.
    const alts = [], noMeal = [];
    for (const tR of (data.noMeal || []).filter(t => t > T0 && t < Tend).sort((a, b) => a - b)) {
      const prev = [...meals, ...(data.prior || [])].filter(m => m.ts <= tR - 20 * MIN && m.ts >= tR - 6 * 60 * MIN).sort((a, b) => b.ts - a.ts)[0];
      const J = terms => solve(best.sp, first.sig, [...alts, ...terms])?.J ?? Infinity;
      const pick = list => list.reduce((b, x) => { const j = J([x.term]); return j < b.j ? { ...x, j } : b; }, { j: Infinity });
      const ramp = pick([60, 30, 0].map(d => tR - d * MIN).filter(st => st >= T0).map(st => ({ st, term: rampTerm(st) })));
      let tail = { j: Infinity };
      if (prev) {
        const g0 = prev.conf != null ? prev.conf : est(prev) || prev.s || 30;
        tail = pick([30, 60, 90, 120, 150, 180, 240].map(d => prev.ts + d * MIN).filter(st => st <= tR)
          .map(st => ({ st, term: tailTerm(prev, st, Math.max(10, 0.6 * g0)) })));
      }
      const why = !(tail.j < Infinity) ? 'basal' : tail.j + 4 <= ramp.j ? 'tail' : ramp.j + 4 <= tail.j ? 'basal' : 'both';
      const nm = { t: tR, why, prevTs: prev?.ts ?? null, prevKat: prev?.kat ?? null, prevId: prev?.id ?? null,
        dJ: tail.j < Infinity && ramp.j < Infinity ? ramp.j - tail.j : null }; // > 0: dobíhání sedí lépe
      if (why !== 'basal') { nm.tailIdx = alts.length; nm.tailFrom = tail.st; alts.push(tail.term); }
      if (why !== 'tail' && ramp.j < Infinity) { nm.rampIdx = alts.length; nm.rampFrom = ramp.st; alts.push(ramp.term); }
      noMeal.push(nm);
    }
    if (alts.length) best = bestOf(alts, first.sig) || best;
    const nearNoMeal = t => (data.noMeal || []).some(x => Math.abs(x - t) <= 60 * MIN);

    // ── Nezapsané jídlo? ──
    // S volným předpokladem by vyfocená jídla „spolkla" i sacharidy, které nikdo nezapsal (křivka pak
    // sedí, ale výsledky jsou špatně). Druhé proložení proto drží jídla u odhadu AI (±35 %) a dovolí
    // malé nezapsané vstupy (střední GI) každých 20 min mimo vyfocená jídla. Když výrazně pomohou,
    // jde nejspíš o nezapsané jídlo — jídla kolem něj se k učení nepoužijí.
    const unlogged = [];
    {
      const cand = [];
      for (let t = T0 + 20 * MIN; t <= Tend - 60 * MIN; t += 20 * MIN) if (!meals.some(m => Math.abs(m.ts - t) <= 25 * MIN) && !nearNoMeal(t)) cand.push(t);
      if (cand.length) {
        const ghost = t => ({ ts: t, gi: 'střední', kat: 'ostatni' });
        const mkX = withC => pts.map((p, k) => [
          ...sittings.map(S => S.members.reduce((a, m) => a + scale(m.ts) * est(m) / S.E * absIn(m, p.t, best.sp), 0)),
          tau[k], ...alts.map(e => e.f(p.t)), ...(withC ? cand.map(c => scale(c) * absIn(ghost(c), p.t)) : [])]);
        const fit = withC => {
          const X = mkX(withC), n = X[0].length;
          const mu0 = [...sittings.map(S => S.E), 0, ...alts.map(e => e.mu), ...(withC ? cand.map(() => 0) : [])];
          const prec0 = [...sittings.map(S => 1 / (0.35 * S.E) ** 2), 1 / DRIFT_SD ** 2, ...alts.map(e => 1 / e.sd ** 2), ...(withC ? cand.map(() => 1 / 15 ** 2) : [])];
          const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? prec0[i] : 0)));
          const b = mu0.map((m, i) => prec0[i] * m);
          for (let k = 0; k < pts.length; k++) {
            const wk = best.w[k] / best.sig ** 2;
            for (let i = 0; i < n; i++) { b[i] += wk * X[k][i] * yBase[k]; for (let j = 0; j < n; j++) A[i][j] += wk * X[k][i] * X[k][j]; }
          }
          const cv = invert(A);
          if (!cv) return null;
          const be = cv.map(r => r.reduce((a, v, j) => a + v * b[j], 0));
          const sse = pts.reduce((a, p, k) => a + best.w[k] * (yBase[k] - X[k].reduce((s2, x, i) => s2 + x * be[i], 0)) ** 2, 0);
          return { be, J: sse / best.sig ** 2 + be.reduce((a, v, i) => a + prec0[i] * (v - mu0[i]) ** 2, 0) };
        };
        const f0 = fit(false), f1 = fit(true);
        if (f0 && f1 && f0.J - f1.J >= 6) {
          const u = f1.be.slice(sittings.length + 1 + alts.length);
          // sečíst sousední kandidáty (vstup se mezi ně rozloží) a hlásit výrazné shluky
          for (let i = 0; i < cand.length; i++) {
            const win = cand.map((c, j) => ({ c, g: u[j] })).filter(x => Math.abs(x.c - cand[i]) <= 30 * MIN && x.g > 0);
            const g = win.reduce((a, x) => a + x.g, 0);
            if (g >= 10 && u[i] === Math.max(...win.map(x => x.g)) && !unlogged.some(x => Math.abs(x.t - cand[i]) <= 60 * MIN)) {
              unlogged.push({ t: win.reduce((a, x) => a + x.c * x.g, 0) / g, g });
            }
          }
        }
      }
    }

    // Konec segmentu: hodnota a sklon (pro vysvětlení).
    const tail = post.filter(r => r.t >= Tend - 15 * MIN);
    const end = tail.length ? tail.reduce((a, r) => a + r.v, 0) / tail.length : null;
    const last = post.filter(r => r.t >= Tend - 30 * MIN);
    let endSlope15 = null;
    if (last.length >= 3) {
      const mt = last.reduce((a, r) => a + r.t, 0) / last.length, lv = last.reduce((a, r) => a + r.v, 0) / last.length;
      const sxx = last.reduce((a, r) => a + (r.t - mt) ** 2, 0);
      endSlope15 = sxx > 0 ? last.reduce((a, r) => a + (r.t - mt) * (r.v - lv), 0) / sxx * 15 * MIN : 0;
    }
    if (unlogged.length || alts.length) {
      const refit = solve(best.sp, null, [...alts, ...unlogged.map(ghostTerm)]);
      if (refit) {
        best = refit;
        const o = sittings.length + 1;
        for (let k = 0; k < unlogged.length; k++) unlogged[k].g = Math.max(0, best.beta[o + alts.length + k]);
        for (const nm of noMeal) {
          if (nm.tailIdx != null) nm.tailG = best.beta[o + nm.tailIdx];
          if (nm.rampIdx != null) nm.slope = best.beta[o + nm.rampIdx];
        }
      }
    }
    const r2f = sst > 0 ? 1 - best.res.reduce((a, r) => a + r * r, 0) / sst : 0;
    const seg = { T0, Tend, n: pts.length, nMeals: meals.length, sittings: sittings.length, rmse: best.rms, r2: r2f, speed: best.sp,
      drift: best.beta[sittings.length], outliers, excluded: excl.map(x => x[2]), basalOk, del, unlogged, noMeal,
      coveredCarbs: s0.icr * del.meal, extraCarbs: s0.icr * (del.auto + del.basal), manCarbs: s0.icr * del.man };
    out.seg = seg;
    const fitOk = best.rms <= 1.2 && r2f >= 0.3;

    // Výsledky po jídlech.
    for (const m of meals) {
      const r = base(m);
      Object.assign(r, { bg0, end, endSlope15, stable: endSlope15 != null ? Math.abs(endSlope15) <= 0.5 : null, basalOk,
        del, coveredCarbs: seg.coveredCarbs, extraCarbs: seg.extraCarbs, manCarbs: seg.manCarbs, icr: s0.icr, isf: s0.isf,
        seg: { n: seg.nMeals, sittings: seg.sittings, rmse: seg.rmse, r2: r2f, unlogged, noMeal } });
      // „nic jsem nejedl" poblíž: čím se vzestup vysvětlil (pro zobrazení u jídla)
      const nmNear = noMeal.filter(x => x.t >= m.ts - 150 * MIN && x.t <= m.ts + postFor(m)).sort((a, b) => Math.abs(a.t - m.ts) - Math.abs(b.t - m.ts))[0];
      if (nmNear) r.noMeal = nmNear;
      const ownTail = noMeal.find(x => x.prevId != null && x.prevId === m.id && x.why === 'tail' && x.tailG >= 3);
      if (ownTail) r.tail = { g: ownTail.tailG, from: ownTail.tailFrom, at: ownTail.t };
      // ukazatele tohoto jídla
      let peak = null, tPeak = null, above = 0;
      const own = rd.filter(x => x.t > m.ts && x.t <= m.ts + postFor(m));
      for (const x of own) { if (peak == null || x.v > peak) { peak = x.v; tPeak = x.t; } if (x.v > 10) above += 5; }
      const ownBg0 = rd.filter(x => x.t <= m.ts).pop()?.v ?? bg0;
      Object.assign(r, { peak, tPeak, rise: peak != null ? peak - ownBg0 : null, tAbove10: own.length ? above : null, absorbed: absIn(m, Tend) });
      const lead = dedupeBoluses(data.boluses).filter(b => b.u >= 1 && Math.abs(b.t - m.ts) <= 20 * MIN).sort((a, b) => Math.abs(a.t - m.ts) - Math.abs(b.t - m.ts))[0];
      if (lead) r.bolusLead = (lead.t - m.ts) / MIN;
      const ownEx = own.length ? own.filter(x => excluded(x.t)).length / own.length : 0;
      if (excl.some(x => x[2] === 'hypo' && x[0] <= m.ts + postFor(m) && x[1] >= m.ts)) r.hypo = true;
      const exNear = (data.targets || []).find(g => g.t <= m.ts + postFor(m) && g.t + ((g.dur || 0) + 120) * MIN >= m.ts - 60 * MIN);
      if (exNear) r.exercise = 'during';
      else if ((data.targets || []).some(g => { const e2 = g.t + (g.dur || 0) * MIN; return e2 < m.ts && e2 >= m.ts - 12 * 60 * MIN; })) r.exercise = 'after';
      if (m.alc) r.alcohol = true;
      if (!isUnknown(m)) { r.flags.push(m.conf != null ? 'ověřené jídlo — slouží jako známá hodnota' : 'sacharidy zadané do pumpy'); out.results[m.id] = r; continue; }
      const si = sittings.findIndex(S => S.members.includes(m)), S = sittings[si];
      const C = Math.max(0, best.beta[si]), sd = Math.sqrt(Math.max(0, best.cov[si][si]));
      const share = est(m) / S.E;
      r.implied = C * share;
      // relativní nejistota štítku; sezení s více fotkami se dělí jen podle odhadů AI
      r.relSd = C > 0 ? Math.min(2, sd / C) : 2;
      // v sezení se podíl talířů dělí podle odhadů AI → nejistota rozdělení ±25 %
      if (S.members.length > 1) r.relSd = Math.min(2, Math.hypot(r.relSd, 0.25));
      r.share = r.implied / Math.max(1e-6, sittings.reduce((a, X, i) => a + Math.max(0, best.beta[i]), 0));
      r.fit = { used: fitOk, speed: (m.speed > 0 ? m.speed : 1) * best.sp, rel: best.sp, rmse: best.rms, r2: r2f, n: pts.length,
        informative: fitOk && sittings.length === 1 && meals.length === 1 && r.relSd < 0.2 };
      r.sitting = S.members.length > 1 ? S.members.filter(x => x !== m).map(x => x.ts) : null;
      // kvalita z vlastní nejistoty + důvody k vyřazení
      let q = r.relSd <= 0.2 ? 'good' : r.relSd <= 0.4 ? 'fair' : 'poor';
      const down = x => { const o = ['good', 'fair', 'poor']; if (o.indexOf(x) > o.indexOf(q)) q = x; };
      if (!fitOk) { r.flags.push('průběh glykémie model dobře nevysvětluje'); down('poor'); }
      if (meals.length > 1) r.flags.push(`vyhodnoceno spolu s ${meals.length - 1} ${meals.length === 2 ? 'dalším jídlem' : 'dalšími jídly'} — každé má vlastní nejistotu`);
      if (r.sitting) r.flags.push('fotky do 20 min od sebe — počítají se jako jedno sezení, podíl podle odhadů AI');
      if (r.relSd > 0.4) r.flags.push('z glykémie se toto jídlo nedá dost přesně oddělit od ostatních');
      if (ownEx > 0.5) { r.flags.push(r.hypo ? 'hypoglykémie v okně — data vynechána' : 'pohyb v okně — data vynechána'); down('poor'); }
      else if (r.hypo) { r.flags.push('hypoglykémie v okně — její úsek vynechán'); down('fair'); }
      if (r.exercise === 'during' && ownEx <= 0.5) { r.flags.push('dočasný cíl pumpy (pohyb) — jeho úsek vynechán'); down('fair'); }
      if (r.exercise === 'after') { r.flags.push('pohyb během posledních 12 h — citlivost na inzulin může být vyšší'); down('fair'); }
      if (m.alc) { r.flags.push('alkohol — ovlivňuje glykémii ještě hodiny, nepoužito k učení'); down('poor'); }
      if (r.heavy) r.flags.push('hodně tuku a bílkovin — okno prodlouženo na 4 h, pozdní vzestup započten');
      if (outliers > pts.length * 0.15) r.flags.push('část průběhu model nevysvětluje (nezapsané jídlo?) — tyto hodnoty mají menší váhu');
      // „Nic jsem nejedl" v okně tohoto jídla: tvar křivky neodpovídal předpokladu → štítek váží méně.
      const nmIn = noMeal.find(x => (x.prevId != null && x.prevId === m.id) || (x.t > m.ts && x.t <= m.ts + postFor(m)));
      if (nmIn) {
        r.relSd = Math.max(r.relSd, nmIn.why === 'both' ? 0.3 : 0.2);
        if (r.relSd > 0.2) down('fair');
        r.flags.push(nmIn.why === 'tail' ? 'jídlo dobíhalo déle, než model čekal — pozdní část započtena zvlášť'
          : nmIn.why === 'basal' ? 'po jídle chyběl bazál — započteno zvlášť'
            : 'vzestup bez jídla v okně — dobíhání jídla a chybějící bazál se z jedné křivky rozlišit nedají, výsledek je méně jistý');
      }
      const ul = unlogged.find(x => Math.abs(x.t - m.ts) <= 150 * MIN);
      if (ul) {
        r.unlogged = ul;
        r.relSd = Math.max(r.relSd, 0.35); // nezapsané jídlo poblíž → štítek váží málo
        r.flags.push(`průběh naznačuje nezapsané jídlo kolem ${new Date(ul.t).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })} (~${Math.round(ul.g)} g) — započteno odhadem, výsledek je méně jistý`);
        down('fair');
      }
      // Pojistka: výsledek víc než ~2,5× mimo odhad AI je spíš chyba (nezapsané jídlo, špatná fotka)
      // než skutečnost — k učení jen po potvrzení.
      const ratio = r.implied / est(m);
      if (C > 0 && (ratio > 2.5 || ratio < 0.4)) { r.flags.push('výsledek se od odhadu AI liší víc než 2,5× — k učení jen po vašem potvrzení'); down('poor'); }
      if (C === 0) { r.flags.push('výpočet vychází na nulu'); down('poor'); }
      r.quality = r.implied > 0 ? q : 'none';
      out.results[m.id] = r;
    }
    return out;
  }

  /* ─── Křivky dne: co jsme čekali vs. co se stalo ───
     Den se rozdělí na úseky: navazující jídla (jako segment) a mezery mezi nimi (po nejvýš 4 h). Každý
     úsek začíná skutečnou glykémií z CGM a dál se počítá jen z toho, co je známé: sacharidy (vstřebávání
     podle GI a druhu jídla, tuk a bílkoviny), bolusy a odchylky automatického bazálu od obvyklého.
     „logged" = sacharidy, jak byly zapsané; „fit" = sacharidy přepočtené z glykémie (implied), naučená
     rychlost a odhalená nezapsaná jídla. Rozdíl proti CGM ukazuje, kde a o kolik se předpoklad mýlil.
     meals: [{ ts, s, conf, aiRaw, implied, fitSpeed, ghost, g, gi, kat, fat, prot, speed }]
     Vrací { grid, actual, carbs: [{ m, rate }], ins, insBasal, intervals: [{ a, b, kind, logged, fit, … }], stats }. */
  function dayCurves({ from, to, readings, boluses, basal, basalBase, meals, settingsAt, therapy, cgmLag, step = 5 * MIN }) {
    const lag = cgmLag ?? CGM_LAG, tp = therapy?.insulin === 'ultra' ? 55 : 75;
    const set = t => (settingsAt ? settingsAt(t) : null);
    if (!set(from) && !set(to)) return { error: 'chybí sacharidový poměr nebo citlivost v nastavení léčby' };
    const isfAt = t => (set(t) || set(from) || set(to)).isf;
    const scaleAt = t => { const x = set(t) || set(from) || set(to); return x.isf / x.icr; };
    const grid = [];
    for (let t = from; t <= to; t += step) grid.push(t);
    const rd = (readings || []).filter(r => r.t >= from - 60 * MIN && r.t <= to + 15 * MIN).sort((a, b) => a.t - b.t);
    // CGM v čase t (lineárně mezi hodnotami, mezera nejvýš 15 min)
    let j = 0;
    const cgmAt = t => {
      if (!rd.length) return null;
      while (j > 0 && rd[j].t > t) j--;
      while (j < rd.length - 1 && rd[j + 1].t <= t) j++;
      const a = rd[j], b = rd[j + 1];
      if (!a) return null;
      if (a.t === t) return a.v;
      if (a.t < t && b && b.t - a.t <= 15 * MIN) return a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t);
      if (Math.abs(a.t - t) <= 5 * MIN) return a.v;
      if (b && Math.abs(b.t - t) <= 5 * MIN) return b.v;
      return null;
    };

    // Inzulin: bolusy + odchylky bazálu od obvyklého (po 5 min, chybějící záznamy z nejbližšího do 15 min).
    const doses = dedupeBoluses(boluses).filter(b => b.t >= from - PRIOR_WIN && b.t <= to).map(b => ({ t: b.t, u: b.u, basal: false }));
    if (basal?.length && basalBase != null) {
      const recs = basal.filter(r => r.t >= from - PRIOR_WIN - 20 * MIN && r.t <= to + 20 * MIN).sort((a, b) => a.t - b.t);
      let k = 0;
      for (let t = from - PRIOR_WIN; t < to; t += 5 * MIN) {
        while (k < recs.length - 1 && recs[k + 1].t <= t) k++;
        let best = null;
        for (const r of [recs[k], recs[k + 1]]) if (r && Math.abs(r.t - t) <= 15 * MIN && (!best || Math.abs(r.t - t) < Math.abs(best.t - t))) best = r;
        if (best) doses.push({ t: t + 2.5 * MIN, u: (best.r - basalBase) * 5 / 60, basal: true });
      }
    }
    // Jídla: kolik g (zapsané / přepočtené) a jak rychle
    const gLogged = m => (m.ghost ? 0 : m.conf != null ? m.conf : m.s > 0 ? m.s : m.aiRaw || 0);
    const gFit = m => (m.ghost ? m.g || 0 : m.conf != null ? m.conf : m.implied > 0 ? m.implied : gLogged(m));
    const durOf = (m, fit) => absDuration({ ...m, speed: fit && m.fitSpeed > 0 ? m.fitSpeed : m.speed });
    const carbCum = (m, t, fit) => { const g = fit ? gFit(m) : gLogged(m), x = (t - m.ts) / MIN; return g * absorbedFrac(x, durOf(m, fit)) + (m.ghost ? 0 : fpuAbs(m, x)); };
    const ms = (meals || []).filter(m => m.ts >= from - PRIOR_WIN && m.ts <= to).sort((a, b) => a.ts - b.ts);

    // Kumulativní vliv (mmol/l) v čase krve t − lag; projekce úseku = kotva + rozdíl proti začátku úseku.
    const tb = grid.map(t => t - lag);
    const cumL = tb.map(t => ms.reduce((a, m) => a + scaleAt(m.ts) * carbCum(m, t, false), 0));
    const cumF = tb.map(t => ms.reduce((a, m) => a + scaleAt(m.ts) * carbCum(m, t, true), 0));
    const cumI = tb.map(t => doses.reduce((a, d) => a + isfAt(d.t) * d.u * insulinActed((t - d.t) / MIN, tp), 0));
    const h = step / (60 * MIN);
    // Rychlosti (mmol/l za hodinu): sacharidy každého jídla (zapsané), inzulin celkem a z toho bazál.
    const carbs = ms.filter(m => !m.ghost && m.ts >= from - 6 * 60 * MIN).map(m => ({ m, rate: tb.map(t => Math.max(0, scaleAt(m.ts) * (carbCum(m, t, false) - carbCum(m, t - step, false)) / h)) }));
    const ghosts = ms.filter(m => m.ghost).map(m => ({ m, rate: tb.map(t => Math.max(0, scaleAt(m.ts) * (carbCum(m, t, true) - carbCum(m, t - step, true)) / h)) }));
    const insRate = sel => tb.map(t => doses.filter(sel).reduce((a, d) => a + isfAt(d.t) * d.u * (insulinActed((t - d.t) / MIN, tp) - insulinActed((t - step - d.t) / MIN, tp)), 0) / h);
    const ins = insRate(() => true), insBasal = insRate(d => d.basal);

    // Úseky: od každého jídla (chody do 30 min = jedno) do dalšího jídla, nejvýš do konce jeho okna a 4 h;
    // zbytek dne v mezerách po nejvýš 4 h. Každý úsek začíná skutečnou glykémií, takže chyba se nesčítá
    // přes celý den a je vidět, kde vznikla (vliv dřívějších jídel a inzulinu se do úseku započítá).
    const real = ms.filter(m => !m.ghost && m.ts >= from && m.ts < to);
    const snap = t => from + Math.round((t - from) / step) * step;
    const groups = [];
    for (const m of real) { const g = groups[groups.length - 1]; if (g && m.ts - g[0].ts < 30 * MIN) g.push(m); else groups.push([m]); }
    const ivs = [];
    let cur = from;
    // Den začíná ještě v okně jídla z předchozího dne → ten úsek je dobíhání, ne „bez jídla".
    const prevEnd = Math.max(from, ...ms.filter(m => !m.ghost && m.ts < from).map(m => Math.min(m.ts + postFor(m), from + 4 * 60 * MIN)));
    if (prevEnd - from >= 20 * MIN) { cur = Math.min(to, snap(prevEnd)); ivs.push({ a: from, b: cur, kind: 'tail' }); }
    // Mezery po nejvýš 4 h. „Nalačno" (fasting) až 5 h po posledním jídle (i odhaleném nezapsaném) —
    // dřív v sobě mezera nese dobíhání jídla (tuk, bílkoviny, pomalé sacharidy) a o bazálu by nic neříkala.
    const lastMealBefore = t => Math.max(-Infinity, ...ms.filter(m => m.ts < t).map(m => m.ts));
    const gaps = until => {
      for (let g0 = cur; until - g0 >= 20 * MIN;) {
        const fast = lastMealBefore(g0 + 1) + 5 * 60 * MIN;
        let b = Math.min(until, g0 + 4 * 60 * MIN);
        if (fast - g0 >= 20 * MIN && b - fast >= 20 * MIN) b = snap(fast);
        ivs.push({ a: g0, b, kind: 'gap', fasting: g0 >= fast - 20 * MIN });
        g0 = b;
      }
      cur = Math.max(cur, until);
    };
    groups.forEach((g, i) => {
      const a = snap(g[0].ts);
      gaps(a);
      const next = groups[i + 1] ? snap(groups[i + 1][0].ts) : to;
      const b = Math.min(next, snap(Math.min(windowEnd(g), g[0].ts + 4 * 60 * MIN)), to);
      if (b > a) { ivs.push({ a, b, kind: 'meal', meals: g }); cur = b; }
    });
    gaps(to);
    const idx = t => Math.round((t - from) / step);
    const actual = grid.map(cgmAt);
    for (const iv of ivs) {
      const ia = idx(iv.a), ib = Math.min(grid.length - 1, idx(iv.b));
      const anchor = actual[ia];
      if (anchor == null || ib <= ia) { iv.logged = iv.fit = null; continue; }
      iv.logged = []; iv.fit = [];
      for (let k = ia; k <= ib; k++) {
        const ins0 = cumI[k] - cumI[ia];
        iv.logged.push({ t: grid[k], v: anchor + cumL[k] - cumL[ia] - ins0 });
        iv.fit.push({ t: grid[k], v: anchor + cumF[k] - cumF[ia] - ins0 });
      }
      // jak moc jsme se mýlili: průměr a maximum rozdílu CGM − předpověď, a stav na konci úseku
      const d = iv.logged.map(p => { const v = actual[idx(p.t)]; return v == null ? null : { t: p.t, d: v - p.v }; }).filter(Boolean);
      if (d.length) {
        iv.mae = d.reduce((a, x) => a + Math.abs(x.d), 0) / d.length;
        iv.max = d.reduce((a, x) => (Math.abs(x.d) > Math.abs(a.d) ? x : a));
        const last = d[d.length - 1];
        iv.endDiff = last.d; iv.endT = last.t;
        iv.endG = last.d / scaleAt(iv.a); // ≈ g sacharidů (kladné = glykémie výš, než odpovídá zápisu a inzulinu)
        const df = iv.fit.map(p => { const v = actual[idx(p.t)]; return v == null ? null : v - p.v; }).filter(x => x != null);
        iv.maeFit = df.reduce((a, x) => a + Math.abs(x), 0) / df.length;
      }
    }
    const withD = ivs.filter(iv => iv.mae != null && iv.kind === 'meal');
    const stats = withD.length ? { mae: withD.reduce((a, iv) => a + iv.mae, 0) / withD.length, maeFit: withD.reduce((a, iv) => a + iv.maeFit, 0) / withD.length,
      worst: withD.reduce((a, iv) => (Math.abs(iv.max.d) > Math.abs(a.max.d) ? iv : a)) } : null;
    return { grid, actual, carbs, ghosts, ins, insBasal, intervals: ivs, stats, scale: scaleAt(from), lag };
  }

  /* ─── Vývoj a rozbor podle denní doby (obrazovka Učení) ─── */
  // Souhrn dne z křivek: CGM (čas v rozmezí, variabilita), přesnost předpovědi u jídel a odchylky bez jídla.
  // Úseky bez jídla s hypoglykémií (řešení sacharidy, které nikdo nezapíše) nebo s pohybem se vynechají.
  function dayStatsOf(cv, readings, from, to, targets) {
    const rd = (readings || []).filter(r => r.t >= from && r.t < to);
    const st = { n: rd.length, sum: 0, sumsq: 0, inR: 0, low: 0, high: 0, mae: null, maeFit: null, nMeal: 0, gaps: [] };
    for (const r of rd) { st.sum += r.v; st.sumsq += r.v * r.v; if (r.v < 3.9) st.low++; else if (r.v > 10) st.high++; else st.inR++; }
    if (!cv || cv.error) return st;
    const ms = cv.intervals.filter(iv => iv.kind === 'meal' && iv.mae != null);
    if (ms.length) {
      st.nMeal = ms.length;
      st.mae = ms.reduce((a, iv) => a + iv.mae, 0) / ms.length;
      st.maeFit = ms.reduce((a, iv) => a + iv.maeFit, 0) / ms.length;
    }
    const k0 = t => Math.round((t - cv.grid[0]) / (cv.grid[1] - cv.grid[0]));
    for (const iv of cv.intervals) {
      if (iv.kind !== 'gap' || !iv.fasting || iv.mae == null || iv.b - iv.a < 2 * 60 * MIN) continue;
      const act = cv.actual.slice(k0(iv.a), k0(iv.b) + 1);
      if (act.some(v => v != null && v < 3.9)) continue;
      if ((targets || []).some(g => g.t <= iv.b && g.t + ((g.dur || 0) + 120) * MIN >= iv.a)) continue;
      const hours = (iv.endT - iv.a) / (60 * MIN);
      if (hours >= 1.5) st.gaps.push({ t: (iv.a + iv.b) / 2, rate: iv.endDiff / hours, hours });
    }
    return st;
  }

  // Týdny (od pondělí): čas v rozmezí 3,9–10, variabilita (CV), průměrná odchylka předpovědi od CGM
  // ze zapsaných sacharidů (mae) a po přepočtu z glykémie (maeFit). days: [{ from, ...dayStatsOf }]
  function weeklyTrend(days) {
    const W = {};
    for (const d of days || []) {
      if (!d || !(d.n >= 72)) continue; // aspoň ~6 h dat z CGM
      const ws = new Date(d.from); ws.setDate(ws.getDate() - (ws.getDay() + 6) % 7); ws.setHours(0, 0, 0, 0);
      const w = (W[+ws] ??= { start: +ws, days: 0, n: 0, sum: 0, sumsq: 0, inR: 0, low: 0, high: 0, maeW: 0, maeFitW: 0, nMeal: 0 });
      w.days++; w.n += d.n; w.sum += d.sum; w.sumsq += d.sumsq; w.inR += d.inR; w.low += d.low; w.high += d.high;
      if (d.mae != null) { w.maeW += d.mae * d.nMeal; w.maeFitW += d.maeFit * d.nMeal; w.nMeal += d.nMeal; }
    }
    return Object.values(W).sort((a, b) => b.start - a.start).map(w => {
      const mean = w.sum / w.n, sd = Math.sqrt(Math.max(0, w.sumsq / w.n - mean * mean));
      return { start: w.start, days: w.days, tir: w.inR / w.n, low: w.low / w.n, high: w.high / w.n, mean, cv: sd / mean,
        mae: w.nMeal ? w.maeW / w.nMeal : null, maeFit: w.nMeal ? w.maeFitW / w.nMeal : null, nMeal: w.nMeal };
    });
  }

  // Co chybuje v které denní době:
  //  carb  — zadané sacharidy vs. skutečnost (štítek z glykémie nebo potvrzený): ratio > 1 = jídla měla víc
  //  ins   — jídla se známým množstvím: glykémie se chovala, jako by měla ratio× tolik sacharidů
  //          (> 1 = inzulin k jídlu v tuto dobu u vás pokrývá méně, než počítá nastavení pumpy)
  //  basal — bez jídla: glykémie se odchylovala o rate mmol/l za hodinu od předpovědi (> 0 = stoupala)
  // meals: [{ ts, logged, label }], checks: [{ ts, ratio }], gaps: [{ t, rate, hours }]
  function timeOfDay({ meals = [], checks = [], gaps = [] }) {
    const gm = xs => Math.exp(median(xs.map(Math.log)));
    const out = {};
    for (const k of Object.keys(BLOCKS)) {
      const ms = meals.filter(m => blockOf(m.ts) === k && m.logged > 0 && m.label > 0);
      const cs = checks.filter(c => blockOf(c.ts) === k && c.ratio > 0);
      const gs = gaps.filter(g => blockOf(g.t) === k);
      const hours = gs.reduce((a, g) => a + g.hours, 0);
      const o = out[k] = {
        carb: ms.length ? { ratio: gm(ms.map(m => m.label / m.logged)), n: ms.length } : { n: 0 },
        ins: cs.length ? { ratio: gm(cs.map(c => c.ratio)), n: cs.length } : { n: 0 },
        basal: hours ? { rate: gs.reduce((a, g) => a + g.rate * g.hours, 0) / hours, hours, n: gs.length } : { n: 0, hours: 0 },
        flags: [],
      };
      if (o.carb.n >= 3 && Math.abs(Math.log(o.carb.ratio)) > 0.12) o.flags.push('carb');
      if (o.ins.n >= 2 && Math.abs(Math.log(o.ins.ratio)) > 0.15) o.flags.push('ins');
      if (o.basal.hours >= 6 && Math.abs(o.basal.rate) >= 0.3) o.flags.push('basal');
    }
    return out;
  }

  /* ─── Kontrola nastavení: citlivost a sacharidový poměr z dat ─── */
  // Citlivost (ISF) z korekcí nalačno — stejně jako test korekčního faktoru u diabetologa: korekce
  // (vaše ≥ 1 U mimo jídlo, nebo shluk korekcí pumpy ≥ 1 U za 20 min), aspoň 4 h po jídle a 3 h bez
  // jídla po ní, glykémie ≥ 8 a před korekcí ustálená (±1,5 mmol/l za h), bez hypoglykémie a pohybu.
  // Za 3 h: pokles glykémie / jednotky, které v okně zapůsobily (korekce, další bolusy, bazál proti
  // sazbě v hodině PŘED korekcí — ne proti dennímu mediánu, ten v sobě nese potřebu bazálu).
  // Úseky nalačno bez korekce ISF neurčí: automatika tam přidává bazál právě podle potřeby.
  function correctionEpisodes({ readings, boluses, basal, basalBase, meals, targets, from, to, tp = 75, cgmLag }) {
    const lag = cgmLag ?? CGM_LAG, W = 180 * MIN, out = [];
    const rd = (readings || []).filter(r => r.t >= from - 90 * MIN && r.t <= to + W + 15 * MIN).sort((a, b) => a.t - b.t);
    const at = t => { // CGM v čase t (lineárně, mezera nejvýš 15 min)
      let i = rd.findIndex(r => r.t >= t);
      if (i < 0) return null;
      if (rd[i].t === t || i === 0) return Math.abs(rd[i].t - t) <= 5 * MIN ? rd[i].v : null;
      const a = rd[i - 1], b = rd[i];
      return b.t - a.t <= 15 * MIN ? a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t) : null;
    };
    const bol = dedupeBoluses(boluses).filter(b => b.t >= from - 5 * 60 * MIN && b.t <= to + W);
    const ms = (meals || []).map(m => m.ts);
    const recs = (basal || []).filter(r => r.t >= from - 6 * 60 * MIN && r.t <= to + W + 20 * MIN).sort((a, b) => a.t - b.t);
    let busyUntil = -Infinity;
    for (const b of bol) {
      if (b.t < from || b.t >= to || b.t < busyUntil) continue;
      const cluster = bol.filter(x => x.t >= b.t && x.t <= b.t + 20 * MIN);
      const own = b.u >= 1, dose = own ? b.u : cluster.reduce((a, x) => a + x.u, 0);
      if (dose < 1) continue;
      if (ms.some(t => t > b.t - 4 * 60 * MIN && t < b.t + W)) continue;                       // jídlo blízko
      if (bol.some(x => x.u >= 1 && x.t >= b.t - 3 * 60 * MIN && x.t < b.t)) continue;           // předchozí korekce ještě působí
      if ((targets || []).some(g => g.t <= b.t + W && g.t + ((g.dur || 0) + 120) * MIN >= b.t - 60 * MIN)) continue;
      const g0 = at(b.t), gPre = at(b.t - 30 * MIN), g1 = at(b.t + W);
      if (g0 == null || gPre == null || g1 == null || g0 < 8) continue;
      if (Math.abs(g0 - gPre) * 2 > 1.5) continue;                                                // před korekcí ustálená
      if (rd.some(r => r.t >= b.t && r.t <= b.t + W && r.v < 4.5)) continue;
      // bazál: sazba v hodině před korekcí jako výchozí
      const pre = recs.filter(r => r.t >= b.t - 60 * MIN && r.t < b.t);
      const preRate = pre.length >= 3 ? pre.reduce((a, r) => a + r.r, 0) / pre.length : basalBase;
      const acted = (t, u) => u * (insulinActed((b.t + W - lag - t) / MIN, tp) - insulinActed((b.t - lag - t) / MIN, tp));
      let E = bol.filter(x => x.t <= b.t + W).reduce((a, x) => a + acted(x.t, x.u), 0);
      if (preRate != null && recs.length) {
        for (let t = b.t - 5 * 60 * MIN; t < b.t + W; t += 5 * MIN) {
          const r = recs.find(x => Math.abs(x.t - t) <= 7.5 * MIN);
          if (r) E += acted(t + 2.5 * MIN, (r.r - preRate) * 5 / 60);
        }
      }
      if (E < 0.5) continue;
      out.push({ t: b.t, own, dose, bg0: g0, dBG: g1 - g0, E, isf: -(g1 - g0) / E });
      busyUntil = b.t + W;
    }
    return out;
  }
  // Souhrn korekcí: medián (odolný vůči jedné zkažené), rozpětí; jisté od 3 korekcí s malým rozptylem.
  function estimateISF(episodes, isfSet) {
    const es = (episodes || []).filter(e => isFinite(e.isf));
    if (!es.length) return { n: 0, set: isfSet };
    const v = es.map(e => Math.min(8, Math.max(0.1, e.isf))).sort((a, b) => a - b);
    const q = p => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))];
    const med = median(v);
    return { n: es.length, own: es.filter(e => e.own).length, isf: med, lo: v[0], hi: v[v.length - 1], set: isfSet,
      reliable: es.length >= 3 && med > 0.2 && (q(0.75) - q(0.25)) / med <= 0.6 };
  }

  // Sacharidový poměr z jídel se známým množstvím: inzulin, který jídlo nakonec potřebovalo
  // (bolus + korekce a bazál pumpy navíc + zbylá glykémie / ISF) vs. známé gramy → g na 1 U.
  // Rovná se poměru z pumpy / (kolikrát víc sacharidů glykémie „ukázala"). checks: [{ ts, ratio, icr }]
  function ratioCheck(checks) {
    const out = {};
    for (const k of Object.keys(BLOCKS)) {
      const cs = (checks || []).filter(c => blockOf(c.ts) === k && c.ratio > 0 && c.icr > 0);
      if (!cs.length) { out[k] = { n: 0 }; continue; }
      const eff = cs.map(c => c.icr / c.ratio).sort((a, b) => a - b);
      out[k] = { n: cs.length, eff: Math.exp(median(eff.map(Math.log))), lo: eff[0], hi: eff[eff.length - 1], set: median(cs.map(c => c.icr)) };
    }
    return out;
  }

  // Osobní rychlost vstřebávání podle druhu jídla z dobře proložených křivek (log-průměr,
  // smrštěný k celkové hodnotě a ta k 1 — s málo daty se nic nemění).
  // samples: [{ ts, kat, speed }] → { global, cats: { kat: { factor, n } } }
  function learnSpeed(samples, now) {
    const prep = samples.filter(s => s.speed > 0).map(s => ({ kat: catKey(s.kat), y: Math.log(s.speed),
      w: Math.pow(0.5, Math.max(0, (now - s.ts) / 86400000) / HALF_LIFE_D) / 0.3 ** 2 }));
    const sw = prep.reduce((a, s) => a + s.w, 0);
    const mu = prep.reduce((a, s) => a + s.w * s.y, 0) / (1 / 0.12 ** 2 + sw); // obecná rychlost se mění opatrně
    const cats = {};
    for (const k of Object.keys(CATS)) {
      const cs = prep.filter(s => s.kat === k);
      const m = (mu / 0.2 ** 2 + cs.reduce((a, s) => a + s.w * s.y, 0)) / (1 / 0.2 ** 2 + cs.reduce((a, s) => a + s.w, 0));
      cats[k] = { factor: Math.min(1.8, Math.max(0.55, Math.exp(m))), n: cs.length };
    }
    return { n: prep.length, global: Math.exp(mu), cats };
  }

  const REL_SD = { confirmed: 0.10, good: 0.25, fair: 0.40 };
  const AI_NOISE = 0.20;   // rozptyl AI mezi jídly (log)
  const PRIOR_G = 0.30, PRIOR_C = 0.20, HALF_LIFE_D = 60;

  // samples: [{ts, kat, aiRaw, label, src: 'confirmed'|'good'|'fair'}] → osobní kalibrace AI
  function calibrate(samples, now) {
    const use = samples.filter(s => s.aiRaw >= 8 && s.label > 0 && REL_SD[s.src]);
    // Nejistota štítku: vlastní (ze společného vyhodnocení), jinak podle kvality.
    const labSd = s => (s.src !== 'confirmed' && s.labSd > 0 ? Math.min(1, s.labSd) : REL_SD[s.src]);
    const prep = use.map(s => {
      const decay = Math.pow(0.5, Math.max(0, (now - s.ts) / 86400000) / HALF_LIFE_D);
      const v = labSd(s) ** 2 + AI_NOISE ** 2;
      return { ...s, kat: catKey(s.kat), y: Math.log(s.label / s.aiRaw), w: decay / v, decay, lab: labSd(s) ** 2 };
    });
    const sw = prep.reduce((a, s) => a + s.w, 0);
    const mu = prep.reduce((a, s) => a + s.w * s.y, 0) / (1 / PRIOR_G ** 2 + sw);
    const cats = {};
    for (const k of Object.keys(CATS)) {
      const cs = prep.filter(s => s.kat === k);
      const cw = cs.reduce((a, s) => a + s.w, 0);
      const m = (mu / PRIOR_C ** 2 + cs.reduce((a, s) => a + s.w * s.y, 0)) / (1 / PRIOR_C ** 2 + cw);
      cats[k] = { factor: clamp(Math.exp(m)), n: cs.length, mu: m };
    }
    // Denní doba: co zbude po korekci podle druhu jídla (např. ráno vyšší inzulinová rezistence,
    // kterou nastavení pumpy úplně nepokrývá) — smrštěno k nule, s málo daty bez vlivu.
    const blocks = {};
    for (const b of Object.keys(BLOCKS)) {
      const bs = prep.filter(s => blockOf(s.ts) === b);
      const m = bs.reduce((a, s) => a + s.w * (s.y - cats[s.kat].mu), 0) / (1 / PRIOR_B ** 2 + bs.reduce((a, s) => a + s.w, 0));
      blocks[b] = { factor: Math.exp(m), n: bs.length, mu: m };
    }
    const resid = s => s.y - cats[s.kat].mu - blocks[blockOf(s.ts)].mu;
    // Osobní přesnost po kalibraci: rozptyl reziduí minus šum samotných „pravd".
    let sd = null;
    if (prep.length >= 5) {
      const dw = prep.reduce((a, s) => a + s.decay, 0);
      const r2 = prep.reduce((a, s) => a + s.decay * resid(s) ** 2, 0) / dw;
      const lab = prep.reduce((a, s) => a + s.decay * s.lab, 0) / dw;
      sd = Math.min(0.6, Math.max(0.10, Math.sqrt(Math.max(0, r2 - lab))));
    }
    // Typická chyba AI před kalibrací (pro srovnání na obrazovce Učení).
    const mapeBefore = prep.length ? median(prep.map(s => Math.abs(Math.exp(s.y) - 1))) : null;
    const mapeAfter = prep.length ? median(prep.map(s => Math.abs(Math.exp(resid(s)) - 1))) : null;
    return { n: prep.length, nConfirmed: prep.filter(s => s.src === 'confirmed').length, global: clamp(Math.exp(mu)), cats, blocks, sd, mapeBefore, mapeAfter };
  }
  const clamp = f => Math.min(1.6, Math.max(0.6, f));
  // Části dne pro kalibraci (místní čas jídla).
  const BLOCKS = { rano: { label: 'Ráno (4–10 h)' }, den: { label: 'Přes den (10–17 h)' }, vecer: { label: 'Večer a v noci (17–4 h)' } };
  const PRIOR_B = 0.15;
  const blockOf = ts => { const h = new Date(ts).getHours(); return h >= 4 && h < 10 ? 'rano' : h >= 10 && h < 17 ? 'den' : 'vecer'; };

  function applyCal(aiRaw, kat, cal, ts) {
    const c = cal && cal.n ? cal.cats[catKey(kat)] : null;
    const b = cal && cal.n && ts != null && cal.blocks ? cal.blocks[blockOf(ts)] : null;
    const factor = clamp((c ? c.factor : 1) * (b ? b.factor : 1));
    return { C: aiRaw * factor, factor, catFactor: c ? c.factor : 1, blockFactor: b ? b.factor : 1, learnedSd: cal && cal.sd != null ? cal.sd : null };
  }

  // Bez inzulinu: osobní citlivost k = medián (plocha pod křivkou / sacharidy) z kvalitních jídel.
  function estimateKNone(evals) {
    const xs = evals.filter(e => e.iauc > 0 && e.label > 0).map(e => e.iauc * (e.absorbed || 0.85) / e.label);
    return xs.length >= 4 ? median(xs) : null;
  }

  // Spojení AI odhadu a odhadu z glykémie (vážené přesností).
  function combine(aiC, aiSigma, implied, quality, relSd) {
    if (!implied || !REL_SD[quality]) return { C: aiC, sigma: aiSigma };
    const si = implied * (relSd > 0 ? Math.max(0.08, relSd) : REL_SD[quality]);
    const wa = 1 / (aiSigma * aiSigma), wi = 1 / (si * si);
    return { C: (aiC * wa + implied * wi) / (wa + wi), sigma: 1 / Math.sqrt(wa + wi) };
  }

  // ─── Export z CareLinku (CSV) ───
  function parseCareLink(text) {
    const lines = text.split(/\r?\n/);
    const sample = lines.slice(0, 60).join('\n');
    const delim = (sample.match(/;/g) || []).length > (sample.match(/,/g) || []).length ? ';' : ',';
    const split = l => l.split(delim).map(c => c.trim().replace(/^"|"$/g, ''));
    const num = s => { if (s == null || s === '') return null; const n = parseFloat(String(s).replace(',', '.')); return isFinite(n) ? n : null; };
    const out = { readings: [], boluses: [], settings: [], carbsEntered: [], unit: null, dateFmt: null };
    let col = null;
    const rows = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      const c = split(l);
      const iDate = c.findIndex(x => /^(date|datum)$/i.test(x));
      const iTime = c.findIndex(x => /^(time|čas|cas|zeit|uhrzeit)$/i.test(x));
      if (iDate >= 0 && iTime >= 0) {
        const find = re => c.findIndex(x => re.test(x));
        col = {
          date: iDate, time: iTime,
          sg: find(/sensor glucose|glukóza senzoru|glukoza senzoru|sensorglukose/i),
          bolus: find(/bolus volume delivered|bolus.*podan|podan.*bolus|bolusvolumen abgegeben/i),
          src: find(/bolus source/i),
          icr: find(/bwz carb ratio|sacharidov.*poměr/i),
          isf: find(/bwz insulin sensitivity|citlivost/i),
          carbs: find(/bwz carb input|sacharid.*zad/i),
        };
        if (col.sg >= 0) out.unit = /mg\/dl/i.test(c[col.sg]) ? 'mgdl' : 'mmol';
        if (col.isf >= 0) col.isfMg = /mg\/dl/i.test(c[col.isf]);
        continue;
      }
      if (!col) continue;
      rows.push({ c, col });
    }
    // Formát data: YYYY/MM/DD, DD.MM.YYYY, nebo xx/xx/YYYY (rozhodne hodnota >12).
    let dmy = true;
    for (const { c, col } of rows) {
      const m = /^(\d{1,2})\/(\d{1,2})\/\d{4}$/.exec(c[col.date] || '');
      if (m && +m[2] > 12) { dmy = false; break; }
      if (m && +m[1] > 12) { dmy = true; break; }
    }
    const parseTs = (ds, ts) => {
      let y, mo, d, m;
      if ((m = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/.exec(ds))) [y, mo, d] = [+m[1], +m[2], +m[3]];
      else if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(ds))) [d, mo, y] = [+m[1], +m[2], +m[3]];
      else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(ds))) { y = +m[3]; [d, mo] = dmy ? [+m[1], +m[2]] : [+m[2], +m[1]]; }
      else return null;
      const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(ts || '');
      if (!t) return null;
      return new Date(y, mo - 1, d, +t[1], +t[2], +(t[3] || 0)).getTime();
    };
    const mg = 18.0182;
    for (const { c, col } of rows) {
      const t = parseTs(c[col.date] || '', c[col.time] || '');
      if (t == null) continue;
      if (col.sg >= 0) { const v = num(c[col.sg]); if (v != null && v > 0) out.readings.push({ t, v: out.unit === 'mgdl' ? v / mg : v }); }
      if (col.bolus >= 0) { const u = num(c[col.bolus]); if (u != null && u > 0) out.boluses.push({ t, u, src: col.src >= 0 ? c[col.src] : '' }); }
      if (col.icr >= 0 && col.isf >= 0) {
        const icr = num(c[col.icr]), isf = num(c[col.isf]);
        if (icr > 0 && isf > 0) out.settings.push({ t, icr, isf: col.isfMg ? isf / mg : isf });
      }
      if (col.carbs >= 0) { const g = num(c[col.carbs]); if (g > 0) out.carbsEntered.push({ t, g }); }
    }
    out.readings.sort((a, b) => a.t - b.t);
    out.boluses.sort((a, b) => a.t - b.t);
    out.settings.sort((a, b) => a.t - b.t);
    return out;
  }

  /* ─── Několik odhadů téže fotky (i od různých AI) → jeden ─── */
  const vendorOf = m => /^claude/i.test(m || '') ? 'claude' : 'gemini';
  const VENDOR_LABEL = { gemini: 'Gemini', claude: 'Claude' };
  // Předpoklad o přesnosti AI, dokud o ní nejsou data: typická log-chyba ~35 %.
  const VW_PRIOR = 0.35 ** 2, VW_K = 4;
  // Váha každé AI podle toho, jak blízko byly její odhady (medián jejích běhů) skutečnosti
  // ověřené glykémií: 1 / střední kvadratická log-chyba, smrštěná k předpokladu (VW_K jídel),
  // takže s málo daty jsou váhy vyrovnané a teprve s ověřenými jídly se rozcházejí.
  // samples: [{ ts, label, runs: [{ m, c }] }]
  function vendorWeights(samples, now) {
    const acc = {};
    for (const s of samples) {
      if (!(s.label > 0) || !s.runs?.length) continue;
      const decay = Math.pow(0.5, Math.max(0, (now - s.ts) / 86400000) / HALF_LIFE_D);
      const by = {};
      for (const r of s.runs) if (r.c > 0) (by[vendorOf(r.m)] ??= []).push(r.c);
      for (const [v, xs] of Object.entries(by)) {
        const e = Math.log(s.label / median(xs));
        const a = acc[v] ??= { w: 0, se: 0, n: 0 };
        a.w += decay; a.se += decay * e * e; a.n++;
      }
    }
    const out = {};
    for (const [v, a] of Object.entries(acc))
      out[v] = { n: a.n, rmse: Math.sqrt(a.se / a.w), weight: (a.w + VW_K) / (a.se + VW_K * VW_PRIOR) };
    return out;
  }

  // Podíly vah pro dané AI (bez dat = předpoklad, tedy vyrovnané).
  function vendorShares(vw, list) {
    const ws = list.map(v => vw[v]?.weight ?? 1 / VW_PRIOR), W = ws.reduce((a, b) => a + b, 0);
    return Object.fromEntries(list.map((v, i) => [v, ws[i] / W]));
  }

  // runs: [{ c, model, min, max, jist (0 nízká – 2 vysoká), kat, ... }] → výsledek:
  // každá AI zvlášť medián svých běhů (potlačí náhodný šum), AI mezi sebou vážený průměr
  // (různé AI chybují jinde, takže se chyby částečně ruší); vw = vendorWeights().
  // SD přes všechny běhy (od 3) zahrnuje i neshodu mezi AI. Reprezentativní odhad
  // (nejblíž výsledku) dá název a poznámku, kategorie je většinová.
  function ensemble(runs, vw = {}) {
    const xs = runs.map(r => r.c).sort((a, b) => a - b), n = xs.length;
    const by = {};
    for (const r of runs) (by[vendorOf(r.model)] ??= []).push(r.c);
    const vendors = Object.entries(by).map(([v, a]) => ({
      v, label: VENDOR_LABEL[v], c: median(a), n: a.length, values: [...a].sort((p, q) => p - q),
      w: vw[v]?.weight ?? 1 / VW_PRIOR,
    }));
    const W = vendors.reduce((s, x) => s + x.w, 0);
    for (const x of vendors) x.share = x.w / W;
    const c = vendors.reduce((s, x) => s + x.share * x.c, 0);
    const mean = xs.reduce((a, x) => a + x, 0) / n;
    const sd = n >= 3 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : null;
    const rep = runs.reduce((b, r) => Math.abs(r.c - c) < Math.abs(b.c - c) ? r : b);
    const votes = {};
    for (const r of runs) votes[r.kat] = (votes[r.kat] || 0) + 1;
    const top = Math.max(...Object.values(votes));
    const kat = votes[rep.kat] === top ? rep.kat : Object.keys(votes).find(k => votes[k] === top);
    // Glykemický index: většina odhadů, které ho uvedly (při shodě rozhodne reprezentativní odhad).
    const gv = {};
    for (const r of runs) { const g = giKey(r.gi); if (g) gv[g] = (gv[g] || 0) + 1; }
    const gtop = Math.max(0, ...Object.values(gv));
    const gi = !gtop ? null : gv[giKey(rep.gi)] === gtop ? giKey(rep.gi) : Object.keys(gv).find(k => gv[k] === gtop);
    const ranged = runs.filter(r => isFinite(r.min) && isFinite(r.max));
    return {
      c, sd, n, values: xs, vendors, rep, kat, gi, jist: Math.round(median(runs.map(r => r.jist))),
      min: ranged.length ? median(ranged.map(r => r.min)) : undefined,
      max: ranged.length ? median(ranged.map(r => r.max)) : undefined,
    };
  }

  root.LEARN = { CATS, catKey, GI_DUR, GI_LABEL, giKey, absDuration, absorbedFrac, clusterOf, windowEnd, postFor, isHeavy, fpu, fpuAbs, learnSpeed, BLOCKS, blockOf, segmentOf, evaluateSegment, dedupeBoluses, basalBaseline, ensemble, vendorWeights, vendorShares, vendorOf, VENDOR_LABEL, insulinActed, segmentAt, evaluateMeal, dayCurves, dayStatsOf, weeklyTrend, timeOfDay, correctionEpisodes, estimateISF, ratioCheck, calibrate, applyCal, estimateKNone, combine, parseCareLink, REL_SD, MIN };
  if (typeof module !== 'undefined') module.exports = root.LEARN;
})(typeof window !== 'undefined' ? window : globalThis);
