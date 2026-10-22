use crate::fs::ReadFs;
use crate::protected::check_protected_path;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OldInstaller {
    pub path: PathBuf,
    pub name: String,
    pub size_bytes: u64,
    pub age_days: u64,
    pub modified_time: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BigMediaFile {
    pub path: PathBuf,
    pub name: String,
    pub size_bytes: u64,
    pub file_type: String,
    pub modified_time: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ForgottenFile {
    pub path: PathBuf,
    pub name: String,
    pub size_bytes: u64,
    pub age_days: u64,
    pub modified_time: Option<u64>,
}

const INSTALLER_EXTENSIONS: &[&str] = &[
    "exe", "msi", "iso", "zip", "dmg", "pkg", "deb", "appx", "msix", "tar.gz", "tgz",
];

const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "mov", "avi", "wmv", "flv", "webm", "m4v", "mpeg", "mpg", "ts",
];

/// Scans user directories (e.g. Downloads, Desktop) for setup installers older than min_age_days
pub fn scan_old_installers(
    fs: &dyn ReadFs,
    search_dirs: &[PathBuf],
    min_age_days: u64,
) -> Vec<OldInstaller> {
    let mut installers = Vec::new();
    let now = SystemTime::now();
    let min_age = Duration::from_secs(min_age_days * 86400);

    for root in search_dirs {
        if !fs.exists(root) {
            continue;
        }

        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            if check_protected_path(&dir, &crate::protected::EnvironmentRoots::default()).is_err() {
                continue;
            }

            let entries = match fs.read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };

            for entry in entries {
                if entry.metadata.is_reparse_point {
                    continue;
                }

                if entry.metadata.is_dir {
                    // Only recurse 1 level deep inside Downloads/Desktop to avoid deep code trees
                    if dir == *root {
                        stack.push(entry.path);
                    }
                } else if entry.metadata.is_file && entry.metadata.len >= 5 * 1024 * 1024 {
                    // Files >= 5MB
                    let ext = entry
                        .path
                        .extension()
                        .and_then(|s| s.to_str())
                        .map(|s| s.to_ascii_lowercase())
                        .unwrap_or_default();

                    if INSTALLER_EXTENSIONS.contains(&ext.as_str()) {
                        let age_days = if let Some(m) = entry.metadata.modified {
                            if let Ok(dur) = now.duration_since(m) {
                                if dur < min_age {
                                    continue;
                                }
                                dur.as_secs() / 86400
                            } else {
                                0
                            }
                        } else {
                            0
                        };

                        let modified_secs = entry.metadata.modified.and_then(|m| {
                            m.duration_since(SystemTime::UNIX_EPOCH).ok().map(|d| d.as_secs())
                        });

                        installers.push(OldInstaller {
                            path: entry.path.clone(),
                            name: entry.name,
                            size_bytes: entry.metadata.len,
                            age_days,
                            modified_time: modified_secs,
                        });
                    }
                }
            }
        }
    }

    installers.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    installers
}

/// Scans for large video and media files >= min_size_bytes (default 100MB)
pub fn scan_big_media(
    fs: &dyn ReadFs,
    search_dirs: &[PathBuf],
    min_size_bytes: u64,
) -> Vec<BigMediaFile> {
    let mut media = Vec::new();

    for root in search_dirs {
        if !fs.exists(root) {
            continue;
        }

        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            if check_protected_path(&dir, &crate::protected::EnvironmentRoots::default()).is_err() {
                continue;
            }

            let entries = match fs.read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };

            for entry in entries {
                if entry.metadata.is_reparse_point {
                    continue;
                }

                if entry.metadata.is_dir {
                    stack.push(entry.path);
                } else if entry.metadata.is_file && entry.metadata.len >= min_size_bytes {
                    let ext = entry
                        .path
                        .extension()
                        .and_then(|s| s.to_str())
                        .map(|s| s.to_ascii_lowercase())
                        .unwrap_or_default();

                    if VIDEO_EXTENSIONS.contains(&ext.as_str()) {
                        let modified_secs = entry.metadata.modified.and_then(|m| {
                            m.duration_since(SystemTime::UNIX_EPOCH).ok().map(|d| d.as_secs())
                        });

                        media.push(BigMediaFile {
                            path: entry.path,
                            name: entry.name,
                            size_bytes: entry.metadata.len,
                            file_type: ext.to_ascii_uppercase(),
                            modified_time: modified_secs,
                        });
                    }
                }
            }
        }
    }

    media.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    media
}

/// Scans for huge files not modified in over min_age_days (default 180 days / 6 months)
pub fn scan_forgotten_files(
    fs: &dyn ReadFs,
    search_dirs: &[PathBuf],
    min_size_bytes: u64,
    min_age_days: u64,
) -> Vec<ForgottenFile> {
    let mut files = Vec::new();
    let now = SystemTime::now();
    let min_age = Duration::from_secs(min_age_days * 86400);

    for root in search_dirs {
        if !fs.exists(root) {
            continue;
        }

        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            if check_protected_path(&dir, &crate::protected::EnvironmentRoots::default()).is_err() {
                continue;
            }

            let entries = match fs.read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };

            for entry in entries {
                if entry.metadata.is_reparse_point {
                    continue;
                }

                if entry.metadata.is_dir {
                    stack.push(entry.path);
                } else if entry.metadata.is_file && entry.metadata.len >= min_size_bytes {
                    let mut is_old = false;
                    let mut age_days = 0;

                    if let Some(m) = entry.metadata.modified {
                        if let Ok(dur) = now.duration_since(m) {
                            if dur >= min_age {
                                is_old = true;
                                age_days = dur.as_secs() / 86400;
                            }
                        }
                    }

                    if is_old {
                        let modified_secs = entry.metadata.modified.and_then(|m| {
                            m.duration_since(SystemTime::UNIX_EPOCH).ok().map(|d| d.as_secs())
                        });

                        files.push(ForgottenFile {
                            path: entry.path,
                            name: entry.name,
                            size_bytes: entry.metadata.len,
                            age_days,
                            modified_time: modified_secs,
                        });
                    }
                }
            }
        }
    }

    files.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    files
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::FakeFs;

    #[test]
    fn test_scan_old_installers() {
        let fake = FakeFs::new();
        let downloads = PathBuf::from("C:\\Users\\Test\\Downloads");
        fake.add_dir(&downloads);

        let old_time = SystemTime::now() - Duration::from_secs(45 * 86400); // 45 days old
        let recent_time = SystemTime::now() - Duration::from_secs(2 * 86400); // 2 days old

        let f_old_installer = downloads.join("setup_v1.exe");
        let f_new_installer = downloads.join("chrome_installer.exe");
        let f_doc = downloads.join("document.pdf");

        fake.add_file(&f_old_installer, 50 * 1024 * 1024, old_time); // 50MB, old
        fake.add_file(&f_new_installer, 80 * 1024 * 1024, recent_time); // 80MB, new
        fake.add_file(&f_doc, 10 * 1024 * 1024, old_time); // pdf, not installer

        let list = scan_old_installers(&fake, &[downloads], 30);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "setup_v1.exe");
        assert_eq!(list[0].size_bytes, 50 * 1024 * 1024);
    }

    #[test]
    fn test_scan_big_media() {
        let fake = FakeFs::new();
        let videos = PathBuf::from("C:\\Users\\Test\\Videos");
        fake.add_dir(&videos);

        let f_video = videos.join("movie.mp4");
        let f_small_clip = videos.join("clip.mp4");
        fake.add_file(&f_video, 500 * 1024 * 1024, SystemTime::now());
        fake.add_file(&f_small_clip, 2 * 1024 * 1024, SystemTime::now());

        let list = scan_big_media(&fake, &[videos], 100 * 1024 * 1024);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "movie.mp4");
        assert_eq!(list[0].file_type, "MP4");
    }
}
