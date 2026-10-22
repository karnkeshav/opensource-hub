# DiskStudio Cleaner — Security & Audit Guide

This document is provided for security auditors, enterprise administrators, and developers to verify that **DiskStudio Cleaner** strictly enforces all safety invariants and that file deletions/modifications are physically impossible without explicit, user-confirmed plans.

---

## 1. Where Does Deletion Happen in the Code?

There is **exactly one place** in the entire codebase where file deletion or recycling can be triggered:

- **Source File:** [`core/src/executor.rs`](file:///mnt/c/Users/keysh/github/opensource-hub/apps/diskstudio-cleaner/core/src/executor.rs)
- **Functions:**
  - `Executor::execute` (Entry point for approved plans)
  - `Executor::execute_single_item` (Re-validation and safety gating)
  - `Executor::delete_permanent` (Removes files/directories through `WriteFs::remove_file` / `WriteFs::remove_dir_all`)
  - `Executor::recycle_item` (Moves files to the Recycle Bin through `WriteFs::recycle`)

### Scanner Cannot Modify the Filesystem
The scanning engine ([`core/src/scanner.rs`](file:///mnt/c/Users/keysh/github/opensource-hub/apps/diskstudio-cleaner/core/src/scanner.rs)) receives **only** a read-only trait object:
```rust
pub struct Scanner<'a> {
    fs: &'a dyn ReadFs,
    ...
}
```
`ReadFs` only exposes `metadata`, `read_dir`, and `free_space`. It contains zero mutation methods (`remove_file`, `remove_dir`, or `recycle`), guaranteeing **by construction** that scanning is strictly read-only.

---

## 2. Verification of Safety Invariants (S1 to S10)

| Invariant | Description | Enforcing Code | Test Location |
| :--- | :--- | :--- | :--- |
| **S1** | **Approved-set-only deletion**<br>Executor accepts only a pre-computed `Plan`. Never scans or deletes unapproved items. | [`core/src/executor.rs`](file:///mnt/c/Users/keysh/github/opensource-hub/apps/diskstudio-cleaner/core/src/executor.rs#L40-L65) | `test_executor_s1_only_approved_items_touched` in `executor.rs` |
| **S2** | **Protected paths refused**<br>Refuses Windows, Program Files, AppData root, user libraries, and critical system files. | [`core/src/protected.rs`](file:///mnt/c/Users/keysh/github/opensource-hub/apps/diskstudio-cleaner/core/src/protected.rs#L190-L340) | `test_table_driven_100_plus_protected_cases` (100+ cases) & proptest |
| **S3** | **Reparse points never followed**<br>Junctions, symlinks, and mount points are never traversed during scan or deletion. | [`core/src/fs.rs`](file:///mnt/c/Users/keysh/github/opensource-hub/apps/diskstudio-cleaner/core/src/fs.rs#L106-L122), [`scanner.rs`](file:///mnt/c/Users/keysh/github/opensource-hub/apps/diskstudio-cleaner/core/src/scanner.rs#L170-L185) | `test_scanner_reparse_points_never_followed` in `scanner.rs` |
| **S4** | **Re-validate before deleting**<br>Stat item immediately before removal; skip if modified or changed into a junction. | [`core/src/executor.rs`](file:///mnt/c/Users/keysh/github/opensource-hub/apps/diskstudio-cleaner/core/src/executor.rs#L85-L160) | `test_executor_s4_revalidation_skips_modified_item` in `executor.rs` |
| **S5** | **Personal data to Recycle Bin**<br>`user-data` rules and user files default unticked and use `recycle`, never permanent delete. | [`core/src/rules.rs`](file:///mnt/c/Users/keysh/github/opensource-hub/apps/diskstudio-cleaner/core/src/rules.rs#L100-L115) | `test_user_data_rule_must_recycle` in `rules.rs` |
| **S6** | **No process killing**<br>Locked files and sharing violations are reported as in-use. Processes are never killed. | [`core/src/executor.rs`](file:///mnt/c/Users/keysh/github/opensource-hub/apps/diskstudio-cleaner/core/src/executor.rs#L190-L215) | `test_executor_s6_in_use_sharing_violation_never_kills` in `executor.rs` |
| **S7** | **Cloud placeholders unhydrated**<br>Placeholder files are detected via attributes and never read. Warns that cloud files delete from cloud. | [`core/src/fs.rs`](file:///mnt/c/Users/keysh/github/opensource-hub/apps/diskstudio-cleaner/core/src/fs.rs#L80-L100), [`scanner.rs`](file:///mnt/c/Users/keysh/github/opensource-hub/apps/diskstudio-cleaner/core/src/scanner.rs#L235-L250) | Covered in `fs.rs` & `scanner.rs` |
| **S8** | **Least privilege elevation**<br>Runs as normal user (`asInvoker`). Elevation only requested for specific helper commands. | Manifest and [`SPEC.md`](file:///mnt/c/Users/keysh/github/opensource-hub/apps/diskstudio-cleaner/SPEC.md) Section 2.2 | Built into release manifest |
| **S9** | **Local audit logging**<br>Every action logged locally to `%LOCALAPPDATA%\DiskStudioCleaner\logs\`. No data leaves machine. | [`core/src/logging.rs`](file:///mnt/c/Users/keysh/github/opensource-hub/apps/diskstudio-cleaner/core/src/logging.rs) | `test_end_to_end_safe_cleaning_flow` in `e2e.rs` |
| **S10**| **Dry-run parity**<br>`--dry-run` follows identical validation logic and plan hash without modifying filesystem. | [`core/src/executor.rs`](file:///mnt/c/Users/keysh/github/opensource-hub/apps/diskstudio-cleaner/core/src/executor.rs#L165-L180) | `test_executor_s10_dry_run_parity` in `executor.rs` |

---

## 3. Network Isolation Audit
To audit that **DiskStudio Cleaner** contains no network, telemetry, or remote communication code:
Run:
```bash
cargo tree
```
Inspect the output. Confirm there are **no** instances of `reqwest`, `hyper`, `tokio-net`, `curl`, `ureq`, `sentry`, or any analytics crates.
DiskStudio Cleaner operates 100% offline.
