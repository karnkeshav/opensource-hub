use crate::fs::{FsError, WriteFs};
use crate::logging::{get_default_log_dir, write_execution_log};
use crate::model::{
    Action, ExecutionResult, ItemExecutionResult, ItemKind, Outcome, Plan, PlannedItem,
};
use crate::protected::{check_protected_path, EnvironmentRoots};
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::{Duration, SystemTime};

pub struct Executor<'a> {
    fs: &'a dyn WriteFs,
    env: EnvironmentRoots,
    log_dir: Option<PathBuf>,
}

impl<'a> Executor<'a> {
    pub fn new(fs: &'a dyn WriteFs, env: EnvironmentRoots) -> Self {
        Self {
            fs,
            env,
            log_dir: None,
        }
    }

    pub fn with_log_dir(mut self, log_dir: PathBuf) -> Self {
        self.log_dir = Some(log_dir);
        self
    }

    /// Executes the user-approved Plan.
    /// If `dry_run` is true, runs identical validation and logging without modifying filesystem (S10).
    pub fn execute(&self, plan: &Plan, dry_run: bool) -> ExecutionResult {
        let initial_free_space = self
            .fs
            .free_space(Path::new(&self.env.system_drive))
            .unwrap_or(0);

        let mut per_item_results = Vec::new();

        // Invariant S1: Only items present in the approved plan are touched
        for planned_item in &plan.items {
            let item_result = self.execute_single_item(planned_item, dry_run);
            per_item_results.push(item_result);
        }

        let final_free_space = self
            .fs
            .free_space(Path::new(&self.env.system_drive))
            .unwrap_or(initial_free_space);

        let bytes_freed_measured = if final_free_space > initial_free_space {
            final_free_space - initial_free_space
        } else {
            0
        };

        let log_dir = self.log_dir.clone().unwrap_or_else(get_default_log_dir);
        let mut result = ExecutionResult {
            per_item: per_item_results,
            bytes_freed_measured,
            log_path: log_dir.join("pending.log"),
        };

        // Invariant S9: Write audit execution log
        if let Ok(path) = write_execution_log(&result, &plan.plan_hash, &log_dir) {
            result.log_path = path;
        }

        result
    }

    fn execute_single_item(&self, item: &PlannedItem, dry_run: bool) -> ItemExecutionResult {
        // Invariant S2: Protected paths are refused at the executor level unconditionally
        if let Err(reason) = check_protected_path(&item.path, &self.env) {
            return ItemExecutionResult {
                item_id: item.id.clone(),
                path: item.path.clone(),
                outcome: Outcome::Skipped(format!("Protected path refused (S2): {}", reason)),
            };
        }

        // Invariant S4: Re-validate immediately before removing
        let current_meta = match self.fs.metadata(&item.path) {
            Ok(m) => m,
            Err(FsError::NotFound(_)) => {
                return ItemExecutionResult {
                    item_id: item.id.clone(),
                    path: item.path.clone(),
                    outcome: Outcome::Skipped("Item no longer exists on disk (S4)".into()),
                };
            }
            Err(e) => {
                return ItemExecutionResult {
                    item_id: item.id.clone(),
                    path: item.path.clone(),
                    outcome: Outcome::Failed(format!("Re-validation stat failed: {}", e)),
                };
            }
        };

        // Invariant S3: Never follow or delete unintended reparse points
        if current_meta.is_reparse_point {
            return ItemExecutionResult {
                item_id: item.id.clone(),
                path: item.path.clone(),
                outcome: Outcome::Skipped("Reparse point or symlink detected (S3)".into()),
            };
        }

        // Check if item kind changed
        if (item.kind == ItemKind::File && current_meta.is_dir)
            || (item.kind == ItemKind::Folder && !current_meta.is_dir)
        {
            return ItemExecutionResult {
                item_id: item.id.clone(),
                path: item.path.clone(),
                outcome: Outcome::Skipped(
                    "Item type changed on disk since plan creation (S4)".into(),
                ),
            };
        }

        // Re-check modified time and size for significant changes
        if let Some(planned_mod) = item.modified {
            if let Some(curr_mod) = current_meta.modified {
                if let Ok(curr_secs) = curr_mod.duration_since(SystemTime::UNIX_EPOCH) {
                    if curr_secs.as_secs() > planned_mod + 300 {
                        // Modified more than 5 minutes after plan creation
                        return ItemExecutionResult {
                            item_id: item.id.clone(),
                            path: item.path.clone(),
                            outcome: Outcome::Skipped(
                                "File was modified since plan was created (S4)".into(),
                            ),
                        };
                    }
                }
            }
        }

        if item.kind == ItemKind::File && item.size_bytes > 0 {
            // If file size grew by more than 5x or 50MB, skip as volatile
            if current_meta.len > item.size_bytes.saturating_mul(5)
                && current_meta.len.saturating_sub(item.size_bytes) > 50 * 1024 * 1024
            {
                return ItemExecutionResult {
                    item_id: item.id.clone(),
                    path: item.path.clone(),
                    outcome: Outcome::Skipped(
                        "File size expanded significantly since plan creation (S4)".into(),
                    ),
                };
            }
        }

        // Dry-run parity (Invariant S10)
        if dry_run {
            let outcome = match item.action {
                Action::Delete => Outcome::Removed,
                Action::Recycle => Outcome::Recycled,
                Action::Uninstall => Outcome::Removed,
            };
            return ItemExecutionResult {
                item_id: item.id.clone(),
                path: item.path.clone(),
                outcome,
            };
        }

        // Perform actual action
        match item.action {
            Action::Delete => self.delete_permanent(item, &current_meta),
            Action::Recycle => self.recycle_item(item),
            Action::Uninstall => {
                // Handled via uninstall engine, fallback to recycling
                self.recycle_item(item)
            }
        }
    }

    fn delete_permanent(
        &self,
        item: &PlannedItem,
        current_meta: &crate::fs::FileMetadata,
    ) -> ItemExecutionResult {
        let res = if current_meta.is_dir {
            self.fs.remove_dir_all(&item.path)
        } else {
            self.remove_file_with_retry(&item.path)
        };

        match res {
            Ok(()) => ItemExecutionResult {
                item_id: item.id.clone(),
                path: item.path.clone(),
                outcome: Outcome::Removed,
            },
            Err(FsError::SharingViolation(_)) => ItemExecutionResult {
                item_id: item.id.clone(),
                path: item.path.clone(),
                outcome: Outcome::Skipped(
                    "File is currently in use; close application and retry (S6)".into(),
                ),
            },
            Err(FsError::AccessDenied(_)) => ItemExecutionResult {
                item_id: item.id.clone(),
                path: item.path.clone(),
                outcome: Outcome::Skipped("Access denied by operating system".into()),
            },
            Err(e) => ItemExecutionResult {
                item_id: item.id.clone(),
                path: item.path.clone(),
                outcome: Outcome::Failed(e.to_string()),
            },
        }
    }

    fn recycle_item(&self, item: &PlannedItem) -> ItemExecutionResult {
        match self.fs.recycle(&item.path) {
            Ok(()) => ItemExecutionResult {
                item_id: item.id.clone(),
                path: item.path.clone(),
                outcome: Outcome::Recycled,
            },
            Err(FsError::SharingViolation(_)) => ItemExecutionResult {
                item_id: item.id.clone(),
                path: item.path.clone(),
                outcome: Outcome::Skipped(
                    "File is in use; close application and retry (S6)".into(),
                ),
            },
            Err(e) => ItemExecutionResult {
                item_id: item.id.clone(),
                path: item.path.clone(),
                outcome: Outcome::Failed(e.to_string()),
            },
        }
    }

    fn remove_file_with_retry(&self, path: &Path) -> Result<(), FsError> {
        let first_try = self.fs.remove_file(path);
        if let Err(FsError::SharingViolation(_)) = &first_try {
            // Transient lock retry once after 50ms (Section 7.4)
            sleep(Duration::from_millis(50));
            self.fs.remove_file(path)
        } else {
            first_try
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::{FakeFs, ReadFs};
    use crate::model::Plan;

    #[test]
    fn test_executor_s1_only_approved_items_touched() {
        let fake = FakeFs::new();
        let env = EnvironmentRoots::default();
        let dir = PathBuf::from("C:\\Users\\Default\\AppData\\Local\\Temp");
        fake.add_dir(&dir);

        let approved_file = dir.join("approved.tmp");
        let unapproved_file = dir.join("unapproved.tmp");
        fake.add_file(&approved_file, 100, SystemTime::now());
        fake.add_file(&unapproved_file, 200, SystemTime::now());

        let planned = vec![PlannedItem {
            id: "1".into(),
            path: approved_file.clone(),
            size_bytes: 100,
            modified: None,
            kind: ItemKind::File,
            action: Action::Delete,
        }];
        let plan = Plan::new(planned);

        let executor = Executor::new(&fake, env);
        let res = executor.execute(&plan, false);

        assert_eq!(res.per_item.len(), 1);
        assert_eq!(res.per_item[0].outcome, Outcome::Removed);

        // Verify approved file was removed and unapproved file was untouched!
        assert!(!fake.exists(&approved_file));
        assert!(fake.exists(&unapproved_file));
    }

    #[test]
    fn test_executor_s2_protected_path_refusal() {
        let fake = FakeFs::new();
        let env = EnvironmentRoots::default();

        let sys32_file = PathBuf::from("C:\\Windows\\System32\\calc.exe");
        fake.add_file(&sys32_file, 50000, SystemTime::now());

        let planned = vec![PlannedItem {
            id: "s2-test".into(),
            path: sys32_file.clone(),
            size_bytes: 50000,
            modified: None,
            kind: ItemKind::File,
            action: Action::Delete,
        }];
        let plan = Plan::new(planned);

        let executor = Executor::new(&fake, env);
        let res = executor.execute(&plan, false);

        assert_eq!(res.per_item.len(), 1);
        match &res.per_item[0].outcome {
            Outcome::Skipped(reason) => assert!(reason.contains("Protected path refused (S2)")),
            other => panic!("Expected protected path to be skipped, got {:?}", other),
        }
        // File must remain on disk
        assert!(fake.exists(&sys32_file));
    }

    #[test]
    fn test_executor_s4_revalidation_skips_modified_item() {
        let fake = FakeFs::new();
        let env = EnvironmentRoots::default();
        let dir = PathBuf::from("C:\\Users\\Default\\AppData\\Local\\Temp");
        fake.add_dir(&dir);

        let file = dir.join("cache.tmp");
        let initial_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1000);
        fake.add_file(&file, 100, initial_time);

        let planned = vec![PlannedItem {
            id: "s4-test".into(),
            path: file.clone(),
            size_bytes: 100,
            modified: Some(1000),
            kind: ItemKind::File,
            action: Action::Delete,
        }];
        let plan = Plan::new(planned);

        // Now modify the file on disk (simulate another app updating it)
        let later_time = SystemTime::UNIX_EPOCH + Duration::from_secs(2000);
        fake.add_file(&file, 100, later_time);

        let executor = Executor::new(&fake, env);
        let res = executor.execute(&plan, false);

        match &res.per_item[0].outcome {
            Outcome::Skipped(reason) => assert!(reason.contains("File was modified since plan")),
            other => panic!("Expected modified file to be skipped, got {:?}", other),
        }
        assert!(fake.exists(&file));
    }

    #[test]
    fn test_executor_s10_dry_run_parity() {
        let fake = FakeFs::new();
        let env = EnvironmentRoots::default();
        let dir = PathBuf::from("C:\\Users\\Default\\AppData\\Local\\Temp");
        fake.add_dir(&dir);

        let file = dir.join("test.tmp");
        fake.add_file(&file, 500, SystemTime::now());

        let planned = vec![PlannedItem {
            id: "dry-run".into(),
            path: file.clone(),
            size_bytes: 500,
            modified: None,
            kind: ItemKind::File,
            action: Action::Delete,
        }];
        let plan = Plan::new(planned);

        let executor = Executor::new(&fake, env);
        let res = executor.execute(&plan, true); // dry_run = true

        assert_eq!(res.per_item[0].outcome, Outcome::Removed);
        // File must NOT be deleted in dry run mode
        assert!(fake.exists(&file));
    }

    #[test]
    fn test_executor_s6_in_use_sharing_violation_never_kills() {
        let fake = FakeFs::new();
        let env = EnvironmentRoots::default();
        let dir = PathBuf::from("C:\\Users\\Default\\AppData\\Local\\Temp");
        fake.add_dir(&dir);

        let file = dir.join("locked.log");
        fake.add_file(&file, 2048, SystemTime::now());
        fake.set_in_use(&file, true);

        let planned = vec![PlannedItem {
            id: "s6-test".into(),
            path: file.clone(),
            size_bytes: 2048,
            modified: None,
            kind: ItemKind::File,
            action: Action::Delete,
        }];
        let plan = Plan::new(planned);

        let executor = Executor::new(&fake, env);
        let res = executor.execute(&plan, false);

        match &res.per_item[0].outcome {
            Outcome::Skipped(reason) => assert!(reason.contains("File is currently in use")),
            other => panic!("Expected in-use file to be skipped, got {:?}", other),
        }
        assert!(fake.exists(&file));
    }
}
