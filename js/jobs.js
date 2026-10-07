// Fronta AI odhadů a deník chyb AI (oba režimy).
// Fotka (nebo popis) se nejdřív uloží do telefonu a teprve pak se posílá AI. Když se odhad
// nepovede, zkouší se znovu (30 s, 1, 2, 5, 10, 15, 30, 60 min…), dokud neuspěje — po celou dobu,
// kdy je aplikace otevřená. Hotový odhad se buď ukáže (pokud je jeho okno otevřené), nebo se jídlo
// rovnou uloží. Každý pokus o odhad se zapíše do deníku a odešle na server k rozboru chyb.
'use strict';
(function () {
  const K = window.KAL;
  const MIN = 60000;
  const BACKOFF_MIN = [0.5, 1, 2, 5, 10, 15, 30, 60];
  const DIAG_URL = 'https://kalorie-ai-production.up.railway.app/diag';
  const handlers = {};
  const listeners = new Set();
  let busy = false;
  const active = new Set(); // úlohy, které právě běží

  /* ─── Deník AI ─── */
  const dev = (() => {
    let d = K.store.get('kal.dev', null);
    if (!d) { d = 'd' + Math.random().toString(36).slice(2, 10); K.store.set('kal.dev', d); }
    return d;
  })();
  // Klíče a tokeny se do deníku nesmí dostat ani omylem (např. v chybové hlášce).
  const scrub = s => String(s ?? '').replace(/AIza[0-9A-Za-z_\-]{20,}/g, '<key>').replace(/sk-ant-[0-9A-Za-z_\-]+/g, '<key>')
    .replace(/([?&](key|token|secret)=)[^&\s"']+/gi, '$1<hidden>').slice(0, 400);
  function logAi(ev) {
    const rec = { at: Date.now(), dev, v: K.VERSION, mode: K.isCarb() ? 'carb' : 'kcal' };
    for (const [k, v] of Object.entries(ev)) if (v !== undefined && v !== null && v !== '') rec[k] = typeof v === 'string' ? scrub(v) : v;
    const log = K.store.get('kal.aiLog', []); log.push(rec); if (log.length > 600) log.splice(0, log.length - 600);
    K.store.set('kal.aiLog', log);
    const out = K.store.get('kal.aiOut', []); out.push(rec); if (out.length > 400) out.splice(0, out.length - 400);
    K.store.set('kal.aiOut', out);
    clearTimeout(flushT); flushT = setTimeout(flush, 3000);
  }
  let flushT = null, flushing = false;
  async function flush() {
    if (flushing || !navigator.onLine) return;
    const out = K.store.get('kal.aiOut', []);
    if (!out.length) return;
    flushing = true;
    try {
      const batch = out.slice(0, 50);
      const r = await fetch(DIAG_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch), signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const rest = K.store.get('kal.aiOut', []).filter(x => !batch.some(b => b.at === x.at && b.dev === x.dev && b.vendor === x.vendor && b.model === x.model));
        K.store.set('kal.aiOut', rest);
        if (rest.length) setTimeout(flush, 1000);
      }
    } catch (e) { /* zkusí se s dalším záznamem nebo při dalším otevření */ }
    finally { flushing = false; }
  }

  /* ─── Fronta ─── */
  // Úloha: { id, kind, ts (čas jídla), created, img? (base64 JPEG), thumb?, text?, meal?,
  //          status: 'pending' | 'ready', attempts, nextAt, lastErr, errCode, result? }
  const newId = () => 'j' + Date.now() + Math.random().toString(36).slice(2, 6);
  const list = async () => (await CGM.all('jobs').catch(() => [])).sort((a, b) => a.ts - b.ts);
  const get = id => CGM.get('jobs', id).catch(() => null);
  const save = job => CGM.put('jobs', [job]);
  async function remove(id) { await CGM.del('jobs', id).catch(() => {}); changed(); }
  function changed() { for (const f of listeners) { try { f(); } catch (e) { /* UI */ } } }

  // kind → { run(job) → {result}|{error}, present(job) → true pokud výsledek ukázalo otevřené okno,
  //          save(job) → uloží jídlo bez otevřeného okna, label(job) → text do přehledu }
  function register(kind, h) { handlers[kind] = h; }

  async function add(job) {
    const j = { id: newId(), created: Date.now(), status: 'pending', attempts: 0, nextAt: Date.now(), ...job };
    await save(j); changed();
    return j;
  }

  // Jeden pokus o odhad. interactive = spuštěno z otevřeného okna (výsledek se tam ukáže).
  async function attempt(id) {
    if (active.has(id)) return null;
    const job = await get(id);
    if (!job || job.status !== 'pending' || !handlers[job.kind]) return null;
    active.add(id); changed();
    let r;
    try {
      job.attempts = (job.attempts || 0) + 1;
      r = await handlers[job.kind].run(job);
    } catch (e) { r = { error: 'app', msg: e.message }; }
    finally { active.delete(id); }
    const cur = await get(id);
    if (!cur) return r; // mezitím zahozeno
    if (r && !r.error) {
      Object.assign(cur, { status: 'ready', result: r, attempts: job.attempts, lastErr: null });
      await save(cur);
      if (!handlers[cur.kind].present?.(cur)) { await handlers[cur.kind].save(cur); await remove(cur.id); }
    } else {
      const wait = BACKOFF_MIN[Math.min(job.attempts - 1, BACKOFF_MIN.length - 1)] * MIN;
      Object.assign(cur, { attempts: job.attempts, lastErr: AI.errMsg(r || { error: 'app' }), errCode: r?.error, nextAt: Date.now() + wait });
      await save(cur);
      handlers[cur.kind].failed?.(cur);
    }
    changed();
    return r;
  }

  // Zpracuje čekající úlohy, kterým uplynul čas dalšího pokusu (po jedné — kvůli limitům AI).
  async function tick() {
    if (busy || !navigator.onLine) return;
    busy = true;
    try {
      for (const j of await list()) {
        if (j.status === 'ready' && !handlers[j.kind]?.present?.(j)) { await handlers[j.kind]?.save(j); await remove(j.id); continue; }
        if (j.status === 'pending' && j.nextAt <= Date.now()) await attempt(j.id);
      }
    } finally { busy = false; }
    flush();
  }
  // Po změně nastavení (klíč, server) zkusit všechno hned.
  async function retryAll() {
    for (const j of await list()) if (j.status === 'pending') { j.nextAt = Date.now(); await save(j); }
    tick();
  }

  setInterval(() => { if (document.visibilityState === 'visible') tick(); }, 20000);
  window.addEventListener('online', () => { tick(); flush(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { tick(); flush(); } });
  setTimeout(() => { tick(); flush(); }, 1500);

  /* ─── Přehled čekajících úloh (Dnes, oba režimy) ─── */
  const hhmm = t => new Date(t).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
  async function renderStrip() {
    const box = document.getElementById('jobs-strip');
    if (!box) return;
    const jobs = (await list()).filter(j => handlers[j.kind]);
    if (!jobs.length) { box.innerHTML = ''; box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = jobs.map(j => {
      const run = active.has(j.id);
      const st = j.status === 'ready' ? 'odhad je hotový — ukládám'
        : run ? 'AI právě odhaduje…'
          : `čeká na AI${j.attempts ? ` · pokus ${j.attempts}, další v ${hhmm(Math.max(j.nextAt, Date.now()))}` : ''}`;
      return `<div class="job-row" data-id="${j.id}">${j.thumb ? `<img class="ctl-thumb" src="${j.thumb}" alt="">` : '<span class="job-ico">📝</span>'}
        <span class="ctl-mid"><span class="ctl-name">${K.esc(handlers[j.kind].label?.(j) || 'Jídlo')} · ${hhmm(j.ts)}</span>
        <span class="ctl-sub">${st}${j.lastErr && !run ? '<br>' + K.esc(j.lastErr) : ''}</span></span>
        <span class="job-btns">${!run ? '<button class="btn slim job-now">Zkusit hned</button>' : ''}
        ${handlers[j.kind].open ? '<button class="btn btn-ghost slim job-open">Otevřít</button>' : ''}
        <button class="btn btn-ghost slim job-del" aria-label="Zahodit">✕</button></span></div>`;
    }).join('');
    box.querySelectorAll('.job-now').forEach(b => b.addEventListener('click', async () => {
      const id = b.closest('.job-row').dataset.id, j = await get(id);
      if (j) { j.nextAt = Date.now(); await save(j); attempt(id); }
    }));
    box.querySelectorAll('.job-open').forEach(b => b.addEventListener('click', async () => {
      const j = await get(b.closest('.job-row').dataset.id);
      if (j) handlers[j.kind].open(j);
    }));
    box.querySelectorAll('.job-del').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Zahodit tuto fotku/popis? Odhad se už nedokončí.')) return;
      await remove(b.closest('.job-row').dataset.id);
    }));
  }
  listeners.add(renderStrip);

  /* ─── Přehled deníku AI (Nastavení) ─── */
  const ERR_LABEL = {
    quota: 'limit vyčerpán', model: 'model nedostupný', network: 'síť / časový limit', truncated: 'odpověď useknutá',
    blocked: 'odmítnuto filtrem', empty: 'prázdná odpověď', parse: 'nečitelná odpověď', auth: 'neplatný klíč',
    nokey: 'chybí klíč', api: 'chyba serveru AI', 'claude-auth': 'Claude: token Nightscoutu', 'claude-login': 'Claude: nepřihlášen',
    noclaude: 'Claude nenastaven', app: 'chyba aplikace',
  };
  function renderDiag() {
    const box = document.getElementById('diag-body');
    if (!box) return;
    const since = Date.now() - 7 * 24 * 60 * MIN;
    const log = K.store.get('kal.aiLog', []).filter(x => x.at >= since);
    if (!log.length) { box.innerHTML = '<p class="muted small-text">Zatím žádné pokusy o odhad.</p>'; return; }
    const by = {};
    for (const x of log) {
      const v = (by[x.vendor || 'gemini'] ??= { n: 0, ok: 0, errs: {} });
      v.n++; if (x.ok) v.ok++; else v.errs[x.err || '?'] = (v.errs[x.err || '?'] || 0) + 1;
    }
    let h = Object.entries(by).map(([v, s]) => `<div class="learn-row"><span>${v === 'claude' ? 'Claude' : 'Gemini'}<br><span class="muted small-text">${
      Object.entries(s.errs).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${ERR_LABEL[e] || e} ${n}×`).join(' · ') || 'bez chyb'}</span></span><b>${Math.round(s.ok / s.n * 100)} % z ${s.n}</b></div>`).join('');
    const errs = log.filter(x => !x.ok).slice(-6).reverse();
    if (errs.length) h += '<p class="muted small-text" style="margin-top:8px">Poslední chyby:<br>' + errs.map(x =>
      `${new Date(x.at).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${x.model || x.vendor} · ${ERR_LABEL[x.err] || x.err}${x.status ? ' (' + x.status + ')' : ''}${x.msg ? ' — ' + K.esc(x.msg.slice(0, 120)) : ''}`).join('<br>') + '</p>';
    const out = K.store.get('kal.aiOut', []).length;
    h += `<p class="muted small-text">Za posledních 7 dní. Záznamy se odesílají k rozboru (bez fotek a klíčů)${out ? ` — čeká na odeslání: ${out}` : ' — vše odesláno'}.</p>`;
    box.innerHTML = h;
  }

  window.JOBS = { add, get, list, remove, save, register, attempt, tick, retryAll, logAi, flush, renderStrip, renderDiag, onChange: f => listeners.add(f) };
})();
