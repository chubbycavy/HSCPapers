// Versioned, self-hosted PDF.js module. No eval-based document processing.
(() => {
  "use strict";
  const version = "6.4.299", base = new URL(`../pdfjs/${version}/`, document.currentScript.src);
  const ready = import(new URL("pdf.min.mjs", base).href).then(lib => {
    lib.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.mjs", base).href;
    const engine = { ...lib, getDocument(options) {
      return lib.getDocument({ cMapUrl: new URL("cmaps/", base).href, cMapPacked: true,
        standardFontDataUrl: new URL("standard_fonts/", base).href, wasmUrl: new URL("wasm/", base).href,
        ...options, isEvalSupported: false });
    } };
    window.pdfjsLib = engine;
    return engine;
  });
  ready.catch(() => {}); // loadPane presents loading failures in the reader UI.
  window.PdfEngine = Object.freeze({ version, ready });
})();
