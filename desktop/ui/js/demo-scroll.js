/*
  demo-scroll.html — continuous-scroll pdf.js reader demo
  =========================================================
  MIT License — Copyright (c) 2026 ChubbyCavy (HSCPapers)

  Permission is hereby granted, free of charge, to any person obtaining a
  copy of this software and associated documentation files (the
  "Software"), to deal in the Software without restriction, including
  without limitation the rights to use, copy, modify, merge, publish,
  distribute, sublicense, and/or sell copies of the Software, subject to
  the following condition: the above copyright notice and this permission
  notice shall be included in all copies or substantial portions of the
  Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

  Techniques writeup: READER-TECHNIQUES.md in
  https://github.com/chubbycavy/HSCPapers
  Free to reuse and adapt for any project, commercial or non-commercial.
*/
(() => {
  "use strict";
  const DEFAULT_URL = "https://pub-ec23c9b69d2544938d816ad28ee491fd.r2.dev/papers/Chemistry/2024/2024-chemistry-barker-paper-00006er22x.pdf";
  const ROOT_MARGIN = 900;      // IntersectionObserver margin (px)
  const MAX_CONCURRENT = 3;     // lazy render queue cap
  const UNLOAD_VHS = 2.5;       // unload rendered pages beyond 2.5 viewport-heights
  const SCALE = 1.6;

  const $ = (s) => document.querySelector(s);
  const scroller = $("#scroller"), errBox = $("#err"), meta = $("#pageMeta");

  let doc = null, numPages = 0, page = 1, pages = [], queue = [], inFlight = 0;
  let observer = null, scrollTick = false, dims = null;

  function fail(msg) { errBox.style.display = "block"; errBox.textContent = msg; }
  function clearErr() { errBox.style.display = "none"; errBox.textContent = ""; }

  function setMeta() {
    const rendered = pages.filter(p => p.rendered).length;
    meta.textContent = `page ${page} / ${numPages} · ${rendered} rendered in memory`;
  }

  async function load(url) {
    clearErr();
    if (observer) { observer.disconnect(); observer = null; }
    doc = null; pages = []; queue = []; inFlight = 0; page = 1;
    scroller.innerHTML = ""; scroller.scrollTop = 0;
    setMeta();
    try {
      const engine = await window.PdfEngine.ready;
      doc = await engine.getDocument({ url, isEvalSupported: false }).promise;
      numPages = doc.numPages;
      const p1 = await doc.getPage(1);
      const vp1 = p1.getViewport({ scale: 1 });
      dims = { w: vp1.width, h: vp1.height };
      const frag = document.createDocumentFragment();
      for (let n = 1; n <= numPages; n++) {
        const d = document.createElement("div");
        d.className = "rpage";
        d.dataset.n = String(n);
        d.style.aspectRatio = `${vp1.width} / ${vp1.height}`;
        const cv = document.createElement("canvas");
        d.appendChild(cv);
        frag.appendChild(d);
        pages.push({ el: d, canvas: cv, rendered: false, rendering: false, pageRef: null, dead: false });
      }
      scroller.appendChild(frag);
      setupObserver();
      wireScroll();
      queueRender(1); // eager first page
      setMeta();
    } catch (e) {
      fail("Could not load PDF: " + (e?.message || e) + " — the URL must be CORS-enabled or same-origin.");
    }
  }

  function queueRender(n) {
    const pg = pages[n - 1];
    if (!doc || !pg || pg.rendered || pg.rendering || queue.includes(n)) return;
    queue.push(n);
    queue.sort((a, b) => Math.abs(a - page) - Math.abs(b - page));
    pump();
  }
  function pump() {
    while (inFlight < MAX_CONCURRENT && queue.length) {
      const n = queue.shift();
      const pg = pages[n - 1];
      if (pg.rendered || pg.rendering) continue;
      inFlight++;
      renderAt(n).finally(() => { inFlight--; pump(); });
    }
  }
  async function renderAt(n) {
    const pg = pages[n - 1];
    if (!doc || !pg || pg.rendered) return;
    pg.rendering = true;
    try {
      const p = await doc.getPage(n);
      if (pg.dead) return;
      pg.pageRef = p;
      const vp = p.getViewport({ scale: SCALE });
      const cv = pg.canvas;
      cv.width = vp.width; cv.height = vp.height;
      await p.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
      if (pg.dead) return;
      pg.rendered = true;
      pg.el.classList.add("done");
      pg.el.classList.remove("rerr");
      setMeta();
    } catch {
      if (!pg.dead) pg.el.classList.add("rerr");
    } finally {
      pg.rendering = false;
    }
  }
  function setupObserver() {
    observer = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) queueRender(Number(en.target.dataset.n));
    }, { root: scroller, rootMargin: `${ROOT_MARGIN}px 0px` });
    for (const pg of pages) observer.observe(pg.el);
  }
  function wireScroll() {
    scroller.onscroll = () => {
      if (scrollTick) return;
      scrollTick = true;
      requestAnimationFrame(() => { scrollTick = false; onScroll(); });
    };
  }
  function onScroll() {
    if (!doc || !pages.length) return;
    const half = scroller.clientHeight * 0.4;
    let cur = 1;
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].el.offsetTop <= scroller.scrollTop + half) cur = i + 1;
      else break;
    }
    sweep(scroller.scrollTop, scroller.clientHeight);
    if (cur !== page) { page = cur; setMeta(); }
    pump();
  }
  function sweep(top, vh) {
    const mid = top + vh / 2;
    for (const pg of pages) {
      if (!pg.rendered || pg.rendering) continue;
      if (Math.abs(pg.el.offsetTop + pg.el.offsetHeight / 2 - mid) > vh * UNLOAD_VHS) {
        pg.rendered = false;
        pg.el.classList.remove("done");
        pg.canvas.width = pg.canvas.height = 0;
        try { pg.pageRef?.destroy(); } catch {}
        pg.pageRef = null;
      }
    }
  }
  function jump(n) {
    if (!doc) return;
    const t = Math.max(1, Math.min(n, numPages));
    pages[t - 1].el.scrollIntoView({ block: "start", behavior: "auto" });
    onScroll();
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "PageDown") jump(page + 1);
    else if (e.key === "ArrowLeft" || e.key === "PageUp") jump(page - 1);
  });

  $("#loadBtn").addEventListener("click", () => load($("#url").value.trim()));
  $("#url").addEventListener("keydown", (e) => { if (e.key === "Enter") load($("#url").value.trim()); });

  $("#url").value = DEFAULT_URL;
  load(DEFAULT_URL);
})();
