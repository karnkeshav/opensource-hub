use crate::model::{Action, Risk};
use crate::protected::{check_protected_path, EnvironmentRoots};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    pub category: String,
    pub title: String,
    pub description: String,
    pub risk: Risk,
    pub action: Action,
    pub paths: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
    #[serde(default)]
    pub min_age_days: u32,
    #[serde(default)]
    pub requires_admin: bool,
    #[serde(default)]
    pub requires_closed: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RulesFile {
    rule: Vec<Rule>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuleValidationError {
    UserDataMustRecycle(String),
    UnknownRoot(String),
    MatchesProtectedPath { rule_id: String, path: String },
    InvalidToml(String),
    EmptyPaths(String),
}

impl std::fmt::Display for RuleValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RuleValidationError::UserDataMustRecycle(id) => write!(
                f,
                "Rule '{}' with risk='user-data' must use action='recycle' (Invariant S5)",
                id
            ),
            RuleValidationError::UnknownRoot(p) => {
                write!(f, "Rule path '{}' does not resolve under a known root", p)
            }
            RuleValidationError::MatchesProtectedPath { rule_id, path } => write!(
                f,
                "Rule '{}' specifies protected path '{}' (Invariant S2 violation)",
                rule_id, path
            ),
            RuleValidationError::InvalidToml(err) => write!(f, "Invalid rules TOML: {}", err),
            RuleValidationError::EmptyPaths(id) => write!(f, "Rule '{}' has no paths specified", id),
        }
    }
}

impl std::error::Error for RuleValidationError {}

pub const BUILTIN_TEMP_TOML: &str = include_str!("../rules/temp.toml");
pub const BUILTIN_BROWSERS_TOML: &str = include_str!("../rules/browsers.toml");
pub const BUILTIN_APPS_TOML: &str = include_str!("../rules/apps.toml");
pub const BUILTIN_DEV_TOML: &str = include_str!("../rules/dev.toml");
pub const BUILTIN_SYSTEM_TOML: &str = include_str!("../rules/system.toml");
pub const BUILTIN_DOWNLOADS_TOML: &str = include_str!("../rules/downloads.toml");

pub const BUILTIN_MACOS_TEMP_TOML: &str = include_str!("../rules/macos_temp.toml");
pub const BUILTIN_MACOS_BROWSERS_TOML: &str = include_str!("../rules/macos_browsers.toml");
pub const BUILTIN_MACOS_APPS_TOML: &str = include_str!("../rules/macos_apps.toml");
pub const BUILTIN_MACOS_DEV_TOML: &str = include_str!("../rules/macos_dev.toml");
pub const BUILTIN_MACOS_SYSTEM_TOML: &str = include_str!("../rules/macos_system.toml");
pub const BUILTIN_MACOS_DOWNLOADS_TOML: &str = include_str!("../rules/macos_downloads.toml");

pub fn load_rules_from_str(toml_str: &str) -> Result<Vec<Rule>, RuleValidationError> {
    let parsed: RulesFile =
        toml::from_str(toml_str).map_err(|e| RuleValidationError::InvalidToml(e.to_string()))?;
    Ok(parsed.rule)
}

pub fn load_all_builtin_rules() -> Result<Vec<Rule>, RuleValidationError> {
    let mut all_rules = Vec::new();
    #[cfg(target_os = "macos")]
    let rule_sources = [
        BUILTIN_MACOS_TEMP_TOML,
        BUILTIN_MACOS_BROWSERS_TOML,
        BUILTIN_MACOS_APPS_TOML,
        BUILTIN_MACOS_DEV_TOML,
        BUILTIN_MACOS_SYSTEM_TOML,
        BUILTIN_MACOS_DOWNLOADS_TOML,
    ];

    #[cfg(not(target_os = "macos"))]
    let rule_sources = [
        BUILTIN_TEMP_TOML,
        BUILTIN_BROWSERS_TOML,
        BUILTIN_APPS_TOML,
        BUILTIN_DEV_TOML,
        BUILTIN_SYSTEM_TOML,
        BUILTIN_DOWNLOADS_TOML,
    ];

    for toml_str in rule_sources {
        let rules = load_rules_from_str(toml_str)?;
        all_rules.extend(rules);
    }
    Ok(all_rules)
}

pub fn load_macos_builtin_rules() -> Result<Vec<Rule>, RuleValidationError> {
    let mut all_rules = Vec::new();
    for toml_str in [
        BUILTIN_MACOS_TEMP_TOML,
        BUILTIN_MACOS_BROWSERS_TOML,
        BUILTIN_MACOS_APPS_TOML,
        BUILTIN_MACOS_DEV_TOML,
        BUILTIN_MACOS_SYSTEM_TOML,
        BUILTIN_MACOS_DOWNLOADS_TOML,
    ] {
        let rules = load_rules_from_str(toml_str)?;
        all_rules.extend(rules);
    }
    Ok(all_rules)
}

/// Expands `%VAR%` and `~/` placeholders in a rule path using the provided `EnvironmentRoots`
pub fn expand_rule_path(path_pattern: &str, env: &EnvironmentRoots) -> Option<String> {
    let mut expanded = path_pattern.to_string();

    // Support macOS home tilde prefix (~/)
    if expanded.starts_with("~/") || expanded.starts_with("~\\") {
        let home = env.user_profile.to_string_lossy();
        expanded = format!("{}{}", home, &expanded[1..]);
        return Some(expanded);
    }

    // Support Unix absolute root paths (/tmp, /private/tmp, /Library)
    if expanded.starts_with("/tmp") || expanded.starts_with("/private/tmp") || expanded.starts_with("/Library") {
        return Some(expanded);
    }

    let local_app_data = env.user_profile.join("AppData").join("Local");
    let app_data = env.user_profile.join("AppData").join("Roaming");
    let temp_dir = local_app_data.join("Temp");

    let replacements = [
        ("%LOCALAPPDATA%", local_app_data.to_string_lossy().to_string()),
        ("%APPDATA%", app_data.to_string_lossy().to_string()),
        ("%TEMP%", temp_dir.to_string_lossy().to_string()),
        ("%WINDIR%", env.windir.to_string_lossy().to_string()),
        ("%SYSTEMROOT%", env.windir.to_string_lossy().to_string()),
        ("%PROGRAMDATA%", env.program_data.to_string_lossy().to_string()),
        ("%USERPROFILE%", env.user_profile.to_string_lossy().to_string()),
        ("%PROGRAMFILES%", env.program_files.to_string_lossy().to_string()),
        (
            "%PROGRAMFILES(X86)%",
            env.program_files_x86.to_string_lossy().to_string(),
        ),
    ];

    let mut matched_known_root = false;
    for (placeholder, val) in &replacements {
        if expanded.contains(placeholder) {
            matched_known_root = true;
            expanded = expanded.replace(placeholder, val);
        }
    }

    if !matched_known_root {
        return None;
    }

    Some(expanded)
}

/// Validates a single rule against safety invariants:
/// 1. `risk == Risk::UserData` requires `action == Action::Recycle` (Invariant S5)
/// 2. Must have non-empty paths
/// 3. All paths must resolve under a known root
/// 4. Base directory of pattern must not be a protected path (Invariant S2)
pub fn validate_rule(rule: &Rule, env: &EnvironmentRoots) -> Result<(), RuleValidationError> {
    if rule.risk == Risk::UserData && rule.action != Action::Recycle {
        return Err(RuleValidationError::UserDataMustRecycle(rule.id.clone()));
    }

    if rule.paths.is_empty() {
        return Err(RuleValidationError::EmptyPaths(rule.id.clone()));
    }

    for path_pattern in &rule.paths {
        let expanded = expand_rule_path(path_pattern, env)
            .ok_or_else(|| RuleValidationError::UnknownRoot(path_pattern.clone()))?;

        // Extract base directory prior to any glob wildcard
        let base_str = if let Some(idx) = expanded.find('*') {
            let prefix = &expanded[..idx];
            prefix.trim_end_matches(['\\', '/']).to_string()
        } else {
            expanded.clone()
        };

        let base_path = PathBuf::from(&base_str);
        // The base directory or any target must not violate protected path invariant S2
        if let Err(_reason) = check_protected_path(&base_path, env) {
            return Err(RuleValidationError::MatchesProtectedPath {
                rule_id: rule.id.clone(),
                path: base_str,
            });
        }
    }

    Ok(())
}

/// Validates all rules in a list
pub fn validate_rules(rules: &[Rule], env: &EnvironmentRoots) -> Result<(), RuleValidationError> {
    for rule in rules {
        validate_rule(rule, env)?;
    }
    Ok(())
}

/// Sibling manifest check for dependency folders (node_modules, target, .venv, build)
pub fn has_required_project_manifest(dir: &Path) -> bool {
    if let Some(parent) = dir.parent() {
        let dir_name = dir
            .file_name()
            .map(|s| s.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();

        match dir_name.as_str() {
            "node_modules" => {
                parent.join("package.json").exists() || parent.join("package-lock.json").exists()
            }
            "target" => parent.join("Cargo.toml").exists(),
            ".venv" | "venv" => {
                parent.join("requirements.txt").exists()
                    || parent.join("pyproject.toml").exists()
                    || parent.join("Pipfile").exists()
            }
            "build" | "dist" => {
                parent.join("package.json").exists()
                    || parent.join("CMakeLists.txt").exists()
                    || parent.join("Makefile").exists()
            }
            _ => false,
        }
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_all_builtin_rules_are_valid() {
        let env = EnvironmentRoots::default();
        let rules = load_all_builtin_rules().expect("Built-in rules should parse correctly");
        assert!(!rules.is_empty(), "Built-in rules should not be empty");

        for rule in &rules {
            validate_rule(rule, &env).unwrap_or_else(|e| {
                panic!("Rule '{}' failed validation: {}", rule.id, e);
            });
        }
    }

    #[test]
    fn test_all_macos_builtin_rules_are_valid() {
        let env = EnvironmentRoots::macos_default(Path::new("/Users/Default"));
        let macos_rules =
            load_macos_builtin_rules().expect("macOS built-in rules should parse correctly");
        assert!(!macos_rules.is_empty());

        for rule in &macos_rules {
            validate_rule(rule, &env).unwrap_or_else(|e| {
                panic!("macOS Rule '{}' failed validation: {}", rule.id, e);
            });
        }
    }

    #[test]
    fn test_user_data_rule_must_recycle() {
        let env = EnvironmentRoots::default();
        let invalid_rule = Rule {
            id: "bad-user-data".into(),
            category: "downloads".into(),
            title: "Bad Rule".into(),
            description: "Violates S5".into(),
            risk: Risk::UserData,
            action: Action::Delete, // S5 violation: UserData cannot be Delete
            paths: vec!["%USERPROFILE%\\Downloads\\*.exe".into()],
            exclude: vec![],
            min_age_days: 0,
            requires_admin: false,
            requires_closed: vec![],
        };

        let err = validate_rule(&invalid_rule, &env).unwrap_err();
        match err {
            RuleValidationError::UserDataMustRecycle(id) => assert_eq!(id, "bad-user-data"),
            _ => panic!("Expected UserDataMustRecycle, got {:?}", err),
        }
    }

    #[test]
    fn test_rule_targeting_protected_path_rejected() {
        let env = EnvironmentRoots::default();
        let bad_protected_rule = Rule {
            id: "bad-system32".into(),
            category: "system".into(),
            title: "Malicious System32 Cleaner".into(),
            description: "Violates S2".into(),
            risk: Risk::Safe,
            action: Action::Delete,
            paths: vec!["%WINDIR%\\System32\\*".into()], // S2 violation!
            exclude: vec![],
            min_age_days: 0,
            requires_admin: true,
            requires_closed: vec![],
        };

        let err = validate_rule(&bad_protected_rule, &env).unwrap_err();
        match err {
            RuleValidationError::MatchesProtectedPath { rule_id, .. } => {
                assert_eq!(rule_id, "bad-system32")
            }
            _ => panic!("Expected MatchesProtectedPath, got {:?}", err),
        }
    }

    #[test]
    fn test_rule_with_unknown_root_rejected() {
        let env = EnvironmentRoots::default();
        let unknown_root_rule = Rule {
            id: "unknown-root".into(),
            category: "temp".into(),
            title: "Unknown root".into(),
            description: "Unknown root placeholder".into(),
            risk: Risk::Safe,
            action: Action::Delete,
            paths: vec!["%CUSTOM_UNKNOWN_VAR%\\Temp\\*".into()],
            exclude: vec![],
            min_age_days: 0,
            requires_admin: false,
            requires_closed: vec![],
        };

        let err = validate_rule(&unknown_root_rule, &env).unwrap_err();
        match err {
            RuleValidationError::UnknownRoot(p) => {
                assert!(p.contains("%CUSTOM_UNKNOWN_VAR%"))
            }
            _ => panic!("Expected UnknownRoot, got {:?}", err),
        }
    }
}
