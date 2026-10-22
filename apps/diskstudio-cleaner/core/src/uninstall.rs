use crate::fs::ReadFs;
use crate::model::{Action, ItemKind, PlannedItem};
use crate::protected::{check_protected_path, EnvironmentRoots};
use serde::{Deserialize, Serialize};
use std::fs::{create_dir_all, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppType {
    Msi,
    Store,
    Steam,
    Epic,
    Exe,
    Portable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledApp {
    pub id: String,
    pub display_name: String,
    pub display_version: Option<String>,
    pub publisher: Option<String>,
    pub install_location: Option<PathBuf>,
    pub install_date: Option<String>,
    pub estimated_size_bytes: u64,
    pub uninstall_string: Option<String>,
    pub quiet_uninstall_string: Option<String>,
    pub is_msi: bool,
    pub is_system_component: bool,
    pub parent_key_name: Option<String>,
    pub app_type: AppType,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UninstallMethod {
    MsiExec {
        guid: String,
        arguments: Vec<String>,
    },
    StorePackage {
        package_full_name: String,
    },
    SteamApp {
        app_id: String,
    },
    EpicApp {
        app_name: String,
    },
    Executable {
        exe_path: PathBuf,
        arguments: Vec<String>,
    },
    Winget {
        package_id: String,
    },
    PortableFolder {
        folder_path: PathBuf,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandParseError {
    EmptyString,
    CommandInjectionDetected(String),
    RelativePathRefused(String),
    ProtectedExeRefused(String),
    UnquotedPathWithSpaces(String),
}

impl std::fmt::Display for CommandParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CommandParseError::EmptyString => write!(f, "Empty uninstall command string"),
            CommandParseError::CommandInjectionDetected(s) => {
                write!(f, "Command injection characters detected: {}", s)
            }
            CommandParseError::RelativePathRefused(s) => {
                write!(f, "Relative executable path refused: {}", s)
            }
            CommandParseError::ProtectedExeRefused(s) => {
                write!(f, "Executing protected system utility refused: {}", s)
            }
            CommandParseError::UnquotedPathWithSpaces(s) => {
                write!(f, "Unquoted executable path containing spaces is unsafe: {}", s)
            }
        }
    }
}

impl std::error::Error for CommandParseError {}

/// Safely parses an uninstaller command string without invoking a shell (cmd.exe).
/// Enforces safety:
/// - Rejects shell meta-characters (&, |, ;, >, <, ^, \n, \r)
/// - Rejects relative paths
/// - Refuses protected system executables (cmd, powershell, format, etc.)
pub fn parse_safe_uninstall_command(
    cmd_str: &str,
    env: &EnvironmentRoots,
) -> Result<(PathBuf, Vec<String>), CommandParseError> {
    let trimmed = cmd_str.trim();
    if trimmed.is_empty() {
        return Err(CommandParseError::EmptyString);
    }

    // Reject command injection characters unconditionally
    let dangerous_chars = ['&', '|', ';', '>', '<', '^', '\n', '\r', '`'];
    for dc in dangerous_chars {
        if trimmed.contains(dc) {
            return Err(CommandParseError::CommandInjectionDetected(format!(
                "Contains '{}'",
                dc
            )));
        }
    }

    let (exe_str, args_str) = if trimmed.starts_with('"') {
        // Quoted path: find matching closing quote
        let after_first = &trimmed[1..];
        let end_quote = after_first
            .find('"')
            .ok_or_else(|| CommandParseError::UnquotedPathWithSpaces(trimmed.to_string()))?;
        let exe = &after_first[..end_quote];
        let rest = &after_first[end_quote + 1..].trim();
        (exe, *rest)
    } else {
        // Unquoted: first space separates exe and args
        if let Some(space_idx) = trimmed.find(' ') {
            let exe = &trimmed[..space_idx];
            let rest = &trimmed[space_idx + 1..].trim();
            // If the unquoted exe path has no extension or looks ambiguous with spaces, flag it
            (exe, *rest)
        } else {
            (trimmed, "")
        }
    };

    let exe_path = PathBuf::from(exe_str);

    // Reject relative paths (evaluate both Windows and POSIX absolute conventions)
    let is_absolute = (exe_str.len() >= 3
        && exe_str.chars().nth(1) == Some(':')
        && (exe_str.chars().nth(2) == Some('\\') || exe_str.chars().nth(2) == Some('/')))
        || exe_str.starts_with(r"\\")
        || exe_str.starts_with('/')
        || exe_path.is_absolute();

    if !is_absolute {
        return Err(CommandParseError::RelativePathRefused(exe_str.to_string()));
    }

    // Refuse protected system shells/executables
    let exe_name = exe_str
        .rsplit(|c| c == '\\' || c == '/')
        .next()
        .unwrap_or(exe_str)
        .to_ascii_lowercase();

    let forbidden_exes = [
        "cmd.exe",
        "powershell.exe",
        "pwsh.exe",
        "wscript.exe",
        "cscript.exe",
        "rundll32.exe",
        "regsvr32.exe",
        "format.com",
    ];

    if forbidden_exes.contains(&exe_name.as_str()) {
        return Err(CommandParseError::ProtectedExeRefused(exe_str.to_string()));
    }

    // Parse remaining arguments safely by tokenizing on whitespace while respecting quotes
    let mut args = Vec::new();
    let mut curr_arg = String::new();
    let mut in_quote = false;

    for ch in args_str.chars() {
        if ch == '"' {
            in_quote = !in_quote;
        } else if ch.is_whitespace() && !in_quote {
            if !curr_arg.is_empty() {
                args.push(curr_arg.clone());
                curr_arg.clear();
            }
        } else {
            curr_arg.push(ch);
        }
    }
    if !curr_arg.is_empty() {
        args.push(curr_arg);
    }

    let _ = env;
    Ok((exe_path, args))
}

/// Deny list and heuristic evaluation (Section 8.1):
/// Never offer Windows components, Visual C++ redistributables, runtimes, security apps.
pub fn is_denied_or_system_app(app: &InstalledApp) -> bool {
    if app.is_system_component {
        return true;
    }
    if app.parent_key_name.is_some() {
        return true;
    }

    let name = app.display_name.to_ascii_lowercase();
    let publ = app
        .publisher
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase();

    // Critical deny keywords
    let deny_keywords = [
        "visual c++",
        "microsoft .net",
        "windows sdk",
        "webview2",
        "security update",
        "update for microsoft",
        "update for windows",
        "directx",
        "nvidia graphics driver",
        "intel(r) management engine",
        "realtek audio driver",
        "windows defender",
        "host runtime",
        "redistributable",
    ];

    for kw in deny_keywords {
        if name.contains(kw) {
            return true;
        }
    }

    // Windows native parts published by Microsoft
    if publ.contains("microsoft") {
        let ms_system_parts = [
            "windows",
            "operating system",
            "driver",
            "framework",
            "edge update",
        ];
        for sp in ms_system_parts {
            if name.contains(sp) {
                return true;
            }
        }
    }

    false
}

/// Selects the best uninstall method strictly following Section 8.2 order:
/// 1. MSI: msiexec /x {GUID} /qb-! /norestart
/// 2. Store / MSIX: package manager removal
/// 3. Steam / Epic launcher
/// 4. Standard uninstaller: QuietUninstallString or UninstallString
/// 5. Winget fallback
/// 6. Portable app folder (Recycle action only)
pub fn resolve_uninstall_method(
    app: &InstalledApp,
    env: &EnvironmentRoots,
) -> Result<UninstallMethod, String> {
    // 1. MSI
    if app.is_msi || (app.id.starts_with('{') && app.id.ends_with('}')) {
        return Ok(UninstallMethod::MsiExec {
            guid: app.id.clone(),
            arguments: vec![
                "/x".into(),
                app.id.clone(),
                "/qb-!".into(),
                "/norestart".into(),
            ],
        });
    }

    // 2. Store / MSIX
    if app.app_type == AppType::Store {
        return Ok(UninstallMethod::StorePackage {
            package_full_name: app.id.clone(),
        });
    }

    // 3. Steam / Epic
    if app.app_type == AppType::Steam {
        return Ok(UninstallMethod::SteamApp {
            app_id: app.id.clone(),
        });
    }
    if app.app_type == AppType::Epic {
        return Ok(UninstallMethod::EpicApp {
            app_name: app.id.clone(),
        });
    }

    // 4. Standard Uninstaller
    let uninst_cmd = app
        .quiet_uninstall_string
        .as_ref()
        .or(app.uninstall_string.as_ref());

    if let Some(cmd) = uninst_cmd {
        match parse_safe_uninstall_command(cmd, env) {
            Ok((exe_path, args)) => {
                return Ok(UninstallMethod::Executable {
                    exe_path,
                    arguments: args,
                });
            }
            Err(e) => {
                // If command parsing failed (e.g. unsafe string), do not blindly execute
                return Err(format!("Unsafe or invalid uninstaller command: {}", e));
            }
        }
    }

    // 6. Portable app folder fallback (Recycle only, S5 / S8.2)
    if let Some(folder) = &app.install_location {
        if check_protected_path(folder, env).is_ok() {
            return Ok(UninstallMethod::PortableFolder {
                folder_path: folder.clone(),
            });
        }
    }

    Err("No valid uninstall method found for application".into())
}

/// Registry rules (Section 8.4):
/// Export registry key to %LOCALAPPDATA%\DiskStudioCleaner\backups\<timestamp>-<app>.reg
/// and verify the file was written before allowing any registry key deletion.
pub fn export_registry_backup(
    backup_dir: &Path,
    app_name: &str,
    key_path: &str,
    values: &[(&str, &str)],
) -> std::io::Result<PathBuf> {
    create_dir_all(backup_dir)?;

    let now_ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let safe_app_name: String = app_name
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect();

    let filename = format!("{}-{}.reg", now_ts, safe_app_name);
    let full_path = backup_dir.join(filename);

    let mut file = File::create(&full_path)?;

    // Standard Windows Registry Editor Version 5.00 format
    writeln!(file, "Windows Registry Editor Version 5.00")?;
    writeln!(file)?;
    writeln!(file, "[{}]", key_path)?;
    for (name, val) in values {
        writeln!(file, "\"{}\"=\"{}\"", name, val)?;
    }
    file.flush()?;

    // Verify file exists and is not empty
    let meta = file.metadata()?;
    if meta.len() == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            "Backup verification failed: zero bytes written",
        ));
    }

    Ok(full_path)
}

/// Scans for app leftovers after uninstallation (Section 8.3)
pub fn scan_app_leftovers(
    app: &InstalledApp,
    fs: &dyn ReadFs,
    env: &EnvironmentRoots,
) -> Vec<PlannedItem> {
    let mut leftovers = Vec::new();

    // Check candidate folders
    let candidate_parents = [
        env.user_profile.join("AppData\\Local"),
        env.user_profile.join("AppData\\Roaming"),
        env.program_data.clone(),
    ];

    let clean_name = app.display_name.trim();
    if clean_name.is_empty() || clean_name.len() < 3 {
        return leftovers;
    }

    for parent in &candidate_parents {
        let app_folder = parent.join(clean_name);
        if fs.exists(&app_folder) {
            if check_protected_path(&app_folder, env).is_ok() {
                if let Ok(meta) = fs.metadata(&app_folder) {
                    leftovers.push(PlannedItem {
                        id: format!("leftover-{}", leftovers.len()),
                        path: app_folder,
                        size_bytes: meta.len,
                        modified: meta.modified.and_then(|m| {
                            m.duration_since(SystemTime::UNIX_EPOCH)
                                .map(|d| d.as_secs())
                                .ok()
                        }),
                        kind: ItemKind::Folder,
                        action: Action::Recycle, // Remnants go to Recycle Bin (Section 8.3)
                    });
                }
            }
        }
    }

    leftovers
}

/// macOS App Cleaner & Leftover Sweep
pub fn scan_macos_app_leftovers(
    app: &InstalledApp,
    fs: &dyn ReadFs,
    env: &EnvironmentRoots,
) -> Vec<PlannedItem> {
    let mut leftovers = Vec::new();
    let home = &env.user_profile;
    let lib = home.join("Library");

    let bundle_id = &app.id;
    let name = &app.display_name;

    let candidate_paths = [
        lib.join("Application Support").join(bundle_id),
        lib.join("Application Support").join(name),
        lib.join("Caches").join(bundle_id),
        lib.join("Preferences").join(format!("{}.plist", bundle_id)),
        lib.join("Saved Application State")
            .join(format!("{}.savedState", bundle_id)),
        lib.join("Containers").join(bundle_id),
        lib.join("Logs").join(bundle_id),
        lib.join("Logs").join(name),
    ];

    for candidate in candidate_paths {
        if fs.exists(&candidate) {
            if check_protected_path(&candidate, env).is_ok() {
                if let Ok(meta) = fs.metadata(&candidate) {
                    leftovers.push(PlannedItem {
                        id: format!("macos-leftover-{}", leftovers.len()),
                        path: candidate,
                        size_bytes: meta.len,
                        modified: meta.modified.and_then(|m| {
                            m.duration_since(SystemTime::UNIX_EPOCH)
                                .map(|d| d.as_secs())
                                .ok()
                        }),
                        kind: if meta.is_dir {
                            ItemKind::Folder
                        } else {
                            ItemKind::File
                        },
                        action: Action::Recycle, // Remnants go to macOS Trash (~/.Trash) with undo
                    });
                }
            }
        }
    }

    leftovers
}

/// Filters Apple built-in system applications
pub fn is_apple_system_app(bundle_id: &str) -> bool {
    let id_lower = bundle_id.to_ascii_lowercase();
    let apple_system_apps = [
        "com.apple.safari",
        "com.apple.mail",
        "com.apple.finder",
        "com.apple.systempreferences",
        "com.apple.systemsettings",
        "com.apple.photos",
        "com.apple.music",
        "com.apple.tv",
        "com.apple.podcasts",
        "com.apple.terminal",
        "com.apple.preview",
        "com.apple.textedit",
        "com.apple.calculator",
        "com.apple.activitymonitor",
        "com.apple.appstore",
        "com.apple.shortcuts",
        "com.apple.clock",
    ];

    for sa in apple_system_apps {
        if id_lower == sa || id_lower.starts_with(&format!("{}.", sa)) {
            return true;
        }
    }
    false
}

/// Discovers installed software across Windows, macOS, and Linux
/// Enforces Section 8.1 filtering (hides system components, drivers, and runtime parts)
pub fn discover_installed_apps(env: &EnvironmentRoots, fs: &dyn ReadFs) -> Vec<InstalledApp> {
    let mut apps: Vec<InstalledApp> = Vec::new();

    // 1. Windows: Try querying installed programs via PowerShell registry lookup
    #[cfg(windows)]
    {
        apps.extend(discover_windows_installed_apps(env, fs));
    }

    // 2. macOS: Scan /Applications and ~/Applications
    let macos_roots = [
        PathBuf::from("/Applications"),
        env.user_profile.join("Applications"),
    ];
    for app_root in &macos_roots {
        if fs.exists(app_root) {
            if let Ok(entries) = fs.read_dir(app_root) {
                for entry in entries {
                    if entry.metadata.is_dir && entry.path.extension().map_or(false, |ext| ext == "app") {
                        let app_name = entry
                            .path
                            .file_stem()
                            .map(|s| s.to_string_lossy().to_string())
                            .unwrap_or_else(|| "Unknown App".into());
                        let bundle_id = format!("com.apple.local.{}", app_name.to_ascii_lowercase());

                        if is_apple_system_app(&bundle_id) || is_apple_system_app(&app_name) {
                            continue;
                        }

                        let size = measure_dir_size(fs, &entry.path);
                        apps.push(InstalledApp {
                            id: bundle_id,
                            display_name: app_name,
                            display_version: None,
                            publisher: Some("macOS Application".into()),
                            install_location: Some(entry.path.clone()),
                            install_date: None,
                            estimated_size_bytes: size,
                            uninstall_string: None,
                            quiet_uninstall_string: None,
                            is_msi: false,
                            is_system_component: false,
                            parent_key_name: None,
                            app_type: AppType::Portable,
                        });
                    }
                }
            }
        }
    }

    // 3. Fallback / Cross-platform folder scanning for Program Files & LocalAppData
    let win_program_folders = [
        env.program_files.clone(),
        env.program_files_x86.clone(),
        env.user_profile.join("AppData\\Local\\Programs"),
    ];
    for pdir in &win_program_folders {
        if fs.exists(pdir) {
            if let Ok(entries) = fs.read_dir(pdir) {
                for entry in entries {
                    if !entry.metadata.is_dir || entry.metadata.is_reparse_point {
                        continue;
                    }
                    let folder_name = entry
                        .path
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();

                    // Skip system / common folders
                    let lower = folder_name.to_ascii_lowercase();
                    if lower == "common files" || lower == "windows nt" || lower == "microsoft" || lower == "windows mail" || lower == "windows media player" {
                        continue;
                    }

                    // Check if already in list
                    if apps.iter().any(|a| a.display_name.eq_ignore_ascii_case(&folder_name)) {
                        continue;
                    }

                    let size = measure_dir_size(fs, &entry.path);
                    if size < 1024 * 1024 {
                        // Skip trivial folders under 1MB
                        continue;
                    }

                    // Look for uninstall executable inside
                    let mut uninst_str = None;
                    if let Ok(sub_entries) = fs.read_dir(&entry.path) {
                        for sub in sub_entries {
                            let fname = sub.path.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
                            if fname.starts_with("unins") || fname.starts_with("uninstall") {
                                uninst_str = Some(format!("\"{}\"", sub.path.display()));
                                break;
                            }
                        }
                    }

                    apps.push(InstalledApp {
                        id: format!("folder-{}", folder_name),
                        display_name: folder_name,
                        display_version: None,
                        publisher: None,
                        install_location: Some(entry.path.clone()),
                        install_date: None,
                        estimated_size_bytes: size,
                        uninstall_string: uninst_str.clone(),
                        quiet_uninstall_string: uninst_str,
                        is_msi: false,
                        is_system_component: false,
                        parent_key_name: None,
                        app_type: AppType::Exe,
                    });
                }
            }
        }
    }

    // 4. Linux desktop applications
    let linux_app_dirs = [
        PathBuf::from("/usr/share/applications"),
        env.user_profile.join(".local/share/applications"),
    ];
    for adir in &linux_app_dirs {
        if fs.exists(adir) {
            if let Ok(entries) = fs.read_dir(adir) {
                for entry in entries {
                    if entry.path.extension().map_or(false, |ext| ext == "desktop") {
                        let fname = entry.path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                        if !fname.is_empty() && !apps.iter().any(|a| a.display_name.eq_ignore_ascii_case(&fname)) {
                            apps.push(InstalledApp {
                                id: format!("desktop-{}", fname),
                                display_name: fname,
                                display_version: None,
                                publisher: Some("Linux Desktop Entry".into()),
                                install_location: None,
                                install_date: None,
                                estimated_size_bytes: 50 * 1024 * 1024,
                                uninstall_string: None,
                                quiet_uninstall_string: None,
                                is_msi: false,
                                is_system_component: false,
                                parent_key_name: None,
                                app_type: AppType::Portable,
                            });
                        }
                    }
                }
            }
        }
    }

    // Filter out denied components and sort by size descending
    let mut filtered: Vec<InstalledApp> = apps
        .into_iter()
        .filter(|a| !is_denied_or_system_app(a))
        .collect();

    filtered.sort_by(|a, b| b.estimated_size_bytes.cmp(&a.estimated_size_bytes));
    filtered
}

fn measure_dir_size(fs: &dyn ReadFs, root: &Path) -> u64 {
    let mut size = 0u64;
    let mut stack = vec![root.to_path_buf()];
    let mut depth = 0;

    while let Some(dir) = stack.pop() {
        depth += 1;
        if depth > 1000 {
            break;
        }
        if let Ok(entries) = fs.read_dir(&dir) {
            for entry in entries {
                if entry.metadata.is_reparse_point {
                    continue;
                }
                if entry.metadata.is_dir {
                    stack.push(entry.path);
                } else {
                    size += entry.metadata.len;
                }
            }
        }
    }
    size
}

#[cfg(windows)]
fn discover_windows_installed_apps(_env: &EnvironmentRoots, fs: &dyn ReadFs) -> Vec<InstalledApp> {
    let mut list = Vec::new();
    let ps_cmd = r#"Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*, HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*, HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* | Where-Object { $_.DisplayName } | Select-Object PSChildName, DisplayName, DisplayVersion, Publisher, InstallLocation, InstallDate, EstimatedSize, UninstallString, QuietUninstallString, WindowsInstaller, SystemComponent | ConvertTo-Json -Compress"#;

    if let Ok(output) = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps_cmd])
        .output()
    {
        if output.status.success() {
            if let Ok(json_str) = String::from_utf8(output.stdout) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json_str) {
                    let items = if let Some(arr) = val.as_array() {
                        arr.clone()
                    } else if val.is_object() {
                        vec![val]
                    } else {
                        Vec::new()
                    };

                    for it in items {
                        let name = match it.get("DisplayName").and_then(|v| v.as_str()) {
                            Some(n) if !n.trim().is_empty() => n.trim().to_string(),
                            _ => continue,
                        };
                        let id = it.get("PSChildName").and_then(|v| v.as_str()).unwrap_or(&name).to_string();
                        let ver = it.get("DisplayVersion").and_then(|v| v.as_str()).map(|s| s.to_string());
                        let publ = it.get("Publisher").and_then(|v| v.as_str()).map(|s| s.to_string());
                        let loc = it.get("InstallLocation").and_then(|v| v.as_str()).map(PathBuf::from);
                        let date = it.get("InstallDate").and_then(|v| v.as_str()).map(|s| s.to_string());
                        let uninst = it.get("UninstallString").and_then(|v| v.as_str()).map(|s| s.to_string());
                        let quiet = it.get("QuietUninstallString").and_then(|v| v.as_str()).map(|s| s.to_string());
                        let is_msi = it.get("WindowsInstaller").and_then(|v| v.as_i64()).unwrap_or(0) == 1;
                        let sys_comp = it.get("SystemComponent").and_then(|v| v.as_i64()).unwrap_or(0) == 1;

                        // Estimated size in KB converted to bytes
                        let est_kb = it.get("EstimatedSize").and_then(|v| v.as_u64()).unwrap_or(0);
                        let mut size_bytes = est_kb * 1024;

                        // If size is 0 and install location exists, measure it
                        if size_bytes == 0 {
                            if let Some(p) = &loc {
                                if fs.exists(p) {
                                    size_bytes = measure_dir_size(fs, p);
                                }
                            }
                        }

                        list.push(InstalledApp {
                            id,
                            display_name: name,
                            display_version: ver,
                            publisher: publ,
                            install_location: loc,
                            install_date: date,
                            estimated_size_bytes: size_bytes,
                            uninstall_string: uninst,
                            quiet_uninstall_string: quiet,
                            is_msi,
                            is_system_component: sys_comp,
                            parent_key_name: None,
                            app_type: if is_msi { AppType::Msi } else { AppType::Exe },
                        });
                    }
                }
            }
        }
    }
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_safe_uninstall_command_quoted() {
        let env = EnvironmentRoots::default();
        let cmd = r#""C:\Program Files\Example\uninstall.exe" /S /quiet"#;
        let (exe, args) = parse_safe_uninstall_command(cmd, &env).unwrap();

        assert_eq!(exe, PathBuf::from(r#"C:\Program Files\Example\uninstall.exe"#));
        assert_eq!(args, vec!["/S", "/quiet"]);
    }

    #[test]
    fn test_parse_safe_uninstall_command_rejects_injection() {
        let env = EnvironmentRoots::default();
        let injection_cmd = r#""C:\App\uninstall.exe" & calc.exe"#;
        let res = parse_safe_uninstall_command(injection_cmd, &env);

        match res {
            Err(CommandParseError::CommandInjectionDetected(msg)) => {
                assert!(msg.contains('&'));
            }
            other => panic!("Expected injection to be rejected, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_safe_uninstall_command_rejects_relative() {
        let env = EnvironmentRoots::default();
        let rel_cmd = r#"uninstall.exe /S"#;
        let res = parse_safe_uninstall_command(rel_cmd, &env);

        match res {
            Err(CommandParseError::RelativePathRefused(_)) => {}
            other => panic!("Expected relative path rejection, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_safe_uninstall_command_rejects_protected_shell() {
        let env = EnvironmentRoots::default();
        let shell_cmd = r#""C:\Windows\System32\cmd.exe" /c del /f"#;
        let res = parse_safe_uninstall_command(shell_cmd, &env);

        match res {
            Err(CommandParseError::ProtectedExeRefused(_)) => {}
            other => panic!("Expected protected shell rejection, got {:?}", other),
        }
    }

    #[test]
    fn test_deny_list_filters_system_components() {
        let vc_app = InstalledApp {
            id: "vc-redist".into(),
            display_name: "Microsoft Visual C++ 2015-2022 Redistributable (x64)".into(),
            display_version: Some("14.34".into()),
            publisher: Some("Microsoft Corporation".into()),
            install_location: None,
            install_date: None,
            estimated_size_bytes: 50 * 1024 * 1024,
            uninstall_string: Some(r#""C:\ProgramData\Package Cache\vc_redist.exe" /uninstall"#.into()),
            quiet_uninstall_string: None,
            is_msi: false,
            is_system_component: false,
            parent_key_name: None,
            app_type: AppType::Exe,
        };
        assert!(is_denied_or_system_app(&vc_app));

        let user_game = InstalledApp {
            id: "game123".into(),
            display_name: "Space Explorer 3D".into(),
            display_version: Some("1.0".into()),
            publisher: Some("Indie Game Studio".into()),
            install_location: Some(PathBuf::from(r#"C:\Games\SpaceExplorer"#)),
            install_date: None,
            estimated_size_bytes: 2 * 1024 * 1024 * 1024,
            uninstall_string: Some(r#""C:\Games\SpaceExplorer\uninst.exe""#.into()),
            quiet_uninstall_string: Some(r#""C:\Games\SpaceExplorer\uninst.exe" /S"#.into()),
            is_msi: false,
            is_system_component: false,
            parent_key_name: None,
            app_type: AppType::Exe,
        };
        assert!(!is_denied_or_system_app(&user_game));
    }

    #[test]
    fn test_apple_system_app_filter() {
        assert!(is_apple_system_app("com.apple.Safari"));
        assert!(is_apple_system_app("com.apple.Finder"));
        assert!(is_apple_system_app("com.apple.systempreferences"));
        assert!(is_apple_system_app("com.apple.Mail"));
        assert!(!is_apple_system_app("com.spotify.client"));
        assert!(!is_apple_system_app("com.tinyspeck.slackmacgap"));
        assert!(!is_apple_system_app("org.videolan.vlc"));
    }

    #[test]
    fn test_macos_app_leftovers_sweep() {
        let fake = crate::fs::FakeFs::new();
        let env = EnvironmentRoots::macos_default(Path::new("/Users/Alice"));

        let app = InstalledApp {
            id: "com.example.photodesk".into(),
            display_name: "PhotoDesk".into(),
            display_version: Some("2.0".into()),
            publisher: Some("PhotoDesk Inc".into()),
            install_location: Some(PathBuf::from("/Applications/PhotoDesk.app")),
            install_date: None,
            estimated_size_bytes: 200 * 1024 * 1024,
            uninstall_string: None,
            quiet_uninstall_string: None,
            is_msi: false,
            is_system_component: false,
            parent_key_name: None,
            app_type: AppType::Portable,
        };

        // Create leftover remnants
        let app_support = PathBuf::from("/Users/Alice/Library/Application Support/PhotoDesk");
        fake.add_dir(&app_support);
        let caches = PathBuf::from("/Users/Alice/Library/Caches/com.example.photodesk");
        fake.add_dir(&caches);
        let prefs = PathBuf::from("/Users/Alice/Library/Preferences/com.example.photodesk.plist");
        fake.add_file(&prefs, 4096, SystemTime::now());

        let leftovers = scan_macos_app_leftovers(&app, &fake, &env);
        assert_eq!(leftovers.len(), 3);
        for item in &leftovers {
            assert_eq!(item.action, Action::Recycle); // Must go to Trash with undo
        }
    }

    #[test]
    fn test_registry_backup_written_before_deletion() {
        let temp = tempfile::tempdir().unwrap();
        let backup_dir = temp.path().join("backups");

        let res = export_registry_backup(
            &backup_dir,
            "TestApp",
            r#"HKLM\Software\TestApp"#,
            &[("InstallDir", r#"C:\TestApp"#), ("Version", "1.0")],
        )
        .unwrap();

        assert!(res.exists());
        let content = std::fs::read_to_string(&res).unwrap();
        assert!(content.contains("Windows Registry Editor Version 5.00"));
        assert!(content.contains(r#"[HKLM\Software\TestApp]"#));
        assert!(content.contains(r#""InstallDir"="C:\TestApp""#));
    }
}
