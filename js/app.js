/* HSC Papers Mirror — search, filter, multi-select + bulk download
   Data: data/papers.json · Remote files: js/config.js -> fileUrl(path) */
(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const cardsEl = $("#cards");
  const resultsCount = $("#resultsCount");
  const activeFilterNote = $("#activeFilterNote");
  const bulkbarEl = $("#bulkbar");
  const bulkCountEl = $("#bulkCount");
  const zipProgressEl = $("#zipProgress");

  // Perf (behaviour-preserving): page the card render + coalesce rapid renders.
  const PAGE_SIZE = 60;
  let renderQueued = false;
  let lastFilterSig = null;
  let lastBulkCount = -1;
  let lastBulkShown = null;
  let showMoreWrap = null;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  const state = {
    papers: [],
    q: "",
    type: "all",          // all | hsc | trial
    solutionsOnly: false,
    subjects: new Set(),
    years: new Set(),
    schools: new Set(),
    sort: "new",
    view: "grid",
    selected: new Set(),  // paper ids (select = paper + solutions if present)
    includeSolutionsInZip: true,
    visibleCount: PAGE_SIZE, // paging: cards rendered (Show more raises it; reset on filter change)
  };

  /* ---------- theme ---------- */
  const root = document.documentElement;
  const savedTheme = localStorage.getItem("hsc-theme");
  if (savedTheme) root.dataset.theme = savedTheme;
  $("#themeBtn").addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem("hsc-theme", root.dataset.theme);
  });

  /* ---------- config badge ---------- */
  const base = (window.SITE_CONFIG?.FILE_HOST_BASE_URL || "").replace(/^https?:\/\//, "");
  $("#hostBadge").textContent = "⇪ " + (base || "no file host set");
  $("#hostBadge").title = window.SITE_CONFIG?.FILE_HOST_BASE_URL || "";
  $("#contactEmail").textContent = window.SITE_CONFIG?.CONTACT_EMAIL || "";

  /* ---------- URL deep-linking ---------- */
  function readURL() {
    const p = new URLSearchParams(location.search);
    if (p.get("q")) { state.q = p.get("q"); $("#q").value = state.q; }
    if (p.get("type") && ["all", "hsc", "trial", "solutions"].includes(p.get("type"))) {
      const t = p.get("type");
      if (t === "solutions") { state.solutionsOnly = true; $("#solOnly").checked = true; }
      else state.type = t;
    }
    for (const [key, set] of [["subject", state.subjects], ["year", state.years], ["school", state.schools]]) {
      if (p.get(key)) p.get(key).split(",").map(s => s.trim()).filter(Boolean).forEach(v => set.add(key === "year" ? Number(v) : v));
    }
    syncPills();
  }
  function writeURL() {
    const p = new URLSearchParams();
    if (state.q) p.set("q", state.q);
    if (state.type !== "all") p.set("type", state.type);
    if (state.solutionsOnly) p.set("type", state.type === "all" ? "solutions" : state.type);
    if (state.subjects.size) p.set("subject", [...state.subjects].join(","));
    if (state.years.size) p.set("year", [...state.years].join(","));
    if (state.schools.size) p.set("school", [...state.schools].join(","));
    history.replaceState(null, "", location.pathname + (p.toString() ? "?" + p : ""));
  }

  /* ---------- load data ---------- */
  async function load() {
    try {
      const res = await fetch("data/papers.json", { cache: "no-store" });
      const json = await res.json();
      state.papers = json.papers || [];
    } catch (e) {
      cardsEl.innerHTML = `<div class="empty"><b>Couldn't load data/papers.json</b>Run via a local server (e.g. <code>npx serve .</code>) — fetch() is blocked on file://.</div>`;
      return;
    }
    readURL();
    buildFilters();
    buildSubjectStrip();
    updateStats();
    render();
  }

  /* ---------- stats ---------- */
  function updateStats() {
    $("#statPapers").textContent = state.papers.length;
    $("#statSubjects").textContent = new Set(state.papers.map(p => p.subject)).size;
    $("#statSchools").textContent = new Set(state.papers.map(p => p.school)).size;
    $("#statSolutions").textContent = state.papers.filter(p => p.hasSolutions).length;
  }

  /* ---------- filters ---------- */
  function countsBy(key) {
    const m = new Map();
    for (const p of state.papers) m.set(p[key], (m.get(p[key]) || 0) + 1);
    return m;
  }
  function checkRow(list, value, label, count, checked) {
    const lab = document.createElement("label");
    lab.className = "check";
    lab.innerHTML = `<input type="checkbox" ${checked ? "checked" : ""}> <span></span> <span class="count">${count}</span>`;
    lab.querySelector("span").textContent = label;
    lab.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) state[list].add(value);
      else state[list].delete(value);
      writeURL(); scheduleRender();
    });
    return lab;
  }
  function buildFilters() {
    // subjects
    const sCounts = countsBy("subject");
    const sList = $("#subjectList"); sList.innerHTML = "";
    [...sCounts.keys()].sort().forEach(s => sList.appendChild(checkRow("subjects", s, s, sCounts.get(s), state.subjects.has(s))));
    // Wired once: buildFilters() re-runs on strip/reset clicks, so guard
    // against stacking duplicate listeners (was a growing lag source).
    const subjSearch = $("#subjectFilterSearch");
    if (!subjSearch.dataset.wired) {
      subjSearch.dataset.wired = "1";
      subjSearch.addEventListener("input", (e) => {
        const v = e.target.value.toLowerCase();
        [...sList.children].forEach(row => row.style.display = row.textContent.toLowerCase().includes(v) ? "" : "none");
      });
    }
    // years
    const yCounts = countsBy("year");
    const yList = $("#yearList"); yList.innerHTML = "";
    [...yCounts.keys()].sort((a, b) => b - a).forEach(y => yList.appendChild(checkRow("years", y, String(y), yCounts.get(y), state.years.has(y))));
    // schools
    const schCounts = countsBy("school");
    const schList = $("#schoolList"); schList.innerHTML = "";
    [...schCounts.keys()].sort().forEach(s => schList.appendChild(checkRow("schools", s, s, schCounts.get(s), state.schools.has(s))));
    const schSearch = $("#schoolFilterSearch");
    if (!schSearch.dataset.wired) {
      schSearch.dataset.wired = "1";
      schSearch.addEventListener("input", (e) => {
        const v = e.target.value.toLowerCase();
        [...schList.children].forEach(row => row.style.display = row.textContent.toLowerCase().includes(v) ? "" : "none");
      });
    }
    // resets (also guarded — same stacking issue as above)
    document.querySelectorAll("[data-clear]").forEach(btn => {
      if (btn.dataset.wired) return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", () => {
      const k = btn.dataset.clear;
      if (k === "type") { state.type = "all"; state.solutionsOnly = false; $("#solOnly").checked = false; }
      if (k === "subject") state.subjects.clear();
      if (k === "year") state.years.clear();
      if (k === "school") state.schools.clear();
      syncPills(); buildFilters(); writeURL(); render();
    });});
  }

  function buildSubjectStrip() {
    const strip = $("#subjectStrip"); strip.innerHTML = "";
    const counts = countsBy("subject");
    const all = document.createElement("button");
    all.className = "subj-chip" + (state.subjects.size === 0 ? " on" : "");
    all.innerHTML = `<b>All subjects</b><span>${state.papers.length} papers</span>`;
    all.addEventListener("click", () => { state.subjects.clear(); buildFilters(); buildSubjectStrip(); writeURL(); render(); });
    strip.appendChild(all);
    [...counts.keys()].sort().forEach(s => {
      const b = document.createElement("button");
      b.className = "subj-chip" + (state.subjects.has(s) ? " on" : "");
      b.innerHTML = `<b></b><span>${counts.get(s)} papers</span>`;
      b.querySelector("b").textContent = s;
      b.addEventListener("click", () => {
        if (state.subjects.has(s) && state.subjects.size === 1) state.subjects.clear();
        else { state.subjects.clear(); state.subjects.add(s); }
        buildFilters(); buildSubjectStrip(); writeURL(); render();
        document.getElementById("browse").scrollIntoView({ behavior: "smooth" });
      });
      strip.appendChild(b);
    });
  }

  /* ---------- search + filter ---------- */
  function norm(s) { return (s ?? "").toString().toLowerCase(); }
  function matches(p, tokens) {
    const hay = `${p.subject} ${p.school} ${p.year} ${p.title} ${p.type}`.toLowerCase();
    return tokens.every(t => hay.includes(t));
  }
  function filtered() {
    const tokens = norm(state.q).split(/\s+/).filter(Boolean);
    let out = state.papers.filter(p => {
      if (state.type !== "all" && p.type !== state.type) return false;
      if (state.solutionsOnly && !p.hasSolutions) return false;
      if (state.subjects.size && !state.subjects.has(p.subject)) return false;
      if (state.years.size && !state.years.has(p.year)) return false;
      if (state.schools.size && !state.schools.has(p.school)) return false;
      if (tokens.length && !matches(p, tokens)) return false;
      return true;
    });
    if (state.sort === "new") out.sort((a, b) => b.year - a.year || a.subject.localeCompare(b.subject));
    if (state.sort === "old") out.sort((a, b) => a.year - b.year || a.subject.localeCompare(b.subject));
    if (state.sort === "az") out.sort((a, b) => a.subject.localeCompare(b.subject) || b.year - a.year);
    if (state.sort === "school") out.sort((a, b) => a.school.localeCompare(b.school) || b.year - a.year);
    return out;
  }

  /* ---------- render ---------- */
  function esc(s) { return (s ?? "").toString().replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
  function filterSig() {
    return [state.q, state.type, state.solutionsOnly,
      [...state.subjects].sort().join("|"),
      [...state.years].sort((a, b) => a - b).join("|"),
      [...state.schools].sort().join("|"), state.sort].join("~");
  }
  function renderShowMore(total, shown) {
    if (!showMoreWrap) {
      showMoreWrap = document.createElement("div");
      showMoreWrap.className = "show-more-wrap";
      cardsEl.after(showMoreWrap);
    }
    showMoreWrap.innerHTML = "";
    if (total > shown) {
      const btn = document.createElement("button");
      btn.className = "btn primary";
      btn.textContent = `Show more (${shown} of ${total})`;
      btn.addEventListener("click", () => { state.visibleCount += PAGE_SIZE; render(); });
      showMoreWrap.appendChild(btn);
    }
  }
  function render() {
    const list = filtered();
    // Reset paging only when the result set itself changed
    // (Show more / selection changes keep the current page).
    const sig = filterSig();
    if (sig !== lastFilterSig) { lastFilterSig = sig; state.visibleCount = PAGE_SIZE; }
    const visible = list.slice(0, state.visibleCount);
    resultsCount.textContent = `${list.length} paper${list.length === 1 ? "" : "s"}`;
    const bits = [];
    if (state.q) bits.push(`“${state.q}”`);
    if (state.type !== "all") bits.push(state.type.toUpperCase());
    if (state.solutionsOnly) bits.push("solutions");
    activeFilterNote.textContent = bits.length ? "· " + bits.join(" · ") : "";

    if (!list.length) {
      cardsEl.innerHTML = `<div class="empty" style="grid-column:1/-1"><b>No papers match</b>Try clearing a filter or searching “maths”, “Ruse”, “2024”…</div>`;
    } else {
      cardsEl.innerHTML = "";
      const frag = document.createDocumentFragment();
      for (const p of visible) frag.appendChild(cardEl(p));
      cardsEl.appendChild(frag);
    }
    renderShowMore(list.length, visible.length);
    renderBulk();
    // keep strip highlight in sync
    document.querySelectorAll(".subj-chip").forEach((chip, i) => {
      if (i === 0) chip.classList.toggle("on", state.subjects.size === 0);
    });
  }

  function cardEl(p) {
    const el = document.createElement("div");
    el.className = "card" + (state.selected.has(p.id) ? " selected" : "");
    const paperHref = window.fileUrl(p.path);
    const solHref = p.solutionPath ? window.fileUrl(p.solutionPath) : null;
    el.innerHTML = `
      <input type="checkbox" ${state.selected.has(p.id) ? "checked" : ""} aria-label="Select ${esc(p.title)}">
      <div class="card-body">
        <div class="card-top">
          <span class="tag ${p.type}">${p.type === "hsc" ? "HSC" : "Trial"}</span>
          <span class="tag">${esc(String(p.year))}</span>
          ${p.hasSolutions ? `<span class="tag sol">Solutions</span>` : ""}
        </div>
        <h3></h3>
        <div class="meta"></div>
        <div class="card-actions">
          <a class="mini-btn go" href="${esc(paperHref)}" target="_blank" rel="noopener" download>⭳ Paper</a>
          ${solHref ? `<a class="mini-btn" href="${esc(solHref)}" target="_blank" rel="noopener" download>Solutions</a>` : ""}
        </div>
      </div>`;
    el.querySelector("h3").textContent = p.title;
    el.querySelector(".meta").textContent = `${p.subject} · ${p.school} · ${p.size || ""}`.replace(/ · $/, "");
    const box = el.querySelector("input");
    box.addEventListener("change", () => {
      if (box.checked) state.selected.add(p.id);
      else state.selected.delete(p.id);
      el.classList.toggle("selected", box.checked);
      renderBulk();
    });
    el.addEventListener("click", (e) => {
      if (e.target.closest("a") || e.target === box) return;
      box.checked = !box.checked;
      box.dispatchEvent(new Event("change"));
    });
    return el;
  }

  /* ---------- selection + bulk ---------- */
  function selectedPapers() {
    return state.papers.filter(p => state.selected.has(p.id));
  }
  function selectedFiles() {
    // paper + its solutions (if any) — each as {url, name}
    const files = [];
    for (const p of selectedPapers()) {
      files.push({ url: window.fileUrl(p.path), name: safeName(p, "paper") });
      if (p.solutionPath && state.includeSolutionsInZip) {
        files.push({ url: window.fileUrl(p.solutionPath), name: safeName(p, "solutions") });
      }
    }
    return files;
  }
  function safeName(p, kind) {
    const base = `${p.year}-${p.subject}-${p.school}-${kind}`.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
    return base + ".pdf";
  }

  function renderBulk() {
    const n = state.selected.size;
    if (n !== lastBulkCount) { bulkCountEl.textContent = `${n} selected`; lastBulkCount = n; }
    const show = n > 0;
    if (show !== lastBulkShown) { bulkbarEl.classList.toggle("show", show); lastBulkShown = show; }
    if (zipProgressEl.textContent !== "") zipProgressEl.textContent = "";
  }

  $("#selectAllBtn").addEventListener("click", () => {
    filtered().forEach(p => state.selected.add(p.id));
    render();
  });
  $("#clearSelBtn").addEventListener("click", () => { state.selected.clear(); render(); });
  $("#bulkClear").addEventListener("click", () => { state.selected.clear(); render(); });

  $("#eachBtn").addEventListener("click", () => {
    const files = selectedFiles();
    if (!files.length) return;
    // Open sequentially — browsers may block >~5 popups; user allows once.
    files.forEach((f, i) => setTimeout(() => window.open(f.url, "_blank", "noopener"), i * 350));
  });

  $("#copyBtn").addEventListener("click", async () => {
    const files = selectedFiles();
    const text = files.map(f => f.url).join("\n");
    try { await navigator.clipboard.writeText(text); $("#zipProgress").textContent = "Links copied ✓"; }
    catch { $("#zipProgress").textContent = "Copy blocked — select & copy manually"; }
    setTimeout(renderBulk, 2500);
  });

  $("#zipBtn").addEventListener("click", async () => {
    const files = selectedFiles();
    if (!files.length) return;
    const max = window.SITE_CONFIG?.MAX_ZIP_FILES || 30;
    if (files.length > max) {
      $("#zipProgress").textContent = `Too many files (${files.length} > ${max}). Deselect or ZIP in batches.`;
      return;
    }
    if (typeof JSZip === "undefined") { $("#zipProgress").textContent = "ZIP library failed to load (CDN blocked). Use Download individually."; return; }
    const zip = new JSZip();
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      $("#zipProgress").textContent = `Fetching ${i + 1}/${files.length}…`;
      try {
        const res = await fetch(f.url);
        if (!res.ok) throw new Error(res.status);
        zip.file(f.name, await res.blob());
        ok++;
      } catch (e) {
        console.warn("ZIP fetch failed (host needs CORS):", f.url, e);
      }
    }
    if (!ok) {
      $("#zipProgress").textContent = "Host blocked ZIP (needs CORS *). Use “Download individually”.";
      return;
    }
    $("#zipProgress").textContent = "Compressing…";
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = window.SITE_CONFIG?.ZIP_NAME || "hsc-papers-selection.zip";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
    $("#zipProgress").textContent = `Done — ${ok}/${files.length} files ✓`;
    setTimeout(renderBulk, 3000);
  });

  /* ---------- events ---------- */
  let debounce;
  $("#q").addEventListener("input", (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.q = e.target.value.trim(); writeURL(); scheduleRender(); }, 160);
  });
  $("#searchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    state.q = $("#q").value.trim(); writeURL(); render();
    document.getElementById("browse").scrollIntoView({ behavior: "smooth" });
  });
  function syncPills() {
    document.querySelectorAll("#typePills .pill").forEach(p => {
      const t = p.dataset.type;
      const on = t === "solutions" ? state.solutionsOnly : state.type === t && !state.solutionsOnly && t !== "all" ? true : t === "all" && state.type === "all" && !state.solutionsOnly;
      p.classList.toggle("on", !!on);
    });
    document.querySelectorAll("#typeSeg button").forEach(b => b.classList.toggle("on", b.dataset.type === state.type));
  }
  document.querySelectorAll("#typePills .pill").forEach(p => p.addEventListener("click", () => {
    const t = p.dataset.type;
    if (t === "solutions") state.solutionsOnly = !state.solutionsOnly;
    else { state.type = t; if (t !== "all") { /* keep sol flag */ } }
    if (t === "all") { state.type = "all"; state.solutionsOnly = false; }
    $("#solOnly").checked = state.solutionsOnly;
    syncPills(); writeURL(); render();
  }));
  document.querySelectorAll("#typeSeg button").forEach(b => b.addEventListener("click", () => {
    state.type = b.dataset.type; syncPills(); writeURL(); render();
  }));
  $("#solOnly").addEventListener("change", (e) => { state.solutionsOnly = e.target.checked; syncPills(); writeURL(); render(); });
  $("#sortSel").addEventListener("change", (e) => { state.sort = e.target.value; render(); });
  $("#viewBtn").addEventListener("click", () => {
    state.view = state.view === "grid" ? "list" : "grid";
    cardsEl.classList.toggle("list", state.view === "list");
  });
  $("#filtersToggle").addEventListener("click", () => $("#sidebar").classList.toggle("open"));

  load();
})();
