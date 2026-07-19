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
    + 'číslo v g, "jistota": "nízká"|"střední"|"vysoká", "poznamka": "krátká poznámka nebo prázdný řetězec"}. '
    + 'Všechny číselné hodnoty platí pro CELOU popsanou/zobrazenou porci, NE na 100 g. Pokud množství není '
    + 'uvedené, odhadni obvyklou porci a napiš odhad do pole "mnozstvi". Vycházej z běžných nutričních '
    + 'tabulek pro české potraviny.';

  // Modely k vyzkoušení v pořadí — Google občas starší modely pro bezplatné klíče vypne,
  // proto se při chybě „model není dostupný" zkusí automaticky další a ten, co funguje,
  // se zapamatuje.
  const MODEL_CHAIN = [
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-3-flash-preview',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
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

  async function callGemini({ text, imageBase64, imageMedia }) {
    const c = cfg();
    if (!c.key) return { error: 'nokey' };
    const parts = [];
    if (imageBase64) parts.push({ inline_data: { mime_type: imageMedia, data: imageBase64 } });
    parts.push({ text: text || 'Odhadni kalorie a makra tohoto jídla z fotky.' });
    const body = {
      systemInstruction: { parts: [{ text: SYS }] },
      contents: [{ role: 'user', parts }],
      // Gemini 3.x jsou „přemýšlecí" modely — interní uvažování se počítá do maxOutputTokens.
      // S malým limitem model celý budget spotřebuje na přemýšlení a nevrátí žádný text.
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 8192 },
    };

    // Zvolený model první, pak zbytek řetězce jako záloha.
    const chain = [c.model, ...MODEL_CHAIN.filter(m => m !== c.model)].filter(Boolean);
    let out = null;
    for (const model of chain) {
      out = await callModel(model, c.key, body);
      if (out.response) {
        if (model !== c.model) window.KAL.setAiModel(model); // zapamatuj funkční model
        break;
      }
      if (out.error !== 'model') break; // jiná chyba než „model nedostupný" → nezkoušet dál
    }
    if (!out.response) return out;

    const resp = out.response;
    const cand = resp.candidates?.[0];
    if (!cand) return { error: resp.promptFeedback?.blockReason ? 'blocked' : 'empty' };
    // Přeskočit případné „thought" části (interní uvažování modelu) — odpověď je v běžných text částech.
    const txt = (cand.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
    if (!txt) return { error: cand.finishReason === 'MAX_TOKENS' ? 'truncated' : (cand.finishReason === 'SAFETY' ? 'blocked' : 'empty') };
    try { return { result: JSON.parse(txt) }; } catch (e) { /* zkusit vyříznout JSON */ }
    const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
    if (a < 0 || b < 0) return { error: 'parse' };
    try { return { result: JSON.parse(txt.slice(a, b + 1)) }; } catch (e) { return { error: 'parse' }; }
  }

  function toEntry(j) {
    const name = (j.nazev || 'Odhad jídla').trim();
    return {
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
      case 'auth': return 'API klíč je neplatný. Zkontrolujte ho v Nastavení → AI odhady.';
      case 'quota': return 'Bezplatný limit je teď vyčerpaný (příliš požadavků). Zkuste to za minutu, případně zítra.';
      case 'model': return 'Žádný z AI modelů teď není pro bezplatný klíč dostupný. Zkuste to později.';
      case 'network': return 'Nepodařilo se spojit s Google. Zkontrolujte připojení k internetu.';
      case 'truncated': return 'Odpověď se nevešla do limitu. Zkuste to znovu, případně kratší popis.';
      case 'blocked': return 'Google tenhle požadavek odmítl zpracovat (bezpečnostní filtr). Zkuste jinou fotku nebo popis.';
      case 'empty': return 'Model vrátil prázdnou odpověď. Zkuste to prosím znovu.';
      case 'parse': return 'Odpověď se nepodařilo přečíst. Zkuste to prosím znovu.';
      default: return 'Něco se nepovedlo (' + (e.status || '?') + '). ' + (e.msg || 'Zkuste to znovu.');
    }
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
    const res = await callGemini({ text });
    $('ai-text-submit').disabled = false;
    if (res.error) { $('ai-text-status').textContent = errMsg(res); return; }
    window.KAL.closeSheet('sheet-aitext');
    $('ai-text-input').value = '';
    window.KAL.openQuick(toEntry(res.result));
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
    let img;
    try { img = await downscale(file); } catch (err) { window.KAL.toast('Fotku se nepodařilo načíst'); return; }
    $('ai-photo-preview').src = img.dataUrl;
    $('ai-photo-status').textContent = 'Analyzuji fotku… (pár vteřin)';
    window.KAL.openSheet('sheet-aiphoto');
    const res = await callGemini({ imageBase64: img.base64, imageMedia: 'image/jpeg' });
    if (res.error) { $('ai-photo-status').textContent = errMsg(res); return; }
    window.KAL.closeSheet('sheet-aiphoto');
    window.KAL.openQuick(toEntry(res.result));
  });

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
})();
