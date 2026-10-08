//! Windows update hand-off. Never pass an inline cmd.exe command through
//! Command::args: CRT escaping produces \" that cmd interprets literally.
//! PowerShell receives a UTF-16LE encoded script instead; all filesystem
//! paths are literal strings, and Start-Process launches each EXE directly.
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{fs, os::windows::process::CommandExt};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);

fn path_literal(path: &Path) -> Result<String, String> {
    let text = path.to_str().ok_or("update path is not valid Unicode")?;
    Ok(format!("'{}'", text.replace('\'', "''")))
}

fn script(
    installer: &Path,
    app_exe: &Path,
    parent_id: u32,
    ready: &Path,
    log: &Path,
    show_error_dialog: bool,
) -> Result<String, String> {
    Ok(format!(
        r#"$ErrorActionPreference = 'Stop'
$installer = {installer}
$appExe = {app_exe}
$parentId = {parent_id}
$readyFile = {ready}
$logFile = {log}
$showErrorDialog = {dialog}
function Write-UpdateLog([string]$message) {{
    [System.IO.File]::AppendAllText($logFile, [DateTime]::UtcNow.ToString('o') + ' ' + $message + [Environment]::NewLine)
}}
try {{
    [System.IO.File]::WriteAllText($logFile, '')
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {{ throw 'The verified installer is missing.' }}
    if (-not (Test-Path -LiteralPath $appExe -PathType Leaf)) {{ throw 'The installed app is missing.' }}
    Write-UpdateLog 'Launcher ready.'
    [System.IO.File]::WriteAllText($readyFile, 'ready')
    $parent = $null
    try {{ $parent = [System.Diagnostics.Process]::GetProcessById($parentId) }} catch [System.ArgumentException] {{ }}
    if ($null -ne $parent) {{
        try {{
            if (-not $parent.WaitForExit(60000)) {{ throw 'The old app did not close within 60 seconds.' }}
        }} finally {{ $parent.Dispose() }}
    }}
    Write-UpdateLog 'Old app exited. Starting installer.'
    $installation = Start-Process -FilePath $installer -ArgumentList @('/S', '/UPDATE') -Wait -PassThru
    Write-UpdateLog ('Installer exit code: ' + $installation.ExitCode)
    if ($installation.ExitCode -ne 0) {{ throw ('Installer failed with exit code ' + $installation.ExitCode + '.') }}
    $replacement = Start-Process -FilePath $appExe -PassThru
    Write-UpdateLog ('Relaunched app, PID ' + $replacement.Id + '.')
    exit 0
}} catch {{
    $failure = $_.Exception.Message
    try {{ Write-UpdateLog ('ERROR: ' + $failure) }} catch {{ }}
    if ($showErrorDialog) {{
        try {{
            Add-Type -AssemblyName System.Windows.Forms
            [System.Windows.Forms.MessageBox]::Show(
                'HSCPapers update failed: ' + $failure + [Environment]::NewLine + [Environment]::NewLine +
                'You can install the latest release manually. Details: ' + $logFile,
                'HSCPapers update', 'OK', 'Error') | Out-Null
        }} catch {{ }}
    }}
    exit 1
}}
"#,
        installer = path_literal(installer)?,
        app_exe = path_literal(app_exe)?,
        ready = path_literal(ready)?,
        log = path_literal(log)?,
        dialog = if show_error_dialog { "$true" } else { "$false" },
    ))
}

fn encoded_script(script: &str) -> String {
    let bytes: Vec<u8> = script
        .encode_utf16()
        .flat_map(|c| c.to_le_bytes())
        .collect();
    B64.encode(bytes)
}

fn command(
    installer: &Path,
    app_exe: &Path,
    parent_id: u32,
    ready: &Path,
    log: &Path,
    show_error_dialog: bool,
) -> Result<Command, String> {
    let system_root = std::env::var_os("SystemRoot").ok_or("Windows SystemRoot is unavailable")?;
    let powershell =
        PathBuf::from(system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let encoded = encoded_script(&script(
        installer,
        app_exe,
        parent_id,
        ready,
        log,
        show_error_dialog,
    )?);
    let mut cmd = Command::new(powershell);
    cmd.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        &encoded,
    ])
    .creation_flags(CREATE_NO_WINDOW)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    Ok(cmd)
}

async fn spawn_ready(mut cmd: Command, ready: &Path, log: &Path) -> Result<(), String> {
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("start update launcher: {e}"))?;
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        if ready.is_file() {
            let _ = fs::remove_file(ready);
            // Dropping Child does NOT terminate the process. The launcher
            // stays alive, waits for this app to exit, installs, relaunches.
            return Ok(());
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("check update launcher: {e}"))?
        {
            let detail = fs::read_to_string(log).unwrap_or_default();
            return Err(format!(
                "update launcher exited before it was ready ({status}). {} Details: {}",
                detail.trim(),
                log.display()
            ));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("update launcher did not start within 15 seconds; the app is staying open. Details: {}", log.display()));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub async fn launch(installer: &Path, app_exe: &Path, parent_id: u32) -> Result<(), String> {
    let directory = installer
        .parent()
        .ok_or("installer has no parent directory")?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let ready = directory.join(format!("HSCPapers-update-{parent_id}-{stamp}.ready"));
    let log = directory.join("HSCPapers-update.log");
    spawn_ready(
        command(installer, app_exe, parent_id, &ready, &log, true)?,
        &ready,
        &log,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"
use std::{env, fs, io::Write, path::PathBuf, thread, time::Duration};
fn event(s: &str) {
    let p = env::var_os("HSCPAPERS_FIXTURE_TRACE").unwrap();
    let mut f = fs::OpenOptions::new().create(true).append(true).open(p).unwrap();
    writeln!(f, "{s}").unwrap();
}
fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args == ["--parent"] {
        event("parent-start"); thread::sleep(Duration::from_millis(1200)); event("parent-exit"); return;
    }
    let exe = env::current_exe().unwrap();
    if exe.file_name().unwrap().to_string_lossy().starts_with("installer") {
        event(&format!("installer:{}", args.join("|")));
        let code: i32 = env::var("HSCPAPERS_FIXTURE_EXIT").unwrap_or_else(|_| "0".into()).parse().unwrap();
        if code != 0 { event("installer-failed"); std::process::exit(code); }
        let target = PathBuf::from(env::var_os("HSCPAPERS_FIXTURE_APP").unwrap());
        if let Err(e) = fs::copy(&exe, target) { event(&format!("replacement-failed:{e}")); std::process::exit(41); }
        event("replacement-ok");
    } else { event(&format!("relaunch:{}", args.join("|"))); }
}
"#;

    struct Fixture {
        directory: PathBuf,
        installer: PathBuf,
        app: PathBuf,
        trace: PathBuf,
        ready: PathBuf,
        log: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let directory = std::env::temp_dir()
                .join("opencode")
                .join(format!("updater-test-{}-{stamp}", std::process::id()))
                .join("Student Å & O'Brien 100% ! paths");
            fs::create_dir_all(&directory).unwrap();
            let source = directory.join("fixture.rs");
            let binary = directory.join("fixture.exe");
            fs::write(&source, FIXTURE).unwrap();
            let built = Command::new("rustc")
                .arg(&source)
                .arg("-o")
                .arg(&binary)
                .output()
                .unwrap();
            assert!(
                built.status.success(),
                "fixture compilation failed: {}",
                String::from_utf8_lossy(&built.stderr)
            );
            let installer = directory.join("installer test.exe");
            let app = directory.join("installed app.exe");
            fs::copy(&binary, &installer).unwrap();
            fs::copy(&binary, &app).unwrap();
            Self {
                trace: directory.join("events.trace"),
                ready: directory.join("launcher.ready"),
                log: directory.join("update.log"),
                directory,
                installer,
                app,
            }
        }

        fn env(&self, command: &mut Command) {
            command
                .env("HSCPAPERS_FIXTURE_TRACE", &self.trace)
                .env("HSCPAPERS_FIXTURE_APP", &self.app);
        }

        fn parent(&self) -> std::process::Child {
            let mut parent = Command::new(&self.app);
            parent.arg("--parent").creation_flags(CREATE_NO_WINDOW);
            self.env(&mut parent);
            parent.spawn().unwrap()
        }

        fn launcher(&self, parent: u32) -> Command {
            let mut cmd = command(
                &self.installer,
                &self.app,
                parent,
                &self.ready,
                &self.log,
                false,
            )
            .unwrap();
            self.env(&mut cmd);
            cmd
        }

        fn trace(&self) -> String {
            fs::read_to_string(&self.trace).unwrap_or_default()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(self.directory.parent().unwrap());
        }
    }

    #[test]
    fn paths_and_unicode_survive_encoded_command() {
        let path = Path::new(r"C:\Users\Å & O'Brien 100% !\setup.exe");
        let text = script(path, path, 1234, path, path, false).unwrap();
        assert!(text.contains(r"'C:\Users\Å & O''Brien 100% !\setup.exe'"));
        let decoded = B64.decode(encoded_script(&text)).unwrap();
        let words: Vec<u16> = decoded
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        assert_eq!(String::from_utf16(&words).unwrap(), text);
        let cmd = command(path, path, 1234, path, path, false).unwrap();
        assert!(cmd
            .get_program()
            .to_string_lossy()
            .ends_with("powershell.exe"));
        assert_eq!(cmd.get_args().nth(5).unwrap(), "-EncodedCommand");
    }

    #[tokio::test]
    async fn actual_windows_handoff_waits_installs_and_relaunches_with_special_paths() {
        let fixture = Fixture::new();
        let mut parent = fixture.parent();
        spawn_ready(fixture.launcher(parent.id()), &fixture.ready, &fixture.log)
            .await
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !fixture.trace().contains("relaunch:") && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        parent.wait().unwrap();
        let trace = fixture.trace();
        assert!(
            trace.contains("installer:/S|/UPDATE"),
            "wrong installer arguments: {trace}"
        );
        assert!(
            trace.contains("replacement-ok"),
            "app executable was still locked or path was wrong: {trace}"
        );
        assert!(
            trace.contains("relaunch:"),
            "replacement did not relaunch: {trace}"
        );
        assert!(
            trace.find("parent-exit").unwrap() < trace.find("installer:").unwrap(),
            "installation ran before app exit: {trace}"
        );
        assert!(
            trace.find("replacement-ok").unwrap() < trace.find("relaunch:").unwrap(),
            "relaunch preceded installation: {trace}"
        );
    }

    #[test]
    fn failed_installer_does_not_relaunch_and_records_exit_code() {
        let fixture = Fixture::new();
        let mut parent = fixture.parent();
        let mut cmd = fixture.launcher(parent.id());
        cmd.env("HSCPAPERS_FIXTURE_EXIT", "7");
        let mut child = cmd.spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                panic!("failure-path launcher timed out");
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        parent.wait().unwrap();
        assert!(!status.success());
        assert!(fixture.trace().contains("installer:/S|/UPDATE"));
        assert!(!fixture.trace().contains("relaunch:"));
        assert!(fs::read_to_string(&fixture.log)
            .unwrap()
            .contains("Installer exit code: 7"));
    }
}
