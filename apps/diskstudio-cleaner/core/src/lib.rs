pub mod docker;
pub mod duplicates;
pub mod executor;
pub mod fs;
pub mod logging;
pub mod model;
pub mod protected;
pub mod rules;
pub mod scanner;
pub mod system_space;
pub mod uninstall;
pub mod user_data;

pub use docker::{analyze_docker_space, execute_docker_prune, DockerAnalysis, DockerCategory};
pub use duplicates::{replace_with_hardlink, scan_duplicates, DuplicateGroup};
pub use executor::Executor;
pub use fs::{DirEntry, FakeFs, FileMetadata, FsError, ReadFs, RealFs, WriteFs};
pub use logging::{get_default_backup_dir, get_default_log_dir, write_execution_log};
pub use model::{
    Action, AppRef, Category, DriveStats, ExecutionResult, Flags, Item, ItemExecutionResult,
    ItemKind, Outcome, Plan, PlannedItem, Risk, ScanResult,
};
pub use protected::{
    check_protected_path, normalize_for_safety, EnvironmentRoots, ProtectedReason,
};
pub use rules::{
    expand_rule_path, has_required_project_manifest, load_all_builtin_rules,
    load_macos_builtin_rules, load_rules_from_str, validate_rule, validate_rules, Rule,
    RuleValidationError,
};
pub use scanner::{BiggestDiskUsage, BiggestFile, BiggestFolder, Scanner};
pub use system_space::{
    execute_system_action, scan_system_space, SystemSpaceItem, SystemSpaceReport,
};
pub use uninstall::{
    discover_installed_apps, export_registry_backup, is_apple_system_app,
    is_denied_or_system_app, parse_safe_uninstall_command, resolve_uninstall_method,
    scan_app_leftovers, scan_macos_app_leftovers, AppType, CommandParseError, InstalledApp,
    UninstallMethod,
};
pub use user_data::{
    scan_big_media, scan_forgotten_files, scan_old_installers, BigMediaFile, ForgottenFile,
    OldInstaller,
};
