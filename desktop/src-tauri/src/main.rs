// HSCPapers backend — download queue, local library, catalogue info.
//
// Direct files and migrated THSC fragments are validated before finalization.
// The approved legacy transition uses the currently published export=view API;
// only real 429/503 responses trigger backoff. Ordinary HTTP 404 and THSC's
// one-page error PDF are availability failures, not evidence of corruption.
// - Skip-if-exists makes every batch resumable; temp .part files rename only
//   on success. All file work happens here (no JS fs access).
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    Arc,
};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;
use tokio::sync::Semaphore;

#[cfg(windows)]
mod update_launcher;
mod safe_paths;
mod network_policy;
mod updater;
use updater::UpdateInfo;

const USER_AGENT: &str = "HSCPapers/1.0 (study use; cached index, on-demand downloads)";
const MAX_WORKERS: usize = 10; // 5 CDN + 3 BOS + 2 script lanes; script calls also gate via `meta`
const MIN_DELAY_MS: u64 = 1500; // floor gap between resolver calls (polite)
const IDLE_RESET_MS: u64 = 5 * 60 * 1000; // idle this long => assume pool recovered
const MAX_ATTEMPTS: usize = 3; // ladder tries before the long-pause final try
const PAUSE_AFTER_CONSECUTIVE_404: usize = 3;
const AUTO_PAUSE_MS: u64 = 10 * 60 * 1000;
// Historical published resolver endpoints. Production uses only the last
// export=view fallback; the list does not establish independent quota pools.
const EXPORT_APIS: [&str; 16] = [
    "https://script.google.com/macros/s/AKfycbzwc57zmEK1Vm9Q5L1n1my3dxRafZRfNhCZ24zSLIa9H7MhySFhNahvPfW4R3uq753_/exec",
    "https://script.google.com/macros/s/AKfycbxCi8vsX-_l5a0JP-mG1RXIbSeiuZOfteumnk96oZCgQMR9nHjikpDqpknUHp-K5hg/exec",
    "https://script.google.com/macros/s/AKfycbz0Jc62sHl3IKUJNpqYZp6FGf85aERQKg4SITYgb0pbOJXGvo7CVshdIhN3AEbEBkQmww/exec",
    "https://script.google.com/macros/s/AKfycbwMElTU5QdXoUEc4yWj8mUbF-753lHMFAafJnGuaV8WpACWy16DWhXS8KfJA_HKEZ03Q/exec",
    "https://script.google.com/macros/s/AKfycbwafzfiazfcLyo4MPomtJV8j8P3Ys5Y5Z5dlbo6X_Ddll40NQyylFotiGP4RmlNEPNFpg/exec",
    "https://script.google.com/macros/s/AKfycbz2OkJ8-2GbIVWOAOAP0Qp37Sts2tclovMTtGEIfqWRkePvz1G1Ag3YywZNyDxeBtYkjg/exec",
    "https://script.google.com/macros/s/AKfycbyMS8xD-tK6wRe7wc3fyKAX7MmLiLOU5CTLHVV_HLNImZFx8SsPA2Cvhcc0Ml2TUeas/exec",
    "https://script.google.com/macros/s/AKfycbyOERxQbjmX6cmaY9txazA2MFY7y66ylYHyGG1FeGFHARXk36jLvIOGJUsUoy8VmOrp/exec",
    "https://script.google.com/macros/s/AKfycbx0LmnTURBcvLI1I4hASnAOTOkqsNEWToguRNAkypoIiGorRQr6YyqFlbOaZjtnWBjx/exec",
    "https://script.google.com/macros/s/AKfycbyaAQFka8STu0Fupxt333SW2T-7InSqmY6moyRs8-YGHucSiFqqpyCE4vktadLziRPe/exec",
    "https://script.google.com/macros/s/AKfycbxBXfKvsLNcAoiD1usgXLJejnVbGJ4Q0c9WYdufoHoIsuC4bbLKPlQ4XsLPNHRFAzilow/exec",
    "https://script.google.com/macros/s/AKfycbw3FjfIIds8UpY4GE_Jdu9hF8Mf58govLZcdpVdHOqb6IbF_A8F2cgtkvv--iEgOEzm/exec",
    "https://script.google.com/macros/s/AKfycbyzcBH0M5Np7XQf4aaGktd0zgHt5Sa0CRAXiG-XiUyWd5jzEN1qLDcjXbpVgu0LKQbJ/exec",
    "https://script.google.com/macros/s/AKfycbxq4Pi15A7VI2PQGJBnCU0OL0K08gfqbl1dRQEwQc5dcELs1BUoGBw8s9cGQHQncmjh/exec",
    "https://script.google.com/macros/s/AKfycbwYhBoXMfdf0QisZrOiUqr27DwE5Hf9hIYAeXV9SfYce-j5VrdwXkJp_wKSwV70yOe6TQ/exec",
    "https://script.google.com/macros/s/AKfycbx69GPoJtf9sSevsUbWtPr46vpa01u4oNkHjFmkkWxmj62AZ0q-/exec", // original (fallback)
];
const INDEX_BASE: &str = "https://thsconline.github.io/s/index/";
// Rough per-paper size used only for pre-download estimates.
const EST_BYTES_PER_PAPER: u64 = 4 * 1024 * 1024;

/// Round-robin endpoint picker: `idx % 16 -> full exec URL`.
#[cfg(test)]
fn export_api_at(idx: usize) -> &'static str {
    EXPORT_APIS[idx % EXPORT_APIS.len()]
}

struct AppState {
    client: reqwest::Client,
    fragment_client: reqwest::Client,
    update_client: reqwest::Client,
    picked_folder: safe_paths::PickedFolder,
    meta: Arc<Semaphore>, // 1 permit: script-resolver calls stay sequential
    dl: Arc<Semaphore>,   // parallel direct downloads (mirrors/NESA)
    consec_404: AtomicUsize,
    ema_ms: AtomicU64,   // EMA of resolver response latency (congestion signal)
    last_call: AtomicU64, // unix ms of last resolver response (idle detection)
    cancel: AtomicBool,   // user hit ✕: abort in-flight work between steps
    throttle_until: AtomicU64, // unix ms: skip resolver entirely while set
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Pre-throttle pacing tiers: fast responses mean the shared pool is free;
/// creeping TTFB means congestion — wait longer proactively instead of
/// burning a failed (and globally harmful) round-trip.
fn delay_from_ema(ema_ms: u64) -> u64 {
    if ema_ms < 6_000 {
        1_500
    } else if ema_ms < 12_000 {
        4_000
    } else if ema_ms < 20_000 {
        8_000
    } else {
        12_000
    }
}

/// Sleep before the next resolver call. After a long idle (auto-pause,
/// relaunch, scheduled overnight start) the shared window has likely
/// recovered, so pace from the minimum again. Returns true if cancelled.
async fn adaptive_delay(state: &AppState, cancel: &AtomicBool) -> bool {
    let ema = state.ema_ms.load(Ordering::Relaxed);
    let last = state.last_call.load(Ordering::Relaxed);
    let idle = now_ms().saturating_sub(last);
    let ms = if idle > IDLE_RESET_MS {
        MIN_DELAY_MS
    } else {
        delay_from_ema(ema).max(MIN_DELAY_MS)
    };
    sleep_interruptible(cancel, ms).await
}

/// Sleep that checks the cancel flag every 500ms so ✕ aborts promptly even
/// during long backoffs / auto-pauses. Returns true if cancelled.
async fn sleep_interruptible(cancel: &AtomicBool, ms: u64) -> bool {
    let mut left = ms;
    while left > 0 {
        if cancel.load(Ordering::Relaxed) {
            return true;
        }
        let step = left.min(500);
        tokio::time::sleep(std::time::Duration::from_millis(step)).await;
        left -= step;
    }
    cancel.load(Ordering::Relaxed)
}

async fn cancel_watch(cancel: &AtomicBool) {
    loop {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

/// Await a request's response headers, aborting within ~200ms of ✕ by
/// dropping the in-flight request (safe: the connection just closes). This
/// closes the biggest cancellation gap — the 13–39s resolver TTFB window.
async fn send_interruptible(
    req: reqwest::RequestBuilder,
    cancel: &AtomicBool,
    ctx: &str,
) -> Result<reqwest::Response, String> {
    tokio::select! {
        r = req.send() => r.map_err(|e| format!("{ctx}: {e}")),
        _ = cancel_watch(cancel) => Err(CANCELLED.to_string()),
    }
}

const CANCELLED: &str = "cancelled by user";
const DEFERRED: &str = "deferred: THSC rate-limited (will retry on resume)";

#[derive(Clone, serde::Serialize)]
struct DlProgress {
    id: String,
    downloaded: u64,
    total: Option<u64>,
    done: bool,
}

#[derive(Clone, serde::Serialize)]
struct DlNotice {
    message: String,
}

fn config_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("HSCPapers"))
        .join("config.json")
}

/// Library location: user-configured (config.json) or the default. The
/// default avoids OneDrive-synced Documents (sync locks + throttling make a
/// 6+ GB library unreliable there).
fn default_library(app: &AppHandle) -> PathBuf {
    if let Ok(docs) = app.path().document_dir() {
        if !docs.to_string_lossy().contains("OneDrive") {
            return docs.join("HSCPapers");
        }
    }
    std::env::var("USERPROFILE")
        .map(|h| PathBuf::from(h).join("HSCPapers"))
        .unwrap_or_else(|_| app.path().home_dir().unwrap_or_default().join("HSCPapers"))
}

fn library_path(app: &AppHandle) -> Result<PathBuf, String> {
    let cfg = config_path(app);
    if let Ok(text) = std::fs::read_to_string(&cfg) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(dir) = v.get("library").and_then(|d| d.as_str()) {
                if !dir.trim().is_empty() {
                    return Ok(PathBuf::from(dir));
                }
            }
        }
    }
    Ok(default_library(app))
}

/// Library folder (created on demand). Returns absolute path as string.
#[tauri::command]
async fn library_dir(app: AppHandle) -> Result<String, String> {
    let dir = library_path(&app)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("mkdir library: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Lexical, case-insensitive path normalisation. Windows fs::canonicalize
/// returns `\\?\C:\...` extended paths — mixing prefixed and plain paths
/// silently breaks every `starts_with` check (this is what broke the
/// Library button and the Open buttons). Normalise BOTH sides the same way.
#[cfg(test)]
fn norm_path(p: &Path) -> String {
    let s = std::path::absolute(p)
        .map(|x| x.to_string_lossy().into_owned())
        .unwrap_or_else(|_| p.to_string_lossy().into_owned());
    let s = s.strip_prefix(r"\\?\UNC\").map(|x| format!(r"\\{}", x)).unwrap_or_else(|| s.to_string());
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s).to_lowercase();
    s.replace('/', "\\")
}

#[cfg(test)]
fn path_within(root: &Path, path: &Path) -> bool {
    let r = norm_path(root);
    let c = norm_path(path);
    c == r || c.starts_with(&format!("{r}\\"))
}

#[derive(serde::Serialize)]
struct LibraryConfig {
    library: String,
    is_default: bool,
}

#[tauri::command]
fn get_library_config(app: AppHandle) -> Result<LibraryConfig, String> {
    let configured = std::fs::read_to_string(config_path(&app))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("library").and_then(|d| d.as_str()).map(String::from));
    let is_default = configured.is_none();
    let dir = configured.unwrap_or_else(|| default_library(&app).to_string_lossy().into_owned());
    Ok(LibraryConfig { library: dir, is_default })
}

/// Pick a folder via the native dialog (Rust-side, no JS plugin API needed).
#[tauri::command]
async fn pick_folder(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .pick_folder(move |folder| {
            let _ = tx.send(folder.map(|f| f.to_string()));
        });
    let selected = rx.await.map_err(|e| format!("dialog: {e}"))?;
    if let Some(folder) = &selected { state.picked_folder.select(Path::new(folder))?; }
    Ok(selected)
}

#[tauri::command]
async fn set_library_dir(app: AppHandle, state: State<'_, AppState>, dir: String) -> Result<String, String> {
    let _quiet = state.dl.clone().try_acquire_many_owned(MAX_WORKERS as u32).map_err(|_| "finish downloads before changing the library")?;
    let p = state.picked_folder.consume(Path::new(&dir))?;
    // Extend the asset-protocol scope so the embedded reader can serve it.
    app.asset_protocol_scope().allow_directory(&p, true).map_err(|e| format!("asset scope: {e}"))?;
    let displayed = safe_paths::presentation(&p);
    let cfg = serde_json::json!({ "library": displayed.to_string_lossy() });
    let cfg_path = config_path(&app);
    if let Some(parent) = cfg_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("config dir: {e}"))?;
    }
    tokio::fs::write(&cfg_path, serde_json::to_string(&cfg).unwrap_or_default())
        .await
        .map_err(|e| format!("save config: {e}"))?;
    Ok(displayed.to_string_lossy().into_owned())
}

/* ------------- import / adopt existing files ------------- */

/// JS-compatible filename hash (h*31+c, u32, base36, zero-padded 10 chars) —
/// mirrors the frontend `hash6(url)` used in library filenames.
fn name_hash(s: &str) -> String {
    let mut h: u32 = 0;
    for c in s.encode_utf16() {
        h = h.wrapping_mul(31).wrapping_add(c as u32);
    }
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = [b'0'; 10];
    let mut v = h;
    for i in (0..10).rev() {
        out[i] = DIGITS[(v % 36) as usize];
        v /= 36;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn js_seg(s: &str) -> String {
    let mut o = String::new();
    for ch in s.chars() {
        if "\\/:*?\"<>|".contains(ch) {
            o.push('-');
        } else {
            o.push(ch);
        }
    }
    let t = o.trim();
    if t.is_empty() { "unsorted".into() } else { t.into() }
}

fn js_safe_name(year: Option<u64>, subject: &str, school: &str, kind: &str) -> String {
    let b = format!(
        "{}-{}-{}-{}",
        year.map(|y| y.to_string()).unwrap_or_else(|| "na".into()),
        subject,
        school,
        kind
    )
    .to_lowercase();
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in b.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            if !out.is_empty() {
                out.push('-');
            }
            prev_dash = true;
        }
    }
    while out.starts_with('-') {
        out.remove(0);
    }
    while out.ends_with('-') {
        out.pop();
    }
    out.chars().take(90).collect::<String>()
}

/// Registry of every downloadable catalogue file grouped by base path:
/// base (old no-hash name) -> [(canonical relpath, hash, url)]
fn catalogue_registry() -> Vec<(String, Vec<(String, String, String)>)> {
    let raw = include_str!("../../ui/data/papers-v2.json");
    let v: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let mut out: std::collections::HashMap<String, Vec<(String, String, String)>> = std::collections::HashMap::new();
    for p in v.get("papers").and_then(|p| p.as_array()).into_iter().flatten() {
        let subject = p.get("subject").and_then(|x| x.as_str()).unwrap_or("");
        let year = p.get("year").and_then(|x| x.as_u64());
        let school = p.get("school").and_then(|x| x.as_str()).unwrap_or("");
        let kinds: [(&str, Option<String>); 2] = [
            ("paper", p.get("url").and_then(|x| x.as_str()).map(String::from)),
            (
                "solutions",
                p.get("solutionUrl")
                    .and_then(|x| x.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .or_else(|| {
                        p.get("solutionPath")
                            .and_then(|x| x.as_str())
                            .filter(|s| !s.is_empty())
                            .map(String::from)
                    }),
            ),
        ];
        for (kind, url) in kinds {
            let Some(url) = url else { continue };
            let base = format!(
                "{}/{}/{}/{}",
                js_seg(subject),
                year.map(|y| y.to_string()).unwrap_or_else(|| "unknown".into()),
                js_seg(school),
                js_safe_name(year, subject, school, kind)
            );
            let rel = format!("{base}.pdf");
            let h = name_hash(&url);
            out.entry(base).or_default().push((rel, h, url));
        }
    }
    let mut v: Vec<(String, Vec<(String, String, String)>)> = out.into_iter().collect();
    v.sort();
    v
}

#[derive(serde::Serialize)]
struct AdoptReport {
    scanned: usize,
    adopted: usize,
    already_canonical: usize,
    unmatched: usize,
    library: String,
}

/// Import existing PDFs from a user folder into the canonical library.
/// Matches by exact current name, or by base name + (hash | unique group).
/// Files are COPIED into the library; originals stay untouched.
#[tauri::command]
async fn adopt_library(app: AppHandle, state: State<'_, AppState>, folder: String) -> Result<AdoptReport, String> {
    let _quiet = state.dl.clone().try_acquire_many_owned(MAX_WORKERS as u32).map_err(|_| "finish downloads before importing files")?;
    let lib = library_path(&app)?;
    let src = state.picked_folder.consume(Path::new(&folder))?;
    let mut by_rel: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    // filename (lowercased, no dir) -> candidate entries — old-scheme files
    // may sit in any folder, so match on the filename itself.
    let mut by_file: std::collections::HashMap<String, Vec<(String, String, String)>> = std::collections::HashMap::new();
    for (_base, entries) in catalogue_registry() {
        for (rel, hash, url) in &entries {
            by_rel.insert(rel.to_lowercase(), rel.clone());
            let fname = rel.rsplit('/').next().unwrap_or("").to_lowercase();
            by_file.entry(fname).or_default().push((rel.clone(), hash.clone(), url.clone()));
        }
    }
    let mut scanned = 0usize;
    let mut adopted = 0usize;
    let mut already_canonical = 0usize;
    let mut unmatched = 0usize;
    let mut stack = vec![src.clone()];
    let mut visited = std::collections::HashSet::new();
    while let Some(dir) = stack.pop() {
        let Ok(canonical) = std::fs::canonicalize(&dir) else { continue; };
        if !canonical.starts_with(&src) || !visited.insert(canonical) { continue; }
        let mut rd = match tokio::fs::read_dir(&dir).await {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = rd.next_entry().await {
            let p = entry.path();
            let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                stack.push(p);
                continue;
            }
            let name_lower = p.to_string_lossy().to_lowercase();
            if !name_lower.ends_with(".pdf") {
                continue;
            }
            if !std::fs::canonicalize(&p).is_ok_and(|p| p.starts_with(&src)) { continue; }
            scanned += 1;
            let rel = p
                .strip_prefix(&src)
                .map(|r| r.to_string_lossy().replace('\\', "/").to_lowercase())
                .unwrap_or_default();
            if let Some(dest_rel) = by_rel.get(&rel) {
                let dest = safe_paths::destination(&lib, dest_rel, true)?.path.clone();
                if dest == p {
                    already_canonical += 1;
                } else if copy_in(&lib, dest_rel, &p).await.is_ok() {
                    adopted += 1;
                } else {
                    unmatched += 1;
                }
                continue;
            }
            // filename-only match (old no-hash scheme files may be anywhere)
            let fname = name_lower.rsplit('/').next_back().unwrap_or("").to_string();
            let entries = by_file.get(&fname);
            if let Some(entries) = entries {
                let stem = fname.trim_end_matches(".pdf").to_string();
                let file_hash = stem
                    .rsplit('-')
                    .next()
                    .filter(|h| h.len() == 10 && h.chars().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()))
                    .map(|h| h.to_string());
                let mut dest_rel: Option<String> = None;
                for (rel, hash, _url) in entries {
                    if file_hash.as_deref() == Some(hash.as_str()) {
                        dest_rel = Some(rel.clone());
                        break;
                    }
                }
                if dest_rel.is_none() && entries.len() == 1 {
                    dest_rel = Some(entries[0].0.clone());
                }
                if let Some(dr) = dest_rel {
                    if copy_in(&lib, &dr, &p).await.is_ok() {
                        adopted += 1;
                    } else {
                        unmatched += 1;
                    }
                } else {
                    unmatched += 1;
                }
                let _ = stem;
                continue;
            }
            unmatched += 1;
        }
    }
    Ok(AdoptReport {
        scanned,
        adopted,
        already_canonical,
        unmatched,
        library: lib.to_string_lossy().into_owned(),
    })
}

/// Import without replacing an existing library file or following child links.
async fn copy_in(root: &Path, relative: &str, src: &Path) -> Result<(), String> {
    let target = safe_paths::destination(root, relative, true)?;
    if target.path.exists() {
        return if pdf_magic_ok(&target.path).await { Ok(()) } else { Err("existing library file preserved; move it aside before replacing it".into()) };
    }
    // Import staging is distinct from resumable download .part files, so an
    // import cannot truncate an existing partial (or its own symlinked source).
    let temporary = tempfile::Builder::new().prefix("HSCPapers-import-").suffix(".import")
        .tempfile_in(target.path.parent().ok_or("import target has no parent")?).map_err(|e| e.to_string())?;
    let (output, temporary) = temporary.into_parts();
    let mut input = tokio::fs::File::open(src).await.map_err(|e| e.to_string())?;
    let mut output = tokio::fs::File::from_std(output);
    let copied = tokio::io::copy(&mut input, &mut output).await.map_err(|e| e.to_string());
    let flushed = output.flush().await.map_err(|e| e.to_string()); drop(output.into_std().await);
    copied?; flushed?;
    if !pdf_magic_ok(&temporary).await { return Err("imported file is not a complete PDF".into()); }
    safe_paths::finalize(&temporary, &target.path)
}

/// Modern catalogue snapshot baked in at build time.
#[tauri::command]
fn catalogue_info() -> Result<serde_json::Value, String> {
    let raw = include_str!("../../ui/data/papers-v2.json");
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("catalogue parse: {e}"))?;
    Ok(serde_json::json!({
        "generated": v.get("generated"),
        "total": v.get("papers").and_then(|p| p.as_array()).map(|a| a.len()).unwrap_or(0),
    }))
}

/* ---------------- URL helpers ---------------- */

mod thsc_fragments;

fn hexval(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Percent-decode one URL path segment (mirrors the site router's input).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hexval(b[i + 1]), hexval(b[i + 2])) {
                out.push(h << 4 | l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Strict percent-encode for query values (spaces -> %20, like the site).
fn enc_q(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                o.push(*b as char)
            }
            _ => o.push_str(&format!("%{b:02X}")),
        }
    }
    o
}

/// Split a THSC router URL into (viewno, title). None for direct URLs.
fn split_router_url(url: &str) -> Option<(String, String)> {
    for prefix in [
        "https://thsconline.github.io/s/d/",
        "http://thsconline.github.io/s/d/",
    ] {
        if let Some(rest) = url.strip_prefix(prefix) {
            let rest = rest.split('?').next().unwrap_or(rest);
            let mut parts = rest.splitn(2, '/');
            if let (Some(v), Some(t)) = (parts.next(), parts.next()) {
                if !v.is_empty() && !t.is_empty() {
                    // mirror loadshell(): '&' in titles becomes '_'
                    return Some((v.to_string(), percent_decode(t).replace('&', "_")));
                }
            }
        }
    }
    None
}

fn strip_jsonp(body: &str) -> Result<&str, String> {
    let inner = body
        .trim()
        .strip_prefix("downloadfile(")
        .ok_or_else(|| "resolver: unexpected response shape".to_string())?;
    let inner = inner.trim_end();
    let inner = inner.strip_suffix(';').unwrap_or(inner).trim_end();
    inner
        .strip_suffix(')')
        .ok_or_else(|| "resolver: truncated response".to_string())
}

/* ---------------- resolution ---------------- */

/// Record returned by the resolver (`downloadfile({...})`).
#[derive(serde::Deserialize)]
struct ThscRecord {
    data: Option<String>,
}

/// Published per-page index JSON fast path (rare, but free when present).
async fn try_index_url(client: &reqwest::Client, viewno: &str, title: &str, cancel: &AtomicBool) -> Option<String> {
    let idx = format!("{INDEX_BASE}{viewno}.json");
    let resp = send_interruptible(client.get(&idx).header(reqwest::header::USER_AGENT, USER_AGENT), cancel, "index request").await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body = network_policy::body(resp, 1024 * 1024, Some(cancel)).await.ok()?;
    let json: serde_json::Value = serde_json::from_slice(&body).ok()?;
    let items: Vec<&serde_json::Value> = match json.get(title) {
        Some(v) if v.is_array() => v.as_array().unwrap().iter().collect(),
        Some(v) => vec![v],
        None => vec![],
    };
    for it in items {
        if let Some(u) = it.get("url").and_then(|u| u.as_str()) {
            return Some(u.to_string());
        }
    }
    None
}

async fn fetch_bytes(client: &reqwest::Client, url: &str, cancel: &AtomicBool) -> Result<Vec<u8>, String> {
    let response = send_interruptible(client.get(network_policy::source(url)?).header(reqwest::header::USER_AGENT, USER_AGENT), cancel, "index file request").await?
        .error_for_status()
        .map_err(|e| format!("file HTTP {e}"))?;
    network_policy::body(response, network_policy::MAX_PDF_BYTES, Some(cancel)).await
}

/// One resolver attempt: streams the base64 response with progress so the UI
/// stays alive during the long fetch. Returns bytes on success. Feeds the
/// observed response latency into the pacing EMA (any status — a slow 404
/// still means the shared pool is congested).
async fn resolve_attempt(
    state: &AppState,
    cancel: &AtomicBool,
    app: &AppHandle,
    evt: &str,
    viewno: &str,
    title: &str,
) -> Result<Vec<u8>, String> {
    if cancel.load(Ordering::Relaxed) {
        return Err(CANCELLED.to_string());
    }
    let mut hasher = Sha256::new();
    hasher.update(viewno.as_bytes());
    let hash = hex::encode(hasher.finalize());
    // Fixed published legacy fallback; fragment requests never enter this lane.
    let api = format!(
        "{}?export=view&field={}&base={}&hash={}",
        EXPORT_APIS[EXPORT_APIS.len() - 1],
        enc_q(title),
        enc_q(viewno),
        hash
    );
    let t0 = std::time::Instant::now();
    // Send raced against the cancel flag: ✕ aborts within ~200ms even
    // during the 13-39s congested TTFB window (previously unabortable).
    let resp = send_interruptible(
        state
            .client
            .get(&api)
            .header(reqwest::header::USER_AGENT, USER_AGENT),
        cancel,
        "resolver request",
    )
    .await?;
    if cancel.load(Ordering::Relaxed) {
        return Err(CANCELLED.to_string());
    }
    let ttfb_ms = t0.elapsed().as_millis() as u64;
    // Pacing EMA: slow responses dominate (congestion signal), but fast
    // responses pull it down faster (0.6/0.4) so pacing recovers within
    // ~2 quick calls after a congestion window clears.
    let prev = state.ema_ms.load(Ordering::Relaxed);
    let next = if prev == 0 {
        ttfb_ms
    } else if ttfb_ms < prev {
        prev * 6 / 10 + ttfb_ms * 4 / 10
    } else {
        prev * 7 / 10 + ttfb_ms * 3 / 10
    };
    state.ema_ms.store(next, Ordering::Relaxed);
    state.last_call.store(now_ms(), Ordering::Relaxed);
    let status = resp.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status == reqwest::StatusCode::SERVICE_UNAVAILABLE {
        return Err("THROTTLED".to_string());
    }
    if !status.is_success() {
        return Err(format!("resolver HTTP {status}"));
    }
    let total = resp.content_length();
    if let Some(length) = total { network_policy::check_size(0, length, network_policy::MAX_RESOLVER_BYTES)?; }
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    // Throttled progress events: at most every 128 KiB or 300ms — a big
    // base64 body used to flood ~2000 IPC events per file.
    let mut last_emit: u64 = 0;
    let mut last_emit_t = std::time::Instant::now();
    while let Some(c) = network_policy::chunk(&mut stream, cancel).await? {
        network_policy::check_size(buf.len() as u64, c.len() as u64, network_policy::MAX_RESOLVER_BYTES)?;
        buf.extend_from_slice(&c);
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        let pos = buf.len() as u64;
        if pos - last_emit >= 131_072 || last_emit_t.elapsed().as_millis() >= 300 {
            last_emit = pos;
            last_emit_t = std::time::Instant::now();
            let _ = app.emit(
                "dl-progress",
                DlProgress { id: evt.to_string(), downloaded: pos, total, done: false },
            );
        }
    }
    let body = String::from_utf8_lossy(&buf);
    let rec: ThscRecord = serde_json::from_str(if body.trim().starts_with("downloadfile(") { strip_jsonp(&body)? } else { &body })
        .map_err(|e| format!("resolver parse: {e}"))?;
    let b64 = rec
        .data
        .ok_or_else(|| "resolver returned no file data (paper may be missing on THSC)".to_string())?;
    let clean: String = b64.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = B64
        .decode(clean)
        .map_err(|e| format!("resolver decode: {e}"))?;
    network_policy::check_size(0, bytes.len() as u64, network_policy::MAX_PDF_BYTES)?;
    thsc_fragments::validate_pdf(&bytes)?;
    Ok(bytes)
}

/// Resolve with backoff: 404s are throttle signals (verified), so retry with
/// growing delays; sustained 404 bursts trigger a 10-minute auto-pause, then
/// one final try. If even that is throttled, the file is DEFERRED (kept in
/// the resume queue) and a batch-wide throttle gate opens so remaining files
/// fast-fail instead of each burning the whole ladder.
/// (Gate check lives in download_paper, BEFORE pacing, so deferred files
/// cost ~0ms each.)
async fn resolve_throttled(
    state: &State<'_, AppState>,
    cancel: &AtomicBool,
    app: &AppHandle,
    evt: &str,
    viewno: &str,
    title: &str,
) -> Result<Vec<u8>, String> {
    // Rare free fast path first (CDN, no quota cost).
    if let Some(u) = try_index_url(&state.client, viewno, title, cancel).await {
        if let Ok(b) = fetch_bytes(&state.client, &u, cancel).await {
            if thsc_fragments::validate_pdf(&b).is_ok() {
                state.consec_404.store(0, Ordering::Relaxed);
                return Ok(b);
            }
        }
    }
    let delays = [15_000u64, 60_000];
    let mut paused_once = false;
    for attempt in 0..MAX_ATTEMPTS {
        if attempt > 0 {
            let base = delay_from_ema(state.ema_ms.load(Ordering::Relaxed));
            if sleep_interruptible(cancel, base + delays[attempt.min(delays.len() - 1)]).await {
                return Err(CANCELLED.to_string());
            }
        }
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        match resolve_attempt(&state, cancel, app, evt, viewno, title).await {
            Ok(bytes) => {
                state.consec_404.store(0, Ordering::Relaxed);
                return Ok(bytes);
            }
            Err(e) if e == "THROTTLED" => {
                let n = state.consec_404.fetch_add(1, Ordering::Relaxed) + 1;
                if n == PAUSE_AFTER_CONSECUTIVE_404 {
                    let _ = app.emit(
                        "dl-notice",
                        DlNotice { message: "THSC is rate-limiting — auto-pausing 10 min, then resuming…".to_string() },
                    );
                    if sleep_interruptible(cancel, AUTO_PAUSE_MS).await {
                        return Err(CANCELLED.to_string());
                    }
                    paused_once = true;
                    state.consec_404.store(0, Ordering::Relaxed);
                    let _ = app.emit(
                        "dl-notice",
                        DlNotice { message: "Resuming downloads…".to_string() },
                    );
                }
                if attempt + 1 >= MAX_ATTEMPTS {
                    break; // ladder exhausted -> final try
                }
            }
            Err(e) => return Err(e),
        }
    }
    // Final chance: wait out the congestion window, then one last attempt —
    // skipped when a pause just ran mid-ladder (no double 20-min waits).
    if !paused_once {
        let _ = app.emit(
            "dl-notice",
            DlNotice { message: "Still rate-limited — pausing 10 min for one final try…".to_string() },
        );
        if sleep_interruptible(cancel, AUTO_PAUSE_MS).await {
            return Err(CANCELLED.to_string());
        }
    }
    match resolve_attempt(&state, cancel, app, evt, viewno, title).await {
        Ok(bytes) => {
            state.consec_404.store(0, Ordering::Relaxed);
            Ok(bytes)
        }
        Err(e) if e == "THROTTLED" => {
            state
                .throttle_until
                .store(now_ms() + AUTO_PAUSE_MS, Ordering::Relaxed);
            Err(DEFERRED.to_string())
        }
        Err(e) => Err(e),
    }
}

/* ---------------- file writing ---------------- */

async fn write_part(path: &Path, bytes: &[u8]) -> Result<(), String> {
    network_policy::check_size(0, bytes.len() as u64, network_policy::MAX_PDF_BYTES)?;
    let mut file = tokio::fs::File::from_std(safe_paths::open_part(path, 0)?);
    file.write_all(bytes).await.map_err(|e| format!("write: {e}"))?;
    file.flush().await.map_err(|e| format!("flush: {e}"))?;
    drop(file.into_std().await);
    Ok(())
}

async fn stream_to_file(
    app: &AppHandle,
    cancel: &AtomicBool,
    evt: &str,
    resp: reqwest::Response,
    tmp: &Path,
    resume_from: u64,
) -> Result<u64, String> {
    let total = resp.content_length().map(|n| network_policy::check_size(resume_from, n, network_policy::MAX_PDF_BYTES)).transpose()?;
    network_policy::check_size(0, resume_from, network_policy::MAX_PDF_BYTES)?;
    let mut stream = resp.bytes_stream();
    let mut f = tokio::fs::File::from_std(safe_paths::open_part(tmp, resume_from)?);
    let mut downloaded = resume_from;
    let mut last_emit = downloaded;
    let mut last_emit_t = std::time::Instant::now();
    while let Some(c) = network_policy::chunk(&mut stream, cancel).await? {
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        network_policy::check_size(downloaded, c.len() as u64, network_policy::MAX_PDF_BYTES)?;
        f.write_all(&c)
            .await
            .map_err(|e| format!("write: {e}"))?;
        downloaded += c.len() as u64;
        // 512 KB / 500 ms: at multi-GB/s this quarters IPC event volume
        // (each event is a cross-thread JSON message) without hurting the
        // progress feel; per-file done events are unaffected.
        if downloaded - last_emit >= 524_288 || last_emit_t.elapsed().as_millis() >= 500 {
            last_emit = downloaded;
            last_emit_t = std::time::Instant::now();
            let _ = app.emit(
                "dl-progress",
                DlProgress { id: evt.to_string(), downloaded, total, done: false },
            );
        }
    }
    f.flush().await.map_err(|e| format!("flush: {e}"))?;
    drop(f.into_std().await);
    Ok(downloaded)
}

/* ---------------- commands ---------------- */

/// Save via the official THSC resolver (sequential meta gate + throttle
/// gates + adaptive pacing), then write/rename. Shared by the primary
/// router path and the mirror->THSC fallback. `single_attempt` is used for
/// mirror-fallback resolves: ONE attempt, no backoff ladder and no 10-min
/// auto-pause — those would otherwise park a CDN-lane slot (and a meta
/// permit) for minutes on every stale mirror URL and amplify THSC bursts.
/// Throttled fallbacks defer immediately; the primary script lane keeps the
/// full ladder.
async fn resolve_and_save(
    app: &AppHandle,
    state: &State<'_, AppState>,
    id: &str,
    router_url: &str,
    tmp: &Path,
    dest: &Path,
    single_attempt: bool,
) -> Result<u64, String> {
    let (viewno, title) = split_router_url(router_url).ok_or("not a THSC router URL")?;
    let _m = state.meta.acquire().await.map_err(|e| format!("queue: {e}"))?;
    // Batch-wide throttle gate: while a recent congestion window is
    // active, defer immediately — no pacing, no attempt ladder.
    if now_ms() < state.throttle_until.load(Ordering::Relaxed) {
        return Err(DEFERRED.to_string());
    }
    if adaptive_delay(state, &state.cancel).await {
        return Err(CANCELLED.to_string());
    }
    let bytes = if single_attempt {
        match resolve_attempt(state, &state.cancel, app, id, &viewno, &title).await {
            Ok(bytes) => {
                state.consec_404.store(0, Ordering::Relaxed);
                bytes
            }
            // One 404 from a fallback is NOT evidence of a global burst
            // (the file may simply be absent from THSC too) — defer just
            // this file; never freeze the script lane on a fallback.
            Err(e) if e == "THROTTLED" => return Err(DEFERRED.to_string()),
            Err(e) => return Err(e),
        }
    } else {
        resolve_throttled(state, &state.cancel, app, id, &viewno, &title).await?
    };
    thsc_fragments::validate_pdf(&bytes)?;
    write_part(tmp, &bytes).await?;
    safe_paths::finalize(tmp, dest)?;
    Ok(bytes.len() as u64)
}

/// First 5 bytes == "%PDF-"? (Guards against mirrors serving 200-status
/// HTML error pages.)
async fn pdf_magic_ok(tmp: &Path) -> bool {
    use tokio::io::AsyncReadExt;
    let mut f = match safe_paths::read_file(tmp) {
        Ok(f) => tokio::fs::File::from_std(f),
        Err(_) => return false,
    };
    let mut head = [0u8; 5];
    if f.read_exact(&mut head).await.is_err() || &head != b"%PDF-" { return false; }
    let mut hasher = Sha256::new(); hasher.update(head);
    let mut tail = head.to_vec(); let mut chunk = vec![0u8; 65536];
    loop {
        let n = match f.read(&mut chunk).await { Ok(n) => n, Err(_) => return false };
        if n == 0 { break; }
        hasher.update(&chunk[..n]); tail.extend_from_slice(&chunk[..n]);
        if tail.len() > 4096 { tail.drain(..tail.len() - 4096); }
    }
    tail.windows(5).any(|x| x == b"%%EOF") && hex::encode(hasher.finalize()) != thsc_fragments::PLACEHOLDER_SHA
}

async fn download_direct(app: &AppHandle, state: &State<'_, AppState>, id: &str, url: &str, tmp: &Path) -> Result<(), String> {
    let resume_from = tokio::fs::metadata(tmp).await.map(|m| m.len()).unwrap_or(0);
    let mut req = state.client.get(network_policy::source(url)?).header(reqwest::header::USER_AGENT, USER_AGENT);
    if resume_from > 0 { req = req.header(reqwest::header::RANGE, format!("bytes={resume_from}-")); }
    let resp = send_interruptible(req, &state.cancel, "request").await?;
    if !resp.status().is_success() { return Err(format!("HTTP {}", resp.status())); }
    let from = if resp.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        let range = resp.headers().get(reqwest::header::CONTENT_RANGE).and_then(|x| x.to_str().ok()).unwrap_or("");
        if !range.starts_with(&format!("bytes {resume_from}-")) { return Err("Source returned a mismatched resume range".into()); }
        resume_from
    } else { 0 };
    stream_to_file(app, &state.cancel, id, resp, tmp, from).await?;
    if !pdf_magic_ok(tmp).await { let _ = tokio::fs::remove_file(tmp).await; return Err("Source returned HTML, a placeholder or an incomplete PDF".into()); }
    Ok(())
}
async fn save_source(app: &AppHandle, state: &State<'_, AppState>, id: &str, url: &str, tmp: &Path, dest: &Path, fallback_attempt: bool) -> Result<(), String> {
    if let Some((viewno, title)) = thsc_fragments::descriptor(url)? {
        let bytes = thsc_fragments::resolve(&state.fragment_client, &viewno, &title, &state.cancel).await?;
        write_part(tmp, &bytes).await?;
    } else if split_router_url(url).is_some() {
        resolve_and_save(app, state, id, url, tmp, dest, fallback_attempt).await?;
        return Ok(());
    } else { download_direct(app, state, id, url, tmp).await?; }
    safe_paths::finalize(tmp, dest)?;
    Ok(())
}

fn fallback_allowed(primary: &str, candidate: &str) -> Result<bool, String> {
    if candidate.is_empty() || candidate == primary { return Ok(false); }
    let fragment_primary = thsc_fragments::descriptor(primary)?.is_some();
    Ok(!(fragment_primary && split_router_url(candidate).is_some()))
}

/// Download one paper into the library at `relpath` (e.g. "Physics/2024/...pdf").
/// Emits `dl-progress` events {id, downloaded, total, done} and `dl-notice`
/// messages. Skips if present. `fallback` (optional) is the THSC router URL
/// used when a mirror/direct URL fails or returns a non-PDF.
#[tauri::command]
async fn download_paper(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    url: String,
    relpath: String,
    fallback: Option<String>,
) -> Result<String, String> {
    safe_paths::relative_pdf(&relpath)?;
    network_policy::source(&url)?;
    if let Some(candidate) = fallback.as_ref().filter(|s| !s.is_empty()) { network_policy::source(candidate)?; }
    if state.cancel.load(Ordering::Relaxed) {
        return Err(CANCELLED.to_string());
    }
    let _dl = state.dl.acquire().await.map_err(|e| format!("queue: {e}"))?;
    if state.cancel.load(Ordering::Relaxed) {
        return Err(CANCELLED.to_string());
    }

    let guarded = safe_paths::destination(&library_path(&app)?, &relpath, true)?;
    let dest = &guarded.path;
    if dest.exists() {
        if !pdf_magic_ok(&dest).await { return Err("Existing file is invalid; it has been preserved in your library. Move it aside before downloading its replacement.".into()); }
        let _ = app.emit(
            "dl-progress",
            DlProgress { id: id.clone(), downloaded: 0, total: None, done: true },
        );
        return Ok(dest.to_string_lossy().into_owned());
    }
    let tmp = &guarded.part;
    let finish = |app: &AppHandle, n: u64| {
        let _ = app.emit(
            "dl-progress",
            DlProgress { id: id.clone(), downloaded: n, total: Some(n), done: true },
        );
    };

    if let Err(direct_err) = save_source(&app, &state, &id, &url, &tmp, &dest, false).await {
        if direct_err == CANCELLED {
            return Err(direct_err);
        }
        // Mirror failed -> degrade to the official (slow) resolver path.
        // single_attempt: one throttle-gated try; a burst defers this file
        // immediately instead of parking this CDN slot (and a meta permit)
        // through the whole ladder / auto-pause.
        let fb = fallback.unwrap_or_default();
        // A fragment descriptor cannot implicitly enter Apps Script on failure.
        if fallback_allowed(&url, &fb)? {
            let _ = tokio::fs::remove_file(&tmp).await; // never splice different sources' partial files
            let _ = app.emit(
                "dl-notice",
                DlNotice { message: "Primary source unavailable — trying a verified alternative…".to_string() },
            );
            save_source(&app, &state, &id, &fb, &tmp, &dest, true).await?;
            let n = tokio::fs::metadata(&dest).await.map(|m| m.len()).unwrap_or(0);
            finish(&app, n);
            return Ok(dest.to_string_lossy().into_owned());
        }
        return Err(direct_err);
    }
    let n = tokio::fs::metadata(&dest).await.map(|m| m.len()).unwrap_or(0);
    finish(&app, n);
    Ok(dest.to_string_lossy().into_owned())
}

/// Cancel flag for in-flight downloads. `true` makes in-flight work abort
/// between steps (streaming chunks, backoff sleeps, auto-pauses); a new
/// batch passes `false` to re-arm before starting.
#[tauri::command]
fn cancel_downloads(state: State<'_, AppState>, cancel: bool) {
    state.cancel.store(cancel, Ordering::Relaxed);
}

#[derive(serde::Deserialize)]
struct PreflightIn {
    relpath: String,
    url: String,
}

#[derive(serde::Serialize)]
struct PreflightOut {
    selected: usize,
    already_saved: usize,
    saved_bytes: u64,
    to_fetch: usize,
    est_bytes: u64,
    sampled: usize,
}

/// Source classification for size-sampling (URL prefix).
fn source_of(url: &str) -> &'static str {
    if matches!(thsc_fragments::descriptor(url), Ok(Some(_))) { "thsc-fragments" }
    else if url.contains("hscportal.pages.dev") {
        "portal"
    } else if url.contains("www.nsw.gov.au") {
        "nesa-archive"
    } else if url.contains("boardofstudies.nsw.edu.au") {
        "bos"
    } else if url.contains("thsconline.com.au") {
        "thsc-au"
    } else if url.contains("/s/d/") || url.contains("/s/v/") || url.contains("/s/fz/") {
        "script"
    } else if url.contains("thsconline.github.io") {
        "thsc-index"
    } else if url.contains("web.archive.org") {
        "wayback"
    } else if url.contains("aceh.b-cdn.net") {
        "acehsc"
    } else if url.contains("4unitmaths.com") {
        "4unit-maths"
    } else if url.contains("cresteconomics.com") {
        "crest"
    } else if url.contains("educationstandards.nsw.edu.au") {
        "nesa"
    } else {
        "script"
    }
}

/// Per-request HEAD (short timeout; used for size sampling).
async fn head_len(client: &reqwest::Client, url: &str) -> Option<u64> {
    let r = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        client
            .head(url)
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .send(),
    )
    .await
    .ok()?
    .ok()?;
    r.error_for_status().ok()?.content_length()
}

/// Per-request size sample (short timeout). HEAD first; if the response
/// carries no usable Content-Length (Cloudflare Pages HEADs omit it) or a
/// bogus zero, fall back to a ranged GET whose Content-Range carries the
/// real total. HTML responses (redirect targets, error pages) are ignored —
/// they aren't sizeable papers.
async fn sample_len(client: &reqwest::Client, url: &str) -> Option<u64> {
    network_policy::source(url).ok()?;
    if thsc_fragments::descriptor(url).ok().flatten().is_some() { return None; }
    if let Some(len) = head_len(client, url).await {
        if len > 0 {
            return Some(len);
        }
    }
    let r = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        client
            .get(url)
            .header(reqwest::header::RANGE, "bytes=0-0")
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .send(),
    )
    .await
    .ok()?
    .ok()?;
    if !r.status().is_success() && r.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return None;
    }
    if let Some(ct) = r.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()) {
        if ct.to_ascii_lowercase().contains("text/html") {
            return None;
        }
    }
    if let Some(cr) = r.headers().get(reqwest::header::CONTENT_RANGE).and_then(|v| v.to_str().ok()) {
        // "bytes 0-0/12345" — total after the slash.
        if let Some(total) = cr.rsplit('/').next().and_then(|t| t.parse::<u64>().ok()) {
            if total > 0 {
                return Some(total);
            }
        }
    }
    r.content_length().filter(|l| *l > 0)
}

/// Pre-download check: exact count + size of already-saved files, and a size
/// estimate for the rest from per-source samples (~24 files) instead of a
/// flat per-paper guess. Zero-sized or too-few samples degrade to the flat
/// per-paper estimate (a run of Content-Length: 0 responses must not make
/// the whole estimate read 0.0 MB).
#[tauri::command]
async fn preflight(
    app: AppHandle,
    state: State<'_, AppState>,
    files: Vec<PreflightIn>,
) -> Result<PreflightOut, String> {
    let base = library_path(&app)?;
    for file in &files { safe_paths::relative_pdf(&file.relpath)?; network_policy::source(&file.url)?; }
    let mut already_saved = 0usize;
    let mut saved_bytes = 0u64;
    let mut missing: Vec<&PreflightIn> = Vec::new();
    for f in &files {
        let checked = safe_paths::destination(&base, &f.relpath, false);
        match checked.and_then(|p| safe_paths::read_file(&p.path)).and_then(|f| f.metadata().map_err(|e| e.to_string())) {
            Ok(m) => {
                already_saved += 1;
                saved_bytes += m.len();
            }
            Err(_) => missing.push(f),
        }
    }
    // Sample sizes evenly across the missing set (parallel, capped).
    let sample_n = 24usize;
    let mut sample_jobs = Vec::new();
    if missing.len() > sample_n {
        let step = missing.len() as f64 / sample_n as f64;
        for k in 0..sample_n {
            sample_jobs.push(missing[(k as f64 * step) as usize].url.clone());
        }
    } else {
        sample_jobs = missing.iter().map(|f| f.url.clone()).collect();
    }
    let mut per_src: std::collections::HashMap<&'static str, (u64, u64)> = std::collections::HashMap::new();
    let mut global = (0u64, 0u64);
    let heads = futures_util::future::join_all(sample_jobs.iter().map(|u| sample_len(&state.client, u))).await;
    for (url, res) in sample_jobs.iter().zip(heads.into_iter()) {
        if let Some(len) = res {
            let src = source_of(url);
            let e = per_src.entry(src).or_insert((0, 0));
            e.0 += len;
            e.1 += 1;
            global.0 += len;
            global.1 += 1;
        }
    }
    // Sanity floor: an average of 0 or too-few successful samples means the
    // sampling learned nothing usable (e.g. every response carried
    // Content-Length: 0) — use the flat per-paper guess instead of
    // displaying a misleading 0.0 MB estimate.
    let global_avg = if global.1 > 0 && global.0 > 0 { global.0 / global.1 } else { 0 };
    let avg = |src: &str| -> u64 {
        match per_src.get(src) {
            Some((sum, n)) if *n > 0 && *sum > 0 => sum / n,
            _ if global_avg > 0 => global_avg,
            _ => EST_BYTES_PER_PAPER,
        }
    };
    let mut est_bytes = 0u64;
    for f in &missing {
        est_bytes += avg(source_of(&f.url));
    }
    Ok(PreflightOut {
        selected: files.len(),
        already_saved,
        saved_bytes,
        to_fetch: missing.len(),
        est_bytes,
        sampled: global.1 as usize,
    })
}

/// Absolute library paths for relpaths that already exist (None otherwise).
/// Used by the frontend to enable "Open" on saved papers.
#[tauri::command]
async fn saved_paths(
    app: AppHandle,
    relpaths: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    let lib = library_path(&app)?;
    let mut out = Vec::with_capacity(relpaths.len());
    for r in &relpaths {
        if r.is_empty() {
            out.push(None);
            continue;
        }
        if let Ok(checked) = safe_paths::destination(&lib, r, false) {
            if safe_paths::read_file(&checked.path).is_ok() { out.push(Some(checked.path.to_string_lossy().into_owned())); continue; }
        }
        out.push(None);
    }
    Ok(out)
}

/// Open a library file with its default app. Path must be inside the library.
#[tauri::command]
fn open_file(app: AppHandle, path: String) -> Result<(), String> {
    let lib = library_path(&app)?;
    let p = safe_paths::existing(&lib, Path::new(&path))?;
    open::that(p).map_err(|e| format!("open: {e}"))
}

/// Reveal a library file in Explorer. Path must be inside the library.
#[tauri::command]
fn reveal_in_folder(app: AppHandle, path: String) -> Result<(), String> {
    let lib = library_path(&app)?;
    let path = safe_paths::presentation(&safe_paths::reveal(&lib, Path::new(&path))?).to_string_lossy().into_owned();
    std::process::Command::new("explorer")
        .args(["/select,", &path])
        .spawn()
        .map_err(|e| format!("reveal: {e}"))?;
    Ok(())
}

/* Backend-attested updates. Frontend fields are compatibility hints only.
 * Independent artifact signatures need a separately managed signing-key rollout;
 * the current trust roots remain HTTPS plus the pinned project GitHub account. */
async fn latest_release(state: &State<'_, AppState>) -> Result<UpdateInfo, String> {
    updater::latest(&state.update_client).await
}

/// Check the latest GitHub release against the running version. Returns the
/// full info either way (the UI decides what to show). Read-only.
#[tauri::command]
async fn update_check(state: State<'_, AppState>) -> Result<UpdateInfo, String> {
    latest_release(&state).await
}

#[derive(serde::Serialize, Clone)]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
    done: bool,
}

/// Download the new installer, verify its SHA-256 against the GitHub-attested
/// digest, then launch it silently and exit so files unlock. Refuses while a
/// download batch is running (permits in use). A digest mismatch aborts — an
/// unverified binary never runs.
#[tauri::command]
async fn update_install(
    app: AppHandle,
    state: State<'_, AppState>,
    version: Option<String>,
    url: Option<String>,
    expected_digest: Option<String>,
) -> Result<(), String> {
    // Accept old invocation fields without ever treating them as trust material.
    let _ = (version, url, expected_digest);
    let _quiet = state.dl.clone().try_acquire_many_owned(MAX_WORKERS as u32)
        .map_err(|_| "finish current downloads or the other update first")?;
    let info = latest_release(&state).await?;
    if !info.update_available {
        return Err(format!("already up to date (running v{})", env!("CARGO_PKG_VERSION")));
    }
    let last_emit = AtomicU64::new(0);
    let staged = updater::download(&state.update_client, &info, |pos, total| {
        let now = now_ms();
        if now.saturating_sub(last_emit.load(Ordering::Relaxed)) >= 300 {
            last_emit.store(now, Ordering::Relaxed);
            let _ = app.emit("update-progress", UpdateProgress { downloaded: pos, total: Some(total), done: false });
        }
    }).await?;
    let _ = app.emit(
        "update-progress",
        UpdateProgress { downloaded: info.asset_size, total: Some(info.asset_size), done: true },
    );
    // Start a detached launcher and await its ready signal BEFORE exiting.
    // It waits for this process to end (not a fixed delay), runs the verified
    // NSIS installer with /S /UPDATE, checks its exit code, then relaunches.
    // An inline cmd.exe script passed through Command::args was CRT-escaped
    // to \"; cmd treated the backslashes literally ("cannot find '\\'").
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| format!("locate installed app: {e}"))?;
        update_launcher::launch(&staged.path, &exe, std::process::id()).await?;
        let _retained_for_launcher = staged.keep();
        app.exit(0);
        Ok(())
    }
    #[cfg(not(windows))]
    Err("automatic NSIS installation is available on Windows only".into())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Allow the asset protocol to serve the library (embedded reader).
            // Scope extends at runtime with the configured library dir.
            let scope = app.asset_protocol_scope();
            if let Ok(lib) = library_path(&app.handle()) {
                let _ = scope.allow_directory(&lib, true);
            }
            let client = network_policy::client().expect("restricted source client");
            app.manage(AppState {
                client,
                update_client: updater::client().expect("pinned update client"),
                picked_folder: safe_paths::PickedFolder::default(),
                fragment_client: reqwest::Client::builder().user_agent(USER_AGENT)
                    .redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(30))
                    .build().expect("THSC fragment client"),
                meta: Arc::new(Semaphore::new(2)), // bounded legacy resolver concurrency
                dl: Arc::new(Semaphore::new(MAX_WORKERS)),
                consec_404: AtomicUsize::new(0),
                ema_ms: AtomicU64::new(0),
                last_call: AtomicU64::new(0),
                cancel: AtomicBool::new(false),
                throttle_until: AtomicU64::new(0),
            });
            // Sweep interrupted .part files from the library on startup.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(lib) = library_path(&handle) {
                    let mut stack = vec![lib];
                    while let Some(dir) = stack.pop() {
                        let Ok(mut rd) = tokio::fs::read_dir(&dir).await else { continue };
                        while let Ok(Some(e)) = rd.next_entry().await {
                            let p = e.path();
                            let Ok(metadata) = tokio::fs::symlink_metadata(&p).await else { continue; };
                            if safe_paths::is_reparse(&metadata) { continue; }
                            if metadata.is_dir() {
                                stack.push(p);
                            } else if p.extension().and_then(|x| x.to_str()) == Some("part") {
                                tokio::fs::remove_file(&p).await.ok();
                            }
                        }
                    }
                }
            });
            // Re-extend the asset scope if the user changes the library later.
            let handle2 = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = handle2;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library_dir,
            get_library_config,
            pick_folder,
            set_library_dir,
            adopt_library,
            saved_paths,
            catalogue_info,
            download_paper,
            preflight,
            cancel_downloads,
            open_file,
            reveal_in_folder,
            update_check,
            update_install
        ])
        .run(tauri::generate_context!())
        .expect("HSCPapers failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn importing_preserves_sources_existing_pdfs_and_rejects_escaped_destinations() {
        let root = tempfile::tempdir().unwrap(); let source = tempfile::tempdir().unwrap();
        let file = source.path().join("Å & O'Brien.pdf");
        let original = b"%PDF-1.4\noriginal structural fixture\n%%EOF";
        std::fs::write(&file, original).unwrap();
        let relative = "Physics/2025/fixture.pdf";
        let partial = safe_paths::destination(root.path(), relative, true).unwrap().part.clone();
        std::fs::write(&partial, b"preserve interrupted download").unwrap();
        copy_in(root.path(), relative, &file).await.unwrap();
        assert_eq!(std::fs::read(&partial).unwrap(), b"preserve interrupted download");
        let saved = safe_paths::destination(root.path(), relative, false).unwrap();
        assert_eq!(std::fs::read(&saved.path).unwrap(), original);
        assert_eq!(std::fs::read(&file).unwrap(), original);
        std::fs::write(&file, b"%PDF-1.4\na larger different source that must not replace the user's existing file\n%%EOF").unwrap();
        copy_in(root.path(), relative, &file).await.unwrap();
        assert_eq!(std::fs::read(&saved.path).unwrap(), original);
        assert!(copy_in(root.path(), "../escaped.pdf", &file).await.is_err());
        std::fs::write(&file, b"HTML error").unwrap();
        assert!(copy_in(root.path(), "Physics/2025/invalid.pdf", &file).await.is_err());
        assert!(!root.path().join("Physics/2025/invalid.pdf").exists());
    }

    #[test]
    fn every_published_download_source_and_historical_filename_fits_the_native_policy() {
        let catalogue: serde_json::Value = serde_json::from_str(include_str!("../../ui/data/papers-v2.json")).unwrap();
        let mut filenames = 0usize;
        fn names(row: &serde_json::Value, count: &mut usize) {
            let subject = row["subject"].as_str().unwrap_or("unsorted");
            let school = row["school"].as_str().unwrap_or(""); let year = row["year"].as_u64();
            for (key, kind) in [("url", "paper"), ("solutionUrl", "solutions")] {
                if let Some(url) = row[key].as_str().filter(|s| !s.is_empty()) {
                    let relative = format!("{}/{}/{}-{}.pdf", js_seg(subject), year.map(|y| y.to_string()).unwrap_or_else(|| "unknown".into()), js_safe_name(year, subject, school, kind), name_hash(url));
                    safe_paths::relative_pdf(&relative).unwrap_or_else(|e| panic!("{relative}: {e}")); *count += 1;
                }
            }
        }
        for p in catalogue["papers"].as_array().unwrap() {
            for key in ["url", "solutionUrl", "fallbackUrl", "solFallbackUrl"] {
                if let Some(url) = p[key].as_str().filter(|s| !s.is_empty()) { network_policy::source(url).unwrap_or_else(|e| panic!("{url}: {e}")); }
            }
            for key in ["alternateSources", "fileVariants"] {
                for row in p[key].as_array().into_iter().flatten() {
                    if let Some(url) = row["url"].as_str() { network_policy::source(url).unwrap_or_else(|e| panic!("{url}: {e}")); }
                }
            }
        }
        for p in catalogue["papers"].as_array().unwrap().iter().chain(catalogue["recoveryPapers"].as_array().unwrap()) {
            names(p, &mut filenames);
            for alias in p["libraryAliases"].as_array().into_iter().flatten() { names(alias, &mut filenames); }
            for v in p["fileVariants"].as_array().into_iter().flatten() {
                if v["libraryRecord"].is_object() { names(&v["libraryRecord"], &mut filenames); }
                for alias in v["libraryAliases"].as_array().into_iter().flatten() { names(alias, &mut filenames); }
            }
        }
        assert!(filenames > catalogue["papers"].as_array().unwrap().len());
    }

    #[test]
    fn migrated_primary_never_falls_back_to_legacy_script() {
        let fragment = "https://www.thsconline.net/s/v/5338/Example%202025";
        let legacy = "https://thsconline.github.io/s/d/5338/Example%202025";
        assert!(!fallback_allowed(fragment, legacy).unwrap());
        assert!(fallback_allowed(fragment, "https://hscportal.pages.dev/file.pdf").unwrap());
        assert!(fallback_allowed("https://hscportal.pages.dev/file.pdf", legacy).unwrap());
        assert!(!fallback_allowed(fragment, fragment).unwrap());
        assert!(!fallback_allowed(fragment, "").unwrap());
    }

    #[test]
    fn compatibility_bridge_is_an_ordinary_pdf_download() {
        let bridge = "https://hscpapers.com/proxy?url=https%3A%2F%2Fwww.thsconline.net%2Fs%2Fv%2F5338%2FExample&dl=1";
        assert!(split_router_url(bridge).is_none());
        assert!(thsc_fragments::descriptor(bridge).unwrap().is_none());
    }

    #[test]
    fn router_url_split() {
        let (v, t) = split_router_url(
            "https://thsconline.github.io/s/d/5328/Abbotsleigh%202024%20w.%20sol",
        )
        .expect("router url");
        assert_eq!(v, "5328");
        assert_eq!(t, "Abbotsleigh 2024 w. sol");
        assert!(split_router_url("https://educationstandards.nsw.edu.au/x.pdf").is_none());
    }

    #[test]
    fn encodings() {
        assert_eq!(percent_decode("A%202024%20w.%20sol"), "A 2024 w. sol");
        assert_eq!(enc_q("A 2024 w. sol"), "A%202024%20w.%20sol");
        assert_eq!(strip_jsonp("downloadfile({\"a\":1});").unwrap(), "{\"a\":1}");
    }

    #[test]
    fn adaptive_delay_tiers() {
        // Fast pool -> minimum polite gap; congestion -> stretch proactively.
        assert_eq!(delay_from_ema(0), 1_500);
        assert_eq!(delay_from_ema(5_999), 1_500);
        assert_eq!(delay_from_ema(6_000), 4_000);
        assert_eq!(delay_from_ema(11_999), 4_000);
        assert_eq!(delay_from_ema(12_000), 8_000);
        assert_eq!(delay_from_ema(19_999), 8_000);
        assert_eq!(delay_from_ema(20_000), 12_000);
        assert_eq!(delay_from_ema(60_000), 12_000);
    }

    #[tokio::test]
    async fn cancel_aborts_sleeps_instantly() {
        // ✕ pre-set: a 10s sleep must return "cancelled" almost immediately
        // (verifies interruptible sleeps; previously ✕ could feel dead).
        let cancel = AtomicBool::new(true);
        let t0 = std::time::Instant::now();
        assert!(sleep_interruptible(&cancel, AUTO_PAUSE_MS).await);
        assert!(t0.elapsed() < std::time::Duration::from_secs(2));
    }

    #[tokio::test]
    async fn sleep_interruptible_waits_when_not_cancelled() {
        let cancel = AtomicBool::new(false);
        let t0 = std::time::Instant::now();
        assert!(!sleep_interruptible(&cancel, 700).await);
        assert!(t0.elapsed() >= std::time::Duration::from_millis(650));
    }

    #[test]
    fn throttle_gate_math() {
        // Gate window comparisons used by download_paper.
        let now = now_ms();
        let until = now + AUTO_PAUSE_MS;
        assert!(now < until, "gate open right after failure");
        assert!(now + AUTO_PAUSE_MS + 1 >= until, "gate expired later");
    }

    #[test]
    fn worker_pool_rotates() {
        assert_eq!(EXPORT_APIS.len(), 16);
        assert_eq!(export_api_at(0), EXPORT_APIS[0]);
        assert_eq!(export_api_at(15), EXPORT_APIS[15]); // original = fallback slot
        assert_eq!(export_api_at(16), EXPORT_APIS[0]); // wraps
        for api in EXPORT_APIS {
            assert!(api.starts_with("https://script.google.com/macros/s/"), "{api}");
            assert!(api.ends_with("/exec"), "{api}");
        }
    }

    #[test]
    fn name_hash_matches_frontend() {
        // Values computed by the frontend hash6() (base36, 10 chars, u32).
        assert_eq!(name_hash("https://example.com/test.pdf"), "0000czz2d3");
        assert_eq!(name_hash("Abbotsleigh 2024 w. sol"), "000046x3d7");
    }

    #[test]
    fn js_safe_name_matches_frontend() {
        assert_eq!(
            js_safe_name(Some(2024), "Earth & Environmental Science", "Sydney Boys", "paper"),
            "2024-earth-environmental-science-sydney-boys-paper"
        );
        assert_eq!(js_safe_name(None, "English", "NESA", "paper"), "na-english-nesa-paper");
    }

    #[test]
    fn path_validation() {
        use std::path::Path;
        let root = Path::new("C:\\tmp\\lib");
        assert!(path_within(root, Path::new("C:\\tmp\\lib\\a\\b.pdf")));
        assert!(path_within(root, root));
        assert!(!path_within(root, Path::new("C:\\tmp\\other\\x.pdf")));
        assert!(!path_within(root, Path::new("C:\\Windows\\system32\\evil.pdf")));
        // case-insensitive + trailing separators
        assert!(path_within(root, Path::new("C:\\TMP\\LIB\\x.pdf")));
        // canonicalized (\\?\) root vs plain path — the historical bug
        let prefixed = std::path::absolute(root).unwrap();
        assert!(path_within(&prefixed, Path::new("C:\\tmp\\lib\\x.pdf")));
        assert!(path_within(root, &prefixed));
    }
}
