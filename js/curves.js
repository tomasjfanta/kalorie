// Křivky (režim sacharidů): den po dni — skutečná glykémie z CGM proti předpovědi z toho, co bylo
// zapsané (sacharidy) a co pumpa dala (bolusy, automatický bazál). Pod tím působení každého jídla
// a inzulinu ve stejných jednotkách (mmol/l za hodinu), takže je vidět, kde a o kolik jsme se mýlili.
'use strict';
(function () {
  const K = window.KAL;
  const $ = s => document.querySelector(s);
  const MIN = 60000, DAY = 86400000, MG = 18.0182;
  const esc = K.esc, r0 = K.r0, dec = K.dec;
  let day = null, zoom = null, cache = null, showFit = true, busy = false;

  const dayStart = ds => { const [y, m, d] = ds.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
  const hhmm = t => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const isMg = () => (K.settings().therapy || {}).unit === 'mgdl';
  const uLbl = () => (isMg() ? 'mg/dl' : 'mmol/l');
  const fmt = v => (v == null ? '–' : isMg() ? String(Math.round(v * MG)) : dec(K.r1(v)));
  const sgn = v => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v));

  async function render() {
    if (!window.CARB || busy) return;
    busy = true;
    try {
      day ??= K.todayStr();
      const from = dayStart(day), now = Math.floor(Date.now() / (5 * MIN)) * 5 * MIN;
      const to = Math.min(from + DAY, now);
      const today = day === K.todayStr();
      let h = `<div class="cv-nav"><button id="cv-prev" aria-label="Předchozí den">‹</button><b>${esc(K.fmtHuman(day))}</b><button id="cv-next" aria-label="Další den"${today ? ' disabled' : ''}>›</button></div>`;
      $('#curves-body').innerHTML = h + '<div class="card muted">Počítám křivky…</div>';
      bindNav();
      if (to - from < 30 * MIN) { $('#curves-body').innerHTML = h + '<div class="card muted">Den teprve začal.</div>'; bindNav(); return; }
      const d = await CARB.dayData(from, to);
      const cv = LEARN.dayCurves({ from, to, ...d });
      cache = { cv, d, from, to, head: h };
      draw();
    } finally { busy = false; }
  }

  function bindNav() {
    $('#cv-prev')?.addEventListener('click', () => { day = K.dstr(new Date(dayStart(day) - DAY / 2)); zoom = null; render(); });
    $('#cv-next')?.addEventListener('click', () => { if (day === K.todayStr()) return; day = K.dstr(new Date(dayStart(day) + DAY * 1.5)); zoom = null; render(); });
  }

  function draw() {
    const { cv, d, from, to, head } = cache;
    let h = head;
    if (cv.error) { $('#curves-body').innerHTML = h + `<div class="card">Křivky nejde spočítat: ${esc(cv.error)}.</div>`; bindNav(); return; }
    if (!cv.actual.some(v => v != null)) { $('#curves-body').innerHTML = h + '<div class="card muted">Pro tento den nejsou data z CGM.</div>'; bindNav(); return; }
    const wa = zoom != null ? Math.max(from, zoom - 30 * MIN) : from;
    const wb = zoom != null ? Math.min(to, zoom + 240 * MIN) : to;
    const inW = t => t >= wa && t <= wb;
    const mealIvs = cv.intervals.filter(iv => iv.kind === 'meal');

    // Přiblížení: celý den nebo okno kolem jídla
    h += '<div class="chips cv-chips"><button class="chip' + (zoom == null ? ' on' : '') + '" data-z="">Celý den</button>'
      + mealIvs.map(iv => `<button class="chip${zoom === iv.a ? ' on' : ''}" data-z="${iv.a}">${hhmm(iv.a)}</button>`).join('') + '</div>';

    // ── Graf ──
    const W = 360, L = 28, R = 6, T = 16, H1 = 210, G = 12, H2 = 110, B = 16, H = H1 + G + H2 + B;
    const x = t => L + (W - L - R) * (t - wa) / (wb - wa);
    const idx = cv.grid.map((t, k) => (inW(t) ? k : -1)).filter(k => k >= 0);
    const vals = [...idx.map(k => cv.actual[k]), ...cv.intervals.flatMap(iv => (iv.logged || []).filter(p => inW(p.t)).map(p => p.v))].filter(v => v != null);
    const lo = Math.max(1.5, Math.min(3.5, ...vals) - 0.3), hi = Math.min(22, Math.max(11, ...vals) + 0.5);
    const y1 = v => T + (H1 - T) * (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo));
    const poly = pts => pts.map(p => x(p.t).toFixed(1) + ',' + y1(p.v).toFixed(1)).join(' ');
    let s = '';
    s += `<rect x="${L}" y="${y1(10).toFixed(1)}" width="${W - L - R}" height="${(y1(3.9) - y1(10)).toFixed(1)}" class="bg-band"/>`;
    for (const g of d.targets || []) {
      const a = Math.max(wa, g.t), b = Math.min(wb, g.t + (g.dur || 0) * MIN);
      if (b > a) s += `<rect x="${x(a).toFixed(1)}" y="${T}" width="${(x(b) - x(a)).toFixed(1)}" height="${H1 - T}" class="cv-ex"/>`;
    }
    // rozdíl skutečnost × předpověď (podbarvení) a předpovědi
    for (const iv of cv.intervals) {
      if (!iv.logged) continue;
      const lp = iv.logged.filter(p => inW(p.t));
      if (lp.length < 2) continue;
      const act = lp.map(p => ({ t: p.t, v: cv.actual[Math.round((p.t - from) / (5 * MIN))] })).filter(p => p.v != null);
      if (act.length > 1) s += `<polygon points="${poly(lp)} ${poly([...act].reverse())}" class="cv-gap"/>`;
      s += `<polyline points="${poly(lp)}" class="cv-proj"/>`;
      if (showFit && iv.fit) {
        const fp = iv.fit.filter(p => inW(p.t));
        if (fp.some((p, k) => Math.abs(p.v - lp[k].v) > 0.2)) s += `<polyline points="${poly(fp)}" class="cv-fit"/>`;
      }
    }
    // CGM
    let run = [];
    const flush = () => { if (run.length > 1) s += `<polyline points="${poly(run)}" class="bg-line"/>`; run = []; };
    for (const k of idx) { if (cv.actual[k] == null) flush(); else run.push({ t: cv.grid[k], v: cv.actual[k] }); }
    flush();
    // jídla, nezapsaná jídla, „nic jsem nejedl", bolusy
    const zoomed = zoom != null;
    let lastLbl = -99;
    for (const m of d.meals.filter(m => !m.ghost && inW(m.ts)).sort((a, b) => a.ts - b.ts)) {
      const X = x(m.ts).toFixed(1), g = m.conf != null ? m.conf : m.s;
      s += `<line x1="${X}" x2="${X}" y1="${T}" y2="${H1}" class="bg-meal${m.pump ? ' bg-meal2' : ''}${zoomed ? '' : ' cv-mealday'}"/>`;
      if (x(m.ts) - lastLbl >= (zoomed ? 26 : 20)) { s += `<text x="${(+X + 2).toFixed(1)}" y="${T - 4}" class="bg-lbl">${r0(g)}${zoomed ? ' g' : ''}</text>`; lastLbl = x(m.ts); }
    }
    for (const m of d.meals.filter(m => m.ghost && inW(m.ts))) {
      const X = x(m.ts).toFixed(1);
      s += `<line x1="${X}" x2="${X}" y1="${T}" y2="${H1}" class="cv-ghostline"/><text x="${(+X + 2).toFixed(1)}" y="${T + 8}" class="bg-lbl">?${zoomed ? ' ~' + r0(m.g) + ' g' : ''}</text>`;
    }
    for (const n of (d.noMeal || []).filter(n => inW(n.t))) s += `<text x="${x(n.t).toFixed(1)}" y="${T + 8}" class="bg-lbl" text-anchor="middle">✕</text>`;
    for (const b of LEARN.dedupeBoluses(d.boluses).filter(b => inW(b.t))) {
      const X = x(b.t);
      if (b.u >= 1 && !/auto|closed_loop|micro/i.test(b.src || '')) {
        s += `<path d="M${(X - 3.5).toFixed(1)},${H1} L${(X + 3.5).toFixed(1)},${H1} L${X.toFixed(1)},${H1 - 6} Z" class="bg-bolus"/>`;
        if (zoomed) s += `<text x="${X.toFixed(1)}" y="${H1 - 8}" class="bg-lbl" text-anchor="middle">${dec(K.r1(b.u))}</text>`;
      } else s += `<line x1="${X.toFixed(1)}" x2="${X.toFixed(1)}" y1="${H1}" y2="${H1 - 3}" class="cv-autob"/>`;
    }
    // osa glykémie
    for (const v of [4, 7, 10, 13, 16, 19].filter(v => v > lo && v < hi)) s += `<text x="${L - 3}" y="${(y1(v) + 3).toFixed(1)}" class="bg-tick" text-anchor="end">${fmt(v)}</text>`;

    // ── Působení: sacharidy nahoru, inzulin dolů (mmol/l za hodinu) ──
    const top = H1 + G, mid = top + H2 * 0.55;
    const carbMax = Math.max(1, ...cv.carbs.flatMap(c => idx.map(k => c.rate[k])), ...cv.ghosts.flatMap(c => idx.map(k => c.rate[k])));
    const insMax = Math.max(1, ...idx.map(k => cv.ins[k]));
    const up = v => mid - (H2 * 0.55 - 4) * Math.min(1, v / carbMax), dn = v => mid + (H2 * 0.45 - 4) * Math.min(1, v / insMax);
    const area = (rate, f, cls) => {
      const pts = idx.map(k => [x(cv.grid[k]), f(rate[k])]);
      if (!pts.some(p => Math.abs(p[1] - mid) > 0.3)) return '';
      return `<path d="M${pts[0][0].toFixed(1)},${mid} ${pts.map(p => 'L' + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')} L${pts[pts.length - 1][0].toFixed(1)},${mid} Z" class="${cls}"/>`;
    };
    for (const c of cv.carbs) s += area(c.rate, v => up(Math.max(0, v)), 'cv-act');
    for (const c of cv.ghosts) s += area(c.rate, v => up(Math.max(0, v)), 'cv-ghost');
    s += area(cv.ins, v => dn(Math.max(0, v)), 'cv-ins');
    const bl = idx.map(k => `${x(cv.grid[k]).toFixed(1)},${(cv.insBasal[k] >= 0 ? dn(cv.insBasal[k]) : up(-cv.insBasal[k])).toFixed(1)}`).join(' ');
    s += `<polyline points="${bl}" class="cv-basal"/>`;
    s += `<line x1="${L}" x2="${W - R}" y1="${mid}" y2="${mid}" class="cv-zero"/>`;
    s += `<text x="${L - 3}" y="${top + 8}" class="bg-tick" text-anchor="end">+${fmt(carbMax)}</text><text x="${L - 3}" y="${top + H2 - 2}" class="bg-tick" text-anchor="end">−${fmt(insMax)}</text>`;
    s += `<text x="${L + 3}" y="${top + 8}" class="bg-tick">sacharidy ↑</text><text x="${L + 3}" y="${top + H2 - 2}" class="bg-tick">inzulin ↓ (${uLbl()} za h)</text>`;
    // osa času
    const span = (wb - wa) / MIN, stepM = span > 600 ? 180 : span > 300 ? 60 : 30;
    const t0 = from + Math.ceil((wa - from) / (stepM * MIN)) * stepM * MIN; // od místní půlnoci
    for (let t = t0; t <= wb; t += stepM * MIN) {
      const X = x(t).toFixed(1);
      const anc = +X > W - R - 12 ? 'end' : +X < L + 12 ? 'start' : 'middle';
      s += `<line x1="${X}" x2="${X}" y1="${T}" y2="${top + H2}" class="cv-grid"/><text x="${X}" y="${H - 3}" class="bg-tick" text-anchor="${anc}">${hhmm(t)}</text>`;
    }
    s += `<line id="cv-cursor" x1="-10" x2="-10" y1="${T}" y2="${top + H2}" class="cv-cursor"/>`;
    h += `<div class="card cv-card"><svg id="cv-svg" class="cv-chart" viewBox="0 0 ${W} ${H}">${s}</svg>
      <div id="cv-read" class="cv-read muted">Posuňte prstem po grafu — ukáže hodnoty v daném čase.</div>
      <div class="cv-legend"><span><i style="border-color:var(--blue)"></i>CGM</span><span><i class="dash" style="border-color:var(--amber)"></i>předpověď ze zápisu</span>
      <span><i class="dot" style="border-color:var(--accent)"></i>po přepočtu z glykémie</span><span><b class="sw" style="background:var(--amber)"></b>jídlo</span><span><b class="sw" style="background:var(--blue)"></b>inzulin</span>
      <span><i class="dash" style="border-color:#a86fc9"></i>bazál nad/pod obvyklým</span><span>? nezapsané jídlo</span></div>
      <label class="cv-toggle"><input type="checkbox" id="cv-fit"${showFit ? ' checked' : ''}> ukazovat přepočet z glykémie</label></div>`;

    // ── Kde a o kolik ──
    h += '<div class="card"><div class="card-title">Kde jsme se mýlili</div>';
    if (cv.stats) {
      const w = cv.stats.worst;
      h += `<p>U jídel se předpověď ze zápisu lišila od CGM průměrně o <b>±${fmt(cv.stats.mae)} ${uLbl()}</b>${showFit ? ` (po přepočtu z glykémie ±${fmt(cv.stats.maeFit)})` : ''}. Nejvíc v <b>${hhmm(w.max.t)}</b>: o ${fmt(Math.abs(w.max.d))} ${w.max.d > 0 ? 'výš' : 'níž'}.</p>`;
    }
    const rows = cv.intervals.filter(iv => iv.mae != null && inW(iv.a) && (iv.kind === 'meal' || Math.abs(iv.endDiff) >= 1.5));
    h += rows.map(iv => {
      const names = (iv.meals || []).map(m => (m.pump ? 'pumpa ' : '') + `${esc(m.n || 'jídlo')} ${r0(m.conf != null ? m.conf : m.s)} g`).join(', ');
      const off = iv.endDiff, big = Math.abs(off) >= 1.5;
      const why = !big ? 'sedí' : iv.kind === 'gap' ? (off > 0 ? 'bez jídla stoupala — bazál, dobíhání předchozího jídla nebo nezapsané jídlo' : 'bez jídla klesala — víc inzulinu než obvykle nebo pohyb')
        : off > 0 ? 'výš, než odpovídá zápisu a inzulinu — víc sacharidů, pomalejší vstřebávání nebo slabší inzulin'
          : 'níž — méně sacharidů, rychlejší vstřebávání nebo silnější inzulin (pohyb)';
      return `<button class="learn-row cv-row" data-z="${iv.kind === 'meal' ? iv.a : iv.a + 30 * MIN}"><span>${hhmm(iv.a)}–${hhmm(iv.b)} ${iv.kind === 'gap' ? '<span class="muted">bez jídla</span>' : names}<br>
        <span class="muted small-text">na konci ${sgn(off)} ${uLbl()}${big && iv.kind === 'meal' ? ` (≈ ${off > 0 ? '+' : '−'}${r0(Math.abs(iv.endG))} g)` : ''} · ${why}</span></span><b class="${big ? (off > 0 ? 'cv-up' : 'cv-dn') : ''}">${sgn(off)}</b></button>`;
    }).join('') || '<p class="muted">V tomto okně nejsou jídla s daty z CGM.</p>';
    h += `<p class="muted small-text">Každý úsek začíná skutečnou glykémií v čase jídla a dál počítá jen se zapsanými sacharidy (včetně tuku a bílkovin), bolusy a automatickým bazálem pumpy (rozdíl proti obvyklému). Vliv dřívějších jídel a inzulinu se započítá. Popis z dat, ne doporučení k dávkování.</p></div>`;
    $('#curves-body').innerHTML = h;
    bindNav();
    document.querySelectorAll('#curves-body [data-z]').forEach(b => b.addEventListener('click', () => { zoom = b.dataset.z ? +b.dataset.z : null; draw(); if (b.classList.contains('cv-row')) window.scrollTo({ top: 0, behavior: 'smooth' }); }));
    $('#cv-fit')?.addEventListener('change', e => { showFit = e.target.checked; draw(); });
    bindCursor(x, wa, wb, W);
  }

  // Hodnoty pod prstem
  function bindCursor(x, wa, wb, W) {
    const svg = $('#cv-svg'), { cv, from } = cache;
    const show = ev => {
      const r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) / r.width * W;
      const t = wa + (px - 28) / (W - 28 - 6) * (wb - wa);
      const k = Math.round((t - from) / (5 * MIN));
      if (k < 0 || k >= cv.grid.length || cv.grid[k] < wa || cv.grid[k] > wb) return;
      const tk = cv.grid[k];
      $('#cv-cursor').setAttribute('x1', x(tk)); $('#cv-cursor').setAttribute('x2', x(tk));
      const iv = cv.intervals.find(i => i.logged && tk >= i.a && tk <= i.b);
      const p = iv?.logged.find(q => q.t === tk), a = cv.actual[k];
      const carb = cv.carbs.reduce((s, c) => s + c.rate[k], 0);
      $('#cv-read').innerHTML = `<b>${hhmm(tk)}</b> · CGM ${fmt(a)}${p ? ` · předpověď ${fmt(p.v)}${a != null ? ` (<b>${sgn(a - p.v)}</b>)` : ''}` : ''} ${uLbl()}<br>sacharidy +${fmt(carb)} · inzulin −${fmt(cv.ins[k])} ${uLbl()} za h${cv.insBasal[k] >= 0.05 ? ` (z toho bazál nad obvyklým −${fmt(cv.insBasal[k])})` : cv.insBasal[k] <= -0.05 ? ` · bazál pod obvyklým +${fmt(-cv.insBasal[k])}` : ''}`;
    };
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointermove', ev => { if (ev.pointerType === 'mouse' || ev.buttons || ev.pressure > 0) show(ev); });
  }

  window.CURVES = { render, refresh: () => { if (document.querySelector('#view-krivky.active')) render(); } };
})();
