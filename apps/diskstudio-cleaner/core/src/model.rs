use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::SystemTime;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Risk {
    Safe,
    UserData,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ItemKind {
    File,
    Folder,
    App,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    Delete,
    Recycle,
    Uninstall,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Flags {
    pub in_cloud_folder: bool,
    pub requires_admin: bool,
    pub in_use_suspected: bool,
    pub protected: bool,
    pub reparse: bool,
}

impl Default for Flags {
    fn default() -> Self {
        Self {
            in_cloud_folder: false,
            requires_admin: false,
            in_use_suspected: false,
            protected: false,
            reparse: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppRef {
    pub id: String,
    pub name: String,
    pub publisher: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub kind: ItemKind,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub modified: Option<u64>, // Unix timestamp in seconds
    pub owner: Option<AppRef>,
    pub risk: Risk,
    pub action: Action,
    pub flags: Flags,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Category {
    pub id: String,
    pub title: String,
    pub description: String,
    pub risk: Risk,
    pub items: Vec<Item>,
    pub total_bytes: u64,
    pub default_selected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DriveStats {
    pub mount_point: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanResult {
    pub categories: Vec<Category>,
    pub drive_stats: DriveStats,
    pub started_at: String,
    pub finished_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlannedItem {
    pub id: String,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub modified: Option<u64>,
    pub kind: ItemKind,
    pub action: Action,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    pub items: Vec<PlannedItem>,
    pub created_at: String,
    pub total_bytes: u64,
    pub plan_hash: String,
}

impl Plan {
    pub fn new(mut items: Vec<PlannedItem>) -> Self {
        // Enforce deterministic canonical ordering by path string
        items.sort_by(|a, b| a.path.cmp(&b.path));

        let total_bytes: u64 = items.iter().map(|it| it.size_bytes).sum();

        let mut hasher = Sha256::new();
        for item in &items {
            hasher.update(item.path.to_string_lossy().as_bytes());
            hasher.update(b"|");
            hasher.update(item.size_bytes.to_le_bytes());
            hasher.update(b"|");
            hasher.update(item.modified.unwrap_or(0).to_le_bytes());
            hasher.update(b"|");
            hasher.update(format!("{:?}", item.action).as_bytes());
            hasher.update(b"\n");
        }
        let plan_hash = format!("{:x}", hasher.finalize());

        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_else(|_| "0".into());

        Self {
            items,
            created_at: now,
            total_bytes,
            plan_hash,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Removed,
    Recycled,
    Skipped(String),
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemExecutionResult {
    pub item_id: String,
    pub path: PathBuf,
    pub outcome: Outcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionResult {
    pub per_item: Vec<ItemExecutionResult>,
    pub bytes_freed_measured: u64,
    pub log_path: PathBuf,
}
