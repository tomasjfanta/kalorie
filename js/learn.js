// Zpětná vazba z glykémie: z průběhu CGM kolem jídla (−30 až +150 min) a podaného inzulinu
// odvodí, kolik sacharidů jídlo nejspíš mělo, a z toho se učí osobní korekci AI odhadů.
// Čistě výpočetní modul (bez DOM) — testovatelný v Node.
'use strict';
(function (root) {
  const MIN = 60000;
  const PRE = 30 * MIN, POST = 150 * MIN;

  // Kategorie jídla (vrací je AI) → podíl sacharidů vstřebaných do 150 min.
  // Tuk a bílkoviny vstřebávání zpomalují; pizza je známý „pozdní" případ.
  const CATS = {
    pecivo: { label: 'Pečivo', short: 'pečivo', abs: 0.90 },
    prilohy: { label: 'Přílohy (rýže, těstoviny, brambory, knedlíky)', short: 'přílohy', abs: 0.85 },
    hotove: { label: 'Hotová jídla s omáčkou / masem', short: 'hotová jídla', abs: 0.80 },
    fastfood: { label: 'Pizza, burger, smažené', short: 'pizza a fast food', abs: 0.65 },
    sladke: { label: 'Sladké a dezerty', short: 'sladké', abs: 0.95 },
    ovoce: { label: 'Ovoce', short: 'ovoce', abs: 0.95 },
    mlecne: { label: 'Mléčné', short: 'mléčné', abs: 0.90 },
    napoje: { label: 'Slazené nápoje', short: 'nápoje', abs: 1.00 },
    ostatni: { label: 'Ostatní', short: 'ostatní', abs: 0.85 },
  };
  const catKey = k => CATS[k] ? k : 'ostatni';

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

  // meal: { ts, aiRaw, kat, fat, manual: {bg0, bg2, units} }
  // data: { readings: [{t, v mmol/L}], boluses: [{t, u}], otherMeals: [ts], settingsAt: ts → {icr, isf} }
  // therapy: { type: 'aid'|'insulin'|'none', insulin: 'rapid'|'ultra' }
  function evaluateMeal(meal, data, therapy, kNone) {
    const T = meal.ts;
    const flags = [];
    const rd = (data.readings || []).filter(r => r.t >= T - PRE && r.t <= T + POST).sort((a, b) => a.t - b.t);
    const pre = rd.filter(r => r.t <= T + 5 * MIN);
    const post = rd.filter(r => r.t > T);
    const coverage = Math.min(1, post.length / 30); // CGM Medtronic měří po 5 min → 30 hodnot
    let bg0 = median(pre.map(r => r.v));
    if (bg0 == null && meal.manual?.bg0) bg0 = meal.manual.bg0;

    const res = { ts: T, readings: rd, coverage, bg0, flags, quality: 'none', implied: null };
    if (bg0 == null) { flags.push('chybí glykémie před jídlem'); return res; }

    let peak = null, tPeak = null, end = null, tEnd = T + POST, iauc = 0;
    if (post.length) {
      for (const r of post) if (peak == null || r.v > peak) { peak = r.v; tPeak = r.t; }
      const tail = post.filter(r => r.t >= T + 135 * MIN);
      if (tail.length) {
        end = tail.reduce((a, r) => a + r.v, 0) / tail.length;
        tEnd = tail.reduce((a, r) => a + r.t, 0) / tail.length; // inzulin hodnotit ve stejném čase jako glykémii
      }
      let prev = { t: T, v: bg0 };
      for (const r of post) {
        iauc += ((Math.max(0, prev.v - bg0) + Math.max(0, r.v - bg0)) / 2) * (r.t - prev.t) / MIN;
        prev = r;
      }
    }
    if (end == null && meal.manual?.bg2) { end = meal.manual.bg2; flags.push('ruční glykémie po jídle'); }
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
    const others = data.otherMeals || [];
    if (others.some(t => t > T && t <= T + POST)) { flags.push('další jídlo v okně 2,5 h'); down('poor'); }
    if (others.some(t => t < T && t >= T - 120 * MIN)) { flags.push('předchozí jídlo se ještě vstřebává'); down('fair'); }

    const k = catKey(meal.kat);
    let abs = CATS[k].abs;
    if ((meal.fat || 0) > 30) { abs *= 0.85; flags.push('tučné jídlo — část sacharidů se vstřebá později'); }
    if (abs < 0.75) down('fair');
    res.absorbed = abs;

    if (therapy.type === 'none') {
      // Bez inzulinu: sacharidy z plochy pod křivkou přes osobní citlivost k (mmol/L·min na 1 g).
      if (!kNone) { flags.push('učím se osobní reakci — potřebuji ještě pár jídel'); res.quality = 'none'; return res; }
      res.implied = iauc / kNone / abs;
    } else {
      const set = data.settingsAt ? data.settingsAt(T) : null;
      if (!set || !set.icr || !set.isf) { flags.push('chybí sacharidový poměr nebo citlivost v nastavení léčby'); return res; }
      const tp = therapy.insulin === 'ultra' ? 55 : 75;
      const end2 = tEnd;
      let units = 0, any = false;
      for (const b of data.boluses || []) {
        if (b.t < T - 180 * MIN || b.t > end2) continue;
        // účinek bolusu během okna [T, T+150]; část před jídlem už je v bg0
        const eff = insulinActed((end2 - b.t) / MIN, tp) - insulinActed(Math.max(0, T - b.t) / MIN, tp);
        units += b.u * eff; any = true;
      }
      if (!any && meal.manual?.units) { units = meal.manual.units * insulinActed((end2 - T) / MIN, tp); any = true; flags.push('inzulin zadaný ručně'); }
      if (!any) { flags.push('chybí údaj o inzulinu k jídlu'); return res; }
      if (therapy.type === 'aid') { flags.push('pumpa upravuje bazál automaticky — ten v bilanci chybí'); down('fair'); }
      res.units = units; res.icr = set.icr; res.isf = set.isf;
      // Bilance: Δglykémie = citlivost × (vstřebané sacharidy / poměr − účinný inzulin)
      res.implied = set.icr * (units + (end - bg0) / set.isf) / abs;
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

  root.LEARN = { CATS, catKey, insulinActed, segmentAt, evaluateMeal, calibrate, applyCal, estimateKNone, combine, parseCareLink, REL_SD, MIN };
  if (typeof module !== 'undefined') module.exports = root.LEARN;
})(typeof window !== 'undefined' ? window : globalThis);
