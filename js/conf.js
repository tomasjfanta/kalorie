// Rozhodovací vrstva: jak moc věřit odhadu sacharidů.
// Jev A = „skutečné sacharidy se od odhadu liší nejvýš o ±T g" (výchozí T = 10 g:
// chyba ±10 g na jídlo podle Smart et al., Diabetic Medicine 2009, glykémii po jídle
// měřitelně nemění, ±20 g už ano).
// Každý odhad C má směrodatnou odchylku σ podle zdroje hodnoty a způsobu určení porce;
// chyby bereme jako normální a nezávislé → P(A) = erf(T / (σ·√2)), u jídla σ = √Σσᵢ².
'use strict';
(function (root) {
  // Relativní nejistota obsahu sacharidů na 100 g podle kategorie vestavěné databáze.
  const CAT_SD = {
    'Pečivo': 0.10, 'Mléčné a vejce': 0.06, 'Maso a ryby': 0.10, 'Uzeniny': 0.20,
    'Přílohy a obiloviny': 0.10, 'Luštěniny': 0.12, 'Zelenina': 0.15, 'Ovoce': 0.15,
    'Ořechy a semínka': 0.10, 'Tuky a dochucení': 0.10, 'Sladké a slané': 0.15,
    'Nápoje': 0.06, 'Polévky': 0.30, 'Hotová jídla': 0.25, 'Fast food': 0.20,
  };
  const DISH_CATS = new Set(['Polévky', 'Hotová jídla', 'Fast food']);
  // Obal z Open Food Facts je přepisovaný komunitou → o něco víc než vlastní opis z obalu.
  const SRC_SD = { label: 0.10, custom: 0.07, manual: 0.25 };
  // AI odhad celé porce podle jistoty, kterou model sám uvedl (podlaha — AI nesmí být jistější).
  const AI_SD = {
    'ai-text': { 'vysoká': 0.15, 'střední': 0.25, 'nízká': 0.40 },
    'ai-photo': { 'vysoká': 0.25, 'střední': 0.35, 'nízká': 0.50 },
  };
  // Nejistota množství: zváženo / dané obalem / počet kusů / od oka.
  const PORTION_SD = { weighed: 0.04, pack: 0.03, count: 0.12, eyeball: 0.25, unknown: 0.15 };
  const Z90 = 1.645;

  // Abramowitz–Stegun 7.1.26, chyba < 1,5·10⁻⁷.
  function erf(x) {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }

  function portionKind(label) {
    const l = String(label || '').toLowerCase();
    if (/^100 (g|ml)$/.test(l)) return 'weighed';
    if (/sklenice|sklenka|plechovk|láhev|lahev|kelímek|balení|vanička|tabulk|sáček|panák|šálek|hrnek|půllitr|malé|espresso|tyčinka/.test(l)) return 'pack';
    if (/\bks\b|plátek|krajíc|kostičk|kostka|vejce|bílek|žloutek|stroužek|kopeček|dílek|kolečko|párek|tyčink/.test(l)) return 'count';
    return 'eyeball'; // porce, miska, talíř, hrst, lžíce…
  }

  function kindForFood(food) {
    if (!food) return 'db';
    if (food.src === 'off') return 'label';
    if (food.src === 'custom') return 'custom';
    return DISH_CATS.has(food.cat) ? 'dish' : 'db';
  }

  // info: { C (g sacharidů), kind, cat, pk, jist, sMin, sMax } → { sigma, driver }
  function entrySigma(info) {
    const C = Math.max(0, info.C || 0);
    let sigma, driver = info.kind;
    if (info.kind === 'ai-text' || info.kind === 'ai-photo') {
      const tab = AI_SD[info.kind];
      const floor = tab[info.jist] ?? tab['střední'];
      const rangeSd = info.sMax > info.sMin ? (info.sMax - info.sMin) / (2 * Z90) : 0;
      sigma = Math.max(rangeSd, C * floor);
    } else if (info.kind === 'manual') {
      sigma = C * SRC_SD.manual;
    } else {
      const srcSd = (info.kind === 'db' || info.kind === 'dish') ? (CAT_SD[info.cat] ?? 0.15) : SRC_SD[info.kind] ?? 0.15;
      const portSd = PORTION_SD[info.pk] ?? PORTION_SD.unknown;
      sigma = C * Math.hypot(srcSd, portSd);
      if (portSd > srcSd) driver = info.pk === 'count' ? 'count' : 'portion';
    }
    // Absolutní podlaha: i „přesná" hodnota má zaokrouhlení a odchylku šarže.
    return { sigma: Math.hypot(sigma, C > 0 ? 1 : 0.2), driver };
  }

  const probWithin = (sigma, T) => sigma <= 0 ? 1 : erf(T / (sigma * Math.SQRT2));

  // items: [{C, sigma}] → souhrn jídla nebo dne.
  function combine(items, T) {
    const C = items.reduce((a, x) => a + x.C, 0);
    const sigma = Math.sqrt(items.reduce((a, x) => a + x.sigma * x.sigma, 0));
    return { C, sigma, p: probWithin(sigma, T), lo: Math.max(0, C - Z90 * sigma), hi: C + Z90 * sigma };
  }

  const level = p => p >= 0.85 ? 'ok' : p >= 0.6 ? 'mid' : 'low';
  const LEVEL_LABEL = { ok: 'spolehlivý', mid: 'orientační', low: 'nejistý' };
  const pct = p => Math.min(99, Math.round(p * 100)) + ' %'; // 100 % nikdy netvrdíme

  const KIND_LABEL = {
    label: 'údaj z obalu', custom: 'vaše potravina z obalu', db: 'tabulková hodnota',
    dish: 'hotové jídlo (recept se liší)', manual: 'ruční zápis',
    'ai-text': 'AI odhad z popisu', 'ai-photo': 'AI odhad z fotky',
  };
  const PORTION_LABEL = { weighed: 'zváženo', pack: 'dáno obalem', count: 'počet kusů', eyeball: 'porce od oka', unknown: 'porce neurčená' };
  // Co udělat, aby se odhad zpřesnil — podle toho, co nejistotu nejvíc způsobuje.
  const TIP = {
    portion: 'Porci odhadujete od oka — zvažte ji na kuchyňské váze.',
    count: 'Velikost kusu se liší — zvažte ho, nebo zadejte gramy.',
    dish: 'Hotové jídlo se liší recepturou — zapište přílohu zvlášť (knedlík, rýže, brambory) nebo ji zvažte.',
    'ai-photo': 'Odhad z fotky — doplňte popis (druh a množství přílohy) nebo porci zvažte.',
    'ai-text': 'Odhad z popisu — uveďte gramy nebo konkrétní velikost porce.',
    manual: 'Ruční zápis — ověřte hodnotu na obalu, nebo naskenujte čárový kód.',
    db: 'Tabulková hodnota se liší podle výrobce — máte-li obal, naskenujte čárový kód.',
    label: 'Hodnota z obalu je přesná — zbývající nejistota je hlavně v množství.',
    custom: 'Hodnota z obalu je přesná — zbývající nejistota je hlavně v množství.',
  };

  root.CONF = {
    erf, portionKind, kindForFood, entrySigma, probWithin, combine, level, pct, Z90,
    LEVEL_LABEL, KIND_LABEL, PORTION_LABEL, TIP, DISH_CATS,
  };
  if (typeof module !== 'undefined') module.exports = root.CONF;
})(typeof window !== 'undefined' ? window : globalThis);
