//! Migrated THSC byte transport. This module never calls an Apps Script endpoint.
use futures_util::{StreamExt, TryStreamExt};
use sha2::{Digest, Sha256};
use std::{io::Read, sync::atomic::{AtomicBool, Ordering}, time::Duration};

pub const PLACEHOLDER_SHA: &str = "ae3414ce7149e4f808bca8563d46b813a36af04c5651762c47ce0f854ff0561c";
const MAX_COMPRESSED: usize = 16 * 1024 * 1024;
const MAX_PDF: usize = 32 * 1024 * 1024;

pub fn sanitize_title(raw: &str) -> String {
    raw.trim().replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'")
        .replace("&nbsp;", " ").replace("(Adv.)", "__ADV__").replace("(Std.)", "__STD__")
        .chars().filter(|c| c.is_ascii_alphanumeric() || "._- ".contains(*c)).collect::<String>()
        .replace("__ADV__", "(Adv.)").replace("__STD__", "(Std.)")
}
pub fn descriptor(value: &str) -> Result<Option<(String, String)>, String> {
    let u = reqwest::Url::parse(value).map_err(|_| "Invalid source URL".to_string())?;
    if !matches!(u.host_str(), Some("www.thsconline.net" | "thsconline.net")) { return Ok(None); }
    if u.scheme() != "https" || u.port().is_some() || !u.username().is_empty() || u.password().is_some() || u.query().is_some() || u.fragment().is_some() {
        return Err("Malformed THSC fragment descriptor".into());
    }
    let parts: Vec<_> = u.path().split('/').collect();
    if parts.len() != 5 || parts[1] != "s" || parts[2] != "v" || parts[3].is_empty() || parts[3].len() > 8 || !parts[3].bytes().all(|b| b.is_ascii_digit()) {
        return Err("Malformed THSC fragment descriptor".into());
    }
    let raw = decode_segment(parts[4])?;
    let title = sanitize_title(&raw);
    if title.is_empty() || title.len() > 400 { return Err("Invalid THSC lookup title".into()); }
    Ok(Some((parts[3].into(), title)))
}
fn decode_segment(value: &str) -> Result<String, String> {
    let b = value.as_bytes(); let mut out = Vec::new(); let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            if i + 2 >= b.len() { return Err("Malformed THSC title encoding".into()); }
            let h = (b[i + 1] as char).to_digit(16).ok_or("Malformed THSC title encoding")?;
            let l = (b[i + 2] as char).to_digit(16).ok_or("Malformed THSC title encoding")?;
            out.push((h * 16 + l) as u8); i += 3;
        } else { out.push(b[i]); i += 1; }
    }
    String::from_utf8(out).map_err(|_| "Malformed THSC title UTF-8".into())
}
pub fn validate_pdf(bytes: &[u8]) -> Result<(), String> {
    if !bytes.starts_with(b"%PDF-") || !bytes[bytes.len().saturating_sub(4096)..].windows(5).any(|b| b == b"%%EOF") {
        return Err("Source returned HTML or an incomplete PDF".into());
    }
    if hex::encode(Sha256::digest(bytes)) == PLACEHOLDER_SHA {
        return Err("THSC returned its 404 placeholder; requested file unavailable".into());
    }
    Ok(())
}
async fn body(mut r: reqwest::Response, max: usize, cancel: &AtomicBool) -> Result<Vec<u8>, String> {
    if !r.status().is_success() { return Err(format!("THSC migrated source HTTP {}", r.status())); }
    if r.content_length().unwrap_or(0) > max as u64 { return Err("Source exceeds transport byte limit".into()); }
    let mut bytes = Vec::new();
    loop {
        if cancel.load(Ordering::Relaxed) { return Err(crate::CANCELLED.into()); }
        tokio::select! {
            chunk = r.chunk() => match chunk.map_err(|e| format!("THSC fragment body: {e}"))? {
                Some(c) => { if bytes.len() + c.len() > max { return Err("Source exceeds transport byte limit".into()); } bytes.extend_from_slice(&c); }
                None => break,
            },
            _ = tokio::time::sleep(Duration::from_millis(150)) => {}
        }
    }
    Ok(bytes)
}
pub fn decompress(mut parts: Vec<(usize, Vec<u8>)>) -> Result<Vec<u8>, String> {
    parts.sort_by_key(|x| x.0);
    if parts.iter().enumerate().any(|(i, p)| p.0 != i) { return Err("Missing THSC fragment".into()); }
    let size: usize = parts.iter().map(|p| p.1.len()).sum();
    if size > MAX_COMPRESSED { return Err("Compressed file exceeds transport byte limit".into()); }
    let compressed: Vec<u8> = parts.into_iter().flat_map(|p| p.1).collect();
    let mut bytes = Vec::new();
    flate2::read::GzDecoder::new(&compressed[..]).take(MAX_PDF as u64 + 1)
        .read_to_end(&mut bytes).map_err(|_| "THSC returned incomplete or invalid gzip fragments".to_string())?;
    if bytes.len() > MAX_PDF { return Err("PDF exceeds transport byte limit".into()); }
    validate_pdf(&bytes)?; Ok(bytes)
}
pub async fn resolve(client: &reqwest::Client, viewno: &str, title: &str, cancel: &AtomicBool) -> Result<Vec<u8>, String> {
    let operation = async {
        let prefix = "https://www.thsconline.net/api/v1/";
        let key = format!("{}/{}", crate::enc_q(viewno), crate::enc_q(title));
        let response = crate::send_interruptible(client.get(format!("{prefix}getmetadata/{key}")).timeout(Duration::from_secs(20)), cancel, "THSC metadata").await?;
        let metadata: serde_json::Value = serde_json::from_slice(&body(response, 65536, cancel).await?).map_err(|_| "Invalid THSC metadata JSON")?;
        if metadata.get("error").is_some_and(|x| !x.is_null() && x != "") { return Err("THSC metadata reports the requested file unavailable".into()); }
        let count = metadata.get("fragmentCount").and_then(|x| x.as_u64()).ok_or("Invalid THSC fragment count")?;
        if count == 0 { return Err("File not available through THSC's migrated transport".into()); }
        if count > 16 { return Err("Invalid THSC fragment count".into()); }
        let parts = futures_util::stream::iter(0..count as usize).map(|i| {
            let url = format!("{prefix}getfragment/{key}/{i}");
            async move {
                let r = crate::send_interruptible(client.get(url).timeout(Duration::from_secs(20)), cancel, "THSC fragment").await?;
                Ok::<_, String>((i, body(r, MAX_COMPRESSED, cancel).await?))
            }
        }).buffer_unordered(2).try_collect::<Vec<_>>().await?;
        if cancel.load(Ordering::Relaxed) { return Err(crate::CANCELLED.into()); }
        let bytes = tokio::task::spawn_blocking(move || decompress(parts)).await.map_err(|e| format!("THSC decompression: {e}"))??;
        if cancel.load(Ordering::Relaxed) { return Err(crate::CANCELLED.into()); }
        Ok(bytes)
    };
    tokio::time::timeout(Duration::from_secs(30), operation).await.map_err(|_| "THSC fragment delivery timed out".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn strict_descriptor_and_lookup() {
        assert_eq!(descriptor("https://www.thsconline.net/s/v/5338/A%20%26%20O%27Brien%20(Adv.)").unwrap(), Some(("5338".into(), "A  OBrien (Adv.)".into())));
        for u in ["https://thsconline.net/s/v/no/title", "https://thsconline.net/s/v/1/%ZZ", "https://thsconline.net/s/v/1/title?q=x"] { assert!(descriptor(u).is_err()); }
        assert!(descriptor("https://hscportal.pages.dev/a.pdf").unwrap().is_none());
    }
    #[test] fn ordered_gzip_and_validation() {
        use std::io::Write;
        let pdf = b"%PDF-1.4\nfixture\n%%EOF";
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default()); encoder.write_all(pdf).unwrap(); let gzip = encoder.finish().unwrap();
        assert_eq!(decompress(vec![(1, gzip[10..].to_vec()), (0, gzip[..10].to_vec())]).unwrap(), pdf);
        assert!(decompress(vec![(1, gzip)]).is_err());
        assert!(decompress(vec![(0, b"not gzip".to_vec())]).is_err());
        assert!(validate_pdf(b"%PDF-1.4\ntruncated").is_err());
    }
}
