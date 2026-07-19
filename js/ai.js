// AI odhad kalorií z fotky nebo popisu — volá Claude přímo z prohlížeče uživatelovým API klíčem.
// Klíč je jen v localStorage telefonu; nikam jinam se neposílá.
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
    + 'uvedené, odhadni obvyklou porci a napiš odhad do pole "mnozstvi".';

  async function callClaude({ text, imageBase64, imageMedia }) {
    const c = cfg();
    if (!c.key) return { error: 'nokey' };
    const model = c.model || 'claude-sonnet-5';
    const content = [];
    if (imageBase64) content.push({ type: 'image', source: { type: 'base64', media_type: imageMedia, data: imageBase64 } });
    content.push({ type: 'text', text: text || 'Odhadni kalorie a makra tohoto jídla z fotky.' });
    const body = { model, max_tokens: 1024, system: SYS, messages: [{ role: 'user', content }] };
    if (model !== 'claude-haiku-4-5') body.thinking = { type: 'disabled' }; // rychlý, levný odhad

    let r;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': c.key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });
    } catch (e) { return { error: 'network' }; }

    if (!r.ok) {
      let msg = '';
      try { msg = (await r.json()).error?.message || ''; } catch (e) { /* ignore */ }
      if (r.status === 401) return { error: 'auth' };
      return { error: 'api', status: r.status, msg };
    }
    const data = await r.json();
    const txt = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
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
      case 'nokey': return 'Nejdřív vložte svůj Anthropic API klíč v Nastavení → AI odhady.';
      case 'auth': return 'API klíč je neplatný. Zkontrolujte ho v Nastavení → AI odhady.';
      case 'network': return 'Nepodařilo se spojit s Claude. Zkontrolujte připojení k internetu.';
      case 'parse': return 'Odpověď se nepodařilo přečíst. Zkuste to prosím znovu.';
      default: return 'Něco se nepovedlo (' + (e.status || '?') + '). ' + (e.msg || 'Zkuste to znovu.');
    }
  }

  /* ── Odhad z popisu (text) ── */
  $('ai-text-btn').addEventListener('click', () => {
    if (!cfg().key) { window.KAL.toast('Vložte API klíč v Nastavení'); return; }
    $('ai-text-status').textContent = '';
    window.KAL.openSheet('sheet-aitext');
    setTimeout(() => $('ai-text-input').focus(), 250);
  });
  $('ai-text-submit').addEventListener('click', async () => {
    const text = $('ai-text-input').value.trim();
    if (!text) { window.KAL.toast('Napište, co jste snědli'); return; }
    $('ai-text-status').textContent = 'Odhaduji… (pár vteřin)';
    $('ai-text-submit').disabled = true;
    const res = await callClaude({ text });
    $('ai-text-submit').disabled = false;
    if (res.error) { $('ai-text-status').textContent = errMsg(res); return; }
    window.KAL.closeSheet('sheet-aitext');
    $('ai-text-input').value = '';
    window.KAL.openQuick(toEntry(res.result));
  });

  /* ── Odhad z fotky ── */
  $('ai-photo-btn').addEventListener('click', () => {
    if (!cfg().key) { window.KAL.toast('Vložte API klíč v Nastavení'); return; }
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
    const res = await callClaude({ imageBase64: img.base64, imageMedia: 'image/jpeg' });
    if (res.error) { $('ai-photo-status').textContent = errMsg(res); return; }
    window.KAL.closeSheet('sheet-aiphoto');
    window.KAL.openQuick(toEntry(res.result));
  });

  // Zmenší fotku na max 1024 px a JPEG ~0.8 — méně tokenů, rychlejší odeslání, nižší cena.
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
