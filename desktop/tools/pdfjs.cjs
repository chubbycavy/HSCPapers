// One maintained PDF.js engine for operator tools and deterministic regressions.
"use strict";
const path = require("path"), { pathToFileURL } = require("url");
const VERSION = require("./vendor-pdfjs.cjs").VERSION;
const root = path.join(__dirname, "../ui/pdfjs", VERSION);
let ready;
function load() {
  return ready ||= import(pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href).then(lib => {
    lib.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
    return { ...lib, getDocument(options) { return lib.getDocument({
      cMapUrl: path.join(root, "cmaps").replace(/\\/g, "/") + "/", cMapPacked: true,
      standardFontDataUrl: path.join(root, "standard_fonts").replace(/\\/g, "/") + "/",
      wasmUrl: path.join(root, "wasm").replace(/\\/g, "/") + "/", ...options, isEvalSupported: false,
    }); } };
  });
}
module.exports = { load, VERSION };
