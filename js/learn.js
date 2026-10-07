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
  function absDuration(m) {
    let D = GI_DUR[giKey(m.gi)] ?? CATS[catKey(m.kat)].dur;
    const fat = m.fat || 0;
    if (fat >= 40) D += 75; else if (fat >= 25) D += 45; // tuk vyprazdňování žaludku zpomaluje
    return D;
  }
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

  // Jídla, která se v okně 2,5 h překrývají, se vyhodnocují společně (jinak by si „kradla" glykémii).
  // meals: [{ id, ts, ... }] — ostatní jídla; vrací seřazené členy shluku včetně `meal`.
  function clusterOf(meal, meals) {
    const all = [meal, ...(meals || []).filter(m => m.id !== meal.id)];
    const set = [meal];
    for (let grew = true; grew;) {
      grew = false;
      for (const m of all) {
        if (set.includes(m)) continue;
        if (set.some(c => Math.abs(m.ts - c.ts) <= POST)) { set.push(m); grew = true; }
      }
    }
    return set.sort((a, b) => a.ts - b.ts);
  }

  // meal: { id, ts, aiRaw, s, kat, gi, fat, manual: {bg0, bg2, units} }
  // data: { readings: [{t, v mmol/L}], boluses: [{t, u, src}], basal: [{t, r U/h}] | null, basalBase,
  //         meals: ostatní jídla [{ id, ts, aiRaw, s, conf, kat, gi, fat }], settingsAt: ts → {icr, isf} }
  // therapy: { type: 'aid'|'insulin'|'none', insulin: 'rapid'|'ultra' }
  // Bilance okna od prvního jídla shluku do 2,5 h po posledním:
  //   poměr × (účinný inzulin + Δglykémie / citlivost) = vstřebané sacharidy všech jídel.
  // Jídla s ověřenou hodnotou (a dovstřebávání předchozích) jsou známá; neznámá mají sacharidy
  // k × odhad AI (společné k — AI se u jednoho člověka v jednom okně plete podobně).
  function evaluateMeal(meal, data, therapy, kNone) {
    const T = meal.ts;
    const flags = [];
    const others = (data.meals || []).filter(m => m.id !== meal.id);
    const cluster = clusterOf(meal, others);
    const T0 = cluster[0].ts, TL = cluster[cluster.length - 1].ts;
    const rd = (data.readings || []).filter(r => r.t >= T0 - PRE && r.t <= TL + POST).sort((a, b) => a.t - b.t);
    const pre = rd.filter(r => r.t <= T0 + 5 * MIN);
    const post = rd.filter(r => r.t > T0);
    const coverage = Math.min(1, post.length / ((TL - T0 + POST) / (5 * MIN)));
    // Glykémie přesně v čase jídla: přímka přes hodnoty z půlhodiny před ním (medián by ji při
    // klesající nebo stoupající glykémii posunul o ~12 min dřív, než od kdy se počítá inzulin).
    let bg0 = median(pre.map(r => r.v));
    if (pre.length >= 3) {
      const mt = pre.reduce((a, r) => a + r.t, 0) / pre.length, mv = pre.reduce((a, r) => a + r.v, 0) / pre.length;
      const sxx = pre.reduce((a, r) => a + (r.t - mt) ** 2, 0);
      if (sxx > 0) bg0 = mv + pre.reduce((a, r) => a + (r.t - mt) * (r.v - mv), 0) / sxx * (T0 - mt);
    }
    if (bg0 == null && meal.manual?.bg0) bg0 = meal.manual.bg0;
    const res = { ts: T, readings: rd, coverage, bg0, flags, quality: 'none', implied: null,
      dur: absDuration(meal), gi: giKey(meal.gi), cluster: cluster.filter(m => m !== meal).map(m => m.ts) };
    if (bg0 == null) { flags.push('chybí glykémie před jídlem'); return res; }

    // Ukazatele pro toto jídlo (graf, vrchol); bilance se počítá za celé okno shluku.
    let peak = null, tPeak = null, iauc = 0;
    const own = rd.filter(r => r.t > T && r.t <= T + POST);
    for (const r of own) if (peak == null || r.v > peak) { peak = r.v; tPeak = r.t; }
    let prev = { t: T, v: bg0 };
    for (const r of own) { iauc += ((Math.max(0, prev.v - bg0) + Math.max(0, r.v - bg0)) / 2) * (r.t - prev.t) / MIN; prev = r; }
    let end = null, tEnd = TL + POST;
    const tail = post.filter(r => r.t >= TL + 135 * MIN);
    if (tail.length) {
      end = tail.reduce((a, r) => a + r.v, 0) / tail.length;
      tEnd = tail.reduce((a, r) => a + r.t, 0) / tail.length; // inzulin hodnotit ve stejném čase jako glykémii
    }
    if (end == null && meal.manual?.bg2 && cluster.length === 1) { end = meal.manual.bg2; flags.push('ruční glykémie po jídle'); }
    Object.assign(res, { peak, tPeak, end, iauc, rise: peak != null ? peak - bg0 : null, delta: end != null ? end - bg0 : null });

    if (end == null) { flags.push(post.length ? 'chybí hodnoty ke konci okna (2–2,5 h)' : 'chybí glykémie po jídle'); return res; }
    if (!meal.manual?.bg2 && coverage < 0.6) { flags.push('málo hodnot z CGM'); return res; }
    if (bg0 < 3.9) { flags.push('hypoglykémie před jídlem'); return res; }

    let quality = 'good';
    const down = q => { const order = ['good', 'fair', 'poor']; if (order.indexOf(q) > order.indexOf(quality)) quality = q; };
    if (pre.length >= 3) {
      const slope = (pre[pre.length - 1].v - pre[0].v) / Math.max(1, (pre[pre.length - 1].t - pre[0].t) / MIN);
      res.preSlope = slope;
      if (Math.abs(slope) > 0.04) { flags.push('glykémie se před jídlem rychle měnila'); down('poor'); }
    }
    // Ustálení na konci okna: sklon za posledních 30 min (mmol/l za 15 min).
    const last = post.filter(r => r.t >= tEnd - 30 * MIN);
    if (last.length >= 3) {
      const mt = last.reduce((a, r) => a + r.t, 0) / last.length, mv = last.reduce((a, r) => a + r.v, 0) / last.length;
      const sxx = last.reduce((a, r) => a + (r.t - mt) ** 2, 0), sxy = last.reduce((a, r) => a + (r.t - mt) * (r.v - mv), 0);
      res.endSlope15 = sxx > 0 ? sxy / sxx * 15 * MIN : 0;
      res.stable = Math.abs(res.endSlope15) <= 0.5;
      if (Math.abs(res.endSlope15) > 1.0) { flags.push(res.endSlope15 > 0 ? 'na konci okna glykémie ještě stoupá' : 'na konci okna glykémie ještě klesá'); down('fair'); }
    }
    if (TL - T0 > CLUSTER_MAX) { flags.push('jídla na sebe navazují déle než 4 h — nedají se spolehlivě rozdělit'); down('poor'); }

    // Vstřebané sacharidy v okně: známé části a neznámé (k × odhad AI).
    const est = m => m.aiRaw > 0 ? m.aiRaw : (m.s > 0 ? m.s : 0);
    const inWin = m => absorbedFrac((tEnd - m.ts) / MIN, absDuration(m)) - absorbedFrac(Math.max(0, T0 - m.ts) / MIN, absDuration(m));
    let known = 0, unknownW = 0;
    const unknown = [];
    for (const m of cluster) {
      if (m !== meal && (m.conf != null || !(m.aiRaw > 0))) known += (m.conf != null ? m.conf : est(m)) * inWin(m);
      else if (est(m) > 0) { unknown.push(m); unknownW += est(m) * inWin(m); }
    }
    let priorC = 0;
    for (const m of others) {
      if (cluster.includes(m) || m.ts >= T0 || m.ts < T0 - PRIOR_WIN) continue;
      priorC += (m.conf != null ? m.conf : est(m)) * inWin(m);
    }
    known += priorC;
    res.absorbed = inWin(meal);
    res.priorCarbs = priorC;
    if (priorC > 5) { flags.push(`započteno dovstřebávání dřívějšího jídla (~${Math.round(priorC)} g)`); if (priorC > 15) down('fair'); }
    if (unknown.length > 1) { flags.push('vyhodnoceno společně s dalším jídlem v okně — rozděleno podle odhadů AI'); down('fair'); }
    else if (cluster.length > 1) flags.push('v okně je i jiné, už ověřené jídlo — započteno');
    if (res.absorbed < 0.7) { flags.push(`pomalé jídlo — do konce okna se vstřebá jen ~${Math.round(res.absorbed * 100)} %`); down('fair'); }

    if (therapy.type === 'none') {
      // Bez inzulinu: sacharidy z plochy pod křivkou přes osobní citlivost k (mmol/L·min na 1 g).
      if (cluster.length > 1 || priorC > 5) { flags.push('bez inzulinu umím vyhodnotit jen samostatné jídlo'); return res; }
      if (!kNone) { flags.push('učím se osobní reakci — potřebuji ještě pár jídel'); res.quality = 'none'; return res; }
      res.implied = iauc / kNone / res.absorbed;
    } else {
      const set = data.settingsAt ? data.settingsAt(T0) : null;
      if (!set || !set.icr || !set.isf) { flags.push('chybí sacharidový poměr nebo citlivost v nastavení léčby'); return res; }
      const tp = therapy.insulin === 'ultra' ? 55 : 75;
      const acted = t => insulinActed((tEnd - t) / MIN, tp) - insulinActed(Math.max(0, T0 - t) / MIN, tp);
      const ins = { meal: 0, corr: 0, pre: 0, basal: 0 }, del = { meal: 0, corr: 0, basal: 0 };
      let any = false;
      for (const b of dedupeBoluses(data.boluses)) {
        if (b.t < T0 - PRIOR_WIN || b.t > tEnd) continue;
        // Dávka k jídlu = do 20 min od jídla a aspoň 1 U; automatické korekce 780G jsou skoro vždy
        // pod 1 U (uploader je od ručních bolusů neodliší, export z CareLinku ano — podle „src").
        const atMeal = cluster.some(m => Math.abs(b.t - m.ts) <= 20 * MIN) && b.u >= 1 && !/auto|closed_loop|micro/i.test(b.src || '');
        const cls = atMeal ? 'meal' : b.t < T0 - 20 * MIN ? 'pre' : 'corr';
        ins[cls] += b.u * acted(b.t);
        if (cls !== 'pre') del[cls] += b.u;
        any = true;
      }
      if (!any && meal.manual?.units) { ins.meal = meal.manual.units * acted(T); del.meal = meal.manual.units; any = true; flags.push('inzulin zadaný ručně'); }
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
            ins.basal += dose * acted(t + slot / 2);
            if (t >= T0 - 20 * MIN) del.basal += dose;
          }
        }
      }
      if (therapy.type === 'aid' && !basalOk) { flags.push('chybí údaje o automatickém bazálu — v bilanci chybí'); down('fair'); }
      const units = ins.meal + ins.corr + ins.pre + ins.basal;
      Object.assign(res, { units, ins, del, icr: set.icr, isf: set.isf, basalOk });
      // Kolik sacharidů dávka k jídlu „předpokládala" a kolik musela pumpa automaticky dorovnat.
      res.coveredCarbs = set.icr * del.meal;
      res.extraCarbs = set.icr * (del.corr + del.basal);
      const absorbedTotal = set.icr * (units + (end - bg0) / set.isf);
      if (!(unknownW > 0)) { flags.push('chybí odhad sacharidů jídla'); return res; }
      res.k = (absorbedTotal - known) / unknownW;
      res.implied = res.k * est(meal);
      res.share = unknown.length > 1 ? est(meal) * inWin(meal) / unknownW : 1;
    }
    if (!(res.implied > 0)) { flags.push('bilance nedává smysl (záporné sacharidy)'); res.implied = null; return res; }
    res.quality = quality;
    return res;
  }

  const REL_SD = { confirmed: 0.10, good: 0.25, fair: 0.40 };
  const AI_NOISE = 0.20;   // rozptyl AI mezi jídly (log)
  const PRIOR_G = 0.30, PRIOR_C = 0.20, HALF_LIFE_D = 60;

  // samples: [{ts, kat, aiRaw, label, src: 'confirmed'|'good'|'fair'}] → osobní kalibrace AI
  function calibrate(samples, now) {
    const use = samples.filter(s => s.aiRaw >= 8 && s.label > 0 && REL_SD[s.src]);
    const prep = use.map(s => {
      const decay = Math.pow(0.5, Math.max(0, (now - s.ts) / 86400000) / HALF_LIFE_D);
      const v = REL_SD[s.src] ** 2 + AI_NOISE ** 2;
      return { ...s, kat: catKey(s.kat), y: Math.log(s.label / s.aiRaw), w: decay / v, decay, lab: REL_SD[s.src] ** 2 };
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
    // Osobní přesnost po kalibraci: rozptyl reziduí minus šum samotných „pravd".
    let sd = null;
    if (prep.length >= 5) {
      const dw = prep.reduce((a, s) => a + s.decay, 0);
      const r2 = prep.reduce((a, s) => a + s.decay * (s.y - cats[s.kat].mu) ** 2, 0) / dw;
      const lab = prep.reduce((a, s) => a + s.decay * s.lab, 0) / dw;
      sd = Math.min(0.6, Math.max(0.10, Math.sqrt(Math.max(0, r2 - lab))));
    }
    // Typická chyba AI před kalibrací (pro srovnání na obrazovce Učení).
    const mapeBefore = prep.length ? median(prep.map(s => Math.abs(Math.exp(s.y) - 1))) : null;
    const mapeAfter = prep.length ? median(prep.map(s => Math.abs(Math.exp(s.y - cats[s.kat].mu) - 1))) : null;
    return { n: prep.length, nConfirmed: prep.filter(s => s.src === 'confirmed').length, global: clamp(Math.exp(mu)), cats, sd, mapeBefore, mapeAfter };
  }
  const clamp = f => Math.min(1.6, Math.max(0.6, f));

  function applyCal(aiRaw, kat, cal) {
    const c = cal && cal.n ? cal.cats[catKey(kat)] : null;
    const factor = c ? c.factor : 1;
    return { C: aiRaw * factor, factor, learnedSd: cal && cal.sd != null ? cal.sd : null };
  }

  // Bez inzulinu: osobní citlivost k = medián (plocha pod křivkou / sacharidy) z kvalitních jídel.
  function estimateKNone(evals) {
    const xs = evals.filter(e => e.iauc > 0 && e.label > 0).map(e => e.iauc * (e.absorbed || 0.85) / e.label);
    return xs.length >= 4 ? median(xs) : null;
  }

  // Spojení AI odhadu a odhadu z glykémie (vážené přesností).
  function combine(aiC, aiSigma, implied, quality) {
    if (!implied || !REL_SD[quality]) return { C: aiC, sigma: aiSigma };
    const si = implied * REL_SD[quality];
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

  root.LEARN = { CATS, catKey, GI_DUR, GI_LABEL, giKey, absDuration, absorbedFrac, clusterOf, dedupeBoluses, basalBaseline, ensemble, vendorWeights, vendorShares, vendorOf, VENDOR_LABEL, insulinActed, segmentAt, evaluateMeal, calibrate, applyCal, estimateKNone, combine, parseCareLink, REL_SD, MIN };
  if (typeof module !== 'undefined') module.exports = root.LEARN;
})(typeof window !== 'undefined' ? window : globalThis);
