// Kalorie — hlavní logika aplikace. Data zůstávají v localStorage telefonu.
'use strict';

/* ═══ Pomocníci ═══ */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const store = {
  get(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
};
const pad2 = n => String(n).padStart(2, '0');
const dstr = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const parseD = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseD(s); d.setDate(d.getDate() + n); return dstr(d); };
const WD = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];
const todayStr = () => dstr(new Date());
function fmtHuman(s) {
  if (s === todayStr()) return 'Dnes';
  if (s === addDays(todayStr(), -1)) return 'Včera';
  const d = parseD(s);
  return WD[d.getDay()] + ' ' + d.getDate() + '. ' + (d.getMonth() + 1) + '.';
}
const r0 = n => Math.round(n);
const r1 = n => Math.round(n * 10) / 10;
// Čte číslo z inputu s podporou české čárky (68,5) i tečky. Prázdné → 0.
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.').replace(/\s/g, '')); return isFinite(n) ? n : 0; };
const numEl = sel => num($(sel).value);
// Zobrazení čísla česky (desetinná čárka).
const dec = n => String(n).replace('.', ',');

/* ═══ Stav ═══ */
let settings = store.get('kal.settings', { kcal: null, prot: null, water: 2000 });
let days = store.get('kal.days', {});
let custom = store.get('kal.custom', []);
let products = store.get('kal.products', []);
let favs = store.get('kal.favs', []);
let recent = store.get('kal.recent', []);
let aiCfg = store.get('kal.ai', { key: '', model: 'gemini-2.5-flash' });
// Migrace ze starší verze, která používala Anthropic — klíč i model se liší.
if (!aiCfg.model || aiCfg.model.startsWith('claude')) aiCfg = { key: '', model: 'gemini-2.5-flash' };
let viewDate = todayStr();

const saveAll = () => { store.set('kal.days', days); store.set('kal.custom', custom); store.set('kal.products', products); store.set('kal.favs', favs); store.set('kal.recent', recent); };
const day = (s = viewDate) => (days[s] ??= { e: [], w: 0 });

const MEALS = [['sn', 'Snídaně'], ['ob', 'Oběd'], ['ve', 'Večeře'], ['sv', 'Svačiny']];
const mealByHour = () => { const h = new Date().getHours() + new Date().getMinutes() / 60; return h < 10 ? 'sn' : h < 11.5 ? 'sv' : h < 14.5 ? 'ob' : h < 17.5 ? 'sv' : 've'; };

// Absolutní hodnoty záznamu (quick zápis má hodnoty přímo, jinak přepočet z gramů)
const vals = e => e.q
  ? { k: e.kcal || 0, b: e.b || 0, s: e.s || 0, t: e.t || 0 }
  : { k: e.g * e.k / 100, b: e.g * (e.b || 0) / 100, s: e.g * (e.s || 0) / 100, t: e.g * (e.t || 0) / 100 };
const dayTotals = s => (days[s]?.e || []).reduce((a, e) => { const v = vals(e); a.k += v.k; a.b += v.b; a.s += v.s; a.t += v.t; return a; }, { k: 0, b: 0, s: 0, t: 0 });
const dayBurn = s => (days[s]?.a || []).reduce((a, x) => a + (x.kcal || 0), 0);
// Váha pro výpočet spálených kalorií: poslední zapsané vážení, jinak 70 kg.
function weightForCalc() {
  const withKg = Object.keys(days).filter(d => days[d].kg).sort();
  return withKg.length ? days[withKg[withKg.length - 1]].kg : null;
}

/* ═══ Toast ═══ */
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 1900);
}

/* ═══ Sheets ═══ */
const openSheet = id => { $('#' + id).classList.remove('hidden'); };
const closeSheet = id => { $('#' + id).classList.add('hidden'); };
$$('.sheet').forEach(s => s.addEventListener('click', e => { if (e.target === s) s.classList.add('hidden'); }));
$$('[data-close]').forEach(b => b.addEventListener('click', () => closeSheet(b.dataset.close)));

/* ═══ Přepínání záložek ═══ */
function showView(name) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.view === name));
  const isDnes = name === 'dnes';
  $('#bar-dnes').classList.toggle('hidden', !isDnes);
  $('#bar-title').classList.toggle('hidden', isDnes);
  $('#bar-title').textContent = { historie: 'Historie', vaha: 'Váha', nastaveni: 'Nastavení' }[name] || '';
  if (name === 'historie') renderHistory();
  if (name === 'vaha') renderWeight();
  if (name === 'nastaveni') fillSettings();
  window.scrollTo(0, 0);
}
$$('.tab').forEach(t => t.addEventListener('click', () => showView(t.dataset.view)));
document.addEventListener('click', e => { const g = e.target.closest('[data-goto]'); if (g) showView(g.dataset.goto); });

/* ═══ Navigace dnů ═══ */
$('#date-prev').addEventListener('click', () => { viewDate = addDays(viewDate, -1); renderDnes(); });
$('#date-next').addEventListener('click', () => { if (viewDate < todayStr()) { viewDate = addDays(viewDate, 1); renderDnes(); } });
$('#date-label').addEventListener('click', () => { viewDate = todayStr(); renderDnes(); });

/* ═══ DNES ═══ */
const CIRC = 2 * Math.PI * 52;
function renderDnes() {
  $('#date-label').textContent = fmtHuman(viewDate);
  $('#date-next').style.visibility = viewDate < todayStr() ? 'visible' : 'hidden';
  const t = dayTotals(viewDate);
  const goal = settings.kcal;
  const burn = dayBurn(viewDate);
  $('#goal-hint').classList.toggle('hidden', !!goal);

  const fill = $('#ring-fill'); fill.style.strokeDasharray = CIRC;
  if (goal) {
    const budget = goal + burn; // pohyb rozšiřuje denní budget → přesnější celkový deficit
    const frac = Math.min(t.k / budget, 1);
    fill.style.strokeDashoffset = CIRC * (1 - frac);
    const over = t.k > budget;
    fill.style.stroke = over ? 'var(--red)' : t.k > budget * 0.9 ? 'var(--amber)' : 'var(--accent)';
    $('#ring-num').textContent = over ? '+' + r0(t.k - budget) : r0(budget - t.k);
    $('#ring-num').classList.toggle('over', over);
    $('#ring-sub').textContent = over ? 'kcal přes cíl' : 'kcal zbývá';
  } else {
    fill.style.strokeDashoffset = CIRC;
    $('#ring-num').textContent = r0(t.k);
    $('#ring-num').classList.remove('over');
    $('#ring-sub').textContent = 'kcal snědeno';
  }
  $('#stat-eaten').textContent = r0(t.k);
  $('#stat-goal').textContent = goal ? goal : '–';
  $('#stat-burn').textContent = burn ? '+' + r0(burn) : '0';

  // Makra
  const m = $('#macros');
  const targets = goal ? {
    b: settings.prot || r0(goal * 0.25 / 4),
    s: r0(goal * 0.45 / 4),
    t: r0(goal * 0.30 / 9),
  } : null;
  const defs = [['b', 'Bílkoviny', 'var(--blue)'], ['s', 'Sacharidy', 'var(--amber)'], ['t', 'Tuky', '#a86fc9']];
  m.innerHTML = defs.map(([key, label, color]) => {
    const val = r0(t[key]); const tg = targets ? targets[key] : null;
    const pct = tg ? Math.min(100, val / tg * 100) : 0;
    return `<div class="macro"><div class="m-label">${label}</div><div class="m-val">${val}${tg ? ' / ' + tg : ''} g</div><div class="m-bar"><i style="width:${pct}%;background:${color}"></i></div></div>`;
  }).join('');

  // Voda
  const w = day().w || 0;
  const glasses = Math.min(12, Math.max(4, Math.ceil((settings.water || 2000) / 250)));
  $('#water-total').textContent = w + ' / ' + (settings.water || 2000) + ' ml';
  $('#water-row').innerHTML = Array.from({ length: glasses }, (_, i) =>
    `<button class="water-glass ${w >= (i + 1) * 250 ? 'full' : ''}" data-i="${i}">💧</button>`).join('');
  $$('#water-row .water-glass').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.i; const cur = Math.round((day().w || 0) / 250);
    day().w = (i + 1 === cur ? i : i + 1) * 250; saveAll(); renderDnes();
  }));

  // Pohyb
  const acts = day().a || [];
  $('#act-total').textContent = acts.length ? '+' + r0(burn) + ' kcal' : '';
  $('#act-entries').innerHTML = acts.map(x =>
    `<button class="entry" data-aeid="${x.id}"><span><span class="e-name">${esc(x.n)}</span><br><span class="e-sub">${x.min ? x.min + ' min' : 'ručně'}</span></span><span class="e-kcal">+${r0(x.kcal)}</span></button>`
  ).join('');
  $$('#act-entries .entry').forEach(b => b.addEventListener('click', () => editAct(b.dataset.aeid)));

  // Jídla dne
  $('#meals').innerHTML = MEALS.map(([id, label]) => {
    const es = day().e.filter(e => e.meal === id);
    const kc = es.reduce((a, e) => a + vals(e).k, 0);
    const rows = es.map(e => {
      const v = vals(e);
      const sub = e.q ? 'rychlý zápis' : r0(e.g) + ' ' + (e.u || 'g');
      return `<button class="entry" data-eid="${e.id}"><span><span class="e-name">${esc(e.n)}</span><br><span class="e-sub">${sub}</span></span><span class="e-kcal">${r0(v.k)}</span></button>`;
    }).join('');
    return `<div class="card meal-card"><div class="meal-head"><span class="meal-name">${label}</span><span class="meal-kcal">${es.length ? r0(kc) + ' kcal' : ''}</span></div>${rows}<button class="meal-add" data-meal="${id}">＋ Přidat jídlo</button></div>`;
  }).join('');
  $$('.meal-add').forEach(b => b.addEventListener('click', () => openSearch(b.dataset.meal)));
  $$('.entry').forEach(b => b.addEventListener('click', () => editEntry(b.dataset.eid)));
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ═══ Hledání — jeden sloučený seznam (vestavěná DB + moje + internet) ═══ */
let searchMeal = 'ob', offTimer = null, offSeq = 0;

function openSearch(meal) {
  searchMeal = meal || mealByHour();
  $('#search-input').value = '';
  runSearch();
  openSheet('sheet-add');
  setTimeout(() => $('#search-input').focus(), 250);
}
$('#search-input').addEventListener('input', runSearch);

function allLocalFoods() { return [...custom, ...products, ...DB_FOODS]; }
function foodById(id) { return allLocalFoods().find(f => f.id === id); }

function localSearch(q) {
  const toks = norm(q).split(/\s+/).filter(Boolean);
  const scored = [];
  for (const f of allLocalFoods()) {
    const hay = f._q || (f._q = norm(f.n + ' ' + (f.brand || '')));
    if (!toks.every(t => hay.includes(t))) continue;
    let score = hay.startsWith(toks[0]) ? 0 : new RegExp('\\b' + toks[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(hay) ? 1 : 2;
    if (f.src === 'custom' || f.src === 'off') score -= 0.5;
    scored.push([score, f]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, 60).map(x => x[1]);
}

function resultRow(f) {
  const sub = [f.brand, r0(f.k) + ' kcal / 100 ' + (f.u || 'g')].filter(Boolean).join(' · ');
  return `<button class="result" data-fid="${esc(f.id)}"><span><span class="r-name">${esc(f.n)}</span><br><span class="r-sub">${sub}</span></span><span class="r-kcal">${f.port?.length ? r0(f.k * f.port[0][1] / 100) + ' <small>/' + esc(f.port[0][0]) + '</small>' : ''}</span></button>`;
}
function bindResults(container, foods) {
  container.querySelectorAll('.result').forEach(b => b.addEventListener('click', () => {
    const f = foods.find(x => x.id === b.dataset.fid) || foodById(b.dataset.fid);
    if (f) openFoodDetail(f, { meal: searchMeal });
  }));
}

function runSearch() {
  const q = $('#search-input').value.trim();
  const box = $('#search-results');
  clearTimeout(offTimer);
  offSeq++; // zneplatní případnou běžící internetovou odpověď

  // Prázdné pole → naposledy / oblíbené / moje
  if (!q) {
    const favFoods = favs.map(foodById).filter(Boolean);
    const recFoods = recent.slice(0, 12);
    let html = '';
    if (recFoods.length) html += '<div class="group-label">Naposledy</div>' + recFoods.map(resultRow).join('');
    if (favFoods.length) html += '<div class="group-label">Oblíbené ★</div>' + favFoods.map(resultRow).join('');
    if (custom.length) html += '<div class="group-label">Moje potraviny</div>' + custom.slice(0, 8).map(resultRow).join('');
    if (!html) html = '<div class="result-note">Začněte psát — třeba „rohlík“ nebo „skyr“.<br>Hledá se najednou ve vestavěné databázi, vašich potravinách i na internetu.</div>';
    box.innerHTML = html;
    bindResults(box, [...recFoods, ...favFoods, ...custom]);
    return;
  }

  // 1) Místní výsledky okamžitě (vestavěná DB + moje + uložené produkty)
  const list = localSearch(q);
  box.innerHTML = (list.length ? list.map(resultRow).join('') : '')
    + '<div id="off-zone"><div class="result-note">Hledám i na internetu…</div></div>';
  bindResults(box, list);

  // 2) Internet (Open Food Facts) se připojí, jakmile odpoví
  const seq = ++offSeq;
  offTimer = setTimeout(async () => {
    const res = await offSearch(q);
    if (seq !== offSeq) return;
    const zone = $('#off-zone');
    if (!zone) return;
    if (res === null) {
      zone.innerHTML = list.length
        ? '<div class="result-note">Internetová databáze teď neodpovídá — zobrazeny výsledky z telefonu.</div>'
        : (navigator.onLine
          ? '<div class="result-note">Nenalezeno v telefonu a internetová databáze neodpovídá. Zkuste to za chvíli, nebo použijte 📷 čárový kód, ⚡ rychlý zápis či 🤖 odhad.</div>'
          : '<div class="result-note">Jste offline — zobrazeny jen výsledky z telefonu.</div>');
      return;
    }
    const seen = new Set(list.map(f => f.id));
    const fresh = res.filter(f => !seen.has(f.id));
    if (!fresh.length) {
      zone.innerHTML = list.length ? '' : '<div class="result-note">Nic nenalezeno. Zkuste jiný název, 📷 čárový kód, nebo 🤖 odhad z popisu.</div>';
      return;
    }
    zone.innerHTML = '<div class="group-label">Z internetu (Open Food Facts)</div>' + fresh.map(resultRow).join('');
    bindResults(zone, fresh);
  }, 450);
}

/* ═══ Open Food Facts ═══ */
function parseOffProduct(p) {
  const n = p.nutriments || {};
  let k = n['energy-kcal_100g'];
  if (k == null && n.energy_100g != null) k = n.energy_100g / 4.184;
  if (k == null) return null;
  const qty = (p.quantity || '').toLowerCase();
  const u = /\d\s*(ml|cl|l)\b/.test(qty) ? 'ml' : 'g';
  const port = [];
  const sq = parseFloat(p.serving_quantity);
  if (sq > 0 && sq < 2000) port.push(['porce ' + r0(sq) + ' ' + u, r0(sq)]);
  return {
    id: 'off' + p.code, code: p.code,
    n: p.product_name_cs || p.product_name || 'Produkt ' + p.code,
    brand: (p.brands || '').split(',')[0].trim() || undefined,
    k: r1(k), b: r1(n.proteins_100g || 0), s: r1(n.carbohydrates_100g || 0), t: r1(n.fat_100g || 0),
    u, port: port.length ? port : null, src: 'off',
  };
}
const OFF_FIELDS = 'code,product_name,product_name_cs,brands,nutriments,quantity,serving_quantity';
// Pozn.: používáme doménu world + lc=cs (české názvy). cc=cz NE — přesměrovává na cz.* bez CORS.
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let r;
      try { r = await fetch(url, { signal: ctrl.signal }); } finally { clearTimeout(timer); }
      if (!r.ok) throw new Error('http ' + r.status);
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('json')) throw new Error('not-json'); // Cloudflare výzva / HTML místo dat
      return await r.json();
    } catch (e) {
      if (i < tries - 1) { await sleep(700); continue; }
      return null;
    }
  }
}

async function offSearch(q) {
  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=30&lc=cs&fields=${OFF_FIELDS}`;
  const data = await fetchJson(url);
  if (!data) return null;
  return (data.products || []).map(parseOffProduct).filter(Boolean).slice(0, 25);
}

async function offProduct(ean) {
  const data = await fetchJson(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(ean)}.json?lc=cs&fields=${OFF_FIELDS}`);
  if (!data) return { error: true };
  if (data.status !== 1 || !data.product) return { notFound: true };
  const f = parseOffProduct({ ...data.product, code: ean });
  return f ? { food: f } : { notFound: true };
}

/* ═══ Detail potraviny / úprava záznamu ═══ */
let detail = null; // { food, meal, mode:'unit'|'gram', portIdx, editId, ports }

// Kolik gramů/ml aktuálně zvoleno (podle režimu).
function detailGrams() {
  if (!detail) return 0;
  if (detail.mode === 'gram') return numEl('#food-grams');
  const p = detail.ports[detail.portIdx];
  return (p ? p[1] : 100) * (numEl('#food-count') || 0);
}

function openFoodDetail(food, opts = {}) {
  const ports = [...(food.port || [])];
  if (!ports.some(p => p[1] === 100)) ports.push(['100 ' + (food.u || 'g'), 100]);
  const hasRealPort = !!(food.port && food.port.length);

  let mode = hasRealPort ? 'unit' : 'gram', portIdx = 0, count = 1, gramVal = food.port?.[0]?.[1] || 100;
  if (opts.grams) {  // úprava existujícího záznamu — zkus zrekonstruovat porci
    gramVal = opts.grams;
    const exact = ports.findIndex(p => Math.abs(p[1] - opts.grams) < 0.5 && p[1] !== 100);
    let mult = -1;
    if (exact < 0 && hasRealPort) {
      mult = ports.findIndex(p => p[1] !== 100 && opts.grams / p[1] >= 1 &&
        Math.abs(opts.grams / p[1] - Math.round(opts.grams / p[1])) < 0.02);
    }
    if (exact >= 0) { mode = 'unit'; portIdx = exact; count = 1; }
    else if (mult >= 0) { mode = 'unit'; portIdx = mult; count = Math.round(opts.grams / ports[mult][1]); }
    else { mode = 'gram'; }
  }

  detail = { food, meal: opts.meal || mealByHour(), mode, portIdx, editId: opts.editId || null, ports };
  $('#food-name').textContent = food.n;
  $('#food-sub').textContent = [food.brand, r0(food.k) + ' kcal · B ' + dec(r1(food.b)) + ' · S ' + dec(r1(food.s)) + ' · T ' + dec(r1(food.t)) + ' g (na 100 ' + (food.u || 'g') + ')'].filter(Boolean).join(' · ');
  $('#food-unit').textContent = food.u || 'g';
  $('#food-grams').value = dec(r1(gramVal));
  $('#food-count').value = count;
  $('#food-delete').classList.toggle('hidden', !detail.editId);
  $('#food-submit').textContent = detail.editId ? 'Uložit změny' : 'Přidat';
  $('#food-fav').textContent = favs.includes(food.id) ? '★' : '☆';

  $('#food-portions').innerHTML = ports.map((p, i) => `<button class="chip ${i === detail.portIdx ? 'on' : ''}" data-i="${i}">${esc(p[0])}</button>`).join('');
  $$('#food-portions .chip').forEach(c => c.addEventListener('click', () => {
    detail.portIdx = +c.dataset.i;
    $$('#food-portions .chip').forEach(x => x.classList.toggle('on', x === c));
    previewFood();
  }));
  setMealSeg('#meal-seg', detail.meal);
  setAmountMode(detail.mode);
  openSheet('sheet-food');
}

function setAmountMode(mode) {
  detail.mode = mode;
  $$('#amount-mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  $('#unit-area').classList.toggle('hidden', mode !== 'unit');
  $('#gram-area').classList.toggle('hidden', mode !== 'gram');
  previewFood();
}

function previewFood() {
  const f = detail.food;
  const g = detailGrams();
  if (detail.mode === 'unit') {
    const p = detail.ports[detail.portIdx];
    $('#count-port').textContent = p ? p[0] : '';
    $('#food-total-note').textContent = 'Celkem ' + dec(r1(g)) + ' ' + (f.u || 'g');
  } else {
    $('#food-total-note').textContent = '';
  }
  $('#food-kcal-preview').textContent = r0(g * f.k / 100) + ' kcal';
  $('#food-macro-preview').textContent = 'B ' + dec(r1(g * f.b / 100)) + ' g · S ' + dec(r1(g * f.s / 100)) + ' g · T ' + dec(r1(g * f.t / 100)) + ' g';
}

$$('#amount-mode button').forEach(b => b.addEventListener('click', () => setAmountMode(b.dataset.mode)));
$('#food-grams').addEventListener('input', previewFood);
$('#food-count').addEventListener('input', previewFood);
$('#count-minus').addEventListener('click', () => { $('#food-count').value = Math.max(1, Math.round((numEl('#food-count') || 1)) - 1); previewFood(); });
$('#count-plus').addEventListener('click', () => { $('#food-count').value = Math.max(1, Math.round((numEl('#food-count') || 0)) + 1); previewFood(); });
function setMealSeg(sel, meal) {
  $$(sel + ' button').forEach(b => b.classList.toggle('on', b.dataset.meal === meal));
}
$$('#meal-seg button').forEach(b => b.addEventListener('click', () => { detail.meal = b.dataset.meal; setMealSeg('#meal-seg', detail.meal); }));

$('#food-fav').addEventListener('click', () => {
  const id = detail.food.id;
  favs = favs.includes(id) ? favs.filter(x => x !== id) : [...favs, id];
  if (detail.food.src === 'off' && favs.includes(id) && !products.some(p => p.id === id)) products.unshift(detail.food);
  saveAll();
  $('#food-fav').textContent = favs.includes(id) ? '★' : '☆';
});

$('#food-submit').addEventListener('click', () => {
  const f = detail.food;
  const g = detailGrams();
  if (!g || g <= 0) { toast('Zadejte množství'); return; }
  if (detail.editId) {
    const e = day().e.find(x => x.id === detail.editId);
    if (e) { e.g = g; e.meal = detail.meal; }
    toast('Upraveno');
  } else {
    day().e.push({ id: 'e' + Date.now() + Math.random().toString(36).slice(2, 6), n: f.n, meal: detail.meal, g, u: f.u || 'g', k: f.k, b: f.b, s: f.s, t: f.t, fid: f.id });
    // paměť posledních + auto-uložení internetových produktů
    recent = [{ ...f, port: f.port, _q: undefined }, ...recent.filter(x => x.id !== f.id)].slice(0, 25);
    if (f.src === 'off' && !products.some(p => p.id === f.id)) products.unshift(f);
    toast('Přidáno: ' + f.n);
  }
  saveAll();
  closeSheet('sheet-food'); closeSheet('sheet-add');
  renderDnes();
});
$('#food-delete').addEventListener('click', () => {
  day().e = day().e.filter(x => x.id !== detail.editId);
  saveAll(); closeSheet('sheet-food'); renderDnes(); toast('Smazáno');
});

function editEntry(eid) {
  const e = day().e.find(x => x.id === eid);
  if (!e) return;
  if (e.q) { openQuick(e); return; }
  const food = foodById(e.fid) || { id: e.fid || 'x', n: e.n, k: e.k, b: e.b, s: e.s, t: e.t, u: e.u, src: 'log' };
  openFoodDetail(food, { meal: e.meal, grams: e.g, editId: eid });
}

/* ═══ Rychlý zápis ═══ */
let quickEditId = null;
function openQuick(entry) {
  quickEditId = entry?.id || null;
  $('#quick-name').value = entry?.n && entry.n !== 'Rychlý zápis' ? entry.n : '';
  $('#quick-kcal').value = entry?.kcal || '';
  $('#quick-b').value = entry?.b || ''; $('#quick-s').value = entry?.s || ''; $('#quick-t').value = entry?.t || '';
  setMealSeg('#quick-meal-seg', entry?.meal || searchMeal || mealByHour());
  $('#quick-delete').classList.toggle('hidden', !quickEditId);
  $('#quick-submit').textContent = quickEditId ? 'Uložit změny' : 'Přidat';
  openSheet('sheet-quick');
}
$('#quick-btn').addEventListener('click', () => openQuick(null));
$$('#quick-meal-seg button').forEach(b => b.addEventListener('click', () => setMealSeg('#quick-meal-seg', b.dataset.meal)));
$('#quick-submit').addEventListener('click', () => {
  const kcal = numEl('#quick-kcal');
  if (!kcal || kcal <= 0) { toast('Zadejte kalorie'); return; }
  const meal = $('#quick-meal-seg button.on')?.dataset.meal || mealByHour();
  const data = { n: $('#quick-name').value.trim() || 'Rychlý zápis', meal, q: 1, kcal, b: numEl('#quick-b'), s: numEl('#quick-s'), t: numEl('#quick-t') };
  if (quickEditId) {
    const e = day().e.find(x => x.id === quickEditId);
    if (e) Object.assign(e, data);
  } else {
    day().e.push({ id: 'e' + Date.now() + Math.random().toString(36).slice(2, 6), ...data });
  }
  saveAll(); closeSheet('sheet-quick'); closeSheet('sheet-add'); renderDnes(); toast(quickEditId ? 'Upraveno' : 'Přidáno');
});
$('#quick-delete').addEventListener('click', () => {
  day().e = day().e.filter(x => x.id !== quickEditId);
  saveAll(); closeSheet('sheet-quick'); renderDnes(); toast('Smazáno');
});

/* ═══ Pohyb / aktivity ═══ */
// Záznam: { id, n, min|null, kcal, mid } — mid je index v ACT_DB, null = ruční zápis.
let actState = null;

function openAct(entry) {
  actState = {
    editId: entry?.id || null,
    mode: entry && entry.mid == null ? 'manual' : 'list',
    sel: entry?.mid ?? 0,
  };
  $('#act-search').value = '';
  $('#act-min').value = entry?.min || 30;
  $('#act-name').value = entry && entry.mid == null ? (entry.n === 'Pohyb' ? '' : entry.n) : '';
  $('#act-kcal').value = entry && entry.mid == null ? entry.kcal : '';
  $('#act-min2').value = entry && entry.mid == null ? (entry.min || '') : '';
  $('#act-delete').classList.toggle('hidden', !actState.editId);
  $('#act-submit').textContent = actState.editId ? 'Uložit změny' : 'Přidat';
  setActMode(actState.mode);
  renderActList();
  openSheet('sheet-act');
}

function setActMode(mode) {
  actState.mode = mode;
  $$('#act-mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  $('#act-by-list').classList.toggle('hidden', mode !== 'list');
  $('#act-by-manual').classList.toggle('hidden', mode !== 'manual');
  actPreview();
}

function renderActList() {
  const q = norm($('#act-search').value.trim());
  const kg = weightForCalc() || 70;
  const rows = ACT_DB.map((a, i) => ({ i, n: a[0], met: a[1], hay: norm(a[0] + ' ' + (a[2] || '')) }))
    .filter(x => !q || x.hay.includes(q));
  $('#act-list').innerHTML = rows.length
    ? rows.map(x => `<button class="act-row ${x.i === actState.sel ? 'on' : ''}" data-i="${x.i}"><span>${esc(x.n)}</span><small>~${r0(x.met * kg * 0.5)} kcal / 30 min</small></button>`).join('')
    : '<div class="result-note">Nenalezeno — použijte ruční zápis.</div>';
  $$('#act-list .act-row').forEach(b => b.addEventListener('click', () => {
    actState.sel = +b.dataset.i;
    $$('#act-list .act-row').forEach(x => x.classList.toggle('on', x === b));
    actPreview();
  }));
  const w = weightForCalc();
  $('#act-weight-note').textContent = w
    ? 'Počítáno pro váhu ' + dec(w) + ' kg (poslední vážení).'
    : 'Počítáno pro 70 kg — zapište si váhu v záložce Váha a odhad se zpřesní.';
  actPreview();
}

function actCurrentKcal() {
  if (actState.mode === 'manual') return Math.round(numEl('#act-kcal'));
  const a = ACT_DB[actState.sel];
  const kg = weightForCalc() || 70;
  return Math.round(a[1] * kg * (numEl('#act-min') / 60));
}
function actPreview() { $('#act-preview').textContent = '+' + Math.max(0, actCurrentKcal() || 0) + ' kcal'; }

$('#act-add').addEventListener('click', () => openAct(null));
$$('#act-mode button').forEach(b => b.addEventListener('click', () => setActMode(b.dataset.mode)));
$('#act-search').addEventListener('input', renderActList);
['#act-min', '#act-kcal', '#act-min2'].forEach(sel => $(sel).addEventListener('input', actPreview));

$('#act-submit').addEventListener('click', () => {
  const kcal = actCurrentKcal();
  if (!kcal || kcal <= 0) { toast(actState.mode === 'manual' ? 'Zadejte spálené kalorie' : 'Zadejte dobu trvání'); return; }
  const data = actState.mode === 'manual'
    ? { n: $('#act-name').value.trim() || 'Pohyb', min: Math.round(numEl('#act-min2')) || null, kcal, mid: null }
    : { n: ACT_DB[actState.sel][0], min: Math.round(numEl('#act-min')), kcal, mid: actState.sel };
  const list = (day().a ??= []);
  if (actState.editId) {
    const e = list.find(x => x.id === actState.editId);
    if (e) Object.assign(e, data);
  } else {
    list.push({ id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6), ...data });
  }
  saveAll(); closeSheet('sheet-act'); renderDnes(); toast(actState.editId ? 'Upraveno' : 'Pohyb přidán: +' + kcal + ' kcal');
});
$('#act-delete').addEventListener('click', () => {
  day().a = (day().a || []).filter(x => x.id !== actState.editId);
  saveAll(); closeSheet('sheet-act'); renderDnes(); toast('Smazáno');
});
function editAct(id) {
  const e = (day().a || []).find(x => x.id === id);
  if (e) openAct(e);
}

/* ═══ Vlastní potraviny ═══ */
let custEditId = null;
function openCustom(food) {
  custEditId = food?.id || null;
  $('#cust-name').value = food?.n || '';
  $('#cust-k').value = food?.k ?? ''; $('#cust-b').value = food?.b ?? '';
  $('#cust-s').value = food?.s ?? ''; $('#cust-t').value = food?.t ?? '';
  $('#cust-port').value = food?.port?.[0]?.[1] || '';
  $('#cust-delete').classList.toggle('hidden', !custEditId);
  openSheet('sheet-custom');
}
$('#add-custom').addEventListener('click', () => openCustom(null));
$('#cust-save').addEventListener('click', () => {
  const n = $('#cust-name').value.trim();
  const k = numEl('#cust-k');
  if (!n || !k) { toast('Vyplňte název a kalorie'); return; }
  const port = numEl('#cust-port');
  const f = {
    id: custEditId || 'c' + Date.now(), n, k, b: numEl('#cust-b'), s: numEl('#cust-s'), t: numEl('#cust-t'),
    port: port ? [['porce ' + port + ' g', port]] : null, u: 'g', src: 'custom',
  };
  if (custEditId) { custom = custom.map(x => x.id === custEditId ? f : x); } else { custom.unshift(f); }
  saveAll(); closeSheet('sheet-custom'); renderCustomList(); toast('Uloženo'); runSearchSafe();
});
$('#cust-delete').addEventListener('click', () => {
  custom = custom.filter(x => x.id !== custEditId);
  favs = favs.filter(x => x !== custEditId);
  saveAll(); closeSheet('sheet-custom'); renderCustomList(); toast('Smazáno');
});
const runSearchSafe = () => { if (!$('#sheet-add').classList.contains('hidden')) runSearch(); };
function renderCustomList() {
  const el = $('#custom-list');
  if (!custom.length) { el.textContent = 'Zatím žádné vlastní potraviny.'; return; }
  el.innerHTML = custom.map(f => `<button class="result" data-cid="${f.id}"><span><span class="r-name">${esc(f.n)}</span><br><span class="r-sub">${r0(f.k)} kcal / 100 g</span></span><span class="r-kcal">upravit ›</span></button>`).join('');
  el.querySelectorAll('.result').forEach(b => b.addEventListener('click', () => openCustom(custom.find(x => x.id === b.dataset.cid))));
}

/* ═══ Historie ═══ */
function renderHistory() {
  const today = todayStr();
  const goal = settings.kcal;
  const last7 = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  const tot = last7.map(s => ({ s, k: dayTotals(s).k, has: (days[s]?.e || []).length > 0 }));
  const maxV = Math.max(goal ? goal * 1.15 : 0, ...tot.map(x => x.k), 100);
  const chart = $('#week-chart');
  chart.innerHTML = (goal ? `<div class="wc-goal" style="bottom:${goal / maxV * 100}%"></div>` : '') +
    tot.map(x => `<button class="wc-col" data-d="${x.s}"><div class="wc-bar ${!x.has ? 'empty' : goal && x.k > goal ? 'over' : ''}" style="height:${Math.max(2, x.k / maxV * 100)}%"></div><span class="wc-day">${fmtHuman(x.s).slice(0, 5)}</span></button>`).join('');
  chart.querySelectorAll('.wc-col').forEach(b => b.addEventListener('click', () => { viewDate = b.dataset.d; showView('dnes'); renderDnes(); }));
  const withData = tot.filter(x => x.has);
  $('#week-avg').textContent = withData.length ? 'Průměr: ' + r0(withData.reduce((a, x) => a + x.k, 0) / withData.length) + ' kcal / den' : 'Zatím žádné záznamy.';

  // seznam dnů (posledních 60 se záznamy)
  const listed = Object.keys(days).filter(s => (days[s].e || []).length || days[s].kg || (days[s].a || []).length).sort().reverse().slice(0, 60);
  $('#day-list').innerHTML = listed.length ? listed.map(s => {
    const k = dayTotals(s).k;
    const bs = dayBurn(s);
    const cls = !k ? 'none' : goal ? (k > goal + bs ? 'over' : 'ok') : 'ok';
    const kg = (days[s].kg ? ' · ' + dec(days[s].kg) + ' kg' : '') + (bs ? ' · 🏃 +' + r0(bs) : '');
    return `<button class="day-row" data-d="${s}"><span><span class="dot ${cls}"></span>${fmtHuman(s)}<span class="muted">${kg}</span></span><span class="d-kcal">${k ? r0(k) + ' kcal' : '—'}</span></button>`;
  }).join('') : '<div class="result-note">Historie se objeví, jakmile si zapíšete první jídlo.</div>';
  $('#day-list').querySelectorAll('.day-row').forEach(b => b.addEventListener('click', () => { viewDate = b.dataset.d; showView('dnes'); renderDnes(); }));
}

/* ═══ Váha ═══ */
let weightDays = 30;
$$('#weight-range button').forEach(b => b.addEventListener('click', () => {
  weightDays = +b.dataset.days;
  $$('#weight-range button').forEach(x => x.classList.toggle('on', x === b));
  renderWeight();
}));
$('#weight-save').addEventListener('click', () => {
  const v = numEl('#weight-input');
  if (!v || v < 20 || v > 300) { toast('Zadejte platnou váhu'); return; }
  day(todayStr()).kg = r1(v);
  saveAll(); renderWeight(); toast('Váha uložena');
});
function renderWeight() {
  const t = days[todayStr()]?.kg;
  $('#weight-today-note').textContent = t ? 'Dnes uloženo: ' + dec(t) + ' kg' : '';
  const all = Object.keys(days).filter(s => days[s].kg).sort().map(s => ({ s, kg: days[s].kg }));
  const from = addDays(todayStr(), -weightDays);
  const pts = all.filter(p => p.s >= from);
  const box = $('#weight-chart');
  const stats = $('#weight-stats');
  if (pts.length < 2) {
    box.innerHTML = '<div class="muted center pad">' + (all.length ? 'Za toto období je málo záznamů.' : 'Zapište si první vážení výše. Stačí 1× denně, ideálně ráno.') + '</div>';
    stats.innerHTML = all.length ? `<div class="stat-box"><b>${dec(all[all.length - 1].kg)} kg</b><small>poslední</small></div>` : '';
    return;
  }
  const kgs = pts.map(p => p.kg);
  const min = Math.min(...kgs) - 0.4, max = Math.max(...kgs) + 0.4;
  const W = 600, H = 150, P = 6;
  const t0 = parseD(pts[0].s).getTime(), t1 = parseD(pts[pts.length - 1].s).getTime() || t0 + 1;
  const X = p => P + (W - 2 * P) * (parseD(p.s).getTime() - t0) / Math.max(1, t1 - t0);
  const Y = kg => H - P - (H - 2 * P) * (kg - min) / (max - min);
  const line = pts.map(p => X(p).toFixed(1) + ',' + Y(p.kg).toFixed(1)).join(' ');
  const dots = pts.length <= 40 ? pts.map(p => `<circle cx="${X(p).toFixed(1)}" cy="${Y(p.kg).toFixed(1)}" r="3.2" fill="var(--accent)"/>`).join('') : '';
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>${dots}</svg>`;
  const delta = r1(pts[pts.length - 1].kg - pts[0].kg);
  stats.innerHTML = `
    <div class="stat-box"><b>${dec(pts[pts.length - 1].kg)} kg</b><small>aktuální</small></div>
    <div class="stat-box"><b style="color:${delta < 0 ? 'var(--accent)' : delta > 0 ? 'var(--amber)' : 'inherit'}">${delta > 0 ? '+' : ''}${dec(delta)} kg</b><small>za ${weightDays} dní</small></div>
    <div class="stat-box"><b>${pts.length}</b><small>vážení</small></div>`;
}

/* ═══ Nastavení ═══ */
function fillSettings() {
  $('#set-kcal').value = settings.kcal || '';
  $('#set-prot').value = settings.prot || '';
  $('#set-water').value = settings.water || 2000;
  $('#set-ai-key').value = aiCfg.key || '';
  $('#set-ai-model').value = aiCfg.model || 'gemini-2.5-flash';
  $('#ai-key-note').textContent = aiCfg.key ? '✓ Klíč uložen — AI odhady jsou připravené.' : 'Bez klíče AI odhady nefungují.';
  renderCustomList();
}
$('#save-settings').addEventListener('click', () => {
  settings.kcal = +$('#set-kcal').value || null;
  settings.prot = +$('#set-prot').value || null;
  settings.water = +$('#set-water').value || 2000;
  store.set('kal.settings', settings);
  renderDnes(); toast('Nastavení uloženo'); showView('dnes');
});
$('#save-ai').addEventListener('click', () => {
  aiCfg = { key: $('#set-ai-key').value.trim(), model: $('#set-ai-model').value };
  store.set('kal.ai', aiCfg);
  $('#ai-key-note').textContent = aiCfg.key ? '✓ Klíč uložen — AI odhady jsou připravené.' : 'Bez klíče AI odhady nefungují.';
  toast('Uloženo');
});

/* Kalkulačka (Mifflin-St Jeor) */
let calcSex = 'f';
$$('#calc-sex button').forEach(b => b.addEventListener('click', () => { calcSex = b.dataset.sex; $$('#calc-sex button').forEach(x => x.classList.toggle('on', x === b)); }));
$('#open-calc').addEventListener('click', () => { $('#calc-result').classList.add('hidden'); openSheet('sheet-calc'); });
$('#calc-run').addEventListener('click', () => {
  const age = numEl('#calc-age'), h = numEl('#calc-h'), w = numEl('#calc-w');
  if (!age || !h || !w) { toast('Vyplňte věk, výšku a váhu'); return; }
  const bmr = 10 * w + 6.25 * h - 5 * age + (calcSex === 'm' ? 5 : -161);
  const tdee = bmr * +$('#calc-act').value;
  const target = Math.max(1200, Math.round((tdee + +$('#calc-goal').value) / 10) * 10);
  const prot = Math.round(w * 1.6);
  const el = $('#calc-result');
  el.classList.remove('hidden');
  el.innerHTML = `Váš odhadovaný denní výdej je <b>${r0(tdee)} kcal</b>.<br>Pro zvolený cíl doporučujeme <b>${target} kcal</b> a asi <b>${prot} g bílkovin</b> denně.<br><button id="calc-apply" class="btn" style="margin-top:10px">Použít jako můj cíl</button>`;
  $('#calc-apply').addEventListener('click', () => {
    settings.kcal = target; settings.prot = prot;
    store.set('kal.settings', settings);
    closeSheet('sheet-calc'); fillSettings(); renderDnes(); toast('Cíl nastaven: ' + target + ' kcal');
  });
});

/* Záloha */
$('#export-btn').addEventListener('click', async () => {
  const data = { app: 'kalorie', v: 1, exported: new Date().toISOString(), settings, days, custom, products, favs, recent };
  const json = JSON.stringify(data);
  const name = 'kalorie-zaloha-' + todayStr() + '.json';
  const file = new File([json], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Záloha Kalorie' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
});
$('#import-btn').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'kalorie' || !data.days) throw new Error();
    if (!confirm('Obnovit data ze zálohy? Nahradí to všechna aktuální data v aplikaci.')) return;
    settings = data.settings || settings; days = data.days || {}; custom = data.custom || [];
    products = data.products || []; favs = data.favs || []; recent = data.recent || [];
    store.set('kal.settings', settings); saveAll();
    renderDnes(); fillSettings(); toast('Záloha obnovena');
  } catch { toast('Soubor se nepodařilo načíst'); }
  e.target.value = '';
});
$('#wipe-btn').addEventListener('click', () => {
  if (!confirm('Opravdu smazat úplně všechna data (deník, váhu, nastavení)? Tohle nejde vrátit.')) return;
  ['kal.settings', 'kal.days', 'kal.custom', 'kal.products', 'kal.favs', 'kal.recent', 'kal.ai'].forEach(k => localStorage.removeItem(k));
  location.reload();
});

/* ═══ Export pro scan.js a ai.js ═══ */
window.KAL = {
  offProduct, openFoodDetail, openSheet, closeSheet, toast,
  getMeal: () => searchMeal,
  aiConfig: () => aiCfg,
  openQuick,          // prefill rychlého zápisu z AI výsledku
};

/* ═══ Start ═══ */
renderDnes();
