use crate::fs::{DirEntry, ReadFs};
use crate::model::{
    Category, DriveStats, Flags, Item, ItemKind, Risk, ScanResult,
};
use crate::protected::{check_protected_path, EnvironmentRoots};
use crate::rules::{expand_rule_path, Rule};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

pub struct Scanner<'a> {
    fs: &'a dyn ReadFs,
    env: EnvironmentRoots,
    cancelled: Arc<AtomicBool>,
}

#[derive(Debug, Clone)]
pub struct BiggestFile {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub modified: Option<u64>,
    pub in_cloud: bool,
    pub app_owner: Option<String>,
}

#[derive(Debug, Clone)]
pub struct BiggestFolder {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub file_count: usize,
}

#[derive(Debug, Clone)]
pub struct BiggestDiskUsage {
    pub top_files: Vec<BiggestFile>,
    pub top_folders: Vec<BiggestFolder>,
    pub total_scanned_files: usize,
    pub total_scanned_bytes: u64,
}

impl<'a> Scanner<'a> {
    pub fn new(fs: &'a dyn ReadFs, env: EnvironmentRoots) -> Self {
        Self {
            fs,
            env,
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn with_cancellation(
        fs: &'a dyn ReadFs,
        env: EnvironmentRoots,
        cancelled: Arc<AtomicBool>,
    ) -> Self {
        Self { fs, env, cancelled }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    /// Scans cleanable locations declared in the supplied rules
    pub fn scan_rules(
        &self,
        rules: &[Rule],
        progress: Option<&dyn Fn(&str, u64)>,
    ) -> Result<ScanResult, crate::fs::FsError> {
        let started_at = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            .to_string();

        let mut categories_map: HashMap<String, Category> = HashMap::new();
        let mut total_found_bytes: u64 = 0;

        for rule in rules {
            if self.is_cancelled() {
                break;
            }

            let mut matched_items = Vec::new();

            for path_pattern in &rule.paths {
                if self.is_cancelled() {
                    break;
                }

                let expanded = match expand_rule_path(path_pattern, &self.env) {
                    Some(p) => p,
                    None => continue,
                };

                let matched = self.resolve_and_scan_pattern(&expanded, rule)?;
                for item in matched {
                    total_found_bytes += item.size_bytes;
                    if let Some(cb) = progress {
                        cb(&item.path.to_string_lossy(), total_found_bytes);
                    }
                    matched_items.push(item);
                }
            }

            if !matched_items.is_empty() || !categories_map.contains_key(&rule.category) {
                let cat_bytes: u64 = matched_items.iter().map(|it| it.size_bytes).sum();
                let entry = categories_map
                    .entry(rule.category.clone())
                    .or_insert_with(|| Category {
                        id: rule.category.clone(),
                        title: rule.title.clone(),
                        description: rule.description.clone(),
                        risk: rule.risk,
                        items: Vec::new(),
                        total_bytes: 0,
                        default_selected: rule.risk == Risk::Safe,
                    });
                entry.items.extend(matched_items);
                entry.total_bytes += cat_bytes;
            }
        }

        let finished_at = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            .to_string();

        let free_bytes = self
            .fs
            .free_space(Path::new(&self.env.system_drive))
            .unwrap_or(0);

        let drive_stats = DriveStats {
            mount_point: self.env.system_drive.clone(),
            total_bytes: free_bytes + total_found_bytes,
            free_bytes,
        };

        let mut categories: Vec<Category> = categories_map.into_values().collect();
        categories.sort_by(|a, b| a.id.cmp(&b.id));

        Ok(ScanResult {
            categories,
            drive_stats,
            started_at,
            finished_at,
        })
    }

    /// Resolves wildcards and walks directories for a specific rule pattern
    fn resolve_and_scan_pattern(
        &self,
        pattern: &str,
        rule: &Rule,
    ) -> Result<Vec<Item>, crate::fs::FsError> {
        let mut results = Vec::new();

        #[cfg(not(windows))]
        let normalized = pattern.replace('\\', "/");
        #[cfg(windows)]
        let normalized = pattern.replace('/', "\\");

        let sep = std::path::MAIN_SEPARATOR;
        let parts: Vec<&str> = normalized.split(sep).collect();

        // Find the index of the first component with a wildcard
        let first_wildcard_idx = parts.iter().position(|p| p.contains('*') || p.contains('?'));

        let (base_path, remaining_parts) = match first_wildcard_idx {
            Some(idx) => {
                let base = if parts[0].is_empty() && idx > 0 {
                    // Leading slash on unix (e.g. /tmp/...)
                    format!("/{}", parts[1..idx].join("/"))
                } else {
                    parts[..idx].join(&sep.to_string())
                };
                let rem = parts[idx..].to_vec();
                (PathBuf::from(base), rem)
            }
            None => (PathBuf::from(&normalized), Vec::new()),
        };

        if !self.fs.exists(&base_path) {
            return Ok(results);
        }

        self.match_pattern_recursive(&base_path, &remaining_parts, rule, &mut results)?;
        Ok(results)
    }

    fn match_pattern_recursive(
        &self,
        current_dir: &Path,
        remaining_parts: &[&str],
        rule: &Rule,
        results: &mut Vec<Item>,
    ) -> Result<(), crate::fs::FsError> {
        if self.is_cancelled() {
            return Ok(());
        }

        if remaining_parts.is_empty() {
            // Leaf item (could be directory or file)
            self.evaluate_item(current_dir, rule, results)?;
            return Ok(());
        }

        let part_pattern = remaining_parts[0];
        let next_parts = &remaining_parts[1..];

        let entries = match self.fs.read_dir(current_dir) {
            Ok(e) => e,
            Err(_) => return Ok(()), // Access denied or unreadable silently tolerated (S7.2)
        };

        for entry in entries {
            if self.is_cancelled() {
                break;
            }

            // Invariant S3: Reparse points are NEVER followed during scanning
            if entry.metadata.is_reparse_point {
                continue;
            }

            if self.glob_matches(part_pattern, &entry.name) {
                if next_parts.is_empty() {
                    // Match reached leaf
                    self.evaluate_entry(&entry, rule, results)?;
                } else if entry.metadata.is_dir {
                    // Recurse to next path segment
                    self.match_pattern_recursive(&entry.path, next_parts, rule, results)?;
                }
            }
        }

        Ok(())
    }

    fn evaluate_entry(
        &self,
        entry: &DirEntry,
        rule: &Rule,
        results: &mut Vec<Item>,
    ) -> Result<(), crate::fs::FsError> {
        let path = &entry.path;

        // Invariant S2: Protected paths are refused
        if check_protected_path(path, &self.env).is_err() {
            return Ok(());
        }

        // Check excludes
        let path_str = path.to_string_lossy();
        for excl in &rule.exclude {
            if self.glob_matches(excl, &path_str) {
                return Ok(());
            }
        }

        // Check min_age_days
        if rule.min_age_days > 0 {
            if let Some(mod_time) = entry.metadata.modified {
                let cutoff = SystemTime::now()
                    .checked_sub(Duration::from_secs(rule.min_age_days as u64 * 86400));
                if let Some(c) = cutoff {
                    if mod_time > c {
                        // File is too young; skip
                        return Ok(());
                    }
                }
            }
        }

        let is_cloud = entry.metadata.is_cloud_placeholder || self.is_in_cloud_dir(path);
        let size = if entry.metadata.is_dir {
            self.calculate_dir_size(path)?
        } else {
            entry.metadata.len
        };

        let mod_secs = entry.metadata.modified.and_then(|t| {
            t.duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .ok()
        });

        let kind = if entry.metadata.is_dir {
            ItemKind::Folder
        } else {
            ItemKind::File
        };

        results.push(Item {
            id: format!("{}-{}", rule.id, results.len()),
            kind,
            path: path.clone(),
            size_bytes: size,
            modified: mod_secs,
            owner: None,
            risk: rule.risk,
            action: rule.action,
            flags: Flags {
                in_cloud_folder: is_cloud,
                requires_admin: rule.requires_admin,
                in_use_suspected: false,
                protected: false,
                reparse: entry.metadata.is_reparse_point,
            },
        });

        Ok(())
    }

    fn evaluate_item(
        &self,
        path: &Path,
        rule: &Rule,
        results: &mut Vec<Item>,
    ) -> Result<(), crate::fs::FsError> {
        if let Ok(meta) = self.fs.metadata(path) {
            let entry = DirEntry {
                path: path.to_path_buf(),
                name: path
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default(),
                metadata: meta,
            };
            self.evaluate_entry(&entry, rule, results)?;
        }
        Ok(())
    }

    fn calculate_dir_size(&self, dir: &Path) -> Result<u64, crate::fs::FsError> {
        let mut total = 0u64;
        let mut stack = vec![dir.to_path_buf()];

        while let Some(current) = stack.pop() {
            if self.is_cancelled() {
                break;
            }
            if let Ok(entries) = self.fs.read_dir(&current) {
                for e in entries {
                    // S3: Do not follow reparse points
                    if e.metadata.is_reparse_point {
                        continue;
                    }
                    if e.metadata.is_dir {
                        stack.push(e.path);
                    } else {
                        total += e.metadata.len;
                    }
                }
            }
        }
        Ok(total)
    }

    fn glob_matches(&self, pattern: &str, text: &str) -> bool {
        if pattern == "*" {
            return true;
        }
        if let Ok(pat) = glob::Pattern::new(&pattern.to_lowercase()) {
            pat.matches(&text.to_lowercase())
        } else {
            pattern.eq_ignore_ascii_case(text)
        }
    }

    fn is_in_cloud_dir(&self, path: &Path) -> bool {
        let p = path.to_string_lossy().to_ascii_uppercase();
        if let Some(od) = &self.env.onedrive {
            if p.starts_with(&od.to_string_lossy().to_ascii_uppercase()) {
                return true;
            }
        }
        if let Some(db) = &self.env.dropbox {
            if p.starts_with(&db.to_string_lossy().to_ascii_uppercase()) {
                return true;
            }
        }
        if let Some(gd) = &self.env.google_drive {
            if p.starts_with(&gd.to_string_lossy().to_ascii_uppercase()) {
                return true;
            }
        }
        false
    }

    /// Fast streaming Top-N largest files and folder aggregations (Section 7.2 & Milestone 4)
    pub fn scan_biggest(
        &self,
        root: &Path,
        top_n: usize,
    ) -> Result<BiggestDiskUsage, crate::fs::FsError> {
        self.scan_biggest_with_progress(root, top_n, None)
    }

    /// Fast streaming Top-N largest files and folder aggregations with progress reporting
    pub fn scan_biggest_with_progress(
        &self,
        root: &Path,
        top_n: usize,
        progress: Option<&dyn Fn(&str, usize, u64)>,
    ) -> Result<BiggestDiskUsage, crate::fs::FsError> {
        let mut heap: BinaryHeap<Reverse<(u64, PathBuf, Option<u64>, bool)>> =
            BinaryHeap::with_capacity(top_n + 1);
        let mut folder_sizes: HashMap<PathBuf, (u64, usize)> = HashMap::new();

        let mut stack = vec![root.to_path_buf()];
        let mut total_files = 0usize;
        let mut total_bytes = 0u64;

        while let Some(dir) = stack.pop() {
            if self.is_cancelled() {
                break;
            }

            if let Some(cb) = progress {
                cb(&dir.to_string_lossy(), total_files, total_bytes);
            }

            let entries = match self.fs.read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };

            for entry in entries {
                // Invariant S3: Never follow reparse points
                if entry.metadata.is_reparse_point {
                    continue;
                }

                if entry.metadata.is_dir {
                    stack.push(entry.path);
                } else {
                    let len = entry.metadata.len;
                    total_files += 1;
                    total_bytes += len;

                    let mod_secs = entry.metadata.modified.and_then(|t| {
                        t.duration_since(SystemTime::UNIX_EPOCH)
                            .map(|d| d.as_secs())
                            .ok()
                    });

                    let in_cloud =
                        entry.metadata.is_cloud_placeholder || self.is_in_cloud_dir(&entry.path);

                    // Update streaming top-N min-heap
                    if heap.len() < top_n {
                        heap.push(Reverse((len, entry.path.clone(), mod_secs, in_cloud)));
                    } else if let Some(Reverse((smallest_top, ..))) = heap.peek() {
                        if len > *smallest_top {
                            heap.pop();
                            heap.push(Reverse((len, entry.path.clone(), mod_secs, in_cloud)));
                        }
                    }

                    // Update parent folder aggregate sizes
                    let mut curr = entry.path.parent();
                    while let Some(parent) = curr {
                        if parent == root || !parent.starts_with(root) {
                            break;
                        }
                        let (size, count) = folder_sizes.entry(parent.to_path_buf()).or_insert((0, 0));
                        *size += len;
                        *count += 1;
                        curr = parent.parent();
                    }
                }
            }
        }

        let mut top_files: Vec<BiggestFile> = heap
            .into_iter()
            .map(|Reverse((sz, p, m, ic))| BiggestFile {
                path: p,
                size_bytes: sz,
                modified: m,
                in_cloud: ic,
                app_owner: None,
            })
            .collect();
        top_files.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));

        let mut folder_vec: Vec<BiggestFolder> = folder_sizes
            .into_iter()
            .map(|(p, (sz, cnt))| BiggestFolder {
                path: p,
                size_bytes: sz,
                file_count: cnt,
            })
            .collect();
        folder_vec.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
        folder_vec.truncate(top_n);

        Ok(BiggestDiskUsage {
            top_files,
            top_folders: folder_vec,
            total_scanned_files: total_files,
            total_scanned_bytes: total_bytes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::FakeFs;

    #[test]
    fn test_scanner_reparse_points_never_followed() {
        let fake = FakeFs::new();
        let env = EnvironmentRoots::default();

        let base = PathBuf::from("C:\\Users\\Default\\AppData\\Local\\Temp");
        fake.add_dir(&base);

        let junk_file = base.join("junk.tmp");
        fake.add_file(&junk_file, 1024, SystemTime::now());

        // Create a reparse point (junction) pointing to Windows System32
        let junction = base.join("fake_junction");
        let sys32 = PathBuf::from("C:\\Windows\\System32");
        fake.add_reparse_point(&junction, &sys32);

        let inside_sys32 = junction.join("calc.exe");
        fake.add_file(&inside_sys32, 50000, SystemTime::now());

        let scanner = Scanner::new(&fake, env);
        let rules = crate::rules::load_all_builtin_rules().unwrap();

        let res = scanner.scan_rules(&rules, None).unwrap();
        // The junction target or child must NEVER be returned
        for cat in &res.categories {
            for item in &cat.items {
                assert!(
                    !item.path.to_string_lossy().contains("calc.exe"),
                    "Reparse point target was leaked into scan results: {:?}",
                    item.path
                );
            }
        }
    }

    #[test]
    fn test_scanner_streaming_top_n_oracle() {
        let fake = FakeFs::new();
        let env = EnvironmentRoots::default();

        let root = PathBuf::from("C:\\Data");
        fake.add_dir(&root);

        // Add 10 files with sizes 10..100
        for i in 1..=10 {
            let f = root.join(format!("file_{}.bin", i));
            fake.add_file(&f, i * 10, SystemTime::now());
        }

        let scanner = Scanner::new(&fake, env);
        let biggest = scanner.scan_biggest(&root, 3).unwrap();

        assert_eq!(biggest.top_files.len(), 3);
        assert_eq!(biggest.top_files[0].size_bytes, 100);
        assert_eq!(biggest.top_files[1].size_bytes, 90);
        assert_eq!(biggest.top_files[2].size_bytes, 80);
    }
}
