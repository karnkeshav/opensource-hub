use crate::model::ExecutionResult;
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub fn get_default_log_dir() -> PathBuf {
    #[cfg(windows)]
    {
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| "C:\\Temp".into());
        PathBuf::from(local_app_data)
            .join("DiskStudioCleaner")
            .join("logs")
    }

    #[cfg(not(windows))]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("DiskStudioCleaner")
            .join("logs")
    }
}

pub fn get_default_backup_dir() -> PathBuf {
    #[cfg(windows)]
    {
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| "C:\\Temp".into());
        PathBuf::from(local_app_data)
            .join("DiskStudioCleaner")
            .join("backups")
    }

    #[cfg(not(windows))]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("DiskStudioCleaner")
            .join("backups")
    }
}

/// Invariant S9: Writes execution summary to plain-text / JSON log file
pub fn write_execution_log(
    result: &ExecutionResult,
    plan_hash: &str,
    log_dir: &Path,
) -> std::io::Result<PathBuf> {
    create_dir_all(log_dir)?;

    let now_ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let log_filename = format!("clean-{}-{}.json", now_ts, &plan_hash[..8.min(plan_hash.len())]);
    let log_path = log_dir.join(log_filename);

    let json_bytes = serde_json::to_vec_pretty(result)?;
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)?;

    file.write_all(&json_bytes)?;
    file.flush()?;

    Ok(log_path)
}
