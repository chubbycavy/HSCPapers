//! The webview cannot attest an executable or choose its staging path.
//! Release metadata is fetched afresh from one pinned backend channel.
use futures_util::{Stream, StreamExt};
use reqwest::{Client, Url};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

pub const RELEASES_API: &str = "https://api.github.com/repos/chubbycavy/HSCPapers/releases/latest";
const MAX_INSTALLER: u64 = 128 * 1024 * 1024;
#[derive(serde::Serialize, Clone, Debug)]
pub struct UpdateInfo {
    pub update_available: bool,
    pub version: String,
    pub notes: String,
    pub asset_url: String,
    pub digest: String,
    pub asset_size: u64,
    #[serde(skip_serializing)]
    tag: String,
}
fn version(value: &str) -> Result<[u64; 3], String> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 3
        || parts.iter().any(|s| {
            s.is_empty()
                || s.len() > 10
                || !s.bytes().all(|b| b.is_ascii_digit())
                || (s.len() > 1 && s.starts_with('0'))
        })
    {
        return Err("invalid stable release version".into());
    }
    Ok([
        parts[0].parse().map_err(|_| "invalid version")?,
        parts[1].parse().map_err(|_| "invalid version")?,
        parts[2].parse().map_err(|_| "invalid version")?,
    ])
}
fn digest(value: &str) -> Result<String, String> {
    let hex = value
        .strip_prefix("sha256:")
        .ok_or("release lacks a GitHub SHA-256 digest")?;
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid release SHA-256 digest".into());
    }
    Ok(hex.to_ascii_lowercase())
}
fn secure(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}
fn asset_url(tag: &str, release_version: &str, value: &str) -> Result<Url, String> {
    version(release_version)?;
    if tag != release_version && tag != format!("v{release_version}") {
        return Err("invalid release tag".into());
    }
    let expected = format!("https://github.com/chubbycavy/HSCPapers/releases/download/{tag}/HSCPapers_{release_version}_x64-setup.exe");
    let url = Url::parse(value).map_err(|_| "invalid release URL")?;
    if !secure(&url) || url.as_str() != expected {
        return Err("release installer is not the exact project asset".into());
    }
    Ok(url)
}
pub fn redirect_allowed(original: &Url, next: &Url) -> bool {
    // The pinned API request itself must never redirect to another manifest.
    if original.as_str() == RELEASES_API
        || !secure(next)
        || !secure(original)
        || original.host_str() != Some("github.com")
        || !original
            .path()
            .starts_with("/chubbycavy/HSCPapers/releases/download/")
    {
        return false;
    }
    match next.host_str() {
        Some("github.com") => next.path() == original.path(),
        Some(
            "release-assets.githubusercontent.com"
            | "objects.githubusercontent.com"
            | "github-releases.githubusercontent.com",
        ) => true,
        _ => false,
    }
}
pub fn client() -> Result<Client, reqwest::Error> {
    Client::builder()
        .user_agent(crate::USER_AGENT)
        .timeout(std::time::Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("too many update redirects");
            }
            if attempt
                .previous()
                .first()
                .is_some_and(|first| redirect_allowed(first, attempt.url()))
            {
                attempt.follow()
            } else {
                attempt.error("unapproved update redirect")
            }
        }))
        .build()
}
pub fn parse_release(json: &serde_json::Value, current: &str) -> Result<UpdateInfo, String> {
    if json["draft"].as_bool() == Some(true) || json["prerelease"].as_bool() == Some(true) {
        return Err("release is not a published stable version".into());
    }
    let tag = json["tag_name"].as_str().ok_or("release has no version")?;
    let number = tag.strip_prefix('v').unwrap_or(tag);
    let newer = version(number)? > version(current)?;
    let name = format!("HSCPapers_{number}_x64-setup.exe");
    let matching: Vec<_> = json["assets"]
        .as_array()
        .ok_or("release has no assets")?
        .iter()
        .filter(|a| a["name"].as_str() == Some(name.as_str()))
        .collect();
    if matching.len() != 1 {
        return Err("release must contain one exact Windows installer".into());
    }
    let asset = matching[0];
    let url = asset["browser_download_url"]
        .as_str()
        .ok_or("release has no installer URL")?;
    asset_url(tag, number, url)?;
    let sha = asset["digest"]
        .as_str()
        .ok_or("release has no verifiable digest")?;
    digest(sha)?;
    let size = asset["size"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= MAX_INSTALLER)
        .ok_or("invalid release installer size")?;
    Ok(UpdateInfo {
        update_available: newer,
        version: number.into(),
        notes: json["body"].as_str().unwrap_or("").into(),
        asset_url: url.into(),
        digest: sha.into(),
        asset_size: size,
        tag: tag.into(),
    })
}
pub async fn latest(client: &Client) -> Result<UpdateInfo, String> {
    let response = client
        .get(RELEASES_API)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("update check: {e}"))?;
    if response.url().as_str() != RELEASES_API {
        return Err("update manifest origin changed".into());
    }
    let bytes = crate::network_policy::body(response, 1024 * 1024, None).await?;
    let json = serde_json::from_slice(&bytes).map_err(|e| format!("update metadata: {e}"))?;
    parse_release(&json, env!("CARGO_PKG_VERSION"))
}

pub struct StagedInstaller {
    pub path: PathBuf,
    directory: tempfile::TempDir,
}
impl StagedInstaller {
    pub fn keep(self) -> PathBuf {
        self.directory.keep()
    }
}
async fn stage_in<S, F>(
    parent: &Path,
    info: &UpdateInfo,
    declared: Option<u64>,
    stream: S,
    progress: F,
) -> Result<StagedInstaller, String>
where
    S: Stream<Item = Result<Vec<u8>, String>> + Unpin,
    F: Fn(u64, u64),
{
    asset_url(&info.tag, &info.version, &info.asset_url)?;
    if !info.update_available || info.asset_size == 0 || info.asset_size > MAX_INSTALLER {
        return Err("no verified newer installer is available".into());
    }
    let expected = digest(&info.digest)?;
    if declared.is_some_and(|n| n != info.asset_size) {
        return Err("installer Content-Length differs from release metadata".into());
    }
    let directory = tempfile::Builder::new()
        .prefix("HSCPapers-update-")
        .tempdir_in(parent)
        .map_err(|e| format!("stage update: {e}"))?;
    // Constant filename, private random directory, exclusive creation: no version
    // interpolation, existing-user-file overwrite or shared predictable temp file.
    let path = directory.path().join("installer.exe");
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .await
        .map_err(|e| format!("stage installer: {e}"))?;
    let mut hasher = Sha256::new();
    let mut pos = 0u64;
    let mut head: Vec<u8> = Vec::new();
    tokio::pin!(stream);
    let result: Result<(), String> = async {
        while let Some(chunk) = stream.next().await {
            let bytes = chunk?;
            pos = pos
                .checked_add(bytes.len() as u64)
                .filter(|n| *n <= info.asset_size && *n <= MAX_INSTALLER)
                .ok_or("installer exceeds the verified release size")?;
            if head.len() < 2 {
                head.extend(bytes.iter().take(2 - head.len()).copied());
            }
            hasher.update(&bytes);
            file.write_all(&bytes)
                .await
                .map_err(|e| format!("write installer: {e}"))?;
            progress(pos, info.asset_size);
        }
        Ok(())
    }
    .await;
    // Close pending Tokio writes before TempDir cleanup, including stream errors.
    let flushed = file.flush().await.map_err(|e| e.to_string());
    let synced = file.sync_all().await.map_err(|e| e.to_string());
    drop(file.into_std().await);
    result?;
    flushed?;
    synced?;
    if pos != info.asset_size || head != b"MZ" || hex::encode(hasher.finalize()) != expected {
        return Err("installer size/format/SHA-256 mismatch; staged installer discarded".into());
    }
    Ok(StagedInstaller { path, directory })
}
pub async fn download<F: Fn(u64, u64)>(
    client: &Client,
    info: &UpdateInfo,
    progress: F,
) -> Result<StagedInstaller, String> {
    let url = asset_url(&info.tag, &info.version, &info.asset_url)?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download installer: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("installer HTTP {}", response.status()));
    }
    let declared = response.content_length();
    let stream = response.bytes_stream().map(|r| {
        r.map(|b| b.to_vec())
            .map_err(|e| format!("installer body: {e}"))
    });
    stage_in(&std::env::temp_dir(), info, declared, stream, progress).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release(number: &str) -> serde_json::Value {
        serde_json::json!({ "tag_name": format!("v{number}"), "draft": false, "prerelease": false, "body": "notes", "assets": [{
            "name": format!("HSCPapers_{number}_x64-setup.exe"), "browser_download_url": format!("https://github.com/chubbycavy/HSCPapers/releases/download/v{number}/HSCPapers_{number}_x64-setup.exe"), "digest": format!("sha256:{}", "a".repeat(64)), "size": 20 }] })
    }
    #[test]
    fn tags_assets_and_digests_cannot_supply_paths_or_foreign_executables() {
        for tag in [
            "9.0.0/../../Startup/evil",
            r"9.0.0\..\evil",
            "1.2",
            "1.2.3.4",
            "01.2.3",
            "1.2.3-beta",
            "1.2.3 ",
            "1.2.3:evil",
        ] {
            assert!(
                parse_release(&release(tag), "1.0.27").is_err(),
                "accepted {tag}"
            );
        }
        for url in ["https://github.com/attacker/repo/releases/download/v1/p.exe", "https://objects.githubusercontent.com/arbitrary", "https://github.com.evil.test/p.exe", "http://github.com/chubbycavy/HSCPapers/releases/download/v1.0.99/HSCPapers_1.0.99_x64-setup.exe"] {
            let mut value = release("1.0.99"); value["assets"][0]["browser_download_url"] = url.into(); assert!(parse_release(&value, "1.0.27").is_err());
        }
        let mut value = release("1.0.99");
        value["assets"][0]["digest"] = "sha256:bad".into();
        assert!(parse_release(&value, "1.0.27").is_err());
        value = release("1.0.99");
        value["assets"][0]["size"] = (MAX_INSTALLER + 1).into();
        assert!(parse_release(&value, "1.0.27").is_err());
    }
    #[test]
    fn current_older_and_ambiguous_releases_do_not_install() {
        assert!(
            !parse_release(&release("1.0.27"), "1.0.27")
                .unwrap()
                .update_available
        );
        assert!(
            !parse_release(&release("1.0.26"), "1.0.27")
                .unwrap()
                .update_available
        );
        assert!(
            parse_release(&release("1.0.99"), "1.0.27")
                .unwrap()
                .update_available
        );
        let mut value = release("1.0.99");
        let duplicate = value["assets"][0].clone();
        value["assets"].as_array_mut().unwrap().push(duplicate);
        assert!(parse_release(&value, "1.0.27").is_err());
    }
    #[test]
    fn only_the_pinned_release_can_redirect_to_github_asset_cdns() {
        let info = parse_release(&release("1.0.99"), "1.0.27").unwrap();
        let original = Url::parse(&info.asset_url).unwrap();
        assert!(redirect_allowed(
            &original,
            &Url::parse("https://release-assets.githubusercontent.com/fixture").unwrap()
        ));
        for url in [
            "https://evil.test/p.exe",
            "http://release-assets.githubusercontent.com/fixture",
            "https://github.com/attacker/repo/releases/download/v1/p.exe",
            "https://user@release-assets.githubusercontent.com/fixture",
        ] {
            assert!(!redirect_allowed(&original, &Url::parse(url).unwrap()));
        }
        assert!(!redirect_allowed(
            &Url::parse(RELEASES_API).unwrap(),
            &original
        ));
    }
    #[tokio::test]
    async fn exclusive_random_staging_verifies_bytes_and_cleans_all_failure_paths() {
        let root = tempfile::tempdir().unwrap();
        let victim = root.path().join("HSCPapers_1.0.99_x64-setup.exe");
        std::fs::write(&victim, b"preserve").unwrap();
        let bytes = b"MZ harmless non-executable regression fixture".to_vec();
        let mut info = parse_release(&release("1.0.99"), "1.0.27").unwrap();
        info.asset_size = bytes.len() as u64;
        info.digest = format!("sha256:{}", hex::encode(Sha256::digest(&bytes)));
        let a = stage_in(
            root.path(),
            &info,
            Some(info.asset_size),
            futures_util::stream::iter([Ok(bytes.clone())]),
            |_, _| {},
        )
        .await
        .unwrap();
        let b = stage_in(
            root.path(),
            &info,
            None,
            futures_util::stream::iter([Ok(bytes.clone())]),
            |_, _| {},
        )
        .await
        .unwrap();
        assert_ne!(a.path, b.path);
        assert_eq!(a.path.file_name().unwrap(), "installer.exe");
        assert_eq!(std::fs::read(&a.path).unwrap(), bytes);
        drop(a);
        drop(b);
        for mode in [
            "digest",
            "truncated",
            "oversize",
            "stream-error",
            "version",
            "declared",
        ] {
            let mut value = info.clone();
            let mut payload = bytes.clone();
            let mut declared = None;
            match mode {
                "digest" => value.digest = format!("sha256:{}", "0".repeat(64)),
                "truncated" => {
                    payload.pop();
                }
                "oversize" => payload.push(0),
                "version" => value.version = "../../Startup/evil".into(),
                "declared" => declared = Some(1),
                _ => {}
            }
            let chunks = if mode == "stream-error" {
                vec![Ok(payload[..8].to_vec()), Err("interrupted".into())]
            } else {
                vec![Ok(payload)]
            };
            assert!(stage_in(
                root.path(),
                &value,
                declared,
                futures_util::stream::iter(chunks),
                |_, _| {}
            )
            .await
            .is_err());
            assert_eq!(
                std::fs::read_dir(root.path()).unwrap().count(),
                1,
                "leaked staging for {mode}"
            );
            assert_eq!(std::fs::read(&victim).unwrap(), b"preserve");
        }
    }
}
