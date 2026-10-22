use crate::fs::ReadFs;
use crate::protected::check_protected_path;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DuplicateGroup {
    pub size_bytes: u64,
    pub wasted_bytes: u64,
    pub hash: String,
    pub files: Vec<PathBuf>,
}

/// Scans the given roots for duplicate files by size and SHA-256 content verification.
pub fn scan_duplicates(
    fs: &dyn ReadFs,
    search_dirs: &[PathBuf],
    min_size_bytes: u64,
    max_groups: usize,
    progress: Option<&dyn Fn(&str, usize)>,
) -> Vec<DuplicateGroup> {
    // Stage 1: Enumerate files and group by exact byte size
    let mut size_groups: HashMap<u64, Vec<PathBuf>> = HashMap::new();
    let mut files_scanned = 0usize;

    for root in search_dirs {
        if !fs.exists(root) {
            continue;
        }

        let mut stack = vec![root.clone()];
        while let Some(current_dir) = stack.pop() {
            // Guard: check protected path
            if check_protected_path(&current_dir, &crate::protected::EnvironmentRoots::default()).is_err() {
                // If it's a critical OS path, skip traversing
                continue;
            }

            let entries = match fs.read_dir(&current_dir) {
                Ok(e) => e,
                Err(_) => continue,
            };

            for entry in entries {
                // S3 Invariant: never cross reparse points
                if entry.metadata.is_reparse_point {
                    continue;
                }

                if entry.metadata.is_dir {
                    stack.push(entry.path);
                } else if entry.metadata.is_file {
                    files_scanned += 1;
                    if files_scanned % 100 == 0 {
                        if let Some(cb) = progress {
                            cb(&entry.path.to_string_lossy(), files_scanned);
                        }
                    }

                    if entry.metadata.len >= min_size_bytes && !entry.metadata.is_cloud_placeholder {
                        size_groups
                            .entry(entry.metadata.len)
                            .or_default()
                            .push(entry.path);
                    }
                }
            }
        }
    }

    // Filter out sizes with only 1 file (impossible to be a duplicate)
    let candidate_sizes: Vec<(u64, Vec<PathBuf>)> = size_groups
        .into_iter()
        .filter(|(_, files)| files.len() >= 2)
        .collect();

    // Stage 2: Quick prefix verification (first 4KB)
    let mut prefix_groups: HashMap<(u64, [u8; 32]), Vec<PathBuf>> = HashMap::new();

    for (size, files) in candidate_sizes {
        for file in files {
            if let Ok(bytes) = fs.read_bytes(&file, 4096) {
                let mut hasher = Sha256::new();
                hasher.update(&bytes);
                let hash_arr: [u8; 32] = hasher.finalize().into();
                prefix_groups.entry((size, hash_arr)).or_default().push(file);
            }
        }
    }

    let candidate_prefixes: Vec<(u64, Vec<PathBuf>)> = prefix_groups
        .into_iter()
        .filter(|(_, files)| files.len() >= 2)
        .map(|((sz, _), files)| (sz, files))
        .collect();

    // Stage 3: Full SHA-256 calculation for confirmed candidates
    let mut full_hash_groups: HashMap<(u64, String), Vec<PathBuf>> = HashMap::new();

    for (size, files) in candidate_prefixes {
        for file in files {
            // Read up to 64MB for full verification
            if let Ok(bytes) = fs.read_bytes(&file, 64 * 1024 * 1024) {
                let mut hasher = Sha256::new();
                hasher.update(&bytes);
                let full_hash = format!("{:x}", hasher.finalize());
                full_hash_groups
                    .entry((size, full_hash))
                    .or_default()
                    .push(file);
            }
        }
    }

    let mut result_groups: Vec<DuplicateGroup> = full_hash_groups
        .into_iter()
        .filter(|(_, files)| files.len() >= 2)
        .map(|((size_bytes, hash), files)| {
            let wasted = size_bytes * (files.len() - 1) as u64;
            DuplicateGroup {
                size_bytes,
                wasted_bytes: wasted,
                hash,
                files,
            }
        })
        .collect();

    // Sort by most wasted space first
    result_groups.sort_by(|a, b| b.wasted_bytes.cmp(&a.wasted_bytes));
    if result_groups.len() > max_groups {
        result_groups.truncate(max_groups);
    }

    result_groups
}

/// Replaces a duplicate file with an NTFS/POSIX hard link pointing to the original file.
/// Both paths continue to exist, preserving application and user paths, while reclaiming
/// the duplicate file's physical disk space.
pub fn replace_with_hardlink(
    fs: &dyn ReadFs,
    original: &Path,
    duplicate: &Path,
) -> Result<u64, String> {
    if original == duplicate {
        return Err("Cannot hardlink a file to itself".into());
    }

    // Safety Invariant S2: verify neither path is a protected path
    let env = crate::protected::EnvironmentRoots::default();
    crate::protected::check_protected_path(original, &env)
        .map_err(|e| format!("Protected path check failed for original: {:?}", e))?;
    crate::protected::check_protected_path(duplicate, &env)
        .map_err(|e| format!("Protected path check failed for duplicate: {:?}", e))?;

    let orig_meta = fs
        .metadata(original)
        .map_err(|e| format!("Cannot read metadata of original {}: {}", original.display(), e))?;
    let dup_meta = fs
        .metadata(duplicate)
        .map_err(|e| format!("Cannot read metadata of duplicate {}: {}", duplicate.display(), e))?;

    // Safety Invariant S3: neither file can be a reparse point (symlink/junction)
    if orig_meta.is_reparse_point || dup_meta.is_reparse_point {
        return Err("Reparse points / symlinks cannot be hardlinked (S3 refusal)".into());
    }

    if orig_meta.len != dup_meta.len {
        return Err("Files do not have identical length".into());
    }

    let reclaimed_bytes = dup_meta.len;

    // Check same drive/volume root
    let orig_prefix = original.components().next();
    let dup_prefix = duplicate.components().next();
    if orig_prefix != dup_prefix {
        return Err("Hard links cannot cross different drives or volumes".into());
    }

    // Perform atomic replacement using a temporary backup
    let temp_bak = duplicate.with_extension(format!("dshl_bak_{}", std::process::id()));

    std::fs::rename(duplicate, &temp_bak)
        .map_err(|e| format!("Failed to stage duplicate file for replacement: {}", e))?;

    match std::fs::hard_link(original, duplicate) {
        Ok(()) => {
            let _ = std::fs::remove_file(&temp_bak);
            Ok(reclaimed_bytes)
        }
        Err(e) => {
            let _ = std::fs::rename(&temp_bak, duplicate);
            Err(format!("hard_link failed, reverted original duplicate: {}", e))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::FakeFs;
    use std::time::SystemTime;

    #[test]
    fn test_duplicate_scanner_detects_matching_files() {
        let fake = FakeFs::new();
        let root = PathBuf::from("C:\\Users\\Test\\Documents");
        fake.add_dir(&root);

        let content_a = b"Exact duplicate content payload for unit testing";
        let f1 = root.join("report_v1.docx");
        let f2 = root.join("report_copy.docx");
        let f3 = root.join("unique_other.txt");

        fake.add_file_with_content(&f1, content_a, SystemTime::now());
        fake.add_file_with_content(&f2, content_a, SystemTime::now());
        fake.add_file_with_content(&f3, b"Different unique bytes completely", SystemTime::now());

        let groups = scan_duplicates(&fake, &[root], 10, 50, None);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].files.len(), 2);
        assert_eq!(groups[0].size_bytes, content_a.len() as u64);
        assert_eq!(groups[0].wasted_bytes, content_a.len() as u64);
    }

    #[test]
    fn test_duplicate_scanner_never_follows_reparse_points() {
        let fake = FakeFs::new();
        let root = PathBuf::from("C:\\Users\\Test\\Downloads");
        fake.add_dir(&root);

        let content = b"Duplicate file content";
        let f1 = root.join("file1.iso");
        let junction = root.join("junction_link");
        let sys_target = PathBuf::from("C:\\SystemFiles");
        fake.add_file_with_content(&f1, content, SystemTime::now());
        fake.add_reparse_point(&junction, &sys_target);

        let inside_junction = junction.join("duplicate_inside_symlink.iso");
        fake.add_file_with_content(&inside_junction, content, SystemTime::now());

        let groups = scan_duplicates(&fake, &[root], 5, 50, None);
        // Because junction is a reparse point, it must NOT be traversed
        assert!(groups.is_empty() || groups[0].files.len() == 1);
    }

    #[test]
    fn test_hardlink_deduplication_replaces_duplicate_file() {
        use crate::fs::RealFs;
        let temp_dir = tempfile::tempdir().unwrap();
        let orig = temp_dir.path().join("file1.dat");
        let dup = temp_dir.path().join("file2.dat");

        let content = b"Sample test data for hardlink deduplication test";
        std::fs::write(&orig, content).unwrap();
        std::fs::write(&dup, content).unwrap();

        let fs = RealFs::new();
        let reclaimed = replace_with_hardlink(&fs, &orig, &dup).unwrap();
        assert_eq!(reclaimed, content.len() as u64);

        // Verify both files still exist and have the exact same content
        assert!(orig.exists());
        assert!(dup.exists());
        assert_eq!(std::fs::read(&orig).unwrap(), content);
        assert_eq!(std::fs::read(&dup).unwrap(), content);
    }
}
