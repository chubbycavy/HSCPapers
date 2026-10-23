//! Bound native network capabilities independently of catalogue/frontend checks.
use futures_util::{Stream, StreamExt};
use reqwest::{Client, Url};
use std::sync::atomic::{AtomicBool, Ordering};
pub const MAX_PDF_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_RESOLVER_BYTES: usize = 48 * 1024 * 1024;
const HOSTS: &[&str] = &[
    "hscportal.pages.dev",
    "hscpapers.com",
    "hscpapers.pages.dev",
    "www.nsw.gov.au",
    "nsw.gov.au",
    "www.boardofstudies.nsw.edu.au",
    "boardofstudies.nsw.edu.au",
    "thsconline.github.io",
    "thsconline.pages.dev",
    "thsconline.com.au",
    "web.archive.org",
    "aceh.b-cdn.net",
    "4unitmaths.com",
    "cresteconomics.com",
    "www.thsconline.net",
    "thsconline.net",
    "pub-ec23c9b69d2544938d816ad28ee491fd.r2.dev",
];
fn https(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}
pub fn source_allowed(url: &Url) -> bool {
    https(url) && url.host_str().is_some_and(|host| HOSTS.contains(&host))
}
pub fn source(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "invalid source URL")?;
    if !source_allowed(&url) {
        return Err("unapproved source URL".into());
    }
    Ok(url)
}
fn resolver(url: &Url) -> bool {
    https(url)
        && crate::EXPORT_APIS.iter().any(|api| {
            let Ok(expected) = Url::parse(api) else {
                return false;
            };
            url.origin() == expected.origin() && url.path() == expected.path()
        })
}
pub fn redirect_allowed(original: &Url, next: &Url) -> bool {
    if resolver(original) {
        https(next) && (resolver(next) || next.host_str() == Some("script.googleusercontent.com"))
    } else {
        source_allowed(original) && source_allowed(next)
    }
}
pub fn client() -> Result<Client, reqwest::Error> {
    Client::builder()
        .user_agent(crate::USER_AGENT)
        .timeout(std::time::Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("too many source redirects");
            }
            if attempt
                .previous()
                .first()
                .is_some_and(|first| redirect_allowed(first, attempt.url()))
            {
                attempt.follow()
            } else {
                attempt.error("unapproved source redirect")
            }
        }))
        .build()
}
pub fn check_size(current: u64, additional: u64, max: usize) -> Result<u64, String> {
    current
        .checked_add(additional)
        .filter(|n| *n <= max as u64)
        .ok_or_else(|| "source exceeds transport byte limit".into())
}

/// Progress-reporting direct/Apps Script streams must also be interruptible
/// when the server stops sending chunks, not only between received chunks.
pub async fn chunk<S, T, E>(stream: &mut S, cancel: &AtomicBool) -> Result<Option<T>, String>
where
    S: Stream<Item = Result<T, E>> + Unpin,
    E: std::fmt::Display,
{
    if cancel.load(Ordering::Relaxed) {
        return Err(crate::CANCELLED.into());
    }
    tokio::select! {
        next = stream.next() => next.transpose().map_err(|e| format!("source stream: {e}")),
        _ = crate::cancel_watch(cancel) => Err(crate::CANCELLED.into()),
    }
}
pub async fn body(
    mut response: reqwest::Response,
    max: usize,
    cancel: Option<&AtomicBool>,
) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(format!("source HTTP {}", response.status()));
    }
    if let Some(length) = response.content_length() {
        check_size(0, length, max)?;
    }
    let mut out = Vec::new();
    loop {
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            return Err(crate::CANCELLED.into());
        }
        tokio::select! {
            next = response.chunk() => match next.map_err(|e| format!("source body: {e}"))? {
                None => break,
                Some(bytes) => { check_size(out.len() as u64, bytes.len() as u64, max)?; out.extend_from_slice(&bytes); },
            },
            _ = tokio::time::sleep(std::time::Duration::from_millis(150)) => {},
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_interrupts_the_actual_progress_stream_chunk_reader() {
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        let mut stalled = futures_util::stream::pending::<Result<Vec<u8>, String>>();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
            signal.store(true, Ordering::Relaxed);
        });
        let start = std::time::Instant::now();
        assert_eq!(
            chunk(&mut stalled, &cancel).await.unwrap_err(),
            crate::CANCELLED
        );
        assert!(start.elapsed() < std::time::Duration::from_millis(800));
    }
    #[test]
    fn origins_and_redirect_chains_never_broaden_the_native_capability() {
        for bad in [
            "http://hscportal.pages.dev/a.pdf",
            "https://hscportal.pages.dev.evil.test/a.pdf",
            "https://user@hscportal.pages.dev/a.pdf",
            "https://hscportal.pages.dev:444/a.pdf",
            "http://127.0.0.1/private",
            "file:///C:/private.pdf",
            "https://script.google.com/macros/s/attacker/exec",
        ] {
            assert!(source(bad).is_err());
        }
        let portal = source("https://hscportal.pages.dev/a.pdf").unwrap();
        assert!(redirect_allowed(
            &portal,
            &source("https://www.nsw.gov.au/a.pdf").unwrap()
        ));
        assert!(!redirect_allowed(
            &portal,
            &Url::parse("https://evil.test/a.pdf").unwrap()
        ));
        let script = Url::parse(crate::EXPORT_APIS.last().unwrap()).unwrap();
        let google =
            Url::parse("https://script.googleusercontent.com/macros/echo?key=fixture").unwrap();
        assert!(redirect_allowed(&script, &google));
        assert!(!redirect_allowed(&portal, &google));
        assert!(!redirect_allowed(
            &script,
            &Url::parse("https://script.google.com/macros/s/attacker/exec").unwrap()
        ));
        assert!(!redirect_allowed(
            &script,
            &Url::parse("https://evil.test/a.pdf").unwrap()
        ));
    }
    #[test]
    fn size_checks_reject_overflow_and_oversize_resumes_before_writing() {
        assert_eq!(check_size(5, 5, 10).unwrap(), 10);
        assert!(check_size(10, 1, 10).is_err());
        assert!(check_size(u64::MAX, 1, 10).is_err());
    }
    #[tokio::test]
    async fn streaming_body_limit_is_enforced_even_without_a_content_length() {
        use std::io::{Read, Write};
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = server.accept().unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            stream.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n5\r\nworld\r\n0\r\n\r\n").unwrap();
        });
        // Only this bounded-body fixture uses loopback; production clients deny it.
        let response = Client::new()
            .get(format!("http://{address}/fixture"))
            .send()
            .await
            .unwrap();
        assert!(body(response, 6, None).await.unwrap_err().contains("limit"));
        thread.join().unwrap();
    }
    #[tokio::test]
    async fn cancellation_interrupts_a_stalled_legacy_body() {
        use std::io::{Read, Write};
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = server.accept().unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nx")
                .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(1200));
        });
        let response = Client::new()
            .get(format!("http://{address}/fixture"))
            .send()
            .await
            .unwrap();
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
            signal.store(true, Ordering::Relaxed);
        });
        let start = std::time::Instant::now();
        assert_eq!(
            body(response, 1000, Some(&cancel)).await.unwrap_err(),
            crate::CANCELLED
        );
        assert!(start.elapsed() < std::time::Duration::from_millis(800));
        thread.join().unwrap();
    }
}
