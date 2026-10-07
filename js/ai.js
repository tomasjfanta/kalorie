// AI odhad kalorií z fotky nebo popisu — volá Google Gemini přímo z prohlížeče
// bezplatným klíčem z Google AI Studia. Klíč je jen v localStorage telefonu.
'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const cfg = () => window.KAL.aiConfig();

  const SYS = 'Jsi nutriční asistent pro počítání kalorií. Odhadni energetickou a makronutriční hodnotu '
    + 'popsaného nebo vyfoceného jídla. Odpověz VÝHRADNĚ jedním validním JSON objektem, bez markdownu a bez '
    + 'jakéhokoliv dalšího textu, přesně ve tvaru: {"nazev": "krátký český název jídla", "mnozstvi": "odhad '
    + 'porce, např. 1 talíř ~350 g", "kcal": číslo, "bilkoviny": číslo v g, "sacharidy": číslo v g, "tuky": '
    + 'číslo v g, "sacharidy_min": číslo v g, "sacharidy_max": číslo v g, "jistota": "nízká"|"střední"|"vysoká", '
    + '"kategorie": "pecivo"|"prilohy"|"hotove"|"fastfood"|"sladke"|"ovoce"|"mlecne"|"napoje"|"ostatni", '
    + '"gi": "nízký"|"střední"|"vysoký", '
    + '"poznamka": "krátká poznámka nebo prázdný řetězec"}. "kategorie" = převažující zdroj sacharidů (prilohy = rýže, '
    + 'těstoviny, brambory, knedlíky; hotove = jídlo s omáčkou nebo masem; fastfood = pizza, burger, smažené). '
    + '"gi" = glykemický index jídla jako celku, tj. jak rychle se jeho sacharidy vstřebají: vysoký (bílé pečivo, '
    + 'sladké nápoje, brambory na kaši, sladkosti), střední (rýže, těstoviny vařené na skus, běžné obědy), nízký '
    + '(luštěniny, celozrnné, hodně tuku, bílkovin nebo vlákniny — tuk a bílkoviny vstřebávání zpomalují). '
    + '"sacharidy_min" a "sacharidy_max" je rozsah, ve kterém '
    + 'skutečné sacharidy leží s 90% pravděpodobností — buď poctivý, u nejasné porce nebo receptu ho rozšiř. '
    + 'Všechny číselné hodnoty platí pro CELOU popsanou/zobrazenou porci, NE na 100 g. Pokud množství není '
    + 'uvedené, odhadni obvyklou porci a napiš odhad do pole "mnozstvi". Vycházej z běžných nutričních '
    + 'tabulek pro české potraviny. Sacharidy uváděj jako využitelné sacharidy bez vlákniny (jako na obalech v EU).';
  // V režimu sacharidů (uživatel s diabetem) je přesnost sacharidů to hlavní.
  const SYS_CARB = ' Uživatel má diabetes: sacharidy jsou nejdůležitější údaj — započítej i skryté sacharidy '
    + '(zahušťovadla v omáčkách, strouhanku a těstíčko, slazené nápoje, dresinky, cukr v pečivu).';

  // Modely k vyzkoušení v pořadí — Google občas starší modely pro bezplatné klíče vypne,
  // proto se při chybě „model není dostupný" zkusí automaticky další a ten, co funguje,
  // se zapamatuje.
  // (Bezplatné modely podle ai.google.dev/gemini-api/docs/pricing, říjen 2026.)
  const MODEL_CHAIN = [
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3-flash-preview',
    'gemini-2.5-flash',
  ];
  const modelUnavailable = (status, msg) =>
    (status === 404) || /no longer available|not available for free|not supported|not found/i.test(msg || '');

  async function callModel(model, key, body) {
    let r;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000), // zaseknutý požadavek nesmí blokovat ostatní odhady
      });
    } catch (e) { return { error: 'network' }; }
    if (!r.ok) {
      let msg = '';
      try { msg = (await r.json()).error?.message || ''; } catch (e) { /* ignore */ }
      if (r.status === 400 && /api key/i.test(msg)) return { error: 'auth' };
      if (r.status === 403) return { error: 'auth' };
      if (modelUnavailable(r.status, msg)) return { error: 'model', status: r.status, msg };
      if (r.status === 429) return { error: 'quota' };
      return { error: 'api', status: r.status, msg };
    }
    return { response: await r.json() };
  }

  // Zápis pokusu do deníku AI (jobs.js) — každý model zvlášť, s dobou trvání a důvodem chyby.
  const diag = (args, ev) => window.JOBS?.logAi({ flow: args.diag?.flow || (args.imageBase64 ? 'photo' : 'text'),
    job: args.diag?.job, attempt: args.diag?.attempt, kb: args.imageBase64 ? Math.round(args.imageBase64.length * 0.75 / 1024) : undefined, ...ev });

  async function callGemini(args) {
    const { text, imageBase64, imageMedia, extra, temperature = 0.2 } = args;
    const c = cfg();
    if (!c.key) { diag(args, { vendor: 'gemini', ok: false, err: 'nokey' }); return { error: 'nokey' }; }
    const parts = [];
    if (imageBase64) parts.push({ inline_data: { mime_type: imageMedia, data: imageBase64 } });
    parts.push({ text: text || 'Odhadni kalorie a makra tohoto jídla z fotky.' });
    const body = {
      systemInstruction: { parts: [{ text: SYS + (window.KAL.isCarb() ? SYS_CARB : '') + (extra || '') }] },
      contents: [{ role: 'user', parts }],
      // Gemini 3.x jsou „přemýšlecí" modely — interní uvažování se počítá do maxOutputTokens.
      // S malým limitem model celý budget spotřebuje na přemýšlení a nevrátí žádný text.
      // temperature: null = výchozí hodnota modelu (u Gemini 3 je 1,0 a Google ji doporučuje neměnit).
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8192,
        ...(temperature != null ? { temperature } : {}) },
    };

    // Zvolený model první, pak zbytek řetězce jako záloha.
    const chain = [c.model, ...MODEL_CHAIN.filter(m => m !== c.model)].filter(Boolean);
    let out = null, used = null, retired = false, hops = 0;
    for (const model of chain) {
      const t0 = Date.now();
      out = await callModel(model, c.key, body);
      if (out.response) {
        used = model;
        if (model !== c.model && retired) window.KAL.setAiModel(model); // zapamatuj funkční model
        const parsed = parseAnswer(out.response);
        diag(args, { vendor: 'gemini', model, ok: !!parsed.result, err: parsed.error, ms: Date.now() - t0,
          finish: parsed.finish, tok: parsed.tok, snippet: parsed.snippet, msg: parsed.block });
        return parsed.result ? { ...parsed, model: used } : parsed;
      }
      diag(args, { vendor: 'gemini', model, ok: false, err: out.error, status: out.status, msg: out.msg, ms: Date.now() - t0 });
      if (out.error === 'model') { retired = true; continue; }
      // Přetížený model (503/500/504) nebo vyčerpaný limit jednoho modelu → zkusit další model
      // v řetězci (každý má vlastní limit); zvolený model se kvůli tomu nemění.
      if ((out.error === 'api' && [500, 503, 504].includes(out.status)) || out.error === 'quota') { if (++hops <= 2) continue; }
      break; // klíč, síť apod. — další model by nepomohl
    }
    return out;
  }

  // Claude přes vlastní server (ai-server/ na Railway): ten spouští `claude -p` na předplatném
  // Claude uživatele. Přístup ověří tokenem Nightscoutu, který aplikace už má.
  const claudeReady = () => !!(cfg().claudeUrl && window.KAL.store.get('kal.ns', null)?.token);
  async function callClaude(args) {
    const { imageBase64, imageMedia, extra } = args;
    const url = String(cfg().claudeUrl || '').trim().replace(/\/+$/, '');
    const token = window.KAL.store.get('kal.ns', null)?.token;
    if (!url || !token) return { error: 'noclaude' };
    const t0 = Date.now();
    let r;
    try {
      r = await fetch(url + '/estimate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ system: SYS + SYS_CARB + (extra || ''), prompt: 'Odhadni sacharidy tohoto jídla z fotky.',
          image: imageBase64, media: imageMedia }),
        signal: AbortSignal.timeout(170000),
      });
    } catch (e) {
      diag(args, { vendor: 'claude', ok: false, err: 'network', msg: e.name, ms: Date.now() - t0 });
      return { error: 'network' };
    }
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.result) {
      diag(args, { vendor: 'claude', model: j.model, ok: true, ms: Date.now() - t0, tok: j.usage });
      return { result: j.result, model: j.model };
    }
    const out = { error: r.status === 401 ? 'claude-auth' : j.error === 'not-logged-in' ? 'claude-login'
      : r.status === 429 ? 'quota' : 'api', status: r.status, msg: j.detail || j.error };
    diag(args, { vendor: 'claude', ok: false, err: out.error, status: r.status, msg: out.msg, ms: Date.now() - t0 });
    return out;
  }

  // Několik nezávislých odhadů téže fotky najednou, i od různých AI (souběžně, takže skoro stejně
  // rychle jako jeden). Jediný odhad z jedné fotky se při opakování znatelně liší — medián je
  // stabilnější a rozptyl ukazuje, jak nejistá je právě tahle fotka. plan: { gemini: 5, claude: 2 }.
  // Vrací { runs: [{ result, model }], errors: { gemini?, claude? } }, nebo chybu, když neuspělo nic.
  async function callRuns(args, plan, onProgress) {
    const jobs = [];
    for (let i = 0; i < (plan.gemini || 0); i++) jobs.push(['gemini', () => callGemini({ ...args, temperature: null })]);
    for (let i = 0; i < (plan.claude || 0); i++) jobs.push(['claude', () => callClaude(args)]);
    let done = 0;
    const all = await Promise.all(jobs.map(([v, run]) => run().then(r => { onProgress?.(++done, jobs.length); return { ...r, v }; })));
    const ok = all.filter(r => r.result), errors = {};
    // Chyba se hlásí jen u AI, která neodpověděla ani jednou (jeden vypadlý běh z pěti nevadí).
    for (const r of all) if (!r.result && !errors[r.v] && !ok.some(o => o.v === r.v)) errors[r.v] = r;
    return ok.length ? { runs: ok, errors } : (errors.gemini || errors.claude || { error: 'empty' });
  }

  // Přečte odpověď Gemini. Pro deník chyb vrací i důvod konce, spotřebu tokenů (včetně
  // přemýšlení) a začátek textu, když se ho nepodaří přečíst.
  function parseAnswer(resp) {
    const u = resp.usageMetadata || {};
    const tok = { in: u.promptTokenCount, out: u.candidatesTokenCount, think: u.thoughtsTokenCount };
    const cand = resp.candidates?.[0];
    if (!cand) return { error: resp.promptFeedback?.blockReason ? 'blocked' : 'empty', block: resp.promptFeedback?.blockReason, tok };
    const finish = cand.finishReason;
    // Přeskočit případné „thought" části (interní uvažování modelu) — odpověď je v běžných text částech.
    const txt = (cand.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
    if (!txt) return { error: finish === 'MAX_TOKENS' ? 'truncated' : (finish === 'SAFETY' ? 'blocked' : 'empty'), finish, tok };
    try { return { result: JSON.parse(txt), finish, tok }; } catch (e) { /* zkusit vyříznout JSON */ }
    const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return { result: JSON.parse(txt.slice(a, b + 1)), finish, tok }; } catch (e) { /* níže */ } }
    return { error: finish === 'MAX_TOKENS' ? 'truncated' : 'parse', finish, tok, snippet: txt.slice(0, 300) };
  }

  function toEntry(j, kind) {
    const name = (j.nazev || 'Odhad jídla').trim();
    const jt = String(j.jistota || '').toLowerCase();
    const jist = /vys|high/.test(jt) ? 'vysoká' : /níz|niz|low/.test(jt) ? 'nízká' : 'střední';
    let sMin = +j.sacharidy_min, sMax = +j.sacharidy_max;
    if (!(isFinite(sMin) && isFinite(sMax)) || sMin < 0) { sMin = undefined; sMax = undefined; }
    else if (sMin > sMax) [sMin, sMax] = [sMax, sMin];
    return {
      cs: kind, jist, sMin, sMax,
      n: name + (j.mnozstvi ? ' (' + String(j.mnozstvi).trim() + ')' : ''),
      meal: window.KAL.getMeal(),
      kcal: Math.max(0, Math.round(+j.kcal || 0)),
      b: Math.max(0, Math.round(+j.bilkoviny || 0)),
      s: Math.max(0, Math.round(+j.sacharidy || 0)),
      t: Math.max(0, Math.round(+j.tuky || 0)),
    };
  }

  function errMsg(e) {
    switch (e.error) {
      case 'nokey': return 'Nejdřív vložte bezplatný Google API klíč v Nastavení → AI odhady.';
      case 'noclaude': return 'Claude není nastavený (Nastavení → AI odhady → adresa serveru Claude a token Nightscoutu).';
      case 'claude-auth': return 'Server Claude nepřijal token Nightscoutu — zkontrolujte ho v Nastavení → Data z CGM a pumpy.';
      case 'claude-login': return 'Server Claude není přihlášený k vašemu předplatnému (proměnná CLAUDE_CODE_OAUTH_TOKEN na Railway).';
      case 'auth': return 'API klíč je neplatný. Zkontrolujte ho v Nastavení → AI odhady.';
      case 'quota': return 'Bezplatný limit je teď vyčerpaný (příliš požadavků). Zkuste to za minutu, případně zítra.';
      case 'model': return 'Žádný z AI modelů teď není pro bezplatný klíč dostupný. Zkuste to později.';
      case 'network': return 'Nepodařilo se spojit se serverem AI (síť nebo vypršel čas). Zkontrolujte připojení k internetu.';
      case 'app': return 'Chyba v aplikaci při odhadu' + (e.msg ? ' (' + e.msg + ')' : '') + '.';
      case 'truncated': return 'Odpověď se nevešla do limitu. Zkuste to znovu, případně kratší popis.';
      case 'blocked': return 'Google tenhle požadavek odmítl zpracovat (bezpečnostní filtr). Zkuste jinou fotku nebo popis.';
      case 'empty': return 'Model vrátil prázdnou odpověď. Zkuste to prosím znovu.';
      case 'parse': return 'Odpověď se nepodařilo přečíst. Zkuste to prosím znovu.';
      default: return 'Něco se nepovedlo (' + (e.status || '?') + '). ' + (e.msg || 'Zkuste to znovu.');
    }
  }

  /* ── Režim kalorií: odhady přes frontu (jobs.js) — fotka ani popis se při chybě neztratí ── */
  const sheetOpen = id => !$(id).classList.contains('hidden');
  let shown = { aitext: null, aiphoto: null }; // id úlohy, kterou ukazuje otevřené okno
  // Denní jídlo podle času, kdy se jedlo (ne podle toho, kdy odhad doběhl).
  const mealAt = ts => { const d = new Date(ts), h = d.getHours() + d.getMinutes() / 60; return h < 10 ? 'sn' : h < 11.5 ? 'sv' : h < 14.5 ? 'ob' : h < 17.5 ? 'sv' : 've'; };
  const pad = n => String(n).padStart(2, '0');
  const dkey = ts => { const d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const hm = ts => new Date(ts).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });

  for (const [kind, cs, sheet, statusEl] of [['kcal-text', 'ai-text', 'aitext', 'ai-text-status'], ['kcal-photo', 'ai-photo', 'aiphoto', 'ai-photo-status']]) {
    window.JOBS.register(kind, {
      label: j => kind === 'kcal-text' ? '„' + String(j.text).slice(0, 40) + '"' : 'Fotka jídla',
      run: j => callGemini(kind === 'kcal-text' ? { text: j.text, diag: { flow: 'text', job: j.id, attempt: j.attempts } }
        : { imageBase64: j.img, imageMedia: 'image/jpeg', diag: { flow: 'photo', job: j.id, attempt: j.attempts } }),
      // Okno je otevřené → výsledek do rychlého zápisu (uživatel ho potvrdí) a úloha končí.
      present: j => {
        if (shown[sheet] !== j.id || !sheetOpen('sheet-' + sheet)) return false;
        shown[sheet] = null;
        window.KAL.closeSheet('sheet-' + sheet);
        if (kind === 'kcal-text') { $('ai-text-input').value = ''; $('ai-text-submit').disabled = false; }
        window.KAL.openQuick({ ...toEntry(j.result.result, cs), meal: j.meal || mealAt(j.ts) });
        window.JOBS.remove(j.id);
        return true;
      },
      // Okno je zavřené → jídlo se uloží samo k času, kdy se jedlo.
      save: async j => {
        const e = { id: 'e' + Date.now() + Math.random().toString(36).slice(2, 6), ...toEntry(j.result.result, cs), meal: j.meal || mealAt(j.ts), auto: true };
        window.KAL.day(dkey(j.ts)).e.push(e);
        window.KAL.saveAll(); window.KAL.renderDnes();
        window.KAL.toast(`Odhad z ${hm(j.ts)} doběhl: ${e.kcal} kcal — uloženo (můžete upravit)`);
      },
      failed: j => {
        if (shown[sheet] !== j.id || !sheetOpen('sheet-' + sheet)) return;
        if (kind === 'kcal-text') $('ai-text-submit').disabled = false;
        $(statusEl).innerHTML = window.KAL.esc(j.lastErr) + `<br><b>📌 ${kind === 'kcal-text' ? 'Popis' : 'Fotka'} je uložený v telefonu.</b> Zkusím to znovu sám v ${hm(j.nextAt)} — okno můžete zavřít, jídlo se po odhadu uloží samo.`;
      },
    });
  }

  /* ── Odhad z popisu (text) ── */
  $('ai-text-btn').addEventListener('click', () => {
    if (!cfg().key) { window.KAL.toast('Vložte Google API klíč v Nastavení'); return; }
    $('ai-text-status').textContent = '';
    window.KAL.openSheet('sheet-aitext');
    setTimeout(() => $('ai-text-input').focus(), 250);
  });
  $('ai-text-submit').addEventListener('click', async () => {
    const text = $('ai-text-input').value.trim();
    if (!text) { window.KAL.toast('Napište, co jste snědli'); return; }
    $('ai-text-status').textContent = 'Odhaduji… (pár vteřin)';
    $('ai-text-submit').disabled = true;
    const j = await window.JOBS.add({ kind: 'kcal-text', ts: Date.now(), text, meal: window.KAL.getMeal() });
    shown.aitext = j.id;
    window.JOBS.attempt(j.id);
  });

  /* ── Odhad z fotky ── */
  $('ai-photo-btn').addEventListener('click', () => {
    if (!cfg().key) { window.KAL.toast('Vložte Google API klíč v Nastavení'); return; }
    $('ai-photo-input').value = '';
    $('ai-photo-input').click();
  });
  $('ai-photo-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const now = Date.now();
    // Fotka z galerie nese čas pořízení — jídlo se zapíše k času, kdy se jedlo.
    const ts = file.lastModified && file.lastModified <= now && now - file.lastModified < 864e5 ? file.lastModified : now;
    let img;
    try { img = await downscale(file); } catch (err) { window.KAL.toast('Fotku se nepodařilo načíst'); return; }
    $('ai-photo-preview').src = img.dataUrl;
    $('ai-photo-status').textContent = 'Analyzuji fotku… (pár vteřin)';
    window.KAL.openSheet('sheet-aiphoto');
    const j = await window.JOBS.add({ kind: 'kcal-photo', ts, img: img.base64, thumb: await thumbOf(img.dataUrl), meal: window.KAL.getMeal() });
    shown.aiphoto = j.id;
    window.JOBS.attempt(j.id);
  });

  // Malý náhled do přehledu čekajících fotek.
  function thumbOf(dataUrl) {
    return new Promise(resolve => {
      const im = new Image();
      im.onload = () => {
        const s = 160 / Math.max(im.naturalWidth, im.naturalHeight), cv = document.createElement('canvas');
        cv.width = Math.round(im.naturalWidth * s); cv.height = Math.round(im.naturalHeight * s);
        cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/jpeg', 0.7));
      };
      im.onerror = () => resolve(null);
      im.src = dataUrl;
    });
  }

  // Zmenší fotku na max 1024 px a JPEG ~0.8 — rychlejší odeslání, stejná přesnost odhadu.
  function downscale(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const max = 1024;
        let w = img.naturalWidth, h = img.naturalHeight;
        if (w > max || h > max) { const s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        const dataUrl = cv.toDataURL('image/jpeg', 0.8);
        resolve({ dataUrl, base64: dataUrl.split(',')[1] });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('img')); };
      img.src = url;
    });
  }

  window.AI = { callGemini, callClaude, callRuns, claudeReady, downscale, errMsg, thumbOf };
})();
