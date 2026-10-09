/* HSC Papers Mirror — search, filter, multi-select + bulk download
   Data: data/papers.json · Remote files: js/config.js -> fileUrl(path) */
(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  // Null-tolerant wiring: a missing static element degrades to "that button
  // does nothing" instead of crashing the whole app — a stale-shell version
  // mismatch used to kill every card render this way (v1.0.2 lesson).
  const on = (sel, ev, fn, opts) => $(sel)?.addEventListener(ev, fn, opts);
  const cardsEl = $("#cards");
  const resultsCount = $("#resultsCount");
  const bulkbarEl = $("#bulkbar");
  const bulkCountEl = $("#bulkCount");
  const zipProgressEl = $("#zipProgress");
  // Shell metrics: the paper column's scroller (shell mode) — used by the
  // auto-append observer, marquee math, and autoscroll targeting.
  const scrollerEl = document.querySelector(".content");
  function pageOffsetY() { return window.scrollY + (scrollerEl?.scrollTop || 0); }

  // Perf (behaviour-preserving): page the card render + coalesce rapid renders.
  const PAGE_SIZE = 120;
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

  // Shared: rebuild facet UI + URL after any filter mutation.
  function applyFilterChange() {
    syncPills();
    buildFilters();
    buildSubjectStrip();
    updateStats();
    writeURL();
    scheduleRender();
  }

  const state = {
    papers: [],
    q: "",
    type: "all",          // all | hsc | trial
    level: "all",         // all | hsc | preliminary | year10 | year9
    solutionsOnly: false,
    subjects: new Set(),
    years: new Set(),
    schools: new Set(),
    sort: "new",
    view: "grid",
    selected: new Set(),  // paper ids (select = paper + solutions if present)
    includeSolutionsInZip: true,
    includeSlowRoute: false, // 🐢 THSC-resolver files: excluded from saves by default
    mine: false,          // ★ My papers shelf (bookmarks ∪ downloaded ∪ recent)
    visibleCount: PAGE_SIZE, // paging: cards rendered (Show more raises it; reset on filter change)
  };

  /* Persisted UI state — desktop only. The desktop app keeps filters/
     selection across restarts; the website always opens fresh (deep links
     still restore filters explicitly via ?q=…). Theme + density persist on
     both (device preferences, not filters). */
  const STATE_KEY = "hsc-state-v1";
  function persistState() {
    if (!IS_TAURI) return;
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        q: state.q, type: state.type, level: state.level, solutionsOnly: state.solutionsOnly,
        subjects: [...state.subjects], years: [...state.years], schools: [...state.schools],
        sort: state.sort, view: state.view,         selected: [...state.selected],
        includeSolutionsInZip: state.includeSolutionsInZip,
        includeSlowRoute: state.includeSlowRoute,
        mine: state.mine,
      }));
    } catch {}
  }
  function restoreState() {
    if (!IS_TAURI) return;
    try {
      const s = JSON.parse(localStorage.getItem(STATE_KEY) || "null");
      if (!s) return;
      if (typeof s.q === "string") state.q = s.q;
      if (["all", "hsc", "trial", "internal"].includes(s.type)) state.type = s.type;
      if (["all", "hsc", "preliminary", "year10", "year9"].includes(s.level)) state.level = s.level;
      state.solutionsOnly = !!s.solutionsOnly;
      for (const [key, set, isNum] of [["subjects", state.subjects, false], ["years", state.years, true], ["schools", state.schools, false]]) {
        if (Array.isArray(s[key])) s[key].forEach((v) => set.add(isNum ? Number(v) : String(v)));
      }
      if (["new", "old", "az", "school"].includes(s.sort)) state.sort = s.sort;
      if (s.view === "list" || s.view === "grid") state.view = s.view;
      if (Array.isArray(s.selected)) s.selected.forEach((id) => { if (id) state.selected.add(id); });
      if (typeof s.includeSolutionsInZip === "boolean") state.includeSolutionsInZip = s.includeSolutionsInZip;
      if (typeof s.includeSlowRoute === "boolean") state.includeSlowRoute = s.includeSlowRoute;
      if (typeof s.mine === "boolean") state.mine = s.mine;
    } catch {}
  }

  // Desktop (Tauri) integration: downloads run through the Rust backend
  // (direct to Documents/HSCPapers) instead of browser ZIP.
  const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI__;

  /* Library paths: <Subject>/<Year>/<year-subject-school-kind>-<urlhash>.pdf
     The 10-char hash is derived from the file URL, so paths NEVER change when
     the catalogue is rebuilt (no re-downloads after catalogue updates). */
  function hash6(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h.toString(36).padStart(10, "0").slice(0, 10);
  }
  function paperUrlOf(p, kind) {
    return kind === "paper"
      ? (p.url || window.fileUrl(p.path))
      : (p.solutionUrl || (p.solutionPath ? window.fileUrl(p.solutionPath) : null));
  }
  function baseRel(p, kind) {
    const seg = (s) => String(s ?? "unsorted").replace(/[\\/:*?"<>|]/g, "-").trim() || "unsorted";
    return `${seg(p.subject)}/${p.year || "unknown"}/${safeName(p, kind)}`;
  }
  function libraryRel(p, kind) {
    const url = paperUrlOf(p, kind);
    if (!url) return null;
    return baseRel(p, kind).replace(/\.pdf$/, `-${hash6(url)}.pdf`);
  }

  /* ---------- theme ---------- */
  const root = document.documentElement;
  const savedTheme = localStorage.getItem("hsc-theme");
  if (savedTheme) root.dataset.theme = savedTheme;
  on("#themeBtn", "click", () => {
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem("hsc-theme", root.dataset.theme);
  });

  /* ---------- shell metrics: exact sticky-header height feeds the locked layout ---------- */
  const headerEl = document.querySelector("header");
  function setHeaderVar() {
    if (headerEl) root.style.setProperty("--header-h", headerEl.offsetHeight + "px");
  }
  setHeaderVar();
  window.addEventListener("resize", setHeaderVar);

  /* ---------- density (compact mode) — persists like theme, both platforms ---------- */
  const DENSITY_KEY = "hsc-density";
  function applyDensity() {
    const compact = localStorage.getItem(DENSITY_KEY) === "compact";
    document.body.classList.toggle("compact", compact);
    const btn = $("#densityBtn");
    if (btn) {
      btn.classList.toggle("on", compact);
      btn.setAttribute("aria-pressed", String(compact));
    }
  }
  applyDensity();
  on("#densityBtn", "click", () => {
    if (localStorage.getItem(DENSITY_KEY) === "compact") localStorage.removeItem(DENSITY_KEY);
    else localStorage.setItem(DENSITY_KEY, "compact");
    applyDensity();
    scheduleRender(); // tag labels are compact-aware (B11) — rebuild them
  });

  /* F6 PWA: installable + offline catalogue (web only — Tauri is native).
     SW takeover: when a newly deployed worker claims this page, auto-reload
     ONCE so the user lands on fresh code + caches without knowing the SW
     dance existed (v1.0.0→v1.0.1 taught this the hard way). */
  if (!IS_TAURI && "serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      try {
        if (sessionStorage.getItem("hsc-sw-reloaded")) return;
        sessionStorage.setItem("hsc-sw-reloaded", "1");
        location.reload();
      } catch {}
    });
  }

  /* ---------- config badge ---------- */
  const base = (window.SITE_CONFIG?.FILE_HOST_BASE_URL || "").replace(/^https?:\/\//, "");
  $("#hostBadge").textContent = "⇪ " + (window.SITE_CONFIG?.HOST_BADGE || base || "no file host set");
  $("#hostBadge").title = window.SITE_CONFIG?.FILE_HOST_BASE_URL || window.SITE_CONFIG?.HOST_BADGE || "";
  $("#contactEmail").textContent = window.SITE_CONFIG?.CONTACT_EMAIL || "";

  /* ---------- desktop-app link (footer + about; hidden if unconfigured) ---------- */
  const appUrl = window.SITE_CONFIG?.DESKTOP_APP_URL || "";
  if (appUrl && !IS_TAURI) { // web only — desktop users already have the app
    const a = $("#desktopAppLink");
    if (a) { a.href = appUrl; a.hidden = false; }
    const fa = $("#footerDesktopLinkA");
    if (fa) { fa.href = appUrl; $("#footerDesktopLink").hidden = false; }
    const ga = $("#footerGitLinkA");
    if (ga) { ga.href = (appUrl.split("/releases")[0] || appUrl); $("#footerGitLink").hidden = false; }
  }

  /* ---------- removal channel (rights-holder takedown path; both surfaces) ---------- */
  const takedownUrl = window.SITE_CONFIG?.TAKE_DOWN_URL || "";
  if (takedownUrl) {
    const ra = $("#removalLink");
    if (ra) { ra.href = takedownUrl; ra.hidden = false; }
    const fra = $("#footerRemovalLinkA");
    if (fra) { fra.href = takedownUrl; $("#footerRemovalLink").hidden = false; }
  }

  /* ---------- paper submission channel (continuous-update path) ---------- */
  const submitUrl = window.SITE_CONFIG?.SUBMIT_URL || "";
  if (submitUrl) {
    const sa = $("#submitLink");
    if (sa) { sa.href = submitUrl; sa.hidden = false; }
    const fsa = $("#footerSubmitLinkA");
    if (fsa) { fsa.href = submitUrl; $("#footerSubmitLink").hidden = false; }
  }

  /* ---------- URL deep-linking ---------- */
  // ?sel=… restores a shared selection (see "shared selections" below).
  // sel stays in the URL afterwards — refresh/re-share keeps working; any
  // filter change rewrites params (dropping sel) via writeURL.
  let sharedSelNote = null; // {restored, dropped} — surfaced once by renderBulk
  async function readURL() {
    const p = new URLSearchParams(location.search);
    if (p.get("q")) { state.q = p.get("q"); $("#q").value = state.q; }
    if (p.get("type") && ["all", "hsc", "trial", "internal", "solutions"].includes(p.get("type"))) {
      const t = p.get("type");
      if (t === "solutions") { state.solutionsOnly = true; $("#solOnly").checked = true; }
      else state.type = t;
    }
    if (p.get("level") && ["all", "hsc", "preliminary", "year10", "year9"].includes(p.get("level"))) state.level = p.get("level");
    if (p.get("mine") === "1") state.mine = true;
    for (const [key, set] of [["subject", state.subjects], ["year", state.years], ["school", state.schools]]) {
      const m = location.search.match(new RegExp(`[?&]${key}=([^&]*)`));
      if (!m) continue;
      const raw = m[1];
      // Split on the SEPARATOR before decoding: the current format separates
      // values with | (%7C), the legacy format with a raw comma. A name's OWN
      // comma is always %-encoded (%2C — URLSearchParams and
      // encodeURIComponent both emit it), so it is never a separator and
      // comma-bearing subject names survive the round-trip.
      (/%7C|\|/i.test(raw) ? raw.split(/%7C|\|/i) : raw.split(","))
        .map((s) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } })
        .map((s) => s.trim()).filter(Boolean)
        .forEach(v => set.add(key === "year" ? Number(v) : v));
    }
    if (p.get("sel")) await applySharedSel(p.get("sel"));
    syncPills();
  }
  function writeURL() {
    const p = new URLSearchParams();
    if (state.q) p.set("q", state.q);
    if (state.type !== "all") p.set("type", state.type);
    if (state.level !== "all") p.set("level", state.level);
    if (state.solutionsOnly) p.set("type", state.type === "all" ? "solutions" : state.type);
    if (state.mine) p.set("mine", "1");
    if (state.subjects.size) p.set("subject", [...state.subjects].join("|"));
    if (state.years.size) p.set("year", [...state.years].join("|"));
    if (state.schools.size) p.set("school", [...state.schools].join("|"));
    history.replaceState(null, "", location.pathname + (p.toString() ? "?" + p : ""));
  }

  /* ---------- shared selections (?sel=…) ---------- */
  // Encode: newline-joined paper ids -> gzip -> base64url ("g.<data>"). Ids
  // (not positions) keep links immune to nightly catalogue reorders; gzip
  // keeps even 200-paper links short. Without CompressionStream (old
  // browsers) fall back to plain comma-joined ids when they fit; otherwise
  // the share is refused with a note. Desktop persists selections locally,
  // so links matter most on the web — both surfaces can share.
  async function encodeSel(ids) {
    const raw = ids.join("\n");
    if (typeof CompressionStream === "undefined")
      return raw.length <= 1400 ? raw.replace(/\n/g, ",") : null;
    const buf = new Uint8Array(await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"))
    ).arrayBuffer());
    let bin = "";
    for (const b of buf) bin += String.fromCharCode(b);
    return "g." + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  async function decodeSel(v) {
    try {
      let text = v;
      if (v.startsWith("g.")) {
        const b64 = v.slice(2).replace(/-/g, "+").replace(/_/g, "/");
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        text = await new Response(
          new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))
        ).text();
      }
      return [...new Set(text.split(/[\n,]+/).map(s => s.trim()).filter(Boolean))];
    } catch { return null; }
  }
  async function applySharedSel(v) {
    const ids = await decodeSel(v);
    if (!ids || !ids.length) return; // unreadable/empty — ignore silently
    const known = new Set(state.papers.map(p => p.id));
    let restored = 0, dropped = 0;
    for (const id of ids) {
      if (known.has(id)) { state.selected.add(id); restored++; }
      else dropped++; // removed/expired ids (e.g. takedown removals)
    }
    if (restored) sharedSelNote = { restored, dropped };
    else if (dropped) sharedSelNote = { restored: 0, dropped, dead: true };
  }

  /* ---------- load data ---------- */
  async function load() {
    let json = null;
    // Desktop: prefer the LIVE nightly catalogue (fresh papers without
    // reinstalling), fall back to the bundled copy when offline/blocked.
    if (IS_TAURI && window.SITE_CONFIG?.LIVE_CATALOGUE_URL) {
      try {
        const res = await fetch(window.SITE_CONFIG.LIVE_CATALOGUE_URL, { cache: "no-store" });
        if (res.ok) json = await res.json();
      } catch {}
    }
    if (!json) {
      try {
        const res = await fetch("data/papers.json", { cache: "no-store" });
        json = await res.json();
      } catch (e) {
        cardsEl.innerHTML = `<div class="empty"><b>Couldn't load data/papers.json</b>Run via a local server (e.g. <code>npx serve .</code>) — fetch() is blocked on file://.</div>`;
        return;
      }
    }
    state.papers = json.papers || [];
    restoreState(); // saved filters/selection first…
    await readURL(); // …URL deep-link overrides on top (incl. ?sel= restores)
    if (sharedSelNote?.dead) { // B6: whole link expired — honest notice, not silence
      showSelNotice(`Shared selection — ${sharedSelNote.dropped} paper${sharedSelNote.dropped === 1 ? "" : "s"} from this link ${sharedSelNote.dropped === 1 ? "is" : "are"} no longer available`);
      sharedSelNote = null; // consume before renderBulk can misread it
    }
    syncUI();       // reflect restored state in inputs/pills/sort
    buildFilters();
    buildSubjectStrip();
    updateStats();
    render();
  }

  /* ---------- stats ---------- */
  function updateStats() {
    // All stats follow the effective (toggle-filtered) catalogue so every
    // paper number on screen agrees.
    const eff = effectivePapers();
    $("#statPapers").textContent = eff.length;
    $("#statSubjects").textContent = new Set(eff.map(p => p.subject)).size;
    $("#statSchools").textContent = new Set(eff.map(p => p.school)).size;
    $("#statSolutions").textContent = eff.filter(p => p.hasSolutions).length;
    // Level pill counts — faceted like the sidebar lists (every OTHER filter
    // applied), and labels come from a map (never mangle "Yr 12" digits).
    const LEVEL_LABELS = { all: "All", hsc: "Yr 12", preliminary: "Yr 11", year10: "Yr 10", year9: "Yr 9" };
    const levelBase = filterPapers({ exclude: "level", noSort: true });
    const levelCounts = { all: levelBase.length, hsc: 0, preliminary: 0, year10: 0, year9: 0 };
    for (const p of levelBase) {
      if (p.level === "HSC") levelCounts.hsc++;
      else if (p.level === "Preliminary") levelCounts.preliminary++;
      else if (p.level === "Year 10") levelCounts.year10++;
      else if (p.level === "Year 9") levelCounts.year9++;
    }
    document.querySelectorAll("#levelSeg button").forEach(b => {
      const n = levelCounts[b.dataset.level];
      if (n === undefined) return;
      b.textContent = `${LEVEL_LABELS[b.dataset.level] || b.dataset.level} ${n}`;
    });
  }

  /* ---------- filters ---------- */
  // Effective catalogue: with "Include slow-route papers" OFF, papers whose
  // PAPER file is slow-route (dead NESA link / THSC resolver) are hidden —
  // and every paper count on every surface (stats, pills, strip, sidebar
  // lists, results count) is derived from this list so the numbers agree.
  function effectivePapers() {
    return state.includeSlowRoute ? state.papers : state.papers.filter(p => isFastHostUrl(p.url));
  }
  function countsBy(key) {
    // Faceted counting: count over the catalogue with every OTHER filter
    // applied (this facet's own filter is excluded so selected values keep
    // their numbers and unselected ones react to the active filters).
    const FACETS = new Set(["subject", "year", "school"]);
    const src = FACETS.has(key) ? filterPapers({ exclude: key, noSort: true }) : effectivePapers();
    const m = new Map();
    for (const p of src) m.set(p[key], (m.get(p[key]) || 0) + 1);
    return m;
  }
  function checkRow(list, value, label, count, checked) {
    const lab = document.createElement("label");
    lab.className = "check";
    lab.dataset.list = list;
    lab.dataset.value = String(value);
    lab.innerHTML = `<input type="checkbox" ${checked ? "checked" : ""}> <span></span> <span class="count">${count}</span>`;
    lab.querySelector("span").textContent = label;
    // No per-label listener: buildFilters() replaces these labels on every
    // filter change, and a rapid click landing on a just-replaced input
    // fired against a detached element (stale value → desynced counts).
    // Change events are delegated on the containers instead.
    return lab;
  }
  function buildFilters() {
    // Preserve scroll + focus across rebuilds: every checkbox click rebuilds
    // these lists (faceted counts), so a reset would yank the user back to
    // the top and kill multi-row selection flow.
    const sidebarBox = $("#sidebar");
    const savedScroll = sidebarBox ? sidebarBox.scrollTop : 0;
    const focusedRow = document.activeElement?.closest?.(".check");
    const focusRef = focusedRow ? { list: focusedRow.dataset.list, value: focusedRow.dataset.value } : null;
    // subjects — unselected values that dropped to 0 under the active
    // filters are hidden (they can't match); selected values always stay.
    const sCounts = countsBy("subject");
    const sList = $("#subjectList"); sList.innerHTML = "";
    [...sCounts.keys()].sort().forEach(s => {
      const n = sCounts.get(s);
      if (!n && !state.subjects.has(s)) return;
      sList.appendChild(checkRow("subjects", s, s, n, state.subjects.has(s)));
    });
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
    [...yCounts.keys()].sort((a, b) => b - a).forEach(y => {
      const n = yCounts.get(y);
      if (!n && !state.years.has(y)) return;
      yList.appendChild(checkRow("years", y, String(y), n, state.years.has(y)));
    });
    // schools
    const schCounts = countsBy("school");
    const schList = $("#schoolList"); schList.innerHTML = "";
    [...schCounts.keys()].sort().forEach(s => {
      const n = schCounts.get(s);
      if (!n && !state.schools.has(s)) return;
      schList.appendChild(checkRow("schools", s, s, n, state.schools.has(s)));
    });
    const schSearch = $("#schoolFilterSearch");
    if (!schSearch.dataset.wired) {
      schSearch.dataset.wired = "1";
      schSearch.addEventListener("input", (e) => {
        const v = e.target.value.toLowerCase();
        [...schList.children].forEach(row => row.style.display = row.textContent.toLowerCase().includes(v) ? "" : "none");
      });
    }
    // Delegated change handling (wired once): the containers persist across
    // rebuilds, so events always read the CURRENT DOM's data-value — the
    // detached-click race class is structurally gone.
    for (const [cont, list] of [["#subjectList", "subjects"], ["#yearList", "years"], ["#schoolList", "schools"]]) {
      const c = $(cont);
      if (!c || c.dataset.changeWired) continue;
      c.dataset.changeWired = "1";
      c.addEventListener("change", (e) => {
        const row = e.target.closest?.(".check");
        if (!row || row.dataset.list !== list) return;
        const value = row.dataset.value;
        const v = list === "years" ? Number(value) : value;
        if (e.target.checked) state[list].add(v);
        else state[list].delete(v);
        writeURL();
        applyFilterChange();
      });
    }
    // resets (also guarded — same stacking issue as above). The buttons live
    // inside <summary>, so prevent the summary's default toggle action.
    const hint = (id, set) => { const el = $(id); if (el) el.textContent = set ? `· ${set} selected` : ""; };
    hint("#subjectHint", state.subjects.size);
    hint("#yearHint", state.years.size);
    hint("#schoolHint", state.schools.size);
    document.querySelectorAll("[data-clear]").forEach(btn => {
      if (btn.dataset.wired) return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const k = btn.dataset.clear;
      if (k === "type") { state.type = "all"; state.solutionsOnly = false; $("#solOnly").checked = false; state.mine = false; $("#mineOnly").checked = false; }
      if (k === "level") state.level = "all";
      if (k === "subject") state.subjects.clear();
      if (k === "year") state.years.clear();
      if (k === "school") state.schools.clear();
      if (k === "type") resetSlowRoute(); // the type panel IS the main clear
      // the canonical pipeline (NOT the old inline shape): the level-seg
      // counts + the strip counts live in updateStats/buildSubjectStrip —
      // bypassing them left the filtered numbers stale after every reset.
      persistState(); applyFilterChange();
    });});
    // Restore: same scroll depth, same focused row (if it survived the
    // faceted recount) — multi-row selection flow stays uninterrupted.
    if (sidebarBox) sidebarBox.scrollTop = savedScroll;
    if (focusRef) {
      const again = [...document.querySelectorAll(`.check[data-list="${focusRef.list}"][data-value="${CSS.escape(focusRef.value)}"] input`)][0];
      if (again) again.focus({ preventScroll: true });
    }
  }

  function buildSubjectStrip() {
    const strip = $("#subjectStrip"); strip.innerHTML = "";
    const counts = countsBy("subject");
    const all = document.createElement("button");
    all.className = "subj-chip" + (state.subjects.size === 0 ? " on" : "");
    all.innerHTML = `<b>All subjects</b><span>${effectivePapers().length} paper${effectivePapers().length === 1 ? "" : "s"}</span>`;
    all.addEventListener("click", () => { state.subjects.clear(); applyFilterChange(); });
    strip.appendChild(all);
    [...counts.keys()].sort().forEach(s => {
      const b = document.createElement("button");
      b.className = "subj-chip" + (state.subjects.has(s) ? " on" : "");
      b.innerHTML = `<b></b><span>${counts.get(s)} paper${counts.get(s) === 1 ? "" : "s"}</span>`;
      b.querySelector("b").textContent = s;
      b.addEventListener("click", () => {
        if (state.subjects.has(s) && state.subjects.size === 1) state.subjects.clear();
        else { state.subjects.clear(); state.subjects.add(s); }
        applyFilterChange();
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
  // Core filter. opts.exclude skips ONE facet — used for faceted counting
  // (each list counts with every other filter applied, so numbers react to
  // what's already active). opts.includeSlow reads the full catalogue;
  // opts.noSort skips sorting (count-only paths).
  function filterPapers(opts = {}) {
    const no = (k) => opts.exclude === k;
    const tokens = norm(state.q).split(/\s+/).filter(Boolean);
    let out = (opts.includeSlow ? state.papers : effectivePapers()).filter(p => {
      if (!no("type")) {
        if (state.type === "internal") {
          if (p.type !== "assessment" && p.type !== "other") return false;
        } else if (state.type !== "all" && p.type !== state.type) return false;
      }
      if (!no("level") && state.level !== "all") {
        const lv = { hsc: "HSC", preliminary: "Preliminary", year10: "Year 10", year9: "Year 9" }[state.level];
        if (p.level !== lv) return false;
      }
      if (!no("solutions") && state.solutionsOnly && !p.hasSolutions) return false;
      if (!no("mine") && state.mine && !shelfHas(p.id)) return false;
      if (!no("subject") && state.subjects.size && !state.subjects.has(p.subject)) return false;
      if (!no("year") && state.years.size && !state.years.has(p.year)) return false;
      if (!no("school") && state.schools.size && !state.schools.has(p.school)) return false;
      if (tokens.length && !matches(p, tokens)) return false;
      return true;
    });
    if (!opts.noSort) {
      if (state.sort === "new") out.sort((a, b) => b.year - a.year || a.subject.localeCompare(b.subject));
      if (state.sort === "old") out.sort((a, b) => a.year - b.year || a.subject.localeCompare(b.subject));
      if (state.sort === "az") out.sort((a, b) => a.subject.localeCompare(b.subject) || b.year - a.year);
      if (state.sort === "school") out.sort((a, b) => a.school.localeCompare(b.school) || b.year - a.year);
    }
    return out;
  }
  function filtered(ignoreSlow) {
    return filterPapers({ includeSlow: ignoreSlow });
  }

  /* A complete reset also drops the 🐢 slow-route override: users who
     turned it on for one search expect "clear" to restore the DEFAULTS
     (off), not leave saves polluted with slow files. Module-scope so both
     the [data-clear] resets and the "Clear all ✕" chip share the lifecycle:
     stale-confirm teardown + selection never references now-hidden papers
     (identical semantics to the #slowRoute change-handler below). */
  function resetSlowRoute() {
    state.includeSlowRoute = false;
    $("#slowRoute").checked = false;
    if (tauriArmed) { tauriArmed = null; $("#zipBtn").textContent = "⭳ Save to library"; } // stale confirm
    const hide = new Set(state.papers.filter(p => !isFastHostUrl(p.url)).map(p => p.id));
    for (const id of [...state.selected]) if (hide.has(id)) state.selected.delete(id);
  }

  /* ---------- render ---------- */
  function esc(s) { return (s ?? "").toString().replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
  function filterSig() {
    return [state.q, state.type, state.level, state.solutionsOnly, state.mine,
      [...state.subjects].sort().join("|"),
      [...state.years].sort((a, b) => a - b).join("|"),
      [...state.schools].sort().join("|"), state.sort].join("~");
  }

  /* ---------- active-filter chips (visible + individually clearable) ---------- */
  function renderChips() {
    const row = $("#chipsRow");
    if (!row) return;
    const chips = [];
    const add = (label, fn) => chips.push({ label, fn });
    if (state.q) add(`“${state.q}”`, () => { state.q = ""; $("#q").value = ""; });
    if (state.type !== "all") add(state.type === "internal" ? "Internals & other" : state.type.toUpperCase(), () => { state.type = "all"; });
    if (state.level !== "all") add({ hsc: "Yr 12", preliminary: "Yr 11", year10: "Yr 10", year9: "Yr 9" }[state.level] || state.level, () => { state.level = "all"; });
    if (state.solutionsOnly) add("Solutions only", () => { state.solutionsOnly = false; $("#solOnly").checked = false; });
    if (state.mine) add("★ My papers", () => { state.mine = false; $("#mineOnly").checked = false; });
    if (state.includeSlowRoute) add("🐢 Slow-route shown", () => {
      state.includeSlowRoute = false; $("#slowRoute").checked = false;
      // Mirror the toggle handler: selection never references hidden papers.
      const hide = new Set(state.papers.filter(p => !isFastHostUrl(p.url)).map(p => p.id));
      for (const id of [...state.selected]) if (hide.has(id)) state.selected.delete(id);
    });
    for (const s of state.subjects) add(s, () => state.subjects.delete(s));
    for (const y of state.years) add(String(y), () => state.years.delete(y));
    for (const s of state.schools) add(s, () => state.schools.delete(s));
    row.innerHTML = "";
    row.hidden = !chips.length;
    if (chips.length) {
      for (const c of chips) {
        const b = document.createElement("button");
        b.className = "chip";
        b.innerHTML = `<span></span><i aria-hidden="true">✕</i>`;
        b.querySelector("span").textContent = c.label;
        b.addEventListener("click", () => { c.fn(); persistState(); applyFilterChange(); });
        row.appendChild(b);
      }
      if (chips.length >= 2) {
        const all = document.createElement("button");
        all.className = "chip chip-all";
        all.textContent = "Clear all ✕";
        all.addEventListener("click", () => {
          state.q = ""; $("#q").value = "";
          state.type = "all"; state.level = "all";
          state.solutionsOnly = false; $("#solOnly").checked = false;
          state.mine = false; $("#mineOnly").checked = false;
          state.subjects.clear(); state.years.clear(); state.schools.clear();
          resetSlowRoute();
          persistState(); applyFilterChange();
        });
        row.appendChild(all);
      }
    }
    // Mobile Filters button badge mirrors the chip count.
    const badge = $("#filterBadge");
    if (badge) { badge.hidden = !chips.length; badge.textContent = chips.length; }
  }
  // Auto-append: load the next page as the user nears the bottom of the
  // paper column (root = the shell scroller; viewport fallback on mobile).
  // The explicit Show more button stays as the fallback (and the click target).
  const moreIO = new IntersectionObserver((entries) => {
    if (!entries.some(en => en.isIntersecting)) return;
    const btn = showMoreWrap?.querySelector("button");
    if (btn) btn.click();
  }, { root: scrollerEl || null, rootMargin: "400px 0px" });
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
      moreIO.observe(showMoreWrap);
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
    // Both numbers, explicitly: the view's file total comes from the SAME
    // generator the save uses, so view ↔ selection always agree. (Preserve
    // lastSlowSkipped — it belongs to the SELECTION, not the view.)
    const skipBefore = lastSlowSkipped;
    const viewFiles = filesForPapers(list).length;
    lastSlowSkipped = skipBefore;
    resultsCount.textContent += ` · ${viewFiles} file${viewFiles === 1 ? "" : "s"}`;
    if (!state.includeSlowRoute) {
      const hiddenN = filtered(true).length - list.length;
      if (hiddenN > 0) resultsCount.textContent += ` · ${hiddenN} hidden (🐢 toggle)`;
    }
    renderChips();

    if (!list.length) {
      cardsEl.innerHTML = `<div class="empty" style="grid-column:1/-1"><b>${state.mine ? "Nothing on your shelf yet" : "No papers match"}</b>${state.mine ? "★ Star papers, download them, or open them in the reader — they’ll gather here. Stored on this device, no accounts." : "Try clearing a filter, or search “maths”, “Ruse” or “2024”."}</div>`;
    } else {
      cardsEl.innerHTML = "";
      const frag = document.createDocumentFragment();
      for (const p of visible) frag.appendChild(cardEl(p));
      cardsEl.appendChild(frag);
    }
    renderShowMore(list.length, visible.length);
    renderBulk();
    patchSavedButtons();
    persistState(); // filters/selection survive restarts + reader overlays
    // keep strip highlight in sync
    document.querySelectorAll(".subj-chip").forEach((chip, i) => {
      if (i === 0) chip.classList.toggle("on", state.subjects.size === 0);
    });
  }

  function cardEl(p) {
    const el = document.createElement("div");
    el.className = "card" + (state.selected.has(p.id) ? " selected" : "");
    el.dataset.id = p.id;
    const paperHref = p.url || window.fileUrl(p.path);
    const solHref = p.solutionUrl || (p.solutionPath ? window.fileUrl(p.solutionPath) : null);
    const prel = libraryRel(p, "paper");
    const srel = solHref ? libraryRel(p, "solutions") : null;
    // 🐢 = per-component honesty: say WHICH file is slow-route. A fast paper
    // with slow solutions downloads at full CDN speed — the old card-level
    // tag made it look mislabeled.
    const slowPaper = !isFastHostUrl(p.url);
    const slowSol = solHref ? !isFastHostUrl(solHref) : false;
    const slowFull = slowPaper && slowSol ? "🐢 paper + sol" : slowPaper ? "🐢 paper" : slowSol ? "🐢 sol" : "";
    // B11: compact mode shortens labels so tag rows never wrap (height stays
    // constant); the 🐢 tooltip keeps the full detail on every density.
    const compact = document.body.classList.contains("compact");
    const slowTag = compact && slowFull ? "🐢" : slowFull;
    const gotTag = compact ? "✓" : "✓ Got";
    const solTag = compact ? "Sol" : "Solutions";
    const slowTip = slowPaper && slowSol
      ? "Paper AND solutions need THSC's rate-limited resolver (or are dead links)"
      : slowPaper
        ? "Paper file needs the slow route (THSC resolver / dead link) — hidden from saves while the toggle is off"
        : "Only the SOLUTIONS file needs the slow route — the paper itself downloads fast; solutions save only when the toggle is on";
    el.innerHTML = `
      <input type="checkbox" ${state.selected.has(p.id) ? "checked" : ""} aria-label="Select ${esc(p.title)}">
      <button class="star-btn ${bkState.has(p.id) ? "on" : ""}" data-star title="${bkState.has(p.id) ? "Remove bookmark" : "Bookmark this paper"}" aria-label="Bookmark ${esc(p.title)}">★</button>
      <div class="card-body">
        <div class="card-top">
          <span class="tag ${p.type}">${{ hsc: "HSC", trial: "Trial", assessment: "Assessment", other: "Other" }[p.type] || (p.type === "hsc" ? "HSC" : "Trial")}</span>
          <span class="tag">${esc(String(p.year))}</span>
          ${p.hasSolutions ? `<span class="tag sol">${solTag}</span>` : ""}
          ${!IS_TAURI && downloadedSet().has(p.id) ? `<span class="tag got" title="Downloaded before in this browser">${gotTag}</span>` : ""}
          ${slowTag ? `<span class="tag slow" title="${esc(slowTip)}">${slowTag}</span>` : ""}
        </div>
        <h3></h3>
        <div class="meta"></div>
        <div class="card-actions">
          <a class="mini-btn go" href="${esc(paperHref)}" target="_blank" rel="noopener" download data-rel="${esc(prel || "")}" ${!IS_TAURI ? `data-dl data-name="${esc(safeName(p, "paper"))}"` : ""}>⭳ Paper</a>
          ${solHref ? `<a class="mini-btn" href="${esc(solHref)}" target="_blank" rel="noopener" download data-rel="${esc(srel || "")}" ${!IS_TAURI ? `data-dl data-name="${esc(safeName(p, "solutions"))}"` : ""}>Solutions</a>` : ""}
          ${!IS_TAURI && paperHref && paperHref !== "#" ? `<button class="mini-btn" data-read>📖 Read</button>` : ""}
        </div>
      </div>`;
    el.querySelector("h3").textContent = p.title;
    el.querySelector(".meta").textContent = `${p.subject} · ${p.school} · ${p.size || ""}`.replace(/ · $/, "");
    const readBtn = el.querySelector("[data-read]");
    if (readBtn) readBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      openReader(paperHref, p.title, p.id, solHref || null, p.solFallbackUrl || null, p.fallbackUrl || null); // auto-split when solutions exist
    });
    const starBtn = el.querySelector("[data-star]");
    starBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      toggleBookmark(p.id);
      const on = bkState.has(p.id);
      starBtn.classList.toggle("on", on);
      starBtn.title = on ? "Remove bookmark" : "Bookmark this paper";
      if (state.mine) scheduleRender(); // unstar can remove it from the shelf view
    });
    if (!IS_TAURI) {
      el.querySelectorAll("a[data-dl]").forEach(a => a.addEventListener("click", (e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // browser opens in new tab
        e.preventDefault();
        instantDownload(a.href, a.dataset.name, p.id);
      }));
    }
    const box = el.querySelector("input");
    box.addEventListener("change", () => {
      if (box.checked) state.selected.add(p.id);
      else state.selected.delete(p.id);
      el.classList.toggle("selected", box.checked);
      renderBulk();
    });
    el.addEventListener("click", (e) => {
      if (didDrag) { didDrag = false; return; }
      if (e.target.closest("a") || e.target.closest("button") || e.target === box) return;
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
    // paper + its solutions (if any) — each as {id, url, name, relpath}
    return filesForPapers(selectedPapers());
  }
  function safeName(p, kind) {
    const base = `${p.year ?? "na"}-${p.subject}-${p.school}-${kind}`.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
    return base + ".pdf";
  }

  function renderBulk() {
    const n = state.selected.size;
    if (n !== lastBulkCount) {
      // Selection changed: stale status text (cap notes, finished-run lines)
      // belongs to the OLD selection — clear it unless a Tauri batch is live.
      if (!tauriRun) $("#zipProgress").textContent = "";
      // Both numbers, explicitly — papers selected and files they produce
      // (solutions ride along; skips from slow sols surface as a note).
      const f = n ? selectedFiles().length : 0;
      bulkCountEl.textContent = n
        ? `${n} paper${n === 1 ? "" : "s"} · ${f} file${f === 1 ? "" : "s"} to save`
        : "no papers selected";
      if (f && lastSlowSkipped) tauriStatus(`🐢 ${lastSlowSkipped} slow-route file${lastSlowSkipped === 1 ? "" : "s"} skipped (of the selection)`);
      if (sharedSelNote && !tauriRun) {
        $("#zipProgress").textContent =
          `🔗 Shared selection — ${sharedSelNote.restored} paper${sharedSelNote.restored === 1 ? "" : "s"} restored` +
          (sharedSelNote.dropped ? ` · ${sharedSelNote.dropped} link item${sharedSelNote.dropped === 1 ? "" : "s"} no longer available` : "");
        sharedSelNote = null;
      }
      lastBulkCount = n;
    }
    // Keep the bar up while a batch runs even with an empty selection
    // (save-all flow), so progress/status stay visible.
    const show = n > 0 || !!tauriRun;
    if (show !== lastBulkShown) { bulkbarEl.classList.toggle("show", show); lastBulkShown = show; }
  }

  on("#selectAllBtn", "click", () => {
    // Desktop: UNLIMITED — the Rust backend has no browser caps. Web: cap the
    // SELECTION to the first maxFiles files (current sort order) so the
    // browser ZIP never has to reject — the bulk bar shows the ceiling.
    if (IS_TAURI) {
      filtered().forEach(p => state.selected.add(p.id));
      render();
      return;
    }
    const cap = window.SITE_CONFIG?.MAX_ZIP_FILES || 200;
    const files = filesForPapers(filtered());
    const capped = files.length > cap;
    if (capped) {
      state.selected = new Set(files.slice(0, cap).map(f => f.kind === "solutions" ? f.id.slice(0, -4) : f.id));
    } else {
      filtered().forEach(p => state.selected.add(p.id));
    }
    render();
    // AFTER render: renderBulk clears stale status on selection changes.
    if (capped) tauriStatus(`Select all: capped at ${cap} files (${files.length} matched)`);
  });
  on("#shareBtn", "click", async () => {
    // Web recipients can only ZIP up to MAX_ZIP_FILES, so links cap there
    // too (unknown recipient surface — desktop sharers included).
    const cap = window.SITE_CONFIG?.MAX_ZIP_FILES || 200;
    let ids = [...state.selected];
    const files = selectedFiles();
    const capped = files.length > cap;
    if (capped) {
      const kept = new Set(files.slice(0, cap).map(f => f.kind === "solutions" ? f.id.slice(0, -4) : f.id));
      ids = ids.filter(id => kept.has(id));
    }
    if (!ids.length) { tauriStatus("Select papers first, then Share"); return; }
    const enc = await encodeSel(ids);
    if (!enc) { tauriStatus("Selection too large to share on this browser"); return; }
    // Share links ALWAYS point at the production site: inside the desktop
    // app location.origin is the tauri:// WebView, which no recipient can
    // open. SHARE_BASE_URL (config.js) is the canonical public URL.
    const base = (window.SITE_CONFIG?.SHARE_BASE_URL || "").replace(/\/+$/, "")
      || (location.origin + location.pathname).replace(/\/+$/, "");
    const url = `${base}/?sel=${enc}`;
    const note = `🔗 Share link copied — ${ids.length} paper${ids.length === 1 ? "" : "s"}${capped ? ` (capped at ${cap} files)` : ""} open pre-selected on any device`;
    // Mobile: the native share sheet is the best UX there. Desktop: the OS
    // share flyout is confusing and often empty — copy straight to the
    // clipboard instead.
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    if (navigator.share && isMobile) {
      try { await navigator.share({ title: "HSCPapers — shared selection", url }); return; }
      catch (e) { if (e && e.name === "AbortError") return; }
    }
    try {
      await navigator.clipboard.writeText(url);
      tauriStatus(note);
    } catch {
      // Clipboard denied: textarea fallback (prompt() is a no-op in Tauri).
      try {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.style.cssText = "position:fixed;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        if (ok) tauriStatus(note);
        else if (!IS_TAURI) window.prompt("Copy this share link:", url);
        else tauriStatus("Couldn't copy the share link — please try again");
      } catch {
        if (!IS_TAURI) window.prompt("Copy this share link:", url);
        else tauriStatus("Couldn't copy the share link — please try again");
      }
    }
  });
  on("#bulkClear", "click", () => {
    if (tauriRun) {
      tauriRun.cancel = true; // remaining files stay queued for resume
      tauriStatus("Cancelling — the current download will stop within a second…");
      if (IS_TAURI) window.__TAURI__.core.invoke("cancel_downloads", { cancel: true }).catch(() => {});
    }
    if (tauriArmed) clearArmedUI();
    state.selected.clear(); render();
  });

  /* B6: transient notice bar above the grid (stale shared links etc.) */
  let selNoticeTimer = null;
  function showSelNotice(text) {
    const bar = $("#selNotice");
    if (!bar) return;
    $("#selNoticeText").textContent = text;
    bar.hidden = false;
    clearTimeout(selNoticeTimer);
    selNoticeTimer = setTimeout(() => { bar.hidden = true; }, 10000);
  }
  on("#selNoticeClose", "click", () => {
    clearTimeout(selNoticeTimer);
    $("#selNotice").hidden = true;
  });

  /* ---------- instant single downloads (web): fetch -> blob -> named save ---------- */
  // Card ⭳ buttons download immediately (no viewer tab): same-origin blob
  // makes the `download` attribute + our filename work, and failures are
  // reportable. Desktop keeps its Save-to-library flow instead.
  let dlState = null;
  function downloadedSet() {
    if (dlState) return dlState;
    try { dlState = new Set(JSON.parse(localStorage.getItem("hsc-downloaded") || "[]")); }
    catch { dlState = new Set(); }
    return dlState;
  }
  function markDownloaded(id) {
    if (IS_TAURI || !id) return; // desktop: the real check is the library on disk
    downloadedSet().add(id);
    if (dlState.size > 600) dlState = new Set([...dlState].slice(-300)); // ring buffer
    try { localStorage.setItem("hsc-downloaded", JSON.stringify([...dlState].slice(-600))); } catch {}
  }

  /* Bookmarks + recently viewed: device-local shelf data (same pattern as
     ✓ Got — localStorage, no accounts). "★ My papers" = starred ∪ downloaded
     ∪ recently opened, so daily users get one personal place. Bookmarks
     capped at 2000 ids, recent ring at 50. */
  let bkState = new Set();
  try { bkState = new Set(JSON.parse(localStorage.getItem("hsc-bookmarked") || "[]").filter(Boolean)); } catch {}
  let rvState = [];
  try { rvState = JSON.parse(localStorage.getItem("hsc-recent") || "[]").filter(Boolean).slice(0, 50); } catch {}
  function saveBookmarks() {
    try { localStorage.setItem("hsc-bookmarked", JSON.stringify([...bkState].slice(-2000))); } catch {}
  }
  function toggleBookmark(id) {
    if (bkState.has(id)) bkState.delete(id); else bkState.add(id);
    saveBookmarks();
  }
  function logRecentlyViewed(id) {
    rvState = [id, ...rvState.filter(x => x !== id)].slice(0, 50);
    try { localStorage.setItem("hsc-recent", JSON.stringify(rvState)); } catch {}
  }
  function shelfHas(id) {
    return bkState.has(id) || downloadedSet().has(id) || rvState.includes(id);
  }
  async function instantDownload(url, filename, paperId) {
    try {
      const res = await fetch(proxied(url));
      if (!res.ok) throw new Error(res.status);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename || "paper.pdf";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 8000);
      markDownloaded(paperId);
      scheduleRender(); // refresh ✓ Got badges
      return true;
    } catch (e) {
      tauriStatus(`Download failed (${filename || "paper"}): ${e?.message || e}`);
      return false;
    }
  }

  on("#zipBtn", "click", async () => {
    let files = selectedFiles();
    if (!files.length) return;
    if (IS_TAURI) { tauriSaveClick(); return; }
    const maxFiles = window.SITE_CONFIG?.MAX_ZIP_FILES || 200;
    const budgetBytes = (window.SITE_CONFIG?.MAX_ZIP_BUDGET_MB || 500) * 1048576;
    let capped = null;
    if (files.length > maxFiles) {
      // Never block on count: take the first maxFiles (current selection
      // order) and say so — the budget stop below handles the rest.
      capped = files.length;
      files = files.slice(0, maxFiles);
    }
    if (typeof JSZip === "undefined") { $("#zipProgress").textContent = "ZIP library failed to load. Use the ⭳ buttons on each card."; return; }
    const zip = new JSZip();
    let ok = 0, bytes = 0, budgetStop = null;
    const budget = budgetBytes;
    const fmtMB = (n) => (n / 1048576).toFixed(1) + " MB";
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      $("#zipProgress").textContent = `Fetching ${i + 1}/${files.length} · ${fmtMB(bytes)} so far…`;
      try {
        const res = await fetch(proxied(f.url));
        if (!res.ok) throw new Error(res.status);
        const blob = await res.blob();
        if (bytes + blob.size > budget) {
          // Budget enforced DURING the build with real sizes: emit what we
          // have instead of risking a tab crash on oversized selections.
          budgetStop = i;
          break;
        }
        zip.file(f.relpath, blob);
        bytes += blob.size;
        ok++;
      } catch (e) {
        console.warn("ZIP fetch failed (source blocked / proxy error):", f.url, e);
      }
    }
    if (!ok) {
      $("#zipProgress").textContent = "ZIP blocked by the source (needs CORS). Use the ⭳ buttons on each card.";
      return;
    }
    $("#zipProgress").textContent = `Packing ${fmtMB(bytes)}…`;
    // STORE, not DEFLATE: PDFs barely compress (~2-5%), so compression is
    // pure cost — one full second pass in RAM. Stored entries keep peak
    // memory at ~raw bytes, which is what makes the 500MB budget safe.
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = window.SITE_CONFIG?.ZIP_NAME || "hsc-papers-selection.zip";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
    $("#zipProgress").textContent = budgetStop !== null
      ? `Done — ${ok} files (≈${fmtMB(bytes)}), budget reached at ${budgetStop + 1} of ${files.length}. Deselect more or use the desktop app for the rest.`
      : capped
        ? `Done — ${ok} of ${capped} selected (capped at ${maxFiles} files, ≈${fmtMB(bytes)}) ✓`
        : `Done — ${ok}/${files.length} files (≈${fmtMB(bytes)}) ✓`;
    setTimeout(renderBulk, 5000);
  });

  /* ----- drag-select v2: Windows-style rubber band ----- */
  // Mouse only (touch keeps tap-toggles); additive — the band never
  // deselects. A fixed marquee rect selects every rendered card it
  // intersects (rAF-throttled), with edge autoscroll near viewport
  // top/bottom. The click that follows a real drag is swallowed.
  let marquee = null;   // {x0doc, y0doc, seen:Set, active, raf}
  let didDrag = false;
  let marqueePX = 0, marqueePY = 0;
  const marqueeEl = document.createElement("div");
  marqueeEl.className = "marquee";
  document.body.appendChild(marqueeEl);
  function dragAddCard(card) {
    const box = card.querySelector("input");
    if (box && !box.checked) box.click(); // reuses the card's own change wiring
  }
  function marqueeApply(px, py) {
    // Two scroll layers: window (page, horizontal + mobile vertical) and the
    // shell's content scroller (desktop card column). Band + card boxes live
    // in the combined offset space so both scroll directions stay correct.
    const sx = window.scrollX;
    const offY = pageOffsetY();
    const y0 = marquee.y0doc, y1 = py + offY;
    const L = Math.min(marquee.x0doc, sx + px), R = Math.max(marquee.x0doc, sx + px);
    const T = Math.min(y0, y1), B = Math.max(y0, y1);
    for (const card of cardsEl.querySelectorAll(".card")) {
      const b = card.getBoundingClientRect();
      if (b.right + sx <= L || b.left + sx >= R || b.bottom + offY <= T || b.top + offY >= B) continue;
      const id = card.dataset.id;
      if (id && !marquee.seen.has(id)) { marquee.seen.add(id); dragAddCard(card); }
    }
    marqueeEl.style.left = Math.min(marquee.x0doc - sx, px) + "px";
    marqueeEl.style.top = Math.min(y0 - offY, py) + "px";
    marqueeEl.style.width = Math.abs(px - (marquee.x0doc - sx)) + "px";
    marqueeEl.style.height = Math.abs(py - (y0 - offY)) + "px";
    marqueeEl.style.display = "block";
  }
  function marqueeLoop() {
    if (!marquee) return;
    const edge = 70;
    const dir = marqueePY < edge ? -1 : marqueePY > window.innerHeight - edge ? 1 : 0;
    if (dir) {
      // Autoscroll the layer the cursor is over: the shell's paper column in
      // shell mode, the page otherwise.
      if (scrollerEl && scrollerEl.scrollHeight > scrollerEl.clientHeight) scrollerEl.scrollTop += dir * 14;
      else window.scrollBy(0, dir * 14);
    }
    marqueeApply(marqueePX, marqueePY);
    marquee.raf = requestAnimationFrame(marqueeLoop);
  }
  cardsEl.addEventListener("pointerdown", (e) => {
    didDrag = false;
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    if (e.target.closest("input,button,a")) return;
    marquee = { x0doc: e.clientX + window.scrollX, y0doc: e.clientY + pageOffsetY(), seen: new Set(), active: false, raf: 0 };
  });
  window.addEventListener("pointermove", (e) => {
    if (!marquee) return;
    if (e.pointerType !== "mouse") return;
    marqueePX = e.clientX; marqueePY = e.clientY;
    if (!marquee.active) {
      const dx = Math.abs(e.clientX + window.scrollX - marquee.x0doc);
      const dy = Math.abs(e.clientY + pageOffsetY() - marquee.y0doc);
      if (dx < 6 && dy < 6) return;
      marquee.active = true;
      didDrag = true;
      document.body.classList.add("drag-select");
    }
    marqueeApply(e.clientX, e.clientY);
    if (!marquee.raf) marquee.raf = requestAnimationFrame(marqueeLoop);
  });
  function marqueeEnd() {
    if (marquee?.active) { didDrag = true; renderBulk(); }
    if (marquee) cancelAnimationFrame(marquee.raf);
    marqueeEl.style.display = "none";
    document.body.classList.remove("drag-select");
    marquee = null;
  }
  window.addEventListener("pointerup", marqueeEnd);
  window.addEventListener("pointercancel", marqueeEnd);
  window.addEventListener("blur", marqueeEnd);

  /* ----- Tauri desktop downloads (Rust backend -> Documents/HSCPapers) ----- */
  let tauriRun = null;     // {total, ok, fail, bytesTotal, bytesDone, t0, cancel}
  let tauriArmed = null;   // preflighted selection awaiting confirm (two-step Save)
  const tauriBytesById = {};
  const QUEUE_KEY = "hsc-queue"; // pending batch — survives app restarts
  const fmtMB = (n) => (Number(n || 0) / 1048576).toFixed(1) + " MB";
  function tauriStatus(msg) { $("#zipProgress").textContent = msg; }

  /* ----- persistent queue: batches survive restarts; resume is free ----- */
  function queueLoad() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "null"); } catch { return null; } }
  function queueSave(files) { try { localStorage.setItem(QUEUE_KEY, JSON.stringify({ files, at: Date.now() })); } catch {} }
  function queueClear() { try { localStorage.removeItem(QUEUE_KEY); } catch {} }
  function queueRemove(id) {
    const q = queueLoad();
    if (!q || !Array.isArray(q.files)) { queueClear(); return; }
    q.files = q.files.filter((f) => f.id !== id);
    if (!q.files.length) queueClear();
    else try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch {}
  }

  // Hosts proven to serve direct bytes — everything else (THSC router,
  // dead NESA wcm) is a "slow route" resolved via the throttled resolver.
  // (A third-party mirror was delisted 2026-09-25; its papers are
  // self-hosted now — desktop/tools/selfhost.json.)
  const FAST_SAVE_HOSTS = new Set(["hscportal.pages.dev", "pub-ec23c9b69d2544938d816ad28ee491fd.r2.dev", "www.nsw.gov.au", "www.boardofstudies.nsw.edu.au", "thsconline.github.io"]);
  function isFastHostUrl(u) {
    try { const url = new URL(u); if (/^\/s\/[dvfz]\//.test(url.pathname)) return false; return FAST_SAVE_HOSTS.has(url.host); } catch { return false; }
  }
  // Hosts whose files can be read cross-site by JS (they send ACAO:*) —
  // reader + ZIP fetch them directly. Everything else goes through the
  // same-origin /proxy Pages Function (allowlisted, Range passthrough)
  // when SITE_CONFIG.PROXY_BASE is set; with no proxy, the CORS hint fires.
  // Our own R2 bucket (self-hosted papers) sends ACAO:* too.
  const CORS_OK_HOSTS = new Set(["hscportal.pages.dev", "pub-ec23c9b69d2544938d816ad28ee491fd.r2.dev", "thsconline.github.io"]);
  function proxied(u) {
    const p = window.SITE_CONFIG?.PROXY_BASE;
    if (!p || !u) return u;
    try {
      if (CORS_OK_HOSTS.has(new URL(u).host)) return u;
      return p + "?url=" + encodeURIComponent(u);
    } catch { return u; }
  }
  let lastSlowSkipped = 0; // slow-route files excluded from the last filesForPapers() call

  // Shared: {id, url, name, relpath, fallback, kind} entries for any paper
  // list (selection or filter). `fallback` = THSC router URL used when a
  // mirror file is unavailable (handled in the Rust backend). `kind` is
  // explicit — id-suffix guessing misclassifies paper files whose THSC link
  // text ends in "w. sol". Unless "Include slow-route papers" is on,
  // slow-route files are excluded from saves (they take ~20-40 min extra).
  function filesForPapers(list) {
    const files = [];
    let skipped = 0;
    const allowSlow = !!state.includeSlowRoute;
    for (const p of list) {
      const paperUrl = paperUrlOf(p, "paper");
      const prel = libraryRel(p, "paper");
      if (prel) {
        const f = { id: p.id, url: paperUrl, name: safeName(p, "paper"), relpath: prel, fallback: p.fallbackUrl || "", kind: "paper" };
        if (allowSlow || isFastHostUrl(f.url)) files.push(f);
        else skipped++;
      }
      const sol = paperUrlOf(p, "solutions");
      if (sol && state.includeSolutionsInZip) {
        const srel = libraryRel(p, "solutions");
        if (srel) {
          const f = { id: p.id + "-sol", url: sol, name: safeName(p, "solutions"), relpath: srel, fallback: p.solFallbackUrl || "", kind: "solutions" };
          if (allowSlow || isFastHostUrl(f.url)) files.push(f);
          else skipped++;
        }
      }
    }
    lastSlowSkipped = skipped;
    return files;
  }
  function tauriEta() {
    if (!tauriRun || !tauriRun.t0) return "";
    // Byte-based ETA from the WINDOWED rate (never the deflated average).
    if (tauriRun.bytesTotal) {
      const remaining = Math.max(tauriRun.bytesTotal - tauriRun.bytesDone, 0);
      const rate = windowedRate("total");
      if (remaining > 0 && rate > 0) {
        const s = Math.round(remaining / rate);
        return ` · ~${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s left`;
      }
      if (!remaining) return "";
    }
    // No estimate (resumed batches): count-based fallback, still imperfect.
    const doneCount = tauriRun.ok + tauriRun.fail + tauriRun.deferred;
    if (!doneCount) return "";
    const el = (Date.now() - tauriRun.t0) / 1000;
    const s = Math.round(el / doneCount * Math.max(tauriRun.total - doneCount, 0));
    return ` · ~${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s left`;
  }
  function tauriLive() {
    if (!tauriRun) return;
    const at = Math.min(tauriRun.ok + tauriRun.fail + tauriRun.deferred + 1, tauriRun.total);
    // Windowed rates: speed/ETA are computed over the last ~12s of real
    // byte movement. The old cumulative rate (bytes ÷ total elapsed)
    // collapsed whenever skips/failures/pauses ate time at 0 bytes — the
    // source of the wildly wrong speed and ETA on large batches.
    pushSample();
    const rates = [];
    const cdnR = windowedRate("cdn"), bosR = windowedRate("bos"), scriptR = windowedRate("script");
    if (cdnR > 0) rates.push(`CDN ${fmtMB(cdnR)}/s`);
    if (bosR > 0) rates.push(`BOS ${fmtMB(bosR)}/s`);
    if (scriptR > 0) rates.push(`script ${(scriptR / 1048576).toFixed(2)} MB/s`);
    const frac = tauriRun.bytesTotal ? `${fmtMB(tauriRun.bytesDone)}/${fmtMB(tauriRun.bytesTotal)}` : fmtMB(tauriRun.bytesDone);
    tauriStatus(`Saving ${at}/${tauriRun.total} file${tauriRun.total === 1 ? "" : "s"}… ${frac}${rates.length ? " · " + rates.join(" · ") : ""}${tauriEta()}`);
  }
  // Ring buffer of (time, per-lane bytes); pruned to the last ~12s.
  function pushSample() {
    if (!tauriRun) return;
    if (!tauriRun.samples) tauriRun.samples = [];
    const s = tauriRun.samples;
    s.push({ t: Date.now(), total: tauriRun.bytesDone, cdn: tauriRun.cdnBytes, bos: tauriRun.bosBytes, script: tauriRun.scriptBytes });
    const cutoff = Date.now() - 12000;
    while (s.length > 2 && s[0].t < cutoff) s.shift();
  }
  // Bytes/second over the sample window (0 until ≥2s of real data).
  function windowedRate(key) {
    if (!tauriRun || !tauriRun.samples || tauriRun.samples.length < 2) return 0;
    const a = tauriRun.samples[0], b = tauriRun.samples[tauriRun.samples.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt < 2) return 0;
    const r = (b[key] - a[key]) / dt;
    return r > 0 ? r : 0;
  }
  async function tauriPool(files, n) {
    let i = 0, active = 0;
    return new Promise((resolve) => {
      const launch = () => {
        if (tauriRun.cancel) { if (active === 0) resolve(); return; }
        while (active < n && i < files.length) {
          const f = files[i++];
          active++;
          // Toggle OFF = zero resolver traffic: no fallback, so a
          // mirror-missing file fails immediately instead of using THSC's
          // rate-limited resolver. Toggle ON keeps the full fallback chain.
          window.__TAURI__.core.invoke("download_paper", { id: f.id, url: f.url, relpath: f.relpath, fallback: (state.includeSlowRoute && f.fallback) || null })
            .then(() => { tauriRun.ok++; queueRemove(f.id); })
            .catch((e) => {
              const msg = String(e?.message || e);
              if (msg.includes("rate-limited") || msg.includes("rate limit")) {
                tauriRun.deferred++; // stays queued; resume later (off-peak)
              } else if (msg.includes("cancel")) {
                tauriRun.stopped++; // ✕ hit: counted separately from rate-limit deferrals
              } else {
                tauriRun.fail++;
                queueRemove(f.id);
                console.warn("HSCPapers download failed:", f.relpath, e);
              }
            })
            .finally(() => { active--; if (tauriRun) tauriLive(); launch(); });
        }
        if (i >= files.length && active === 0) resolve();
      };
      launch();
    });
  }
  /* ----- batch start (shared by Save / Resume) ----- */
  async function tauriStartBatch(files, estBytes = 0) {
    if (tauriRun || !files.length) return;
    try { await window.__TAURI__.core.invoke("cancel_downloads", { cancel: false }); } catch {}
    // Slow-route exclusion applies to resumed queues too.
    if (!state.includeSlowRoute) {
      const before = files.length;
      files = files.filter((f) => isFastHostUrl(f.url));
      if (files.length !== before) tauriStatus(`🐢 ${before - files.length} slow-route files skipped (toggle in sidebar)`);
      if (!files.length) return;
    }
    // Merge into any pending interrupted batch (never silently drop it).
    const pending = queueLoad();
    if (pending && Array.isArray(pending.files) && pending.files.length) {
      const have = new Set(files.map((f) => f.id));
      const add = pending.files.filter((f) => !have.has(f.id) && (state.includeSlowRoute || isFastHostUrl(f.url)));
      if (add.length) {
        // The size estimate was computed for the armed selection only —
        // extend it (flat per-file guess) so progress can't exceed 100%.
        estBytes = (estBytes || 0) + add.length * 4 * 1024 * 1024;
        files = files.concat(add);
      }
    }
    queueSave(files); // persistent: even a crash leaves the batch resumable
    hideResumeBar();
    for (const k of Object.keys(tauriBytesById)) delete tauriBytesById[k];
    tauriRun = { total: files.length, ok: 0, fail: 0, deferred: 0, stopped: 0, bytesTotal: estBytes || 0, bytesDone: 0, cdnBytes: 0, bosBytes: 0, scriptBytes: 0, laneById: new Map(), samples: [], t0: Date.now(), cancel: false };
    const zb = $("#zipBtn"); if (zb) zb.disabled = true;
    tauriLive();
    // Three-lane scheduler: Cloudflare-CDN files (5 lanes), Board-of-Studies
    // files in their own sub-lane (3 — an old school server; a slow BOS file
    // must never occupy a CDN slot), THSC-script files sequential-ish (2).
    // Lane assignment is by PRIMARY HOST (shared FAST_SAVE_HOSTS set): only
    // hosts proven to serve direct bytes get direct-lane slots, so dead NESA
    // wcm links never clog the fast lane. Fallback resolves are
    // single-attempt in Rust (no ladder).
    const isScript = (f) => !isFastHostUrl(f.url);
    const isBOS = (f) => {
      try { return new URL(f.url).host === "www.boardofstudies.nsw.edu.au"; } catch { return false; }
    };
    const direct = files.filter((f) => !isScript(f));
    const bos = direct.filter(isBOS);
    const cdn = direct.filter((f) => !isBOS(f));
    const script = files.filter(isScript);
    // Lane map for per-file byte accounting (progress events carry only ids).
    for (const f of files) tauriRun.laneById.set(f.id, isScript(f) ? "script" : isBOS(f) ? "bos" : "cdn");
    await Promise.all([tauriPool(cdn, 5), tauriPool(bos, 3), tauriPool(script, 2)]);
    const done = tauriRun; tauriRun = null;
    if (zb) zb.disabled = false;
    const bits = [`Saved ${done.ok}/${done.total} file${done.total === 1 ? "" : "s"} ✓`];
    if (done.stopped) bits.push(`${done.stopped} stopped by ✕`);
    if (done.deferred) bits.push(`${done.deferred} deferred (rate-limited — resume later)`);
    if (done.fail) bits.push(`${done.fail} failed`);
    if (done.cancel) bits.push("cancelled");
    tauriStatus(bits.join(" · "));
    render(); // re-render cards so freshly saved papers get 📖 View / 📂 NOW
    setTimeout(() => { if (!tauriRun) tauriStatus(""); }, 8000);
    showResumeBar(); // re-appears if anything remains (deferred/cancelled)
  }

  /* ----- resume bar (interrupted batches) ----- */
  function hideResumeBar() { const rb = $("#resumeBar"); if (rb) rb.hidden = true; }
  function showResumeBar() {
    const rb = $("#resumeBar");
    if (!rb || !IS_TAURI || tauriRun) return;
    const q = queueLoad();
    const n = q && Array.isArray(q.files) ? q.files.length : 0;
    if (!n) { rb.hidden = true; return; }
    const txt = $("#resumeBarText"), btn = $("#resumeBarBtn");
    txt.textContent = `⏵ Interrupted batch: ${n} file${n === 1 ? "" : "s"} remaining`;
    btn.textContent = "Resume";
    rb.hidden = false;
  }

  /* ----- armed-confirm UI ----- */
  function clearArmedUI() {
    tauriArmed = null;
    const zb = $("#zipBtn"); if (zb) zb.textContent = "⭳ Save to library";
  }

  // Two-step Save: 1st click preflights + arms confirm, 2nd click starts.
  // Throughput is capped by THSC's throttled resolver, so batches run
  // sequentially with adaptive pacing (see Rust backend); resume is free.
  function armSig(files) { return files.map((f) => f.id).join("|"); }
  async function tauriSaveClick() {
    if (tauriRun) return;
    const files = selectedFiles();
    if (!files.length) {
      if (state.selected.size && lastSlowSkipped) {
        tauriStatus(`🐢 All ${lastSlowSkipped} selected files are slow-route — enable “Include slow-route papers” in the sidebar to save them`);
      }
      return;
    }
    // Selection changed since arming? Drop the stale confirm and re-check.
    if (tauriArmed && armSig(files) !== armSig(tauriArmed.files)) {
      tauriArmed = null;
      $("#zipBtn").textContent = "⭳ Save to library";
    }
    if (!tauriArmed) {
      tauriStatus("Checking library…");
      try {
        const pre = await window.__TAURI__.core.invoke("preflight", { files: files.map((f) => ({ relpath: f.relpath, url: f.url })) });
        tauriArmed = { files, toFetch: pre.to_fetch, estBytes: pre.est_bytes };
        if (!pre.to_fetch) {
          tauriStatus(`All ${files.length} selected file${files.length === 1 ? "" : "s"} are already on disk (${fmtMB(pre.saved_bytes)}) ✓`);
          tauriArmed = null;
          return;
        }
        // Headline = the SELECTION file count (matches the bulk bar);
        // the status explains how many are actually new to download.
        const skipTxt = lastSlowSkipped ? ` · 🐢 ${lastSlowSkipped} slow-route file${lastSlowSkipped === 1 ? "" : "s"} skipped` : "";
        const haveTxt = pre.already_saved ? `${pre.already_saved} already on disk` : "";
        const sizeTxt = "≈ " + fmtMB(pre.est_bytes) + (pre.sampled ? ` (from ${pre.sampled} sample${pre.sampled === 1 ? "" : "s"})` : "");
        $("#zipBtn").textContent = `Confirm save ${files.length} file${files.length === 1 ? "" : "s"} (≈ ${fmtMB(pre.est_bytes)})?`;
        tauriStatus(`Confirm: ${files.length} files selected · ${pre.to_fetch} will download (${haveTxt}), ${sizeTxt}${skipTxt} — click again to start, ✕ to cancel`);
      } catch (e) { tauriStatus("Check failed: " + (e?.message || e)); }
      return;
    }
    const batch = tauriArmed;
    clearArmedUI();
    await tauriStartBatch(batch.files, batch.estBytes || 0);
  }

  if (IS_TAURI && window.__TAURI__.event) {
    window.__TAURI__.event.listen("dl-progress", (ev) => {
      const p = ev.payload || {};
      if (!tauriRun) return;
      // O(1) incremental accounting: apply per-file deltas to the lane
      // counters. (A full recompute per event over an 8,900-file batch
      // caused visible mid-batch UI stutter.)
      let next = -1;
      if (p.done) {
        // Final size (also covers single-chunk files where no partial event fired).
        if (typeof p.downloaded === "number") next = Math.max(tauriBytesById[p.id] || 0, p.downloaded);
      } else if (typeof p.downloaded === "number") {
        next = Math.max(tauriBytesById[p.id] || 0, p.downloaded);
      }
      if (next >= 0) {
        const delta = next - (tauriBytesById[p.id] || 0);
        if (delta > 0) {
          tauriBytesById[p.id] = next;
          tauriRun.bytesDone += delta;
          const lane = tauriRun.laneById ? tauriRun.laneById.get(p.id) : "cdn";
          if (lane === "script") tauriRun.scriptBytes += delta;
          else if (lane === "bos") tauriRun.bosBytes += delta;
          else tauriRun.cdnBytes += delta;
        }
        tauriLive(); // also pushes a ring-buffer sample
      }
    });
    window.__TAURI__.event.listen("dl-notice", (ev) => {
      if (ev.payload && ev.payload.message) tauriStatus(ev.payload.message);
    });
    const zipBtn = $("#zipBtn");
    if (zipBtn) zipBtn.textContent = "⭳ Save to library";
    const resumeBtn = $("#resumeBarBtn");
    if (resumeBtn) resumeBtn.addEventListener("click", async () => {
      const q = queueLoad();
      hideResumeBar();
      if (q && Array.isArray(q.files) && q.files.length) await tauriStartBatch(q.files);    });
    const resumeDismiss = $("#resumeBarDismiss");
    if (resumeDismiss) resumeDismiss.addEventListener("click", () => {
      queueClear(); hideResumeBar();
      tauriStatus("Batch abandoned");
    });
    const spacer = document.querySelector(".toolbar .spacer");
    if (spacer) {
      // One Library menu instead of four buttons: open / change / import / verify.
      const menu = document.createElement("details");
      menu.className = "menu";
      menu.innerHTML = `
        <summary class="btn menu-summary" title="Library: open, move, import or verify">▾ Library</summary>
        <div class="menu-list">
          <button data-act="open">📂 Open folder</button>
          <button data-act="change">⚙ Change folder…</button>
          <button data-act="import">⇪ Import files…</button>
          <button data-act="verify" title="Scans the FULL catalogue regardless of the slow-route toggle">🔍 Verify library</button>
          <button data-act="check-update" title="Checks GitHub for a newer release">⬇ Check for updates</button>
        </div>`;
      menu.addEventListener("click", async (e) => {
        const item = e.target.closest(".menu-list button");
        if (!item) return;
        menu.open = false;
        const act = item.dataset.act;
        try {
          if (act === "open") {
            const dir = await window.__TAURI__.core.invoke("library_dir");
            await window.__TAURI__.core.invoke("reveal_in_folder", { path: dir });
          } else if (act === "change") {
            const folder = await window.__TAURI__.core.invoke("pick_folder");
            if (!folder) return;
            const dir = await window.__TAURI__.core.invoke("set_library_dir", { dir: folder });
            tauriStatus(`Library set to ${dir} — imports and downloads go there now`);
          } else if (act === "import") {
            if (tauriRun) { tauriStatus("Wait for the current batch to finish before importing"); return; }
            tauriStatus("Choose the folder that contains your PDFs…");
            const folder = await window.__TAURI__.core.invoke("pick_folder");
            if (!folder) { tauriStatus("Import cancelled"); return; }
            tauriStatus("Importing… (this copies your files into the library)");
            const rep = await window.__TAURI__.core.invoke("adopt_library", { folder });
            tauriStatus(`Import done ✓ — ${rep.adopted} adopted, ${rep.already_canonical} already in place, ${rep.unmatched} unmatched of ${rep.scanned} scanned → ${rep.library}`);
            render(); // re-check saved state on visible cards
            patchSavedButtons();
          } else if (act === "verify") {
            if (tauriRun) return;
            tauriStatus("Verifying library…");
            const rels = [];
            for (const p of state.papers) {
              const pr = libraryRel(p, "paper");
              if (pr) rels.push(pr);
              const sr = libraryRel(p, "solutions");
              if (sr) rels.push(sr);
            }
            const res = await window.__TAURI__.core.invoke("saved_paths", { relpaths: rels });
            const have = res.filter(Boolean).length;
            tauriStatus(`Library: ${have}/${rels.length} catalogue files on disk (${rels.length - have} missing) ✓`);
          } else if (act === "check-update") {
            const btn = item;
            btn.disabled = true;
            btn.textContent = "🔍 Checking…";
            await checkForUpdates(false);
            btn.disabled = false;
            btn.textContent = "🔍 Check for updates";
          }
        } catch (e) { tauriStatus("Library action failed: " + (e?.message || e)); }
      });
      spacer.after(menu);
    }
    const hb = $("#hostBadge");
    if (hb) {
      hb.textContent = "🖥 Desktop app";
      window.__TAURI__.core.invoke("get_library_config").then((cfg) => {
        hb.title = "Library: " + cfg.library + (cfg.is_default ? " (default — Library ▾ to change)" : "");
      }).catch(() => { /* title stays default */ });
    }
    showResumeBar(); // offer resume of an interrupted batch
    checkForUpdates(true); // silent self-update check at launch
  }

  /* ---------- app self-update (keyless; Rust verifies the GitHub digest) ---------- */
  let updateInfo = null;
  let updateBarPinned = false;
  async function checkForUpdates(silent = true) {
    if (!IS_TAURI) return;
    try {
      const info = await window.__TAURI__.core.invoke("update_check");
      updateInfo = info;
      if (info.update_available && !updateBarPinned) showUpdateBar();
      else if (!silent && !info.update_available) tauriStatus(`Up to date — running the latest release ✓`);
    } catch (e) {
      if (!silent) tauriStatus("Update check failed: " + (e?.message || e));
    }
  }
  function showUpdateBar() {
    const bar = $("#updateBar");
    if (!bar || !updateInfo) return;
    $("#updateBarText").textContent = `Update available — v${updateInfo.version}`;
    bar.hidden = false;
  }
  on("#updateNowBtn", "click", async () => {
    if (!updateInfo) return;
    if (tauriRun) { tauriStatus("Finish the current download batch first — the update installs after"); return; }
    const btn = $("#updateNowBtn");
    btn.disabled = true;
    $("#updateBarText").textContent = "Downloading update…";
    try {
      await window.__TAURI__.core.invoke("update_install", {
        version: updateInfo.version,
        // The Rust struct serializes snake_case (no rename_all) — reading
        // .assetUrl sent undefined and the install died before starting.
        // With any missing field the Rust side now re-derives the latest
        // release itself (self-healing for stale clients).
        url: updateInfo.asset_url,
        expectedDigest: updateInfo.digest,
      });
      // Success path: the installer runs and the app relaunches itself.
    } catch (e) {
      console.warn("update failed:", e);
      // The happy path ends with app.exit(0), so a dropped connection here
      // means "installing" — only surface real errors, IN THE BAR: the
      // bulkbar (tauriStatus) is selection-gated and hidden right now.
      const msg = String(e?.message || e);
      $("#updateBarText").textContent = /connection|closed|dropped/i.test(msg)
        ? "Update available"
        : "Update failed: " + msg;
      btn.disabled = false;
    }
  });
  on("#updateLaterBtn", "click", () => {
    updateBarPinned = true;
    $("#updateBar").hidden = true;
  });
  window.__TAURI__?.event?.listen("update-progress", (ev) => {
    const p = ev.payload || {};
    const total = p.total ? ` of ${(p.total / 1048576).toFixed(1)} MB` : "";
    $("#updateBarText").textContent = `Downloading update… ${(p.downloaded / 1048576).toFixed(1)} MB${total}` + (p.done ? " — installing…" : "");
  });

  /* Open saved papers: patch card buttons via the backend (validated paths). */
  let savedCheckQueued = false;
  function patchSavedButtons() {
    if (!IS_TAURI) return;
    requestAnimationFrame(async () => {
      const btns = [...cardsEl.querySelectorAll("a[data-rel]:not([data-checked])")];
      if (!btns.length) return;
      const rels = btns.map((b) => { b.dataset.checked = "1"; return b.dataset.rel; });
      try {
        const res = await window.__TAURI__.core.invoke("saved_paths", { relpaths: rels });
        btns.forEach((b, i) => {
          if (!res[i]) return;
          const path = res[i];
          const title = b.closest(".card")?.querySelector("h3")?.textContent || "Paper";
          b.setAttribute("data-checked", "saved");
          b.removeAttribute("href");
          b.removeAttribute("target");
          b.removeAttribute("download");
          b.textContent = "📖 View";
          // Primary: open the embedded reader (split when solutions are on disk).
          b.addEventListener("click", (e) => {
            e.preventDefault();
            const card = b.closest(".card");
            let solLocal = null;
            const p = state.papers.find(x => x.id === card?.dataset.id);
            if (p) {
              const srel = libraryRel(p, "solutions");
              // v1.0.0 bug: the solutions button IS the solutions file —
              // opening it must not split with itself. Only the PAPER
              // button brings its solutions along.
              if (srel && srel !== b.dataset.rel) {
                const idx = rels.indexOf(srel);
                if (idx >= 0 && res[idx]) solLocal = res[idx];
              }
            }
            openReader(path, title, card?.dataset.id, solLocal);
          });
          // Secondary chip: open in the system PDF app.
          const sys = document.createElement("a");
          sys.className = "mini-btn";
          sys.textContent = "📂";
          sys.title = "Open in system PDF app";
          sys.addEventListener("click", (e) => {
            e.preventDefault();
            window.__TAURI__.core.invoke("open_file", { path }).catch((err) => tauriStatus("Open failed: " + (err?.message || err)));
          });
          b.after(sys);
        });
      } catch { /* non-fatal */ }
    });
  }

  /* ----- embedded reader overlay (pdf.js) — continuous scroll, single or SPLIT ----- */
  // Tauri: opens local library files. Web: opens paper URLs directly
  // (works wherever the source sends CORS headers; falls back to a hint).
  // Continuous scroll: each pane holds one placeholder element per page
  // (aspect-ratio stable before render) rendered lazily in a window around
  // the viewport; far pages unload their canvas + page object to bound
  // memory. Paper/Solutions panes navigate and print independently; 🔗
  // sync follows the page index across panes.
  function mkPane() {
    return { doc: null, page: 1, sysPath: null, numPages: 0, pages: [], queue: [], inFlight: 0, observer: null, scrollTick: false, syncLock: false, dims: null };
  }
  const readerPanes = { paper: mkPane(), sol: mkPane() };
  let readerMode = "single"; // "single" (one pane) | "split" (both)
  let readerFocus = "paper"; // keyboard + global bar + print target
  let readerSync = false;    // page-follow toggle (persisted, default off)
  try { readerSync = localStorage.getItem("hsc-reader-sync") === "1"; } catch {}
  let readerPaperUrl = null, readerSolUrl = null, readerSolFallbackUrl = null, readerPaperFallbackUrl = null;
  let pendingPaperId = null; // B8: recently-viewed logs only on a successful load

  function paneNumEl(key) { return $(key === "paper" ? "#numPaper" : "#numSol"); }
  function paneScrollEl(key) { return $(key === "paper" ? "#scrollPaper" : "#scrollSol"); }

  function openReader(path, title, id, solPath, solFallbackPath, paperFallbackPath) {
    if (!path) return;
    pendingPaperId = id || null;
    readerPaperUrl = IS_TAURI ? path : proxied(path);
    readerSolUrl = solPath ? (IS_TAURI ? solPath : proxied(solPath)) : null;
    // Live fallbacks for dead-primary files (Bug 1 residue): the catalogue
    // keeps a working URL beside some dead ones. Same-URL guards avoid
    // retrying identical addresses pointlessly.
    readerSolFallbackUrl = solFallbackPath && solFallbackPath !== solPath
      ? (IS_TAURI ? solFallbackPath : proxied(solFallbackPath)) : null;
    readerPaperFallbackUrl = paperFallbackPath && paperFallbackPath !== path
      ? (IS_TAURI ? paperFallbackPath : proxied(paperFallbackPath)) : null;
    readerPanes.paper = mkPane();
    readerPanes.sol = mkPane();
    readerPanes.paper.sysPath = IS_TAURI ? path : null;
    readerPanes.sol.sysPath = IS_TAURI && solPath ? solPath : null;
    $("#readerTitle").textContent = title || "Paper";
    $("#readerErr").hidden = true; $("#readerErr").textContent = "";
    $("#reader").hidden = false;
    document.body.style.overflow = "hidden";
    // Solutions are HIDDEN by default (attempt first, then check): the
    // reader always opens paper-only — ＋ Solutions adds the second pane.
    readerMode = "single";
    readerFocus = "paper";
    applyReaderChrome();
    renderTimer();
    const sysBtn = $("#readerOpenSys");
    if (sysBtn) sysBtn.hidden = !IS_TAURI;
    if (window.pdfjsLib) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = "pdfjs/pdf.worker.min.js";
      loadPane("paper");
    } else {
      $("#readerErr").hidden = false;
      $("#readerErr").textContent = "Reader engine is still loading — try again in a second (or use the ⭳ button).";
    }
  }
  function applyReaderChrome() {
    const split = readerMode === "split";
    // the container exists in both modes — mode styling keys off this class
    $("#readerSplit").classList.toggle("split", split);
    $("#paneSol").hidden = !split;
    $("#readerSyncBtn").hidden = !split;
    $("#readerSyncBtn").classList.toggle("on", readerSync);
    // ＋ Solutions is ALWAYS present in single mode — disabled with an honest
    // tooltip when the paper has no loadable solutions file, so the toggle's
    // existence is never a mystery.
    const addSol = $("#readerAddSol");
    addSol.hidden = split;
    addSol.disabled = !readerSolUrl;
    addSol.title = readerSolUrl
      ? "Open the solutions alongside the paper"
      : "No solutions file available for this paper";
    // The pane bars own page navigation and printing everywhere — the
    // global bar carries only unique controls (v1.0.6 de-duplication).
    setFocus(readerFocus);
  }
  function setFocus(key) {
    readerFocus = key;
    $("#panePaper").classList.toggle("focus", key === "paper");
    $("#paneSol").classList.toggle("focus", key === "sol");
  }
  function closeReader() {
    $("#reader").hidden = true;
    document.body.style.overflow = "";
    timerPause(); // the study session freezes; it resumes on reopen
    for (const key of ["paper", "sol"]) {
      const pane = readerPanes[key];
      pane.observer?.disconnect();
      for (const pg of pane.pages) {
        pg.dead = true; // any in-flight render aborts cleanly
        try { pg.pageRef?.destroy(); } catch {}
      }
      paneScrollEl(key).innerHTML = "";
      try { pane.doc?.destroy(); } catch {}
      readerPanes[key] = mkPane();
    }
    readerMode = "single"; readerFocus = "paper"; pendingPaperId = null;
    $("#readerErr").hidden = true; $("#readerErr").textContent = "";
  }
  async function loadPane(key, urlOverride) {
    const pane = readerPanes[key];
    try {
      const url = urlOverride
        || ((IS_TAURI && pane.sysPath) ? window.__TAURI__.core.convertFileSrc(pane.sysPath)
          : (key === "paper" ? readerPaperUrl : readerSolUrl));
      const doc = await window.pdfjsLib.getDocument({ url }).promise;
      pane.doc = doc;
      pane.numPages = doc.numPages;
      if (key === "paper" && pendingPaperId) { logRecentlyViewed(pendingPaperId); pendingPaperId = null; } // B8
      // Page placeholders: uniform dims from page 1 (exam papers are
      // uniform; a deviant page simply renders at its own size in place).
      const p1 = await doc.getPage(1);
      const vp1 = p1.getViewport({ scale: 1 });
      pane.dims = { w: vp1.width, h: vp1.height };
      const sc = paneScrollEl(key);
      sc.innerHTML = "";
      sc.scrollTop = 0;
      pane.pages = [];
      const frag = document.createDocumentFragment();
      for (let n = 1; n <= pane.numPages; n++) {
        const d = document.createElement("div");
        d.className = "rpage";
        d.dataset.n = String(n);
        d.style.aspectRatio = `${vp1.width} / ${vp1.height}`;
        const cv = document.createElement("canvas");
        d.appendChild(cv);
        frag.appendChild(d);
        pane.pages.push({ el: d, canvas: cv, rendered: false, rendering: false, pageRef: null, dead: false });
      }
      sc.appendChild(frag);
      setupPaneObserver(key);
      wirePaneScroll(key);
      queueRender(key, 1); // eager first page
    } catch (e) {
      if (key === "sol") {
        // One fallback attempt before giving up: the catalogue keeps a live
        // solFallbackUrl beside some dead-primary solutions — try it once.
        const alt = (!pane.solFallbackTried && readerSolFallbackUrl) ? readerSolFallbackUrl : null;
        if (alt) {
          try { pane.doc?.destroy(); } catch {}
          readerPanes.sol = mkPane();
          readerPanes.sol.solFallbackTried = true;
          return loadPane(key, alt); // recursion happens at most once
        }
        // Solutions failed to load → graceful fallback to single-pane paper.
        try { pane.doc?.destroy(); } catch {}
        readerPanes.sol = mkPane();
        readerMode = "single";
        applyReaderChrome();
        $("#readerErr").hidden = false;
        // Distinguish the two failure classes: a pdf.js parse error usually
        // means the source now serves an HTML page (the soft-dead redirect
        // class) — say that honestly instead of guessing about CORS.
        const parseFail = /invalid pdf|structure|parse|unexpected/i.test(String(e?.message || e));
        $("#readerErr").textContent = parseFail
          ? "These solutions are no longer available at the source (the link no longer points at a document) — the ⭳ download still works."
          : "Solutions couldn't open in the reader (the source may not allow cross-site reading) — the ⭳ download still works.";
      } else {
        // One fallback attempt before giving up: the catalogue keeps the
        // legacy route (or a mirror) as fallbackUrl — worth one try on a
        // 404-class failure (dan's migration retired the /s/d endpoints;
        // the retry is a no-op when the fallback is dead too).
        const alt = (!pane.paperFallbackTried && readerPaperFallbackUrl) ? readerPaperFallbackUrl : null;
        if (alt) {
          try { pane.doc?.destroy(); } catch {}
          readerPanes.paper = mkPane();
          readerPanes.paper.paperFallbackTried = true;
          return loadPane(key, alt); // recursion happens at most once
        }
        $("#readerErr").hidden = false;
        // A 404/410 from the source is a dead link, not a CORS problem —
        // say that honestly instead of guessing about cross-site reading.
        const notFound = /unexpected server response|\(404\)|\(410\)/i.test(String(e?.message || e));
        $("#readerErr").textContent = IS_TAURI
          ? "Could not open paper: " + (e?.message || e)
          : notFound
            ? "This paper's file is no longer available at its source — the ⭳ download may still work."
            : "Could not open this paper in the reader (the source may not allow cross-site reading). Use the ⭳ download button instead.";
      }
    }
  }
  /* Lazy render queue: ≤3 concurrent page renders per pane, nearest to the
     viewport first. Each page renders into ITS OWN canvas, so pages never
     contend — the old single-canvas race is structurally gone. */
  function queueRender(key, n) {
    const pane = readerPanes[key];
    const pg = pane.pages?.[n - 1];
    if (!pane.doc || !pg || pg.rendered || pg.rendering || pane.queue.includes(n)) return;
    pane.queue.push(n);
    pane.queue.sort((a, b) => Math.abs(a - pane.page) - Math.abs(b - pane.page));
    pumpRenders(key);
  }
  function pumpRenders(key) {
    const pane = readerPanes[key];
    while (pane.inFlight < 3 && pane.queue.length) {
      const n = pane.queue.shift();
      const pg = pane.pages[n - 1];
      if (pg.rendered || pg.rendering) continue;
      pane.inFlight++;
      renderPanePageAt(key, n).finally(() => { pane.inFlight--; pumpRenders(key); });
    }
  }
  async function renderPanePageAt(key, n) {
    const pane = readerPanes[key];
    const pg = pane.pages[n - 1];
    if (!pane.doc || !pg || pg.rendered) return;
    pg.rendering = true;
    try {
      const page = await pane.doc.getPage(n);
      if (pg.dead) return;
      pg.pageRef = page;
      const vp = page.getViewport({ scale: 1.6 });
      const cv = pg.canvas;
      cv.width = vp.width; cv.height = vp.height;
      await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
      if (pg.dead) return;
      pg.rendered = true;
      pg.el.classList.add("done");
      pg.el.classList.remove("rerr");
    } catch (e) {
      if (!pg.dead) pg.el.classList.add("rerr"); // per-page failure stays isolated
    } finally {
      pg.rendering = false;
    }
  }
  function setupPaneObserver(key) {
    const pane = readerPanes[key];
    pane.observer?.disconnect();
    pane.observer = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) queueRender(key, Number(en.target.dataset.n));
    }, { root: paneScrollEl(key), rootMargin: "900px 0px" });
    for (const pg of pane.pages) pane.observer.observe(pg.el);
  }
  function wirePaneScroll(key) {
    const sc = paneScrollEl(key);
    sc.onscroll = () => { // property assignment: never stacks across reloads
      const pane = readerPanes[key];
      if (pane.scrollTick) return;
      pane.scrollTick = true;
      requestAnimationFrame(() => { pane.scrollTick = false; onPaneScroll(key); });
    };
  }
  function onPaneScroll(key) {
    const pane = readerPanes[key];
    const sc = paneScrollEl(key);
    if (!pane.doc || !pane.pages.length) return;
    const half = sc.clientHeight * 0.4;
    let cur = 1;
    for (let i = 0; i < pane.pages.length; i++) {
      if (pane.pages[i].el.offsetTop <= sc.scrollTop + half) cur = i + 1;
      else break;
    }
    sweepUnload(key, sc.scrollTop, sc.clientHeight);
    if (cur !== pane.page) {
      pane.page = cur;
      paneNumEl(key).textContent = `${cur} / ${pane.numPages}`;
      if (readerSync && readerMode === "split" && !pane.syncLock) syncPaneTo(key, cur);
    }
    pumpRenders(key);
  }
  function sweepUnload(key, scrollTop, vh) {
    const pane = readerPanes[key];
    const mid = scrollTop + vh / 2;
    for (const pg of pane.pages) {
      if (!pg.rendered || pg.rendering) continue;
      if (Math.abs(pg.el.offsetTop + pg.el.offsetHeight / 2 - mid) > vh * 2.5) {
        pg.rendered = false;
        pg.el.classList.remove("done");
        pg.canvas.width = pg.canvas.height = 0;
        try { pg.pageRef?.destroy(); } catch {}
        pg.pageRef = null;
      }
    }
  }
  function jumpToPage(key, n) {
    const pane = readerPanes[key];
    if (!pane.doc) return;
    const target = Math.max(1, Math.min(n, pane.numPages));
    pane.pages[target - 1].el.scrollIntoView({ block: "start", behavior: "auto" });
    onPaneScroll(key);
  }
  function syncPaneTo(key, n) {
    const other = key === "paper" ? "sol" : "paper";
    const op = readerPanes[other];
    if (!op.doc || op.syncLock) return;
    const target = Math.min(n, op.numPages);
    if (target === op.page) return;
    op.syncLock = true;
    op.page = target;
    paneNumEl(other).textContent = `${target} / ${op.numPages}`;
    op.pages[target - 1].el.scrollIntoView({ block: "start", behavior: "auto" });
    setTimeout(() => { op.syncLock = false; }, 180);
  }
  on("#readerClose", "click", closeReader);
  on("#paneSolClose", "click", (e) => {
    e.stopPropagation();
    const pane = readerPanes.sol;
    pane.observer?.disconnect();
    for (const pg of pane.pages) {
      pg.dead = true;
      try { pg.pageRef?.destroy(); } catch {}
    }
    paneScrollEl("sol").innerHTML = "";
    try { pane.doc?.destroy(); } catch {}
    readerPanes.sol = mkPane();
    readerMode = "single"; readerFocus = "paper";
    applyReaderChrome();
  });
  on("#readerAddSol", "click", (e) => {
    e.stopPropagation();
    if (!readerSolUrl || readerMode === "split") return;
    readerMode = "split";
    applyReaderChrome();
    loadPane("sol");
  });
  on("#readerSyncBtn", "click", (e) => {
    e.stopPropagation();
    readerSync = !readerSync;
    try { localStorage.setItem("hsc-reader-sync", readerSync ? "1" : "0"); } catch {}
    $("#readerSyncBtn").classList.toggle("on", readerSync);
    tauriStatus(readerSync ? "🔗 Pages turn together" : "🔗 Pages turn independently");
  });
  on("#readerOpenSys", "click", () => {
    const pane = readerPanes[readerFocus];
    if (pane.sysPath) window.__TAURI__.core.invoke("open_file", { path: pane.sysPath })
      .catch((err) => tauriStatus("Open failed: " + (err?.message || err)));
  });
  // Per-pane click = focus; per-pane bar nav = that pane's pages.
  for (const key of ["paper", "sol"]) {
    const el = $(key === "paper" ? "#panePaper" : "#paneSol");
    el.addEventListener("click", () => setFocus(key));
    const [prevBtn, nextBtn] = el.querySelectorAll(".pane-nav");
    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation(); setFocus(key);
      const p = readerPanes[key];
      if (p.doc && p.page > 1) jumpToPage(key, p.page - 1);
    });
    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation(); setFocus(key);
      const p = readerPanes[key];
      if (p.doc && p.page < p.numPages) jumpToPage(key, p.page + 1);
    });
    el.querySelector(".pane-print")?.addEventListener("click", (e) => {
      e.stopPropagation();
      printPane(key, true); // F4: whole paper / solutions (capped, progress)
    });
  }
  // Print: web only (desktop prints via the system PDF app on 📂).
  const MAX_PRINT_PAGES = 60;
  if (IS_TAURI) document.querySelectorAll(".pane-print").forEach(b => b.remove());
  async function printPane(key, allPages) {
    const pane = readerPanes[key];
    const fail = (msg) => { $("#readerErr").hidden = false; $("#readerErr").textContent = msg; };
    if (!pane.doc) { fail("Nothing to print yet — open a paper first."); return; }
    const w = window.open("", "_blank", "width=860,height=1000");
    if (!w) { fail("Print blocked — allow pop-ups for this site to use printing."); return; }
    const title = ($("#readerTitle").textContent || "Paper").replace(/</g, "&lt;");
    const max = allPages ? Math.min(pane.numPages, MAX_PRINT_PAGES) : 1;
    const capped = allPages && pane.numPages > MAX_PRINT_PAGES;
    w.document.open();
    w.document.write(
      `<title>${title}</title>` +
      `<style>@page{margin:10mm}body{margin:0;display:flex;flex-direction:column;align-items:center;gap:8px}img{width:100%;max-width:840px}</style>`
    );
    const scratch = document.createElement("canvas"); // offscreen — the live
    // page canvases belong to the continuous scroll and are never touched.
    for (let i = 1; i <= max; i++) {
      try {
        const pg = await pane.doc.getPage(i);
        const vp = pg.getViewport({ scale: 1.6 });
        scratch.width = vp.width; scratch.height = vp.height;
        await pg.render({ canvasContext: scratch.getContext("2d"), viewport: vp }).promise;
        w.document.write(`<img src="${scratch.toDataURL("image/png")}" alt="page ${i}">`);
        if (allPages) paneNumEl(key).textContent = `🖨 ${i} / ${max}`;
      } catch { /* skip a failed page rather than abort the print run */ }
    }
    if (capped) w.document.write(`<p style="font:600 .8rem system-ui;color:#555">First ${MAX_PRINT_PAGES} of ${pane.numPages} pages (print cap).</p>`);
    w.document.close();
    const t = setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 500);
    w.addEventListener("beforeunload", () => clearTimeout(t));
  }
  document.addEventListener("keydown", (e) => {
    if ($("#reader").hidden) return;
    if (e.key === "Escape") closeReader();
    else if (e.key === "ArrowLeft") { const p = readerPanes[readerFocus]; if (p.doc && p.page > 1) jumpToPage(readerFocus, p.page - 1); }
    else if (e.key === "ArrowRight") { const p = readerPanes[readerFocus]; if (p.doc && p.page < p.numPages) jumpToPage(readerFocus, p.page + 1); }
  });

  /* ----- study timer (presets + custom minutes; exam lengths aren't parseable reliably) ----- */
  const studyTimer = {
    visible: false, preset: "0", mode: "up", status: "idle",
    durationMs: 0, elapsedMs: 0, startedAt: 0,
  };
  let timerTick = null;
  function fmtClock(s) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = String(m).padStart(2, "0"), ss = String(sec).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }
  function timerElapsed() {
    return studyTimer.elapsedMs + (studyTimer.status === "running" ? Math.max(0, performance.now() - studyTimer.startedAt) : 0);
  }
  function renderTimer() {
    const elapsed = timerElapsed();
    if (studyTimer.mode === "down" && ["running", "paused"].includes(studyTimer.status) && elapsed >= studyTimer.durationMs) {
      timerStop();
      studyTimer.elapsedMs = studyTimer.durationMs;
      studyTimer.startedAt = 0;
      studyTimer.status = "finished";
    }
    const active = ["running", "paused", "finished"].includes(studyTimer.status);
    const shown = !active ? 0 : studyTimer.mode === "down"
      ? Math.max(0, Math.ceil((studyTimer.durationMs - elapsed) / 1000))
      : Math.floor(elapsed / 1000);
    const paused = studyTimer.status === "paused";
    const el = $("#readerTimer");
    el.hidden = !studyTimer.visible;
    el.textContent = fmtClock(shown);
    el.dataset.state = studyTimer.status;
    el.title = studyTimer.status === "setup" ? "Set a custom countdown duration"
      : `${studyTimer.mode === "down" ? "Countdown" : "Count up"} — ${studyTimer.status}`;
    el.classList.toggle("warn", studyTimer.mode === "down" && active && shown <= 300 && shown > 0);
    el.classList.toggle("done", studyTimer.status === "finished");
    const toggle = $("#readerTimerBtn");
    toggle.setAttribute("aria-expanded", String(studyTimer.visible));
    toggle.title = studyTimer.visible ? "Dismiss and reset study timer" : "Start study timer";
    toggle.setAttribute("aria-label", toggle.title);
    $("#readerTimerPreset").hidden = !studyTimer.visible;
    $("#readerTimerPreset").value = studyTimer.preset;
    $("#readerTimerCustomWrap").hidden = !studyTimer.visible || studyTimer.preset !== "custom";
    const btn = $("#readerTimerPause");
    btn.hidden = !studyTimer.visible || !["running", "paused"].includes(studyTimer.status);
    btn.title = paused ? "Resume timer" : "Pause timer";
    btn.setAttribute("aria-label", btn.title);
    btn.classList.toggle("on", paused);
    $("#readerTimerPauseIcon").hidden = paused;
    $("#readerTimerResumeIcon").hidden = !paused;
    $("#readerTimerStart").textContent = studyTimer.preset === "custom" && active ? "Restart" : "Start";
  }
  function timerStop() { if (timerTick) { clearInterval(timerTick); timerTick = null; } }
  function timerRun(seconds, preset = studyTimer.preset) {
    timerStop();
    Object.assign(studyTimer, {
      visible: true, preset, mode: seconds ? "down" : "up", status: "running",
      durationMs: seconds * 1000, elapsedMs: 0, startedAt: performance.now(),
    });
    renderTimer();
    timerTick = setInterval(renderTimer, 250);
  }
  function timerPause() {
    if (studyTimer.status !== "running") return;
    studyTimer.elapsedMs = timerElapsed();
    timerStop();
    studyTimer.startedAt = 0;
    studyTimer.status = "paused";
    renderTimer();
  }
  function timerResume() {
    if (studyTimer.status !== "paused") return;
    timerStop();
    studyTimer.startedAt = performance.now();
    studyTimer.status = "running";
    renderTimer();
    timerTick = setInterval(renderTimer, 250);
  }
  function timerIdle() {
    timerStop();
    Object.assign(studyTimer, {
      visible: false, preset: "0", mode: "up", status: "idle",
      durationMs: 0, elapsedMs: 0, startedAt: 0,
    });
    $("#readerTimerCustom").value = "";
    renderTimer();
  }
  on("#readerTimerBtn", "click", () => {
    if (studyTimer.visible) timerIdle();
    else timerRun(0, "0");
  });
  on("#readerTimerPreset", "change", (e) => {
    if (e.target.value === "custom") {
      timerStop();
      Object.assign(studyTimer, {
        preset: "custom", mode: "down", status: "setup",
        durationMs: 0, elapsedMs: 0, startedAt: 0,
      });
      renderTimer();
      $("#readerTimerCustom").focus();
      return;
    }
    timerRun(Number(e.target.value), e.target.value);
  });
  on("#readerTimerStart", "click", () => {
    const input = $("#readerTimerCustom");
    if (!input.reportValidity()) return;
    timerRun(Number(input.value) * 60, "custom");
  });
  on("#readerTimerCustom", "keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("#readerTimerStart").click(); }
  });
  on("#readerTimerPause", "click", () => {
    if (studyTimer.status === "paused") timerResume();
    else timerPause();
  });
  renderTimer();

  /* ---------- events ---------- */
  let debounce;
  on("#q", "input", (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.q = e.target.value.trim(); writeURL(); scheduleRender(); }, 160);
  });
  on("#searchForm", "submit", (e) => {
    e.preventDefault();
    state.q = $("#q").value.trim(); writeURL(); render();
    document.getElementById("browse").scrollIntoView({ behavior: "smooth" });
  });
  function syncPills() {
    document.querySelectorAll("#typePills .pill").forEach(p => {
      const t = p.dataset.type;
      // Stacked filters both light: a type pill stays lit while
      // Solutions-only (or the shelf) is also active — the old
      // !state.solutionsOnly guard made stacked filters look inactive.
      const on = t === "solutions" ? state.solutionsOnly
        : t === "mine" ? state.mine
        : t === "all" ? (state.type === "all" && !state.solutionsOnly && !state.mine)
        : state.type === t;
      p.classList.toggle("on", !!on);
    });
    document.querySelectorAll("#typeSeg button").forEach(b => b.classList.toggle("on", b.dataset.type === state.type));
    document.querySelectorAll("#levelSeg button").forEach(b => b.classList.toggle("on", b.dataset.level === state.level));
  }
  // Reflect the full restored state in every input/pill/select.
  function syncUI() {
    $("#q").value = state.q;
    $("#solOnly").checked = state.solutionsOnly;
    $("#mineOnly").checked = state.mine;
    $("#slowRoute").checked = state.includeSlowRoute;
    $("#sortSel").value = state.sort;
    cardsEl.classList.toggle("list", state.view === "list");
    syncPills();
  }
  document.querySelectorAll("#typePills .pill").forEach(p => p.addEventListener("click", () => {
    const t = p.dataset.type;
    if (t === "solutions") state.solutionsOnly = !state.solutionsOnly;
    else if (t === "mine") state.mine = !state.mine;
    else state.type = t;
    // "All papers" is the everything-off pill — the shelf filter too, or
    // users landing on an empty ★ shelf could never get back by clicking it
    if (t === "all") { state.type = "all"; state.solutionsOnly = false; state.mine = false; }
    $("#solOnly").checked = state.solutionsOnly;
    $("#mineOnly").checked = state.mine;
    persistState(); applyFilterChange();
  }));
  document.querySelectorAll("#typeSeg button").forEach(b => b.addEventListener("click", () => {
    state.type = b.dataset.type; persistState(); applyFilterChange();
  }));
  document.querySelectorAll("#levelSeg button").forEach(b => b.addEventListener("click", () => {
    state.level = b.dataset.level; persistState(); applyFilterChange();
  }));
  on("#solOnly", "change", (e) => { state.solutionsOnly = e.target.checked; persistState(); applyFilterChange(); });
  on("#mineOnly", "change", (e) => { state.mine = e.target.checked; persistState(); applyFilterChange(); });
  on("#slowRoute", "change", (e) => {
    state.includeSlowRoute = e.target.checked;
    if (tauriArmed) { tauriArmed = null; $("#zipBtn").textContent = "⭳ Save to library"; } // stale confirm
    if (!state.includeSlowRoute) {
      // Selection must never reference hidden papers.
      const hide = new Set(state.papers.filter(p => !isFastHostUrl(p.url)).map(p => p.id));
      for (const id of [...state.selected]) if (hide.has(id)) state.selected.delete(id);
    }
    tauriStatus(state.includeSlowRoute ? "Slow-route papers included in saves" : "Slow-route papers excluded from saves");
    persistState();
    buildFilters();     // sidebar counts follow
    buildSubjectStrip(); // strip counts follow
    updateStats();      // hero stats + level pills follow
    render();           // grid hides/shows + results count + bulk counter
  });
  on("#sortSel", "change", (e) => { state.sort = e.target.value; render(); });
  on("#viewBtn", "click", () => {
    state.view = state.view === "grid" ? "list" : "grid";
    cardsEl.classList.toggle("list", state.view === "list");
  });
  /* Left-column wheel routing, guarded: the wheel over the SIDEBAR ITSELF
     scrolls the sidebar when it actually overflows (a long list panel is
     open); anywhere else — including the far-left gutter — the page scrolls
     naturally (to About/footer in shell mode). */
  const sidebarEl = $("#sidebar");
  document.addEventListener("wheel", (e) => {
    if (!$("#reader").hidden || !sidebarEl) return;
    const r = sidebarEl.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    if (sidebarEl.scrollHeight <= sidebarEl.clientHeight + 1) return; // nothing to scroll
    e.preventDefault();
    sidebarEl.scrollTop += e.deltaY;
  }, { passive: false });

  /* Subject strip: mouse wheel scrolls it horizontally (touch swipes
     natively). At either horizontal end the wheel falls through so the
     page keeps scrolling — no dead zone at the ends. */
  const stripEl = $("#subjectStrip");
  if (stripEl) {
    stripEl.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // native horizontal
      const maxL = stripEl.scrollWidth - stripEl.clientWidth;
      const atStart = stripEl.scrollLeft <= 0 && e.deltaY < 0;
      const atEnd = maxL <= 0 || (stripEl.scrollLeft >= maxL - 1 && e.deltaY > 0);
      if (atStart || atEnd) return;
      e.preventDefault();
      stripEl.scrollLeft += e.deltaY;
    }, { passive: false });
  }

  /* Mobile drawer: the Filters button slides the sidebar in over a backdrop. */
  const backdrop = $("#drawerBackdrop");
  function setDrawer(open) {
    $("#sidebar").classList.toggle("open", open);
    if (backdrop) backdrop.classList.toggle("show", open);
    document.body.classList.toggle("drawer-lock", open);
  }
  on("#filtersToggle", "click", () => setDrawer(!$("#sidebar").classList.contains("open")));
  if (backdrop) backdrop.addEventListener("click", () => setDrawer(false));
  on("#drawerClose", "click", () => setDrawer(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#reader").hidden && $("#sidebar").classList.contains("open")) setDrawer(false);
  });

  load();
})();
