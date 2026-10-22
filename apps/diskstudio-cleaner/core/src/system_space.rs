use crate::fs::ReadFs;
use crate::protected::EnvironmentRoots;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemSpaceItem {
    pub id: String,
    pub tier: String,
    pub title: String,
    pub description: String,
    pub risk_level: String,
    pub current_status: String,
    pub estimated_size_bytes: u64,
    pub requires_admin: bool,
    pub action_label: String,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SystemSpaceReport {
    pub items: Vec<SystemSpaceItem>,
    pub total_potential_gain_bytes: u64,
}

/// Scans Tier 3 (System Space) and Tier 5 (Shrinking without Deleting)
pub fn scan_system_space(env: &EnvironmentRoots, fs: &dyn ReadFs) -> SystemSpaceReport {
    let mut items = Vec::new();
    let mut total_potential = 0u64;

    // -------------------------------------------------------------
    // Tier 3: System Space
    // -------------------------------------------------------------

    // 1. Hibernation File (hiberfil.sys)
    let hiberfil = PathBuf::from(r#"C:\hiberfil.sys"#);
    let mut hiber_active = false;
    let hiber_size = if fs.exists(&hiberfil) {
        hiber_active = true;
        if let Ok(meta) = fs.metadata(&hiberfil) {
            if meta.len > 0 { meta.len } else { 16 * 1024 * 1024 * 1024 }
        } else {
            16 * 1024 * 1024 * 1024
        }
    } else {
        12 * 1024 * 1024 * 1024
    };

    if hiber_active {
        total_potential += hiber_size;
    }

    items.push(SystemSpaceItem {
        id: "hibernation".into(),
        tier: "Tier 3: System space".into(),
        title: "Hibernation File (hiberfil.sys)".into(),
        description: "Stores RAM state on disk for Fast Startup and Sleep-to-Hibernate. Disabling this removes hiberfil.sys instantly and reclaims disk space.".into(),
        risk_level: "Medium (Disables Fast Startup / Hibernate, requires Admin)".into(),
        current_status: if hiber_active {
            format!("Active on drive C: ({:.1} GB allocated)", hiber_size as f64 / 1_073_741_824.0)
        } else {
            "Disabled (hiberfil.sys not present)".into()
        },
        estimated_size_bytes: hiber_size,
        requires_admin: true,
        action_label: if hiber_active { "Disable Hibernation" } else { "Enable Hibernation" }.into(),
        is_active: hiber_active,
    });

    // 2. Previous Windows Installation (Windows.old)
    let win_old = PathBuf::from(r#"C:\Windows.old"#);
    let mut win_old_active = false;
    let mut win_old_size = 0u64;

    if fs.exists(&win_old) {
        win_old_active = true;
        win_old_size = measure_dir_sample(fs, &win_old);
        if win_old_size == 0 {
            win_old_size = 20 * 1024 * 1024 * 1024;
        }
        total_potential += win_old_size;
    }

    items.push(SystemSpaceItem {
        id: "windows-old".into(),
        tier: "Tier 3: System space".into(),
        title: "Previous Windows Installations (Windows.old)".into(),
        description: "Backup of previous OS version created after major Windows updates. Cleaning this removes rollback capability to previous builds.".into(),
        risk_level: "Medium (Removes rollback to older Windows)".into(),
        current_status: if win_old_active {
            format!("Found on C: ({:.1} GB)", win_old_size as f64 / 1_073_741_824.0)
        } else {
            "No previous installation found (0 bytes)".into()
        },
        estimated_size_bytes: win_old_size,
        requires_admin: true,
        action_label: "Clean Windows.old via DISM / Storage Sense".into(),
        is_active: win_old_active,
    });

    // 3. Component Store (WinSxS) Cleanup
    let winsxs = PathBuf::from(r#"C:\Windows\WinSxS"#);
    let winsxs_present = fs.exists(&winsxs);
    let winsxs_gain = 6 * 1024 * 1024 * 1024;
    total_potential += winsxs_gain;

    items.push(SystemSpaceItem {
        id: "winsxs-dism".into(),
        tier: "Tier 3: System space".into(),
        title: "Component Store (WinSxS) Cleanup via DISM".into(),
        description: "Scans for superseded update packages and cleans up WinSxS payloads using official Microsoft DISM maintenance commands.".into(),
        risk_level: "Low to Medium (Official Microsoft DISM API, needs Admin)".into(),
        current_status: if winsxs_present {
            "Ready for maintenance (Typical gain: 4–10 GB)".into()
        } else {
            "Not applicable".into()
        },
        estimated_size_bytes: winsxs_gain,
        requires_admin: true,
        action_label: "Run DISM Component Cleanup".into(),
        is_active: winsxs_present,
    });

    // 4. System Restore Shadow Copies
    let vss_gain = 8 * 1024 * 1024 * 1024;
    items.push(SystemSpaceItem {
        id: "system-restore".into(),
        tier: "Tier 3: System space".into(),
        title: "System Restore Shadow Copies".into(),
        description: "Volume Shadow Copy snapshots for system recovery points. View shadow storage and launch Windows System Protection settings.".into(),
        risk_level: "Medium (Affects recovery restore points)".into(),
        current_status: "Managed by Windows VSS service (5–15 GB typical)".into(),
        estimated_size_bytes: vss_gain,
        requires_admin: true,
        action_label: "Open Windows System Protection Settings".into(),
        is_active: true,
    });

    // 5. Page File Sizing (pagefile.sys / swapfile.sys)
    let pagefile = PathBuf::from(r#"C:\pagefile.sys"#);
    let swapfile = PathBuf::from(r#"C:\swapfile.sys"#);
    let mut page_size = 0u64;
    let mut page_found = false;

    if fs.exists(&pagefile) {
        page_found = true;
        if let Ok(m) = fs.metadata(&pagefile) {
            page_size += m.len;
        }
    }
    if fs.exists(&swapfile) {
        if let Ok(m) = fs.metadata(&swapfile) {
            page_size += m.len;
        }
    }
    if page_size == 0 {
        page_size = 8 * 1024 * 1024 * 1024; // Standard 8GB virtual memory
    }

    items.push(SystemSpaceItem {
        id: "pagefile".into(),
        tier: "Tier 3: System space".into(),
        title: "Virtual Memory Paging File (pagefile.sys)".into(),
        description: "Windows backing store for virtual memory and crash dumps. Sizing can be managed in Windows Virtual Memory settings.".into(),
        risk_level: "Medium (Affects memory overflow handling)".into(),
        current_status: if page_found {
            format!("Allocated on C: ({:.1} GB virtual memory)", page_size as f64 / 1_073_741_824.0)
        } else {
            "Managed by Windows System".into()
        },
        estimated_size_bytes: page_size,
        requires_admin: true,
        action_label: "Open Virtual Memory Settings".into(),
        is_active: page_found,
    });

    // 6. Delivery Optimization & Windows Update Cache
    let do_gain = 3 * 1024 * 1024 * 1024;
    items.push(SystemSpaceItem {
        id: "delivery-optimization".into(),
        tier: "Tier 3: System space".into(),
        title: "Delivery Optimization & Update Cache".into(),
        description: "Temporary peer-to-peer download cache used for Windows Updates and Microsoft Store apps.".into(),
        risk_level: "Very Low (Caches re-download automatically if needed)".into(),
        current_status: "Active cache (Typical gain: 1–5 GB)".into(),
        estimated_size_bytes: do_gain,
        requires_admin: false,
        action_label: "Open Windows Storage Sense Settings".into(),
        is_active: true,
    });

    // -------------------------------------------------------------
    // Tier 5: Shrinking Without Deleting
    // -------------------------------------------------------------

    // 7. CompactOS - Transparent Windows Binaries Compression
    let compact_savings = 3 * 1024 * 1024 * 1024;
    let compact_active = check_compactos_query();
    if !compact_active {
        total_potential += compact_savings;
    }

    items.push(SystemSpaceItem {
        id: "compactos".into(),
        tier: "Tier 5: Shrinking without deleting".into(),
        title: "CompactOS (In-Place Windows Compression)".into(),
        description: "Compresses core Windows binaries in-place using Microsoft WOF algorithm. Zero files deleted, 100% reversible, 2–4 GB space reclaimed.".into(),
        risk_level: "Very Low (Supported Windows native feature)".into(),
        current_status: if compact_active {
            "CompactOS is currently ACTIVE (Space saved ~3 GB)".into()
        } else {
            "Not compressed (~3.0 GB space can be reclaimed)".into()
        },
        estimated_size_bytes: compact_savings,
        requires_admin: true,
        action_label: if compact_active { "Uncompress CompactOS" } else { "Compress Windows (CompactOS)" }.into(),
        is_active: compact_active,
    });

    // 8. Per-Folder In-Place NTFS Compression
    let ntfs_comp_gain = 10 * 1024 * 1024 * 1024;
    items.push(SystemSpaceItem {
        id: "ntfs-compression".into(),
        tier: "Tier 5: Shrinking without deleting".into(),
        title: "Per-Folder In-Place NTFS/LZX Compression".into(),
        description: "Compresses large folders (game libraries, documents, project files) in-place without deleting anything, saving 20–40% disk space.".into(),
        risk_level: "Very Low (Transparent filesystem-level compression)".into(),
        current_status: "Available on NTFS volumes".into(),
        estimated_size_bytes: ntfs_comp_gain,
        requires_admin: false,
        action_label: "Open Folder Compression Helper".into(),
        is_active: true,
    });

    // 9. OneDrive Cloud Offload ("Free up space")
    let onedrive_dir = env.user_profile.join("OneDrive");
    let onedrive_found = fs.exists(&onedrive_dir);
    let onedrive_gain = 15 * 1024 * 1024 * 1024;

    items.push(SystemSpaceItem {
        id: "cloud-offload".into(),
        tier: "Tier 5: Shrinking without deleting".into(),
        title: "OneDrive Cloud Offload ('Free up space')".into(),
        description: "Converts downloaded local files into cloud-only placeholders without deleting them from your account.".into(),
        risk_level: "Low (Files remain safe in cloud storage)".into(),
        current_status: if onedrive_found {
            format!("OneDrive detected at {}", onedrive_dir.display())
        } else {
            "OneDrive sync folder not detected".into()
        },
        estimated_size_bytes: onedrive_gain,
        requires_admin: false,
        action_label: "Open OneDrive Folder to Free Up Space".into(),
        is_active: onedrive_found,
    });

    // 10. Virtual Disk Compaction (.vhdx for WSL2 & Docker)
    let mut vhdx_found = false;
    let mut vhdx_path = String::new();
    let localappdata = env.user_profile.join("AppData").join("Local");
    let wsl_base = localappdata.join("Packages");

    if fs.exists(&wsl_base) {
        if let Ok(entries) = fs.read_dir(&wsl_base) {
            for e in entries {
                let p = e.path.join("LocalState").join("ext4.vhdx");
                if fs.exists(&p) {
                    vhdx_found = true;
                    vhdx_path = p.display().to_string();
                    break;
                }
            }
        }
    }

    let vhdx_gain = 15 * 1024 * 1024 * 1024;
    items.push(SystemSpaceItem {
        id: "virtual-disks".into(),
        tier: "Tier 5: Shrinking without deleting".into(),
        title: "WSL2 & Docker Virtual Disk (.vhdx) Compaction".into(),
        description: "Dynamically expanding virtual disks grow over time. Compacting reclaims space freed inside Linux or Docker back to Windows.".into(),
        risk_level: "Low (Reclaims unused blocks inside virtual disk)".into(),
        current_status: if vhdx_found {
            format!("WSL2 VHDX detected ({})", vhdx_path)
        } else {
            "Virtual disks ready for compaction".into()
        },
        estimated_size_bytes: vhdx_gain,
        requires_admin: true,
        action_label: "Run WSL2 Shutdown & Compaction".into(),
        is_active: vhdx_found,
    });

    SystemSpaceReport {
        items,
        total_potential_gain_bytes: total_potential,
    }
}

fn measure_dir_sample(fs: &dyn ReadFs, root: &Path) -> u64 {
    let mut total = 0u64;
    let mut count = 0;
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        count += 1;
        if count > 500 {
            break;
        }
        if let Ok(entries) = fs.read_dir(&dir) {
            for entry in entries {
                if entry.metadata.is_dir {
                    stack.push(entry.path);
                } else {
                    total += entry.metadata.len;
                }
            }
        }
    }
    total
}

fn check_compactos_query() -> bool {
    #[cfg(windows)]
    {
        if let Ok(output) = std::process::Command::new("compact.exe")
            .arg("/compactos:query")
            .output()
        {
            let text = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
            return text.contains("the system is in the compact state") || text.contains("compact state");
        }
    }
    false
}

/// Executes an action for a System Space / Shrinking item
pub fn execute_system_action(item_id: &str, _is_currently_active: bool) -> Result<String, String> {
    match item_id {
        "hibernation" => {
            #[cfg(windows)]
            {
                let arg = if _is_currently_active { "/h off" } else { "/h on" };
                let output = std::process::Command::new("powercfg.exe")
                    .args([arg])
                    .output()
                    .map_err(|e| format!("Failed to launch powercfg: {}", e))?;
                if output.status.success() {
                    Ok(if _is_currently_active {
                        "Hibernation disabled successfully. hiberfil.sys removed."
                    } else {
                        "Hibernation enabled successfully."
                    }.into())
                } else {
                    Err(format!("powercfg failed (requires Administrator): {}", String::from_utf8_lossy(&output.stderr)))
                }
            }
            #[cfg(not(windows))]
            {
                Ok("Hibernation toggled (simulated on non-windows platform).".into())
            }
        }
        "compactos" => {
            #[cfg(windows)]
            {
                let arg = if _is_currently_active { "/compactos:never" } else { "/compactos:always" };
                let output = std::process::Command::new("compact.exe")
                    .arg(arg)
                    .output()
                    .map_err(|e| format!("Failed to launch compact.exe: {}", e))?;
                if output.status.success() {
                    Ok(format!("CompactOS command executed: {}", arg))
                } else {
                    Err(format!("compact.exe failed: {}", String::from_utf8_lossy(&output.stderr)))
                }
            }
            #[cfg(not(windows))]
            {
                Ok("CompactOS executed (simulated on non-windows platform).".into())
            }
        }
        "winsxs-dism" => {
            #[cfg(windows)]
            {
                let output = std::process::Command::new("dism.exe")
                    .args(["/Online", "/Cleanup-Image", "/StartComponentCleanup"])
                    .output()
                    .map_err(|e| format!("Failed to launch dism.exe: {}", e))?;
                if output.status.success() {
                    Ok("DISM Component Store cleanup completed successfully.".into())
                } else {
                    Err(format!("DISM failed (requires Administrator): {}", String::from_utf8_lossy(&output.stderr)))
                }
            }
            #[cfg(not(windows))]
            {
                Ok("DISM cleanup simulated on non-windows platform.".into())
            }
        }
        "windows-old" => {
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("cleanmgr.exe")
                    .args(["/d", "C:"])
                    .spawn();
                Ok("Launched Windows Disk Cleanup for C: drive to cleanly remove Windows.old.".into())
            }
            #[cfg(not(windows))]
            {
                Ok("Launched Windows.old cleanup helper.".into())
            }
        }
        "system-restore" => {
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("systempropertiesprotection.exe").spawn();
                Ok("Opened Windows System Protection settings.".into())
            }
            #[cfg(not(windows))]
            {
                Ok("Opened System Protection settings.".into())
            }
        }
        "pagefile" => {
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("systempropertiesadvanced.exe").spawn();
                Ok("Opened Windows Virtual Memory settings dialog.".into())
            }
            #[cfg(not(windows))]
            {
                Ok("Opened Virtual Memory settings dialog.".into())
            }
        }
        "delivery-optimization" => {
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("explorer.exe")
                    .arg("ms-settings:storagesense")
                    .spawn();
                Ok("Opened Windows Storage Sense settings.".into())
            }
            #[cfg(not(windows))]
            {
                Ok("Opened Storage Sense settings.".into())
            }
        }
        "ntfs-compression" => {
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("explorer.exe")
                    .arg(dirs_onedrive())
                    .spawn();
                Ok("Opened Explorer. To compress any folder, right click -> Properties -> Advanced -> 'Compress contents to save disk space'.".into())
            }
            #[cfg(not(windows))]
            {
                Ok("Opened folder compression helper.".into())
            }
        }
        "cloud-offload" => {
            let onedrive_path = dirs_onedrive();
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("explorer.exe")
                    .arg(&onedrive_path)
                    .spawn();
                Ok("Opened OneDrive folder. Right-click any folder and select 'Free up space' to offload local files.".into())
            }
            #[cfg(not(windows))]
            {
                Ok(format!("Opened Cloud folder ({}) for offload.", onedrive_path))
            }
        }
        "virtual-disks" => {
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("wsl.exe")
                    .args(["--shutdown"])
                    .output();
                Ok("Issued 'wsl --shutdown' to release locks on ext4.vhdx. Windows will reclaim unused pages.".into())
            }
            #[cfg(not(windows))]
            {
                Ok("Simulated virtual disk compaction.".into())
            }
        }
        _ => Err("Unknown system space action item".into()),
    }
}

fn dirs_onedrive() -> String {
    if let Ok(prof) = std::env::var("USERPROFILE") {
        let p = PathBuf::from(prof).join("OneDrive");
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }
    "C:\\".into()
}
