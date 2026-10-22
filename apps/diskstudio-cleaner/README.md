# DiskStudio Cleaner (Windows & macOS)

**DiskStudio Cleaner** is a free, open-source, offline desktop utility designed to safely and transparently free disk space across **Windows 10/11** and **macOS (Apple Silicon & Intel)**.

A user runs the single portable application and sees three simple screens:
1. **Clean up:** Finds known-safe temporary files, caches, and unnecessary installers.
2. **Biggest space users:** Identifies the largest files, aggregate folders, and installed apps (`.exe`/Store on Windows, `.app` bundles on macOS) so you can free the most space with clean uninstalls.
3. **Done:** Provides a transparent report of what was removed, what was skipped, and measured free space.

---

## Defining Safety Principle: Show, Then Ask, Then Act

Unlike predatory cleaners, DiskStudio Cleaner:
- **Never deletes anything automatically.**
- **Never modifies the registry** except for backing up and removing keys belonging strictly to an uninstalled Windows app.
- **Enforces macOS System Integrity Protection (SIP) & Windows protected paths** at the core filesystem level.
- **Never terminates running processes** to force-delete files.
- **Never follows symlinks, directory junctions, or APFS firmlinks (S3)**, preventing accidental data destruction across drives.
- **Moves user items to Trash / Recycle Bin (S5)** with full undo capability.

---

## What DiskStudio Cleaner Removes

### 1. Safe Categories (Pre-selected, Permanent Deletion Allowed)
- **Temporary Files:**
  - Windows: `%TEMP%` and `%WINDIR%\Temp` (> 24 hours old).
  - macOS: `$TMPDIR/*` and `/tmp/*` (> 24 hours old).
- **Recycle Bin / macOS Trash:**
  - Emptied cleanly via Windows Shell API or user `~/.Trash`.
- **Browser Caches:**
  - Safari (WebKit caches in `~/Library/Caches/com.apple.Safari`), Google Chrome, Microsoft Edge, Mozilla Firefox, Brave Browser.
  - *Never touches passwords, cookies, browsing history, bookmarks, sessions, or saved credentials.*
- **Application Caches:**
  - Microsoft Teams, Slack, Discord, Spotify, Zoom, Microsoft Office document cache.
- **Developer Caches:**
  - macOS: Xcode `DerivedData`, iOS/watchOS `DeviceSupport` debug symbols, Homebrew cache (`~/Library/Caches/Homebrew`), CocoaPods cache (`~/Library/Caches/CocoaPods`).
  - Cross-platform: npm package cache, Python `pip` cache, Rust `Cargo` cache, Gradle cache, NuGet package cache, VS Code extension cache, Yarn & pnpm stores.
- **System Caches:**
  - Windows Update download cache (`SoftwareDistribution\Download`), crash minidumps, WER error reports.
  - macOS: DiagnosticReports (`~/Library/Logs/DiagnosticReports`), QuickLook thumbnail cache.

### 2. Your Files (Unticked by Default, Recycle Bin / Trash Only)
- **Old Downloaded Installers:**
  - Windows: `.exe`, `.msi`, `.iso`, `.zip` in `Downloads` older than 90 days.
  - macOS: `.dmg`, `.pkg`, `.iso`, `.zip` in `~/Downloads` older than 90 days.
  - *Always sent to the Recycle Bin / Trash with undo capability, never permanently deleted.*
- **Stale Project Dependency Folders:** `node_modules`, `target`, `.venv`, and `build` folders unmodified for 90+ days (validated with sibling manifests).

---

## macOS Application Uninstaller & Leftover Sweep

On macOS, DiskStudio Cleaner inspects `.app` bundles in `/Applications` and `~/Applications`:
1. **Safety Filter:** Never offers Apple system apps (Safari, Mail, Finder, System Settings, Music, Photos, Terminal, etc.).
2. **Move to Trash:** Sends the `.app` bundle to `~/.Trash`.
3. **Leftover Sweep:** Automatically finds leftover remnants by Bundle ID and name:
   - `~/Library/Application Support/<BundleID | Name>`
   - `~/Library/Caches/<BundleID>`
   - `~/Library/Preferences/<BundleID>.plist`
   - `~/Library/Saved Application State/<BundleID>.savedState`
   - `~/Library/Containers/<BundleID>`
   - `~/Library/Logs/<BundleID | Name>`
   - Remnants are presented in a review list (unticked by default if containing user data) and moved to `~/.Trash`.

For full macOS specifications, see [`SPEC_MACOS.md`](SPEC_MACOS.md).

---

## What It Will NEVER Touch
- User personal documents, Desktop files, Pictures, Music, or Videos (except when manually chosen on the Biggest Files screen).
- Browser passwords, cookies, browsing history, or active session tokens.
- Windows system files (`pagefile.sys`, `swapfile.sys`, `hiberfil.sys`, `bootmgr`, `System Volume Information`, `System32`, `WinSxS`, etc.).
- Network drives or remote shares.
- Cloud placeholders (OneDrive / Dropbox files are detected and never forcibly hydrated during scans).

---

## Safety Invariants (S1 - S10)

1. **S1 (Approved-set-only deletion):** The executor only accepts an immutable, user-confirmed `Plan`.
2. **S2 (Protected paths refused):** Critical system and user roots are rejected at the executor level.
3. **S3 (Reparse points never followed):** Junctions and symlinks are never traversed.
4. **S4 (Re-validate before deleting):** Items are re-checked immediately before deletion; modified items are skipped.
5. **S5 (Personal data to Recycle Bin):** User files default unticked and use Recycle Bin with undo.
6. **S6 (No process killing):** Locked files are skipped with a polite prompt.
7. **S7 (Cloud placeholders unhydrated):** File attributes prevent unwanted cloud downloads.
8. **S8 (Least privilege elevation):** Runs as normal user (`asInvoker`), elevating only when strictly required.
9. **S9 (Local audit logging):** Every action is logged locally to `%LOCALAPPDATA%\DiskStudioCleaner\logs\`.
10. **S10 (Dry-run parity):** `--dry-run` traverses the exact same code path without touching the disk.

---

## What It Will Not Do / What is UNVERIFIED

In compliance with Section 0 (Principle 5) of the product specification:

### What It Will Not Do (Non-Goals)
- No registry "optimizers" or "cleaners".
- No "RAM boosters" or driver updaters.
- No background services or scheduled auto-cleaners.
- No network connections, telemetry, or analytics.

### What is UNVERIFIED on Physical Hardware
This release was developed and tested against Linux and synthetic Windows testbeds:
- **[UNVERIFIED - Physical Host]** Native Windows 11 23H2 shell COM recycling (`SHFileOperationW`) on physical hardware.
- **[UNVERIFIED - Physical Host]** Live Windows Store package removal (`RemovePackageAsync`) in an interactive session.
- **[UNVERIFIED - Physical Host]** Screen reader / Narrator accessibility testing with `egui`.

---

## Building from Source

### Prerequisites
- Rust stable (edition 2021)
- Optional: `cargo-xwin` for cross-compiling from Linux to Windows

### Building the GUI Application
```bash
# Build the release portable executable
cargo build --release --bin DiskStudio-Cleaner
```

### Running the CLI
```bash
# Scan system (read-only)
cargo run --bin diskstudio-cli -- scan

# Inspect largest files
cargo run --bin diskstudio-cli -- biggest --root C:\ --limit 20

# Create execution plan
cargo run --bin diskstudio-cli -- plan --output plan.json

# Test execution with dry-run
cargo run --bin diskstudio-cli -- clean --plan plan.json --dry-run
```

### Running Test Suites
```bash
cargo test
```

---

## License

MIT License. Open source and auditable.
