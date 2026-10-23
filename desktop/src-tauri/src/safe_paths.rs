//! A remote catalogue/IPC string never chooses a path outside the library.
//! Windows directory handles deny rename/delete while an operation is active.
use std::{
    fs::{self, File, OpenOptions},
    io::{Seek, SeekFrom},
    path::{Path, PathBuf},
};

pub struct Destination {
    pub path: PathBuf,
    pub part: PathBuf,
    _parents: Vec<File>,
}

#[derive(Default)]
pub struct PickedFolder(std::sync::Mutex<Option<PathBuf>>);
impl PickedFolder {
    // Called only by the native folder-picker result, never an IPC command.
    pub fn select(&self, path: &Path) -> Result<(), String> {
        let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
        if !path.is_dir() {
            return Err("selected path is not a folder".into());
        }
        *self.0.lock().map_err(|_| "folder selection unavailable")? = Some(path);
        Ok(())
    }
    pub fn consume(&self, path: &Path) -> Result<PathBuf, String> {
        let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
        let mut picked = self.0.lock().map_err(|_| "folder selection unavailable")?;
        if picked.as_ref() != Some(&path) {
            return Err("choose this folder in the native dialog first".into());
        }
        Ok(picked.take().unwrap())
    }
}

fn reserved(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ')
        .to_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            let mut chars = suffix.chars();
            matches!(chars.next(), Some('1'..='9' | '¹' | '²' | '³')) && chars.next().is_none()
        })
    })
}

pub fn relative_pdf(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.encode_utf16().count() > 4096 {
        return Err("invalid library-relative path".into());
    }
    let mut path = PathBuf::new();
    for component in value.split(['/', '\\']) {
        if component.is_empty()
            || matches!(component, "." | "..")
            || component.ends_with(['.', ' '])
            || component.encode_utf16().count() > 255
            || reserved(component)
            || component
                .chars()
                .any(|c| c.is_control() || ":<>\"|?*".contains(c))
        {
            return Err("invalid library-relative path component".into());
        }
        path.push(component);
    }
    if path.is_absolute()
        || !path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
    {
        return Err("library files must be relative PDF paths".into());
    }
    Ok(path)
}

pub fn is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn directory(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::*;
        options
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|e| format!("open library directory: {e}"))?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_dir() || is_reparse(&metadata) {
        return Err("library child directories must not be reparse points".into());
    }
    Ok(file)
}

fn plain(file: &File) -> Result<(), String> {
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || is_reparse(&metadata) {
        return Err("library target is not a regular file".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::*;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if info.nNumberOfLinks > 1 {
            return Err("hard-linked library targets are not writable/readable through IPC".into());
        }
    }
    Ok(())
}

pub fn read_file(path: &Path) -> Result<File, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if is_reparse(&metadata) {
        return Err("library files must not be reparse points".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::*;
        options
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    plain(&file)?;
    Ok(file)
}

pub fn destination(root: &Path, relative: &str, create: bool) -> Result<Destination, String> {
    let rel = relative_pdf(relative)?; // validate BEFORE mkdir, metadata or network
    if create {
        fs::create_dir_all(root).map_err(|e| format!("create library: {e}"))?;
    }
    let canonical = fs::canonicalize(root).map_err(|e| format!("library unavailable: {e}"))?;
    let mut parents = vec![directory(&canonical)?];
    let mut current = canonical.clone();
    let components: Vec<_> = rel.iter().collect();
    for component in &components[..components.len() - 1] {
        current.push(component);
        if create && !current.exists() {
            fs::create_dir(&current).map_err(|e| format!("create library child: {e}"))?;
        }
        if is_reparse(&fs::symlink_metadata(&current).map_err(|e| e.to_string())?) {
            return Err("library directory reparse point rejected".into());
        }
        parents.push(directory(&current)?);
        if !fs::canonicalize(&current)
            .map_err(|e| e.to_string())?
            .starts_with(&canonical)
        {
            return Err("path escapes library".into());
        }
    }
    let path = current.join(components.last().unwrap());
    let part = path.with_extension("part");
    for target in [&path, &part] {
        match fs::symlink_metadata(target) {
            Ok(metadata) => {
                if !metadata.is_file() || is_reparse(&metadata) {
                    return Err("library target is not a plain file".into());
                }
                let _ = read_file(target)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(Destination {
        path,
        part,
        _parents: parents,
    })
}

pub fn open_part(path: &Path, offset: u64) -> Result<File, String> {
    if !path.extension().is_some_and(|s| s == "part") {
        return Err("invalid partial file".into());
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::*;
        options
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let mut file = options
        .open(path)
        .map_err(|e| format!("open partial file: {e}"))?;
    plain(&file)?; // no truncate/append until the handle itself is checked
    if offset == 0 {
        file.set_len(0).map_err(|e| e.to_string())?;
    } else if file.metadata().map_err(|e| e.to_string())?.len() != offset {
        return Err("partial file changed before resume".into());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    Ok(file)
}

pub fn finalize(part: &Path, destination: &Path) -> Result<(), String> {
    {
        let _ = read_file(part)?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let from: Vec<u16> = part.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(from.as_ptr(), to.as_ptr(), 0)
        } == 0
        {
            return Err(format!(
                "finalize without overwrite: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    #[cfg(not(windows))]
    {
        fs::hard_link(part, destination).map_err(|e| e.to_string())?;
        fs::remove_file(part).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn existing(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(root).map_err(|e| e.to_string())?;
    // Accept plain or verbatim Windows paths; derive components from canonical root.
    let full = fs::canonicalize(path).map_err(|e| e.to_string())?;
    let relative = full
        .strip_prefix(&canonical)
        .map_err(|_| "path is outside the library")?;
    let checked = destination(&canonical, &relative.to_string_lossy(), false)?;
    let _ = read_file(&checked.path)?;
    Ok(checked.path.clone())
}

pub fn reveal(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let target = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if target == canonical {
        return Ok(canonical);
    } // Library -> Open folder
    existing(&canonical, &target)
}

/// Explorer/configuration display must not receive Rust's verbatim path prefix.
/// Filesystem checks and held directory handles still use canonical paths.
pub fn presentation(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.as_os_str().to_string_lossy();
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn an_ipc_string_cannot_silently_reconfigure_the_library_or_import_root() {
        let chosen = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let picker = PickedFolder::default();
        assert!(picker.consume(chosen.path()).is_err());
        picker.select(chosen.path()).unwrap();
        assert!(picker.consume(other.path()).is_err());
        assert_eq!(
            picker.consume(chosen.path()).unwrap(),
            fs::canonicalize(chosen.path()).unwrap()
        );
        assert!(picker.consume(chosen.path()).is_err());
    }
    #[test]
    fn rejects_windows_traversal_and_ambiguous_names_before_creating_anything() {
        let root = tempfile::tempdir().unwrap();
        let absent = root.path().join("not-created");
        for bad in [
            "",
            "../evil.pdf",
            "Physics/../../evil.pdf",
            r"Physics\..\evil.pdf",
            "/abs.pdf",
            r"C:\evil.pdf",
            r"C:evil.pdf",
            r"\\server\share\evil.pdf",
            r"\\?\C:\evil.pdf",
            "Physics//x.pdf",
            "Physics/./x.pdf",
            "Physics./x.pdf",
            "Physics /x.pdf",
            "CON/x.pdf",
            "com¹.txt/x.pdf",
            "con .txt/x.pdf",
            "Physics/x.pdf:evil",
            "Physics/x.exe",
            "Physics/x.pdf.",
            "Physics/x.pdf ",
            "Physics/evil\0.pdf",
        ] {
            assert!(destination(&absent, bad, true).is_err(), "accepted {bad:?}");
            assert!(!absent.exists());
        }
    }
    #[test]
    fn unicode_resume_and_no_overwrite_preserve_existing_files() {
        let root = tempfile::tempdir().unwrap();
        let dest = destination(
            root.path(),
            "Maths (Accelerated)/2025/Å & O'Brien 100% !.pdf",
            true,
        )
        .unwrap();
        {
            let mut part = open_part(&dest.part, 0).unwrap();
            part.write_all(b"first").unwrap();
        }
        {
            let mut part = open_part(&dest.part, 5).unwrap();
            part.write_all(b" second").unwrap();
        }
        finalize(&dest.part, &dest.path).unwrap();
        assert_eq!(fs::read(&dest.path).unwrap(), b"first second");
        {
            let mut part = open_part(&dest.part, 0).unwrap();
            part.write_all(b"replacement").unwrap();
        }
        assert!(finalize(&dest.part, &dest.path).is_err());
        assert_eq!(fs::read(&dest.path).unwrap(), b"first second");
        assert_eq!(existing(root.path(), &dest.path).unwrap(), dest.path);
        assert_eq!(
            reveal(root.path(), root.path()).unwrap(),
            fs::canonicalize(root.path()).unwrap()
        );
    }
    #[cfg(windows)]
    #[test]
    fn shell_paths_preserve_unicode_and_unc_without_verbatim_prefixes() {
        assert_eq!(
            presentation(Path::new(r"\\?\C:\Users\Å & O'Brien\file.pdf")),
            PathBuf::from(r"C:\Users\Å & O'Brien\file.pdf")
        );
        assert_eq!(
            presentation(Path::new(r"\\?\UNC\server\share\file.pdf")),
            PathBuf::from(r"\\server\share\file.pdf")
        );
    }
    #[cfg(windows)]
    #[test]
    fn junction_and_hardlink_escape_cannot_create_or_truncate_outside_files() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let junction = root.path().join("junction");
        let status = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&junction)
            .arg(outside.path())
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "{}",
            String::from_utf8_lossy(&status.stderr)
        );
        assert!(destination(root.path(), "junction/evil.pdf", true).is_err());
        assert!(!outside.path().join("evil.pdf").exists());
        let victim = outside.path().join("victim.pdf");
        fs::write(&victim, b"preserve").unwrap();
        let target = root.path().join("hard.part");
        fs::hard_link(&victim, &target).unwrap();
        assert!(open_part(&target, 0).is_err());
        assert_eq!(fs::read(victim).unwrap(), b"preserve");
        fs::remove_dir(junction).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn guarded_parents_cannot_be_replaced_during_the_write() {
        let root = tempfile::tempdir().unwrap();
        let dest = destination(root.path(), "Physics/2025/file.pdf", true).unwrap();
        let parent = root.path().join("Physics");
        assert!(fs::rename(&parent, root.path().join("moved")).is_err());
        drop(dest);
        fs::rename(&parent, root.path().join("moved")).unwrap();
    }
}
