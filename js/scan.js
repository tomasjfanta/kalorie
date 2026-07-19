// Skener čárových kódů — používá nativní BarcodeDetector (Safari 17+), s ručním zadáním jako záloha.
'use strict';
(function () {
  let stream = null, raf = null, detector = null, active = false;

  async function lookupEan(ean) {
    setStatus('Hledám ' + ean + '…');
    const res = await window.KAL.offProduct(ean);
    if (res.food) {
      stop();
      window.KAL.closeSheet('sheet-scan');
      window.KAL.openFoodDetail(res.food, { meal: window.KAL.getMeal() });
    } else if (res.notFound) {
      setStatus('Produkt ' + ean + ' není v databázi. Zkuste jiný, nebo přidejte ručně přes ⚡ rychlý zápis.');
      active = true; loop();
    } else {
      setStatus('Chyba připojení. Zkontrolujte internet.');
      active = true; loop();
    }
  }

  function setStatus(t) { const el = document.getElementById('scan-status'); if (el) el.textContent = t; }

  async function start() {
    const video = document.getElementById('scan-video');
    if (!('BarcodeDetector' in window)) {
      setStatus('Tento telefon neumí skenovat v prohlížeči. Zadejte kód ručně níže — najdete ho pod čárovým kódem na obalu.');
      return;
    }
    try {
      detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
    } catch {
      setStatus('Skener není dostupný. Zadejte kód ručně níže.');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = stream;
      await video.play();
      setStatus('Namiřte na čárový kód výrobku.');
      active = true;
      loop();
    } catch (e) {
      setStatus(e.name === 'NotAllowedError'
        ? 'Přístup ke kameře byl odmítnut. Povolte kameru v nastavení Safari, nebo zadejte kód ručně.'
        : 'Kameru se nepodařilo spustit. Zadejte kód ručně níže.');
    }
  }

  function loop() {
    const video = document.getElementById('scan-video');
    if (!active || !detector || !video) return;
    raf = requestAnimationFrame(async () => {
      try {
        const codes = await detector.detect(video);
        if (codes.length && codes[0].rawValue) {
          active = false;
          navigator.vibrate?.(60);
          await lookupEan(codes[0].rawValue.trim());
          return;
        }
      } catch { /* přeskočit snímek */ }
      loop();
    });
  }

  function stop() {
    active = false;
    if (raf) cancelAnimationFrame(raf);
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    const v = document.getElementById('scan-video'); if (v) v.srcObject = null;
  }

  document.getElementById('scan-btn').addEventListener('click', () => {
    window.KAL.openSheet('sheet-scan');
    setStatus('Spouštím kameru…');
    start();
  });
  document.querySelector('#sheet-scan .sheet-close').addEventListener('click', stop);
  document.getElementById('sheet-scan').addEventListener('click', e => { if (e.target.id === 'sheet-scan') stop(); });
  document.getElementById('ean-submit').addEventListener('click', () => {
    const ean = document.getElementById('ean-input').value.trim();
    if (ean.length < 6) { window.KAL.toast('Zadejte platný kód'); return; }
    active = false;
    lookupEan(ean);
  });
})();
