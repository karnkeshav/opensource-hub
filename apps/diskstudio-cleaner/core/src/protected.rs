use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtectedReason {
    InvalidPath(String),
    NetworkOrUnc(String),
    DriveRoot(String),
    WindowsSystemDir(String),
    ProgramFilesRoot(String),
    SystemCriticalFile(String),
    SystemCriticalDirectory(String),
    UserLibraryRoot(String),
    UserAppDataRoot(String),
    RelativePathNotAllowed(String),
}

impl std::fmt::Display for ProtectedReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProtectedReason::InvalidPath(p) => write!(f, "Invalid path or traversal attempt: {}", p),
            ProtectedReason::NetworkOrUnc(p) => {
                write!(f, "Network/UNC path is not allowed (fixed drives only): {}", p)
            }
            ProtectedReason::DriveRoot(p) => write!(f, "Cannot delete drive root: {}", p),
            ProtectedReason::WindowsSystemDir(p) => {
                write!(f, "Windows system directory is protected (S2): {}", p)
            }
            ProtectedReason::ProgramFilesRoot(p) => {
                write!(f, "Program Files root is protected (S2): {}", p)
            }
            ProtectedReason::SystemCriticalFile(p) => {
                write!(f, "System critical file is protected: {}", p)
            }
            ProtectedReason::SystemCriticalDirectory(p) => {
                write!(f, "System critical directory is protected: {}", p)
            }
            ProtectedReason::UserLibraryRoot(p) => {
                write!(f, "User library folder root is protected: {}", p)
            }
            ProtectedReason::UserAppDataRoot(p) => {
                write!(f, "User AppData root directory is protected: {}", p)
            }
            ProtectedReason::RelativePathNotAllowed(p) => {
                write!(f, "Relative path not allowed: {}", p)
            }
        }
    }
}

impl std::error::Error for ProtectedReason {}

/// Environment roots representing the system layout.
#[derive(Debug, Clone)]
pub struct EnvironmentRoots {
    pub system_drive: String,             // e.g. "C:"
    pub windir: PathBuf,                   // e.g. "C:\Windows"
    pub program_files: PathBuf,            // e.g. "C:\Program Files"
    pub program_files_x86: PathBuf,        // e.g. "C:\Program Files (x86)"
    pub program_data: PathBuf,             // e.g. "C:\ProgramData"
    pub user_profile: PathBuf,             // e.g. "C:\Users\CurrentUser"
    pub documents: PathBuf,                // e.g. "C:\Users\CurrentUser\Documents"
    pub desktop: PathBuf,                  // e.g. "C:\Users\CurrentUser\Desktop"
    pub pictures: PathBuf,                 // e.g. "C:\Users\CurrentUser\Pictures"
    pub videos: PathBuf,                   // e.g. "C:\Users\CurrentUser\Videos"
    pub music: PathBuf,                    // e.g. "C:\Users\CurrentUser\Music"
    pub downloads: PathBuf,                // e.g. "C:\Users\CurrentUser\Downloads"
    pub onedrive: Option<PathBuf>,         // e.g. "C:\Users\CurrentUser\OneDrive"
    pub dropbox: Option<PathBuf>,          // e.g. "C:\Users\CurrentUser\Dropbox"
    pub google_drive: Option<PathBuf>,     // e.g. "C:\Users\CurrentUser\Google Drive"
}

impl EnvironmentRoots {
    pub fn macos_default(home: &Path) -> Self {
        let user_path = home.to_path_buf();
        Self {
            system_drive: "/".into(),
            windir: PathBuf::from("/System"),
            program_files: PathBuf::from("/Applications"),
            program_files_x86: PathBuf::from("/System/Applications"),
            program_data: PathBuf::from("/Library"),
            user_profile: user_path.clone(),
            documents: user_path.join("Documents"),
            desktop: user_path.join("Desktop"),
            pictures: user_path.join("Pictures"),
            videos: user_path.join("Movies"),
            music: user_path.join("Music"),
            downloads: user_path.join("Downloads"),
            onedrive: Some(user_path.join("Library/CloudStorage/OneDrive")),
            dropbox: Some(user_path.join("Library/CloudStorage/Dropbox")),
            google_drive: Some(user_path.join("Library/CloudStorage/GoogleDrive")),
        }
    }
}

impl Default for EnvironmentRoots {
    fn default() -> Self {
        #[cfg(windows)]
        {
            let sys_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
            let windir = std::env::var("SystemRoot")
                .or_else(|_| std::env::var("WINDIR"))
                .unwrap_or_else(|_| format!("{}\\Windows", sys_drive));
            let pf = std::env::var("ProgramFiles")
                .unwrap_or_else(|_| format!("{}\\Program Files", sys_drive));
            let pf86 = std::env::var("ProgramFiles(x86)")
                .unwrap_or_else(|_| format!("{}\\Program Files (x86)", sys_drive));
            let pd = std::env::var("ProgramData")
                .unwrap_or_else(|_| format!("{}\\ProgramData", sys_drive));
            let user = std::env::var("USERPROFILE")
                .unwrap_or_else(|_| format!("{}\\Users\\Default", sys_drive));

            let user_path = PathBuf::from(&user);
            let onedrive = std::env::var("OneDrive").ok().map(PathBuf::from);

            Self {
                system_drive: sys_drive,
                windir: PathBuf::from(windir),
                program_files: PathBuf::from(pf),
                program_files_x86: PathBuf::from(pf86),
                program_data: PathBuf::from(pd),
                user_profile: user_path.clone(),
                documents: user_path.join("Documents"),
                desktop: user_path.join("Desktop"),
                pictures: user_path.join("Pictures"),
                videos: user_path.join("Videos"),
                music: user_path.join("Music"),
                downloads: user_path.join("Downloads"),
                onedrive,
                dropbox: Some(user_path.join("Dropbox")),
                google_drive: Some(user_path.join("Google Drive")),
            }
        }

        #[cfg(not(windows))]
        {
            let sys_drive = "C:".to_string();
            let user_path = PathBuf::from("C:\\Users\\Default");
            Self {
                system_drive: sys_drive,
                windir: PathBuf::from("C:\\Windows"),
                program_files: PathBuf::from("C:\\Program Files"),
                program_files_x86: PathBuf::from("C:\\Program Files (x86)"),
                program_data: PathBuf::from("C:\\ProgramData"),
                user_profile: user_path.clone(),
                documents: user_path.join("Documents"),
                desktop: user_path.join("Desktop"),
                pictures: user_path.join("Pictures"),
                videos: user_path.join("Videos"),
                music: user_path.join("Music"),
                downloads: user_path.join("Downloads"),
                onedrive: Some(user_path.join("OneDrive")),
                dropbox: Some(user_path.join("Dropbox")),
                google_drive: Some(user_path.join("Google Drive")),
            }
        }
    }
}

/// Normalizes a path string strictly for safety evaluation:
/// - Strips `\\?\` and `\\.\` extended prefixes
/// - Normalizes all slashes to `\`
/// - Strips trailing dots and spaces from every component
/// - Resolves relative segments (`.` and `..`); rejects escaping `..`
/// - Expands 8.3 short names (e.g. `PROGRA~1` -> `Program Files`)
pub fn normalize_for_safety(raw: &Path) -> Result<String, ProtectedReason> {
    let mut s = raw.to_string_lossy().to_string();

    // Check for network / UNC path
    if s.starts_with(r"\\") || s.starts_with("//") {
        if s.starts_with(r"\\?\UNC\") || s.starts_with(r"//?/UNC/") {
            return Err(ProtectedReason::NetworkOrUnc(s));
        }
        if s.starts_with(r"\\?\") || s.starts_with(r"\\.\") {
            s = s[4..].to_string();
        } else {
            return Err(ProtectedReason::NetworkOrUnc(s));
        }
    }

    // Convert forward slashes to backslashes
    let s = s.replace('/', "\\");

    // Must have a drive letter (e.g. "C:\...") or be rooted
    let parts: Vec<&str> = s.split('\\').collect();
    if parts.is_empty() {
        return Err(ProtectedReason::InvalidPath("Empty path".into()));
    }

    let mut normalized_parts: Vec<String> = Vec::new();

    // Check drive prefix
    let first = parts[0];
    if first.len() == 2 && first.ends_with(':') && first.chars().next().unwrap().is_ascii_alphabetic() {
        normalized_parts.push(first.to_ascii_uppercase());
    } else if cfg!(not(windows)) && (raw.is_absolute() || raw.to_string_lossy().starts_with('/')) {
        // Support POSIX absolute paths for test sandbox on Linux
        normalized_parts.push("/".to_string());
    } else {
        return Err(ProtectedReason::RelativePathNotAllowed(s));
    }

    for part in parts.iter().skip(1) {
        if part.is_empty() {
            continue;
        }

        // Handle exact directory traversals first
        if *part == "." {
            continue;
        } else if *part == ".." {
            if normalized_parts.len() <= 1 {
                return Err(ProtectedReason::InvalidPath(
                    "Path attempts to traverse above root with ..".into(),
                ));
            }
            normalized_parts.pop();
            continue;
        }

        // Clean trailing dots and spaces from folder names (e.g. "Windows .." or "System32... ")
        let trimmed = part.trim_end_matches(['.', ' ']);
        if trimmed.is_empty() {
            // Trailing dots trick with only dots/spaces (e.g. "...")
            return Err(ProtectedReason::InvalidPath(format!("Invalid path segment: '{}'", part)));
        }

        if trimmed == "." {
            continue;
        } else if trimmed == ".." {
            if normalized_parts.len() <= 1 {
                return Err(ProtectedReason::InvalidPath(
                    "Path attempts to traverse above root with ..".into(),
                ));
            }
            normalized_parts.pop();
        } else {
            // Expand standard Windows 8.3 short name patterns
            let upper = trimmed.to_ascii_uppercase();
            let expanded = match upper.as_str() {
                "PROGRA~1" => "Program Files".to_string(),
                "PROGRA~2" => "Program Files (x86)".to_string(),
                "WINDOW~1" => "Windows".to_string(),
                "DOCUME~1" => "Documents".to_string(),
                "LOCALS~1" => "Local Settings".to_string(),
                "APPDAT~1" => "AppData".to_string(),
                _ => trimmed.to_string(),
            };
            normalized_parts.push(expanded);
        }
    }

    if normalized_parts.len() == 1 {
        // Drive root: "C:\" or "/"
        if normalized_parts[0] == "/" {
            return Ok("/".to_string());
        }
        return Ok(format!("{}\\", normalized_parts[0]));
    }

    if normalized_parts[0] == "/" {
        Ok(format!("/{}", normalized_parts[1..].join("/")))
    } else {
        Ok(normalized_parts.join("\\"))
    }
}

/// Checks whether a target path is strictly protected under invariant S2.
/// Returns `Ok(())` if safe, or `Err(ProtectedReason)` if protected.
pub fn check_protected_path(path: &Path, env: &EnvironmentRoots) -> Result<(), ProtectedReason> {
    let norm = normalize_for_safety(path)?;

    // 0. macOS SIP and System Protection Rules
    if norm.starts_with('/') {
        if norm == "/" {
            return Err(ProtectedReason::DriveRoot(norm));
        }

        // Allow system temporary subpaths under /tmp and /private/tmp
        if norm == "/private/tmp" || norm.starts_with("/private/tmp/") || norm == "/tmp" || norm.starts_with("/tmp/") {
            return Ok(());
        }

        let macos_system_dirs = [
            "/System",
            "/bin",
            "/sbin",
            "/etc",
            "/var",
            "/Library/Apple",
            "/Library/SystemExtensions",
            "/System/Volumes",
        ];
        for sd in macos_system_dirs {
            if norm == sd || norm.starts_with(&format!("{}/", sd)) {
                return Err(ProtectedReason::SystemCriticalDirectory(norm));
            }
        }

        if norm.starts_with("/private") && !norm.starts_with("/private/tmp") {
            return Err(ProtectedReason::SystemCriticalDirectory(norm));
        }

        if norm.starts_with("/usr") && !norm.starts_with("/usr/local") {
            return Err(ProtectedReason::SystemCriticalDirectory(norm));
        }

        if norm == "/Applications" || norm == "/System/Applications" {
            return Err(ProtectedReason::ProgramFilesRoot(norm));
        }

        // User library protected containers
        let norm_upper = norm.to_ascii_uppercase();
        let user_prof_upper = env.user_profile.to_string_lossy().to_ascii_uppercase();

        if norm_upper == user_prof_upper {
            return Err(ProtectedReason::DriveRoot(norm));
        }

        let user_lib = format!("{}/LIBRARY", user_prof_upper);
        if norm_upper == user_lib {
            return Err(ProtectedReason::UserAppDataRoot(norm));
        }

        let sensitive_user_subpaths = [
            "/KEYCHAINS",
            "/MAIL",
            "/MESSAGES",
            "/SAFARI",
            "/ACCOUNTS",
            "/MOBILE DOCUMENTS",
            "/CLOUDSTORAGE",
        ];
        for sp in sensitive_user_subpaths {
            let prefix = format!("{}{}", user_lib, sp);
            if norm_upper == prefix || norm_upper.starts_with(&format!("{}/", prefix)) {
                return Err(ProtectedReason::UserAppDataRoot(norm));
            }
        }

        let user_roots = [
            &env.documents,
            &env.desktop,
            &env.pictures,
            &env.videos,
            &env.music,
        ];
        for r in user_roots {
            let r_str = r.to_string_lossy();
            if norm == r_str {
                return Err(ProtectedReason::UserLibraryRoot(norm));
            }
        }

        return Ok(());
    }

    let norm_upper = norm.to_ascii_uppercase();

    // 1. Refuse Drive Roots (e.g. "C:\" or "/")
    if norm_upper == "/" || (norm_upper.len() <= 3 && (norm_upper.ends_with('\\') || norm_upper.ends_with('/'))) {
        return Err(ProtectedReason::DriveRoot(norm));
    }

    // 2. Refuse System Critical Root Files (e.g. C:\pagefile.sys)
    let file_name = norm
        .rsplit('\\')
        .next()
        .map(|f| f.to_ascii_uppercase())
        .unwrap_or_default();

    let protected_files = [
        "PAGEFILE.SYS",
        "SWAPFILE.SYS",
        "HIBERFIL.SYS",
        "BOOTMGR",
        "BOOTNXT",
        "DUMPSTACK.LOG",
    ];
    for pf in protected_files {
        if file_name == pf {
            return Err(ProtectedReason::SystemCriticalFile(norm));
        }
    }

    if file_name.starts_with("NTUSER.DAT") || file_name.starts_with("USRCLASS.DAT") {
        return Err(ProtectedReason::SystemCriticalFile(norm));
    }

    // 3. System critical folders
    let protected_sys_dirs = [
        "BOOT",
        "EFI",
        "RECOVERY",
        "SYSTEM VOLUME INFORMATION",
        "$RECYCLE.BIN",
    ];
    for sd in protected_sys_dirs {
        let prefix = format!("{}\\{}", env.system_drive.to_ascii_uppercase(), sd);
        if norm_upper == prefix || norm_upper.starts_with(&format!("{}\\", prefix)) {
            return Err(ProtectedReason::SystemCriticalDirectory(norm));
        }
    }

    // 4. Windows Root & Subpaths Allowlist
    let windir_norm = normalize_for_safety(&env.windir)
        .unwrap_or_else(|_| "C:\\WINDOWS".into())
        .to_ascii_uppercase();

    if norm_upper == windir_norm {
        return Err(ProtectedReason::WindowsSystemDir(norm));
    }

    if norm_upper.starts_with(&format!("{}\\", windir_norm)) {
        // Under Windows directory: only allow explicit safe subpaths
        let rel = &norm_upper[windir_norm.len() + 1..];

        // Explicit allowlist:
        // - TEMP
        // - SOFTWAREDISTRIBUTION\DOWNLOAD
        // - LOGS
        // - MINIDUMP
        let is_allowed = rel == "TEMP"
            || rel.starts_with("TEMP\\")
            || rel == "SOFTWAREDISTRIBUTION\\DOWNLOAD"
            || rel.starts_with("SOFTWAREDISTRIBUTION\\DOWNLOAD\\")
            || rel == "LOGS"
            || rel.starts_with("LOGS\\")
            || rel == "MINIDUMP"
            || rel.starts_with("MINIDUMP\\");

        if !is_allowed {
            return Err(ProtectedReason::WindowsSystemDir(norm));
        }
    }

    // 5. Program Files & Program Files (x86) Roots
    let pf_norm = normalize_for_safety(&env.program_files)
        .unwrap_or_else(|_| "C:\\PROGRAM FILES".into())
        .to_ascii_uppercase();
    let pf86_norm = normalize_for_safety(&env.program_files_x86)
        .unwrap_or_else(|_| "C:\\PROGRAM FILES (X86)".into())
        .to_ascii_uppercase();

    if norm_upper == pf_norm || norm_upper == pf86_norm {
        return Err(ProtectedReason::ProgramFilesRoot(norm));
    }

    // 6. ProgramData\Microsoft
    let pd_norm = normalize_for_safety(&env.program_data)
        .unwrap_or_else(|_| "C:\\PROGRAMDATA".into())
        .to_ascii_uppercase();
    let pd_ms = format!("{}\\MICROSOFT", pd_norm);
    if norm_upper == pd_ms || norm_upper.starts_with(&format!("{}\\", pd_ms)) {
        return Err(ProtectedReason::SystemCriticalDirectory(norm));
    }

    // 7. Users\<any>\AppData as a whole folder root
    // e.g. C:\Users\Alice\AppData or C:\Users\Alice\AppData\Local
    // Individual cache subpaths (e.g. C:\Users\Alice\AppData\Local\Temp or Google\Chrome\User Data\...\Cache) are allowed,
    // but the AppData root itself or its immediate Local/Roaming/LocalLow containers cannot be deleted as a whole!
    let parts_upper: Vec<&str> = norm_upper.split('\\').collect();
    if parts_upper.len() >= 4 && parts_upper[1] == "USERS" {
        // parts: ["C:", "USERS", "<USER>", "APPDATA" or "LOCAL SETTINGS"]
        if parts_upper.len() == 4
            && (parts_upper[3] == "APPDATA" || parts_upper[3] == "LOCAL SETTINGS")
        {
            return Err(ProtectedReason::UserAppDataRoot(norm));
        }
        if parts_upper.len() == 5
            && (parts_upper[3] == "APPDATA" || parts_upper[3] == "LOCAL SETTINGS")
            && (parts_upper[4] == "LOCAL"
                || parts_upper[4] == "ROAMING"
                || parts_upper[4] == "LOCALLOW")
        {
            return Err(ProtectedReason::UserAppDataRoot(norm));
        }
    }

    // 8. User Library Roots as Folders (Documents, Desktop, Pictures, Videos, Music, OneDrive, Dropbox, Google Drive)
    let user_roots = [
        &env.documents,
        &env.desktop,
        &env.pictures,
        &env.videos,
        &env.music,
    ];

    for r in user_roots {
        if let Ok(r_norm) = normalize_for_safety(r) {
            if norm_upper == r_norm.to_ascii_uppercase() {
                return Err(ProtectedReason::UserLibraryRoot(norm));
            }
        }
    }

    if let Some(od) = &env.onedrive {
        if let Ok(r_norm) = normalize_for_safety(od) {
            if norm_upper == r_norm.to_ascii_uppercase() {
                return Err(ProtectedReason::UserLibraryRoot(norm));
            }
        }
    }

    if let Some(db) = &env.dropbox {
        if let Ok(r_norm) = normalize_for_safety(db) {
            if norm_upper == r_norm.to_ascii_uppercase() {
                return Err(ProtectedReason::UserLibraryRoot(norm));
            }
        }
    }

    if let Some(gd) = &env.google_drive {
        if let Ok(r_norm) = normalize_for_safety(gd) {
            if norm_upper == r_norm.to_ascii_uppercase() {
                return Err(ProtectedReason::UserLibraryRoot(norm));
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn test_table_driven_100_plus_protected_cases() {
        let env = EnvironmentRoots::default();

        // 100+ cases covering Windows, System32, WinSxS, pagefile, short names,
        // reparse escapes, trailing spaces/dots, UNC, drive roots, and user libraries.
        let cases_to_refuse = [
            // Drive roots
            "C:\\",
            "C:",
            "D:\\",
            "D:",
            "Z:\\",
            // Windows root & core critical system directories
            "C:\\Windows",
            "C:\\windows",
            "C:\\WINDOWS",
            "c:\\Windows\\",
            "C:\\Windows\\System32",
            "C:\\Windows\\System32\\calc.exe",
            "C:\\Windows\\System32\\drivers",
            "C:\\Windows\\System32\\config",
            "C:\\Windows\\SysWOW64",
            "C:\\Windows\\WinSxS",
            "C:\\Windows\\explorer.exe",
            "C:\\Windows\\regedit.exe",
            "C:\\Windows\\notepad.exe",
            "C:\\Windows\\Prefetch",
            "C:\\Windows\\Prefetch\\something.pf",
            "C:\\Windows\\Fonts",
            "C:\\Windows\\Boot",
            "C:\\Windows\\Globalization",
            "C:\\Windows\\Help",
            "C:\\Windows\\IME",
            "C:\\Windows\\Inf",
            "C:\\Windows\\Media",
            "C:\\Windows\\Resources",
            "C:\\Windows\\schemas",
            // Trailing dots and spaces tricks
            "C:\\Windows .",
            "C:\\Windows... ",
            "C:\\Windows\\System32... ",
            "C:\\Windows \\System32 ",
            "C:\\Windows\\Prefetch .",
            // 8.3 Short name bypass attempts
            "C:\\WINDOW~1",
            "C:\\WINDOW~1\\System32",
            "C:\\WINDOW~1\\Prefetch",
            "C:\\PROGRA~1",
            "C:\\PROGRA~2",
            // Extended prefix \\?\ bypass attempts
            "\\\\?\\C:\\Windows",
            "\\\\?\\C:\\Windows\\System32",
            "\\\\?\\C:\\Windows\\Prefetch",
            "\\\\?\\C:\\pagefile.sys",
            "\\\\?\\C:\\Program Files",
            "\\\\?\\C:\\Program Files (x86)",
            // Traversal .. bypass attempts
            "C:\\Windows\\Temp\\..\\System32",
            "C:\\Windows\\Temp\\..\\..\\Windows\\System32",
            "C:\\Windows\\Temp\\..\\WinSxS",
            "C:\\Windows\\Logs\\..\\explorer.exe",
            "C:\\Users\\Default\\AppData\\Local\\Temp\\..\\..\\..\\..\\..\\Windows\\System32",
            "C:\\Users\\Default\\..\\..\\pagefile.sys",
            // Forward slashes
            "C:/Windows",
            "C:/Windows/System32",
            "C:/Windows/Prefetch",
            "C:/pagefile.sys",
            "C:/Program Files",
            // UNC / Network shares
            "\\\\server\\share\\file.txt",
            "\\\\192.168.1.1\\c$\\Windows",
            "//server/share/file.txt",
            "\\\\?\\UNC\\server\\share\\data",
            // Critical system files
            "C:\\pagefile.sys",
            "c:\\pagefile.sys",
            "C:\\PAGEFILE.SYS",
            "C:\\swapfile.sys",
            "C:\\hiberfil.sys",
            "C:\\bootmgr",
            "C:\\BOOTNXT",
            "C:\\dumpstack.log",
            "C:\\Users\\Default\\NTUSER.DAT",
            "C:\\Users\\Default\\ntuser.dat.LOG1",
            "C:\\Users\\Default\\AppData\\Local\\Microsoft\\Windows\\UsrClass.dat",
            "C:\\Users\\Default\\AppData\\Local\\Microsoft\\Windows\\UsrClass.dat.LOG1",
            // Critical system directories
            "C:\\$Recycle.Bin",
            "C:\\$Recycle.Bin\\S-1-5-21",
            "C:\\System Volume Information",
            "C:\\System Volume Information\\tracking.log",
            "C:\\Boot",
            "C:\\Boot\\BCD",
            "C:\\EFI",
            "C:\\EFI\\Microsoft",
            "C:\\Recovery",
            "C:\\Recovery\\WindowsRE",
            // ProgramData Microsoft
            "C:\\ProgramData\\Microsoft",
            "C:\\ProgramData\\Microsoft\\Windows",
            "C:\\ProgramData\\Microsoft\\Windows Defender",
            "C:\\ProgramData\\Microsoft\\Crypto",
            // AppData roots as whole containers
            "C:\\Users\\Default\\AppData",
            "C:\\Users\\Default\\AppData\\Local",
            "C:\\Users\\Default\\AppData\\Roaming",
            "C:\\Users\\Default\\AppData\\LocalLow",
            "C:\\Users\\Alice\\AppData",
            "C:\\Users\\Alice\\AppData\\Local",
            "C:\\Users\\Bob\\AppData\\Roaming",
            "C:\\Users\\Default\\LOCALS~1",
            "C:\\Users\\Default\\APPDAT~1",
            // User Library roots
            "C:\\Users\\Default\\Documents",
            "C:\\Users\\Default\\Desktop",
            "C:\\Users\\Default\\Pictures",
            "C:\\Users\\Default\\Videos",
            "C:\\Users\\Default\\Music",
            "C:\\Users\\Default\\OneDrive",
            "C:\\Users\\Default\\Dropbox",
            "C:\\Users\\Default\\Google Drive",
            "C:\\Users\\Default\\DOCUME~1",
            // Relative paths (refused)
            "Windows\\System32",
            ".\\Windows",
            "..\\Windows",
            "pagefile.sys",
            "Documents",
            "AppData\\Local",
            // Extra variations to exceed 100 cases
            "C:\\Windows\\System32\\cmd.exe",
            "C:\\Windows\\System32\\windowspowershell",
            "C:\\Windows\\SysWOW64\\cmd.exe",
            "C:\\Windows\\WinSxS\\manifests",
            "C:\\Windows\\servicing",
            "C:\\Windows\\SystemResources",
            "C:\\Windows\\Web",
            "C:\\Windows\\assembly",
            "C:\\Windows\\WinSxS\\temp",
        ];

        assert!(cases_to_refuse.len() >= 100, "Must have at least 100 test cases, got {}", cases_to_refuse.len());

        for case in cases_to_refuse {
            let res = check_protected_path(Path::new(case), &env);
            assert!(
                res.is_err(),
                "Expected protected path to be refused, but was accepted: {}",
                case
            );
        }
    }

    #[test]
    fn test_macos_protected_cases() {
        let env = EnvironmentRoots::macos_default(Path::new("/Users/Alice"));

        let macos_cases_to_refuse = [
            "/",
            "/System",
            "/System/Library",
            "/System/Library/CoreServices",
            "/bin",
            "/bin/sh",
            "/sbin",
            "/sbin/launchd",
            "/usr",
            "/usr/bin",
            "/usr/bin/tar",
            "/usr/sbin",
            "/private",
            "/private/var",
            "/etc",
            "/var",
            "/Library/Apple",
            "/Library/SystemExtensions",
            "/Applications",
            "/System/Applications",
            "/Users/Alice",
            "/Users/Alice/Library",
            "/Users/Alice/Library/Keychains",
            "/Users/Alice/Library/Keychains/login.keychain-db",
            "/Users/Alice/Library/Mail",
            "/Users/Alice/Library/Messages",
            "/Users/Alice/Library/Safari",
            "/Users/Alice/Library/Safari/Bookmarks.plist",
            "/Users/Alice/Library/Accounts",
            "/Users/Alice/Library/Mobile Documents",
            "/Users/Alice/Library/CloudStorage",
            "/Users/Alice/Desktop",
            "/Users/Alice/Documents",
            "/Users/Alice/Pictures",
            "/Users/Alice/Movies",
            "/Users/Alice/Music",
        ];

        for case in macos_cases_to_refuse {
            let res = check_protected_path(Path::new(case), &env);
            assert!(
                res.is_err(),
                "Expected macOS protected path to be refused, but was accepted: {}",
                case
            );
        }

        let macos_allowed = [
            "/tmp/app_123.tmp",
            "/private/tmp/cache.bin",
            "/Users/Alice/Library/Caches/Google/Chrome/Cache/f_001",
            "/Users/Alice/Library/Developer/Xcode/DerivedData/Project123",
            "/Users/Alice/Downloads/installer.dmg",
            "/Users/Alice/.Trash/old_file.txt",
        ];

        for case in macos_allowed {
            let res = check_protected_path(Path::new(case), &env);
            assert!(
                res.is_ok(),
                "Expected safe macOS subpath to be allowed, but was rejected: {} (err: {:?})",
                case,
                res.err()
            );
        }
    }

    #[test]
    fn test_allowed_safe_subpaths_accepted() {
        let env = EnvironmentRoots::default();

        let allowed_cases = [
            "C:\\Windows\\Temp\\junk.tmp",
            "C:\\Windows\\Temp\\sub\\file.txt",
            "C:\\Windows\\SoftwareDistribution\\Download\\some_update_hash",
            "C:\\Windows\\Logs\\CBS\\CBS.log",
            "C:\\Windows\\Minidump\\dump.dmp",
            "C:\\Users\\Default\\AppData\\Local\\Temp\\test.tmp",
            "C:\\Users\\Default\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache\\Cache_Data\\f_001",
            "C:\\Users\\Default\\Downloads\\old_installer.exe",
        ];

        for case in allowed_cases {
            let res = check_protected_path(Path::new(case), &env);
            assert!(
                res.is_ok(),
                "Expected safe subpath to be allowed, but was rejected: {} (err: {:?})",
                case,
                res.err()
            );
        }
    }

    proptest! {
        #[test]
        fn prop_no_crash_on_random_paths(s in "\\PC*") {
            let env = EnvironmentRoots::default();
            // Should never panic or crash
            let _ = check_protected_path(Path::new(&s), &env);
        }

        #[test]
        fn prop_system32_is_always_protected(subpath in "[a-zA-Z0-9_.-]{1,30}") {
            let env = EnvironmentRoots::default();
            let p = format!("C:\\Windows\\System32\\{}", subpath);
            let res = check_protected_path(Path::new(&p), &env);
            prop_assert!(res.is_err());
        }
    }
}
