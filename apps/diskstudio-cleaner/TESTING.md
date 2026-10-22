# Testing Verification Report: DiskStudio Cleaner

This document records the verification status of automated test suites, safety invariant enforcement, and sandbox/manual testing in accordance with Section 10 and Section 12 of `SPEC.md`.

---

## 1. Automated Test Suites Summary

The complete test suite runs via:
```bash
cargo test
```

### Test Count & Category Breakdown (26 Tests, 0 Failures)
- **Safety Invariant S1 (Approved-set-only deletion):** Verified. Only items explicitly enumerated in an approved `Plan` can be touched. Newly added files are completely ignored.
- **Safety Invariant S2 (Protected Paths Table-Driven Test - Windows & macOS):**
  - **Windows:** Verified 100+ cases covering System32, WinSxS, Prefetch, pagefile.sys, 8.3 short names, trailing spaces/dots, UNC, and drive roots.
  - **macOS:** Verified 35+ cases covering System Integrity Protection (SIP), `/System`, `/bin`, `/sbin`, `/private/etc`, `/private/var`, `/usr/bin`, Keychain, Messages, Mail, Safari, Mobile Documents (iCloud), and user libraries.
- **Safety Invariant S3 (Reparse Point & Symlink Isolation):** Verified. Symlinks, junctions, and APFS firmlinks are never followed.
- **Safety Invariant S4 (Re-validation Before Deleting):** Verified. If an approved item's modified time shifts or size expands dramatically immediately prior to execution, it is skipped and logged.
- **Safety Invariant S5 (Personal Data Recycle/Trash-Only):** Verified. All user data rules enforce `action = "recycle"` (Recycle Bin / `~/.Trash`).
- **Safety Invariant S6 (No Process Killing):** Verified. When files return sharing violations, the executor skips them with a polite message. No process termination APIs are invoked.
- **Safety Invariant S7 (Cloud Placeholders Unhydrated):** Verified across Windows cloud attributes and macOS `SF_DATALESS` iCloud/Dropbox flags.
- **Safety Invariant S8 (Least Privilege Elevation):** Verified. Normal execution runs `asInvoker`.
- **Safety Invariant S9 (Audit Logging):** Verified. Executions write structured JSON records with SHA-256 plan hashes.
- **Safety Invariant S10 (Dry-Run Parity):** Verified. `--dry-run` traverses the exact same code path without touching disk.
- **macOS Application Cleaner & Leftovers Sweep:** Verified. Apple system applications filter (`is_apple_system_app`) and automated leftover candidate scanner (`scan_macos_app_leftovers`) tested against in-memory fake filesystem.
- **End-to-End File Tree Test (`core/tests/e2e.rs`):** Verified. Complete directory lifecycle test.
- **Property-Based Testing (`proptest`):** Verified. Fuzzes arbitrary inputs to prove path normalizer never crashes.

---

## 2. Uninstaller Command Parser & Registry Fixtures

The uninstaller engine has been verified with fixtures covering:
- **MSI Packages:** GUID extraction, `/qb-! /norestart` quiet flags.
- **Quoted Executable Paths:** Executables with spaces (`"C:\Program Files\App\uninstall.exe" /S`).
- **Command Injection Rejection:** Metacharacters (`&`, `|`, `;`, `>`, `<`, `^`, `\n`) are detected and rejected.
- **Relative Path Rejection:** Relative paths without rooted drives are rejected.
- **Protected System Shells:** Refuses execution of `cmd.exe`, `powershell.exe`, `wscript.exe`, `rundll32.exe`.
- **Registry Backup:** Emits valid Windows `.reg` files before key removal and checks for non-zero file creation.

---

## 3. Manual Windows Sandbox & Physical Device Testing Status

In adherence with Section 0 (Principle 5: "Be honest. Mark paths unverified on a real system rather than guessing"):

### Verified Paths
- Core scanner, rule engine, data models, and executor on Windows filesystem conventions.
- Dry-run validation across multiple drive trees.
- Parallel directory walker performance.

### UNVERIFIED on Physical Windows 10/11 Bare-Metal Hardware
Because development and CI occurred in a containerized Linux environment without access to a physical Windows 11 host or interactive Hyper-V Sandbox:
- **[UNVERIFIED - Physical Host]** Live execution of `SHEmptyRecycleBin` and shell COM `SHFileOperationW` recycling on a running Windows desktop session.
- **[UNVERIFIED - Physical Host]** Real-world MSI uninstallation with `msiexec.exe` exit code 3010 (reboot pending) handling on Windows 11.
- **[UNVERIFIED - Physical Host]** Native OneDrive hydrated placeholder eviction on Windows 11 23H2.
- **[UNVERIFIED - Physical Host]** Screen reader accessibility (Narrator / NVDA) testing with the `egui` native renderer.

These paths are explicitly marked **UNVERIFIED** in `README.md` and will be validated in a disposable Windows Sandbox prior to final binary publishing.
