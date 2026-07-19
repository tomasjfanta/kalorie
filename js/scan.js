// Skener čárových kódů — knihovna ZXing (funguje i v iOS Safari, kde nativní BarcodeDetector chybí).
'use strict';
(function () {
  let controls = null, reader = null, running = false, lastCode = '', lastAt = 0;

  function makeReader() {
    if (reader) return reader;
    const Z = window.ZXing;
    const hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
      Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8,
      Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E,
    ]);
    reader = new Z.BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 200 });
    return reader;
  }

  function setStatus(t) { const el = document.getElementById('scan-status'); if (el) el.textContent = t; }

  async function lookupEan(ean) {
    setStatus('Hledám ' + ean + '…');
    const res = await window.KAL.offProduct(ean);
    if (res.food) {
      stop();
      window.KAL.closeSheet('sheet-scan');
      window.KAL.openFoodDetail(res.food, { meal: window.KAL.getMeal() });
    } else if (res.notFound) {
      setStatus('Produkt ' + ean + ' není v databázi Open Food Facts. Zadejte ho přes ⚡ rychlý zápis, nebo naskenujte jiný.');
      running = true; // pokračuj ve skenování dalšího
    } else {
      setStatus('Chyba připojení k internetu. Zkuste to znovu.');
      running = true;
    }
  }

  function onResult(result) {
    if (!result || !running) return;
    const code = result.getText().trim();
    const now = Date.now();
    if (code === lastCode && now - lastAt < 4000) return; // stejný kód nedávno → přeskoč
    lastCode = code; lastAt = now;
    running = false;
    navigator.vibrate?.(60);
    lookupEan(code);
  }

  async function start() {
    const video = document.getElementById('scan-video');
    if (!window.ZXing) { setStatus('Skener se nenačetl. Obnovte stránku a zkuste to znovu.'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('Kamera není v tomto prohlížeči dostupná. Zadejte kód ručně níže.'); return;
    }
    setStatus('Spouštím kameru…');
    lastCode = ''; running = true;
    try {
      const r = makeReader();
      controls = await r.decodeFromConstraints(
        { video: { facingMode: { ideal: 'environment' } } },
        video,
        (result) => onResult(result)
      );
      setStatus('Namiřte na čárový kód výrobku.');
    } catch (e) {
      running = false;
      setStatus(e && e.name === 'NotAllowedError'
        ? 'Přístup ke kameře byl odmítnut. Povolte kameru v nastavení telefonu, nebo zadejte kód ručně.'
        : 'Kameru se nepodařilo spustit. Zadejte kód ručně níže.');
    }
  }

  function stop() {
    running = false;
    try { if (controls) controls.stop(); } catch (e) { /* ignore */ }
    controls = null;
    const v = document.getElementById('scan-video'); if (v) v.srcObject = null;
  }

  document.getElementById('scan-btn').addEventListener('click', () => {
    window.KAL.openSheet('sheet-scan');
    start();
  });
  document.querySelector('#sheet-scan .sheet-close').addEventListener('click', stop);
  document.getElementById('sheet-scan').addEventListener('click', e => { if (e.target.id === 'sheet-scan') stop(); });
  document.getElementById('ean-submit').addEventListener('click', () => {
    const ean = document.getElementById('ean-input').value.trim();
    if (ean.length < 6) { window.KAL.toast('Zadejte platný kód'); return; }
    running = false;
    lookupEan(ean);
  });
})();
