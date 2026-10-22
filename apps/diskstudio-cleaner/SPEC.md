# DiskStudio Cleaner: product spec and development instructions

This document is written to be handed to an AI coding agent (or a developer) as the complete brief for building a Windows disk-cleaning utility. Read all of it before writing code. Where this document is specific, follow it. Where it is silent, choose the simplest option that satisfies the principles in section 2 and write the decision down in `DECISIONS.md`.

---

## 0. How you (the developer AI) must work

1. **Work only inside `apps/diskstudio-cleaner/`.** Do not touch other folders in the repository. Do not commit, push, tag or create a GitHub release. Stop when the acceptance criteria in section 12 are met and report.
2. **This software deletes files and uninstalls programs. A bug can destroy someone's data.** Treat every line that deletes, moves, or uninstalls as safety-critical code. Section 2 lists safety invariants that must be enforced in code and covered by tests, not just described in comments.
3. **Never run destructive code against the real machine, the real user profile, or real installed software while developing.** All deletion code must go through a file-system abstraction (section 7.1) so tests run against temporary directories and an in-memory fake. Manual end-to-end checks of deletion/uninstall must be done only in a disposable Windows VM or Windows Sandbox. If you cannot get one, say so in your report and mark those paths "unverified on a real system". Scanning (read-only) may be run on the real machine.
4. **Build in the milestones of section 11, in order.** Each milestone must build, pass its tests, and be usable before the next begins. Do not scaffold everything and fill it in later.
5. **Be honest.** Do not claim a feature works on a Windows version you did not test. Do not claim uninstall works for an installer type you did not exercise. The README must have a "What it will not do / what is unverified" section.
6. **Keep it small and dependency-light.** The size and simplicity of the finished program are explicit goals (section 3). Justify every dependency in `DECISIONS.md`.
7. **Encoding pitfall (Windows PowerShell 5.1):** never read and rewrite source files with `Get-Content`/`Set-Content`; it corrupts UTF-8. Use your editor tools or tools with explicit UTF-8.
8. **Report at the end:** binary size, test count, what was verified and how (and where: VM or not), what is unverified, what you cut and why, and every bug you hit.

---

## 1. Product summary

**DiskStudio Cleaner** is a free, open-source, offline Windows desktop utility that frees disk space. A user downloads one `.exe`, runs it, and sees three simple screens:

1. **Clean up:** finds known-safe junk (temp files, caches, Recycle Bin, etc.).
2. **Biggest space users:** lists the largest files, folders and installed apps on the drive so the user can free the most space with the least effort.
3. **Done:** a report of what was freed and what was skipped.

The defining behaviour: **the user is shown exactly what will be removed, explicitly confirms, and only then is anything deleted or uninstalled.** Anything that belongs to installed software is removed with a **clean uninstall**, not by deleting its folder.

### Target user
A non-technical person with a full laptop. The interface must be understandable without reading documentation. No jargon, no scare tactics.

### Platform
Windows 10 (22H2) and Windows 11, x64. Windows only for version 1. Do not attempt macOS or Linux.

---

## 2. Principles and safety invariants (non-negotiable)

### 2.1 Product principles
- **P1. Show, then ask, then act.** No deletion or uninstall happens without the user having seen the specific items and clicked a confirm button for that exact set.
- **P2. Honest, calm language.** No "your PC is at risk", no invented error counts, no upsell, no countdowns. Numbers shown must be real measured sizes.
- **P3. Simple GUI.** Three screens, large readable text, one primary button per screen. Advanced detail is available by expanding a row, never forced.
- **P4. No registry "cleaning".** The only registry changes ever made are the specific keys belonging to an app the user chose to uninstall, and only after a `.reg` backup is written (section 8.4).
- **P5. Private and offline.** No network access, no telemetry, no account. The program must work with the network disabled. Do not include any update-check or analytics code.

### 2.2 Safety invariants (each must be enforced in code AND have automated tests)

- **S1. Approved-set-only deletion.** The executor accepts only a `Plan` object (section 6) that was built from the user's explicit selection. It must never re-scan and delete "whatever matches". Items not in the approved plan are never touched.
- **S2. Protected paths are refused at the executor level,** regardless of what the UI or rules say. See the protected-path list in section 7.3. A request to delete a protected path must return an error and be logged; it must not be possible to override it with a flag.
- **S3. Reparse points are never followed.** Junctions, symlinks and mount points must not be traversed during scanning or deletion. Delete the link itself only if the link is the approved item. A scan must never double-count or escape its root through a junction.
- **S4. Re-validate before deleting.** Immediately before removing each item, re-check that it still exists at the same path, is within an allowed root, is not protected, and is not a reparse point. If its size or modified time differs wildly from the plan, skip it and report it.
- **S5. Personal data defaults to unticked and to the Recycle Bin.** Any item classified as user data (section 5.2) is unticked by default and, when deleted, goes to the Recycle Bin (with undo), not permanently removed. Only items classified as regenerable cache/junk may be deleted permanently.
- **S6. No process killing.** If a file or program is in use, skip it and tell the user to close the program. Never terminate processes.
- **S7. Cloud placeholders are not hydrated.** Do not read file contents of OneDrive/Dropbox placeholder files during scanning (this would trigger a download). Detect them by file attributes (`FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`, `FILE_ATTRIBUTE_RECALL_ON_OPEN`, `FILE_ATTRIBUTE_OFFLINE`) and flag items inside cloud-synced folders: deleting them deletes them from the cloud too, and the UI must say so.
- **S8. Elevation only when needed,** and only for the specific operation. The app runs as the normal user by default (manifest `asInvoker`). Operations needing admin trigger a clear explanation and a UAC prompt for a helper step, not a blanket "run as administrator".
- **S9. Every action is logged locally** to a plain-text/JSON log in `%LOCALAPPDATA%\DiskStudioCleaner\logs\`, including path, size, result and error. The log never leaves the machine.
- **S10. Dry-run parity.** A `--dry-run` mode must run the identical code path as a real run up to, but not including, the final filesystem/uninstall call, and print what would happen. The UI's confirmation list and the dry-run output must come from the same `Plan`.

---

## 3. Goals, size and technology

### 3.1 Goals
- Single portable `.exe`, no installer required, no runtime to install.
- **Target binary size: <= 8 MB; hard cap 15 MB** (release build, stripped, compressed with UPX only if it does not trigger antivirus flags; otherwise do not compress). Report the real size.
- Cold start under 1 second; scanning must not freeze the UI; a full scan of a 500 GB drive with ~1M files should finish in under ~2 minutes on an SSD (best effort, report measured).
- Memory use under ~300 MB while scanning ~1M files (store compact records, not full strings per file where avoidable).

### 3.2 Recommended stack (follow unless you document a better choice)
- **Language: Rust (stable), edition 2021.** Memory safe, small binaries, excellent Windows API access.
- **Workspace layout:**
  - `core/` a library crate with **no GUI dependency**: scanner, rules engine, plan model, executor, uninstall engine, protected-path logic, filesystem abstraction. All safety logic lives here and is unit-tested here.
  - `cli/` a thin binary for `scan`, `plan`, `--dry-run`, JSON output (used for testing and power users).
  - `gui/` the desktop app, depending on `core`.
- **GUI: `eframe`/`egui`** (immediate-mode, single static exe, no WebView2 dependency). If you choose Tauri instead, justify the size and WebView2 trade-off in `DECISIONS.md`. Either way the GUI must stay a thin layer over `core`.
- **Windows access:** the `windows` crate (official Microsoft bindings) for Win32/COM/registry/shell APIs. Avoid shelling out to PowerShell where a direct API exists; where shelling out is unavoidable (e.g. `DISM`, `winget`, `Remove-AppxPackage`), build the command from validated arguments (never string-concatenate user-controlled text into a shell command) and capture output.
- **Parallel scanning:** `rayon` or a small custom thread pool; `walkdir`-style traversal written so it does not follow reparse points.
- **Serialization:** `serde` + `serde_json`; rules in **TOML** (`toml` crate).
- **Testing:** `cargo test`, `tempfile` for temp directories, an in-memory fake implementing the filesystem trait.
- Forbidden: telemetry crates, HTTP client crates, auto-updaters.

---

## 4. User experience (exact screens)

Keep the window about 900x600, resizable, with a clear light and dark theme following Windows settings. Large buttons. Keyboard accessible. Every control has an accessible name.

### Screen 1: Clean up
- Initial state: a short sentence ("Find files you can safely remove to free up space.") and one button **Scan my PC**.
- During scan: a progress bar, current folder, running total found. A **Cancel** button. The UI never freezes.
- Results: a list of **categories**, each row showing: checkbox, plain-language name, total size, a one-line "what happens if removed", and a risk tag (**Safe** / **Your files**). Rows expand to show the actual files (path, size, modified date) with their own checkboxes. A running "Selected: X GB" total.
- Safe categories are pre-ticked. User-data categories are **unticked**.
- Primary button: **Delete selected (X GB)**. It opens the confirmation dialog (below), never deletes directly.

### Confirmation dialog (shared by every deletion/uninstall)
- Title: "Remove N items (X GB)?"
- Lists the **categories and counts**, with a link "Show every file" that opens the full list. Text: "Files marked *Your files* go to the Recycle Bin. Everything else is removed permanently and cannot be undone." (Adjust to the actual selection.)
- Buttons: **Cancel** (default focus) and **Remove**. There is no "don't ask again".

### Screen 2: Biggest space users
- Segmented control: **Apps | Files | Folders**.
- Apps tab: installed programs sorted by size, with name, publisher, size, install date, last-used date if known, and an **Uninstall** checkbox/button. Hide Windows components, drivers, and anything flagged system-critical (section 8.1).
- Files tab: the largest N (default 200) files on the chosen drive, with path, size, type icon/name, modified date, an "Open folder" link, and a checkbox. If a file lies inside an installed app's folder, the row shows the app name and the action becomes **Uninstall app** (never "delete file").
- Folders tab: the largest folders (aggregate sizes), same rules. Include a simple proportional bar (a treemap is a stretch goal, not required).
- Drive selector if multiple fixed drives exist. Default to the system drive.
- Same primary button and the same confirmation dialog. Uninstalls are executed one at a time with visible progress (section 8).
- Filters: minimum size, "not modified in over N months".

### Screen 3: Done
- "Freed X GB" using **measured** free-space change plus per-item results.
- Table of anything **skipped** with reason (in use, access denied, changed since scan, protected).
- Buttons: **Open log**, **Scan again**.
- For uninstalls: the leftover-review step (section 8.3) appears before this screen.

### Language rules
Plain English. Never "errors", "threats", "optimize", "boost". Explain consequences: "Chrome will re-download these pages", "These are your own files".

---

## 5. What gets scanned (version 1 scope)

### 5.1 Rules are data, not code
Cleanable locations are declared in `core/rules/*.toml`, embedded into the binary at build time (`include_str!`). Adding or fixing a rule must not require touching the scanner or executor. A rule looks like:

```toml
[[rule]]
id          = "browser-cache-chrome"
category    = "browser-caches"
title       = "Chrome cache"
description = "Saved copies of web pages. Chrome re-downloads them as needed."
risk        = "safe"              # safe | user-data
action      = "delete"            # delete | recycle
paths       = ["%LOCALAPPDATA%\\Google\\Chrome\\User Data\\*\\Cache\\*",
               "%LOCALAPPDATA%\\Google\\Chrome\\User Data\\*\\Code Cache\\*"]
exclude     = []                  # globs that must never match
min_age_days = 0
requires_admin = false
requires_closed = ["chrome.exe"]  # skip (and tell the user) if running
```

Rules must be validated at startup/test time: every path must resolve under a known root, no rule may match a protected path, and `risk = "user-data"` rules must use `action = "recycle"`.

### 5.2 Categories for version 1

**Safe (pre-ticked, permanent delete allowed):**
- Temporary files: `%TEMP%`, `%WINDIR%\Temp` (admin), files older than 24 hours only.
- Recycle Bin contents (via `SHEmptyRecycleBin`, shown with size first).
- Thumbnail and icon caches, Windows error reports and crash dumps, old log files.
- Windows Update download cache (`SoftwareDistribution\Download`, admin).
- Delivery Optimization cache (admin).
- Browser caches only: Chrome, Edge, Firefox, Brave (cache and code cache). **Never** cookies, passwords, history, bookmarks, sessions, extensions or local storage.
- App caches: Teams, Slack, Discord, Spotify, Zoom, Office cache folders.
- Developer caches: npm (`%LOCALAPPDATA%\npm-cache`), pip, NuGet, Gradle, Cargo registry cache, Yarn/pnpm stores, Maven repository only if clearly marked cache, Visual Studio/VS Code caches, JetBrains caches, `.android` caches.

**Your files (unticked, Recycle Bin):**
- Old installers in Downloads (`.exe`, `.msi`, `.iso`, `.zip` older than 90 days), shown individually.
- Stale `node_modules`, `target`, `.venv`, `build` folders in project directories not modified for 90+ days. Detection must be conservative (require the sibling manifest such as `package.json`/`Cargo.toml`/`requirements.txt` to confirm the folder is a regenerable dependency folder).
- Duplicate files (**stretch goal**, see section 11, milestone 6). Group by size, then partial hash, then full hash; never auto-select an item without keeping at least one copy.

**Advanced, hidden behind an "Advanced" expander, always unticked, each with its own explanation and admin prompt:**
- Previous Windows installations (`Windows.old`): remove through the supported mechanism (Disk Cleanup/`cleanmgr` with the correct StateFlags or Storage Sense APIs); do not hand-delete.
- Component store cleanup: `DISM /Online /Cleanup-Image /StartComponentCleanup`.
- Hibernation file: offer `powercfg /h off` as an explicit toggle with the consequence stated (fast startup/hibernate disabled).
- System Restore shadow copies: show size, link to Windows' own settings; do not delete automatically in v1.

Do **not** include: registry cleaning, "driver cleaning", startup managers, browser password/history clearing, anything in Documents/Desktop/Pictures/Videos/Music (except through the Biggest Files screen with explicit user selection), or anything that changes Windows settings other than the hibernation toggle above.

---

## 6. Core data model

All safety-relevant behaviour hangs off this model. Implement it in `core` and test it thoroughly.

```text
ScanResult     { categories: Vec<Category>, drive_stats, started_at, finished_at }
Category       { id, title, description, risk: Risk, items: Vec<Item>, total_bytes, default_selected }
Item           { id, kind: File|Folder|App, path, size_bytes, modified, owner: Option<AppRef>,
                 risk: Risk, action: Delete|Recycle|Uninstall, flags: Flags }
Flags          { in_cloud_folder, requires_admin, in_use_suspected, protected, reparse }
Plan           { items: Vec<PlannedItem>, created_at, total_bytes, plan_hash }
PlannedItem    { item snapshot (path, size, modified, kind), action }
ExecutionResult{ per_item: Vec<{ item, outcome: Removed|Recycled|Skipped(reason)|Failed(error) }>,
                 bytes_freed_measured, log_path }
```

- A `Plan` is created **only** from a user selection, is immutable, and is what both the confirmation dialog and the executor read. `plan_hash` (SHA-256 of the canonical list) is logged so a log can be matched to what the user approved.
- Scanning produces `ScanResult` and has **no ability to modify the file system** (give the scanner a read-only filesystem trait object so it is impossible by construction).

---

## 7. Scanner and executor design

### 7.1 Filesystem abstraction
Define a trait (e.g. `Fs`) with the minimal operations needed: list directory (with attributes, size, times, reparse flag), stat, remove file, remove dir, move to recycle bin, free space. Provide:
- `RealFs` (Windows implementation, handles long paths with the `\\?\` prefix, handles read-only attributes and sharing violations gracefully),
- `FakeFs` (in-memory, deterministic, can simulate reparse points, access denied, files that change between scan and delete, huge sizes).
The scanner takes `&dyn ReadFs`; the executor takes `&dyn WriteFs`. Tests use `FakeFs` and `tempfile`.

### 7.2 Scanner
- Resolve environment variables and wildcards in rule paths for every user profile? **No: current user only** in v1 (other users' profiles need admin and are out of scope).
- Walk in parallel, never following reparse points, tolerate access-denied silently (record a count), never read file contents (only metadata), apply `min_age_days`, `exclude` globs and the protected-path filter.
- Size accounting must use allocated/size-on-disk where cheap, else logical size; be consistent and label it.
- Large-file/folder index for the Biggest screen: one pass that keeps the top N files and aggregates folder sizes using compact structures (a streaming top-N heap plus a folder-size map keyed by interned path components). Must not hold one heap-allocated `String` per file for a million files.
- Cancellable at any time; partial results must be discarded or clearly labelled.

### 7.3 Protected paths (enforced in `core`, executor-level, unit-tested)
Refuse to delete, move or recurse into, regardless of rules or user selection:
- `%WINDIR%` and everything under it **except** the specific allowed subpaths used by the safe rules (e.g. `Temp`, `SoftwareDistribution\Download`, `Logs`, `Minidump`, `Prefetch` is not allowed), expressed as an explicit allowlist.
- `%SystemDrive%\Program Files` and `Program Files (x86)` **except** through the uninstall engine for a specific app.
- `%SystemDrive%\ProgramData\Microsoft`, `%SystemDrive%\Users\<any>\AppData` as a whole (only specific allowed cache subpaths via rules), `NTUSER.DAT*`, `pagefile.sys`, `swapfile.sys`, `hiberfil.sys` (except via the hibernation toggle), `$Recycle.Bin` internals (use the shell API), `System Volume Information`, `Boot`, `bootmgr`, `Recovery`, `EFI`.
- User library roots: Documents, Desktop, Pictures, Videos, Music, and OneDrive/Dropbox/Google Drive roots **as folders**. Individual files inside them may be offered only from the Biggest Files screen with the cloud warning (S7), never from rule-based cleanup.
- Any path outside fixed local drives (network shares, removable drives) unless the user picked that drive explicitly on the Biggest screen; never delete from network drives.
- Anything that fails path canonicalisation, contains `..` after normalisation tricks, or resolves through a reparse point to a protected location (**S3**).

Maintain the list in one `protected.rs` file with exhaustive tests (including case-insensitivity, trailing dots/spaces, 8.3 short names, `\\?\` prefixes, forward slashes, and junction escapes).

### 7.4 Executor
- Input: an approved `Plan`. Output: `ExecutionResult`.
- For each item: re-validate (S4), then act: `Delete` (permanent), `Recycle` (use `IFileOperation`/`SHFileOperation` with `FOF_ALLOWUNDO`), or hand off to the uninstall engine for `Uninstall`.
- Deleting directories: remove children first, handle read-only attributes, never follow reparse points; a partially deleted tree is reported as partial.
- Handle sharing violations: skip and report "in use". Retry once after a short delay only for transient errors.
- After execution, measure **actual freed space** from drive free-space delta (note that Recycle Bin moves free no space until it is emptied: report this honestly: "X GB moved to the Recycle Bin; empty it to free the space").
- Support `--dry-run` (S10).

---

## 8. Uninstall engine (the riskiest part; build carefully)

### 8.1 Discover installed software
Enumerate, then deduplicate by name+version+publisher:
- Registry uninstall lists: `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`, `HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`, `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`. Read `DisplayName`, `DisplayVersion`, `Publisher`, `InstallLocation`, `InstallDate`, `EstimatedSize`, `UninstallString`, `QuietUninstallString`, `WindowsInstaller`, `SystemComponent`, `ParentKeyName`, and the key name (an MSI product code `{GUID}` when applicable).
- Microsoft Store/MSIX packages for the current user via the package manager API (`Windows.Management.Deployment.PackageManager`) or `Get-AppxPackage` as a fallback; exclude framework packages and anything `NonRemovable`/system.
- Steam games from `libraryfolders.vdf` and `appmanifest_*.acf`; Epic games from `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item`; other launchers are out of scope for v1 (they appear as normal installed programs if they register).
- Compute size: prefer measured size of the install folder on disk over `EstimatedSize` (which is often missing or wrong).

**Hide** (never offer for removal): entries with `SystemComponent=1`, `ParentKeyName` set (updates), Microsoft Visual C++ redistributables, .NET runtimes, WebView2, Windows SDK components, drivers/firmware packages, GPU control panels' runtime parts, security software, and anything published by Microsoft that is part of Windows. Maintain an explicit deny list plus heuristics; when unsure, **do not offer it**. Items shown as "needed by other programs" are informational only.

### 8.2 Choose an uninstall method (in this order)
1. **MSI:** key name is a `{GUID}` and `WindowsInstaller=1` → `msiexec /x {GUID} /qb-! /norestart` (basic UI, no reboot). Capture exit code (0, 3010 reboot required, 1605 not installed, 1602 cancelled).
2. **Store/MSIX:** remove for the current user through the package manager API (`RemovePackageAsync`); report result.
3. **Steam / Epic:** invoke the launcher's own uninstall (`steam://uninstall/<appid>` / open Epic Launcher to the library with an explanation) and then verify; if the launcher cannot be driven, show the user what to click and do not delete the folder yourself.
4. **Standard uninstaller:** prefer `QuietUninstallString`; else `UninstallString`. Parse the command safely (quoted path + arguments; reject strings that do not resolve to an existing executable path under an allowed root; never pass the string through `cmd /c` blindly). Launch it, wait for exit, and allow the uninstaller to show its own window if it has no quiet mode.
5. **`winget uninstall --id <id> --silent`** as an optional fallback only when the app is winget-managed and the above are unavailable; skip silently if `winget` is missing.
6. **Portable apps (no uninstaller found):** the item is shown as "No uninstaller found. Removing its folder will delete it." with the folder path; deletion goes through the normal executor with the Recycle action, never permanent.

Run uninstalls **sequentially** (never in parallel), each with a visible progress state, a Cancel option between apps, and a timeout/"still running" indicator. Never kill an uninstaller. Elevation: if the uninstall needs admin (HKLM entry or Program Files location), relaunch only the helper step with UAC (S8).

### 8.3 Verify, then leftover sweep (second user-approved list)
After each uninstall:
1. **Verify:** re-read the installed list; the entry must be gone (or the install folder gone). If not, report "The uninstaller finished but the program still appears installed" and offer nothing further automatic.
2. **Leftover scan (read-only):** look for remnants belonging to **that specific app**, matched by exact install path, exact publisher/product folder names, and the app's own registry key names. Candidate locations: the old install folder (if empty or leftover), `%APPDATA%\<Vendor|App>`, `%LOCALAPPDATA%\<Vendor|App>`, `%PROGRAMDATA%\<Vendor|App>`, Start Menu shortcuts that point to the removed executable, and the app's own `HKCU\Software\<Vendor>\<App>` / `HKLM\Software\<Vendor>\<App>` keys.
3. **Show the leftovers** as a new review list (same checkbox UI and confirmation dialog). Everything is **unticked by default** if it may hold user data (saved projects, settings, game saves) with plain wording ("Settings and saved files, 1.2 GB. Keep these if you may reinstall."), and ticked only for clearly regenerable remnants (empty folders, dead shortcuts, caches).
4. Folder remnants go to the Recycle Bin when classified as user data.

### 8.4 Registry rules (strict)
- Only keys that **exactly belong to the uninstalled app** (matched as above) may be offered, and only in that app's leftover list.
- Before deleting any registry key, export it to `%LOCALAPPDATA%\DiskStudioCleaner\backups\<timestamp>-<app>.reg` and verify the file was written. If the backup fails, do not delete the key.
- Never touch keys under `Microsoft`, `Classes` file-association roots, `Run`, services, drivers, or anything not clearly named for the app. No wildcard registry deletion.

### 8.5 Edge cases that must be handled
Uninstaller needs a reboot (report it); uninstaller opens a dialog (let the user use it; wait); uninstall cancelled by the user (report as skipped, not failed); app is currently running (ask the user to close it; never kill); multiple versions installed side by side (show each separately); entries with broken or missing uninstall strings (treat as portable/orphan with explicit wording and never auto-delete the folder); 32/64-bit duplicates; per-user vs machine-wide installs; localisation of names.

---

## 9. Distribution, signing, trust

- Build a release `.exe` with `cargo build --release` (LTO, `opt-level = "z"` or `s`, `strip = true`, `panic = "abort"` unless a panic hook is needed for logging, single codegen unit). Embed a Windows manifest: `requestedExecutionLevel level="asInvoker"`, long-path aware, DPI aware, Common Controls v6, supported OS GUIDs.
- Include version resource info (publisher, product name, description) so Windows shows a proper name.
- **Code signing is strongly recommended** (an unsigned exe that deletes files will be flagged by Windows SmartScreen and some antivirus). Provide a documented signing step in `docs/RELEASING.md` (Azure Trusted Signing or a standard OV/EV certificate), but the build must also work unsigned for development. Do not commit any certificate or key.
- Publish SHA-256 of the final exe in the README and release notes. Provide reproducible build instructions.
- Open source (MIT, same as the repository). Publish the full rule list (`core/rules`) so users can audit exactly what can be touched. Include an `AUDIT.md` that explains where deletion happens in the code (the executor) and how to verify it.
- The repository's index page lists apps from `apps.json` (fields: `id`, `name`, `icon`, `tagline`, `tags`, `size`, `platform`, `asset`, `sha256`, `tag`, `released`, `runOnline`, `source`). **Do not edit `apps.json`**; provide the proposed entry text in your final report. The asset name will be `DiskStudio-Cleaner.exe` (or a zip containing it).

---

## 10. Testing requirements

### 10.1 Automated (must be in `cargo test`, run on every milestone)
- **Protected paths:** a table-driven test with at least 100 cases (case variations, trailing dots, short names, `\\?\`, `..`, junction escape, UNC, other drives) all refused.
- **Rule validation:** every rule resolves under an allowed root, no rule can match a protected path, `user-data` rules never use permanent delete, exclude globs work.
- **Scanner:** correct sizes/ages/excludes on `tempfile` trees; reparse points not followed (simulate with `FakeFs`); access-denied tolerated; cancel works; top-N accuracy against a brute-force oracle on random trees.
- **Plan/executor:** approved-set-only (an item added to disk after planning is untouched); re-validation (item replaced by a junction or changed after the scan is skipped); sharing violation handling; partial directory deletion reporting; recycle vs delete selection; dry-run produces the identical item list and touches nothing.
- **Uninstall engine (parsing and decision logic, no real uninstalling):** parse registry fixtures (provided as JSON/`.reg` samples you write) for MSI, EXE, Store, Steam, Epic, portable, broken entries, SystemComponent, update entries; command-line parsing and path validation (reject injection such as `& calc`, unquoted paths with spaces, relative paths); method selection order; deny-list behaviour; leftover matching does not match other vendors' folders; registry backup written before deletion and deletion refused if the backup fails.
- **Property tests** (e.g. `proptest`) on path normalisation and the protected-path check.
- **GUI-free end-to-end** through the CLI against a temp tree: `scan --json` then `plan` then `clean --dry-run` then `clean --yes` equals the expected end state.

### 10.2 Manual (VM or Windows Sandbox only; record results in `TESTING.md`)
- Installers actually uninstalled and verified gone: one MSI app, one NSIS/Inno-style EXE app, one Store app, one Steam or Epic game if available, one portable app.
- Leftover review shows the expected remnants; keeping them works.
- UAC elevation path for a machine-wide app.
- Behaviour with the Recycle Bin, with a locked file (open in another program), with OneDrive placeholders (if OneDrive is available in the VM), with a junction placed in a scanned folder.
- Windows 10 and Windows 11 both, if you have access; otherwise state which one was tested.
- Measure and record: binary size, cold start, scan time and memory on a synthetic tree of ~1M small files.

If a manual test cannot be run, mark it **UNVERIFIED** in the README rather than skipping it silently.

---

## 11. Milestones (build in this order; each must be shippable)

1. **Foundations:** workspace, `Fs` trait + `RealFs` + `FakeFs`, protected-path module with its full tests, rule loader + validator, plan/result data model. CLI `scan` (read-only) over a small rule set. Exit criteria: protected-path and rule tests green.
2. **Safe cleanup:** safe categories (temp, Recycle Bin, caches, dev caches), executor with re-validation and dry-run, logging, free-space measurement. CLI `clean --dry-run` and `clean`. Exit criteria: executor tests green; manual VM test of a real clean.
3. **GUI screens 1 and 3:** scan progress, categories list with expandable files, confirmation dialog, results screen. Exit criteria: usable end to end by a non-technical person; accessibility labels present; light/dark.
4. **Biggest space users:** streaming top-N and folder aggregation, Files/Folders tabs with filters, "Open folder", cloud-folder warning, user-data -> Recycle Bin behaviour.
5. **Apps and clean uninstall:** installed-software discovery, deny list, uninstall methods in the order of section 8.2 (MSI and Store first, then EXE uninstallers, then Steam/Epic, then portable), verification, leftover scan and review, registry backup and removal. Exit criteria: section 10.2 uninstall tests recorded.
6. **Polish and stretch:** duplicate finder with hardlink/Recycle options, stale project dependency folders, advanced section (Windows.old, DISM, hibernation toggle), simple treemap, installer/portable packaging, `docs/RELEASING.md`, `AUDIT.md`, README with honest limits.

Do not start a milestone until the previous one's tests pass. After each milestone, update `README.md` with the current honest status.

---

## 12. Acceptance criteria (definition of done)

- `cargo test` passes, including every category in section 10.1; test count and coverage of the safety invariants (S1 to S10) reported, with a table mapping each invariant to the test(s) that enforce it.
- `cargo build --release` produces a single `.exe` within the size cap; size reported.
- No network crates in the dependency tree (`cargo tree` output included in the report); the exe works with networking disabled.
- The GUI flow works: Scan, review with expandable file lists, confirm, remove, results; the Biggest screen; app uninstall with leftover review. Screenshots of each screen (light and dark) captured and described.
- Every deletion and uninstall path is reachable only through an approved `Plan` and is covered by tests; a reviewer can find the single place where files are deleted (`AUDIT.md`).
- README includes: what it removes (the full category list), what it will never touch, how to verify the download (SHA-256), honest limits, and an **UNVERIFIED** list for anything not tested on a real or VM Windows system.
- Final report to the requester: size, tests, what was verified and where, what is unverified, deviations from this spec with reasons, bugs hit, and the proposed `apps.json` entry text.

---

## 13. Non-goals (do not build)

Registry cleaners; "PC optimisers"/speed boosters; driver updaters; startup managers; malware scanning; browser password/history/cookie cleaning; background services or scheduled tasks that delete without the user present (a future version may add a *scan-and-notify* reminder, never automatic deletion); telemetry; ads; auto-update; cloud features; macOS/Linux support in v1.

## 14. Open questions the developer should flag rather than guess

- Which exact Windows Update/WinSxS paths are safe to include on the Windows versions available for testing.
- Whether `cleanmgr` StateFlags automation or the Storage Sense APIs is more reliable for `Windows.old` on Windows 10 vs 11.
- Whether the chosen GUI toolkit's accessibility support (screen readers) is adequate; if not, say what is missing.
- Any uninstaller type encountered that cannot be driven reliably: document it in the README rather than falling back to deleting the folder.
