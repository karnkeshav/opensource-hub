use diskstudio_core::{
    load_all_builtin_rules, EnvironmentRoots, Executor, Outcome, Plan, PlannedItem, RealFs, Risk,
    Scanner,
};
use std::fs::{create_dir_all, File};
use std::io::Write;
use std::time::{Duration, SystemTime};
use tempfile::tempdir;

#[test]
fn test_end_to_end_safe_cleaning_flow() {
    let tmp = tempdir().expect("Failed to create tempdir");
    let base = tmp.path();

    // Setup simulated user profile structure
    let user_profile = base.join("User");
    let local_app_data = user_profile.join("AppData").join("Local");
    let temp_dir = local_app_data.join("Temp");
    let downloads_dir = user_profile.join("Downloads");

    create_dir_all(&temp_dir).unwrap();
    create_dir_all(&downloads_dir).unwrap();

    // 1. Create old junk file (> 24 hours old) in Temp
    let old_junk = temp_dir.join("old_junk.tmp");
    {
        let mut f = File::create(&old_junk).unwrap();
        f.write_all(b"temporary cache data 123456").unwrap();
    }
    // Set modification time to 2 days ago
    let two_days_ago = SystemTime::now() - Duration::from_secs(2 * 86400);
    filetime::set_file_mtime(&old_junk, filetime::FileTime::from_system_time(two_days_ago)).unwrap();

    // 2. Create fresh file (0 age) in Temp - should be skipped due to min_age_days
    let fresh_file = temp_dir.join("fresh.tmp");
    {
        let mut f = File::create(&fresh_file).unwrap();
        f.write_all(b"active new file").unwrap();
    }

    // 3. Create important user file in Downloads
    let important_doc = downloads_dir.join("financial_report.docx");
    {
        let mut f = File::create(&important_doc).unwrap();
        f.write_all(b"CONFIDENTIAL FINANCIALS").unwrap();
    }

    // Configure EnvironmentRoots pointing to our test sandbox
    let env = EnvironmentRoots {
        system_drive: "C:".into(),
        windir: base.join("Windows"),
        program_files: base.join("Program Files"),
        program_files_x86: base.join("Program Files (x86)"),
        program_data: base.join("ProgramData"),
        user_profile: user_profile.clone(),
        documents: user_profile.join("Documents"),
        desktop: user_profile.join("Desktop"),
        pictures: user_profile.join("Pictures"),
        videos: user_profile.join("Videos"),
        music: user_profile.join("Music"),
        downloads: downloads_dir.clone(),
        onedrive: None,
        dropbox: None,
        google_drive: None,
    };

    let fs = RealFs::new();
    let rules = load_all_builtin_rules().unwrap();

    // Scan
    let scanner = Scanner::new(&fs, env.clone());
    let scan_res = scanner.scan_rules(&rules, None).unwrap();

    // Ensure our old junk was found
    let mut found_old_junk = false;
    for cat in &scan_res.categories {
        for it in &cat.items {
            if it.path == old_junk {
                found_old_junk = true;
                assert_eq!(it.risk, Risk::Safe);
            }
            // Fresh file and docx should not be present
            assert_ne!(it.path, fresh_file, "Fresh file was erroneously included");
            assert_ne!(
                it.path, important_doc,
                "Important user document was erroneously included"
            );
        }
    }
    assert!(found_old_junk, "Old junk was not detected in scan");

    // Plan: build plan with safe items
    let mut planned = Vec::new();
    for cat in &scan_res.categories {
        if cat.risk == Risk::Safe {
            for it in &cat.items {
                planned.push(PlannedItem {
                    id: it.id.clone(),
                    path: it.path.clone(),
                    size_bytes: it.size_bytes,
                    modified: it.modified,
                    kind: it.kind,
                    action: it.action,
                });
            }
        }
    }
    let plan = Plan::new(planned);
    assert!(!plan.plan_hash.is_empty());

    // Dry Run (Invariant S10): touches nothing
    let log_dir = base.join("logs");
    let executor = Executor::new(&fs, env.clone()).with_log_dir(log_dir.clone());
    let dry_res = executor.execute(&plan, true);

    assert_eq!(dry_res.per_item.len(), plan.items.len());
    assert_eq!(dry_res.per_item[0].outcome, Outcome::Removed);
    assert!(old_junk.exists(), "Dry run must not delete files (S10)");

    // Real Run: removes safe junk
    let real_res = executor.execute(&plan, false);
    assert_eq!(real_res.per_item[0].outcome, Outcome::Removed);

    // Assert files state after execution
    assert!(!old_junk.exists(), "Old junk was not deleted");
    assert!(fresh_file.exists(), "Fresh file was modified or deleted");
    assert!(
        important_doc.exists(),
        "Important user doc was deleted or modified"
    );

    // Verify audit log exists on disk (Invariant S9)
    assert!(real_res.log_path.exists());
    let log_content = std::fs::read_to_string(&real_res.log_path).unwrap();
    assert!(log_content.contains("old_junk.tmp"));
}
