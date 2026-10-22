# DiskStudio Cleaner for macOS: Product Spec and Architecture

This document specifies the product architecture, safety invariants, and implementation requirements for **DiskStudio Cleaner for macOS** (supporting macOS 13 Ventura, macOS 14 Sonoma, and macOS 15 Sequoia on both Apple Silicon `aarch64` and Intel `x86_64`).

---

## 1. Product Summary & User Experience

**DiskStudio Cleaner for macOS** is a free, open-source, offline Mac utility that safely cleans disk space and performs clean application uninstalls without leaving orphaned files.

### Three Simple Screens:
1. **Clean up:** Finds safe caches, developer caches, temporary files, old installers in Downloads, and the macOS Trash.
2. **Biggest space users:**
   - **Apps:** Scans `/Applications` and `~/Applications`, displays app bundle sizes, and offers a **Clean Uninstall** with leftover review.
   - **Files & Folders:** Streaming top 100 largest files and aggregate directory trees across APFS volumes with cloud-sync warnings.
3. **Done:** Reports measured freed space (via APFS volume free-space delta) and skipped items with explicit reasons.

### Safety Philosophy:
- **Show, then ask, then act:** No deletion or uninstallation occurs without explicit user review in a confirmation modal.
- **Move to Trash with Undo:** User data remnants, old installers, and `.app` bundles are moved to `~/.Trash`, never permanently deleted without warning.
- **SIP & System Protection:** Enforces strict System Integrity Protection (SIP) safeguards refusing to touch macOS system containers.

---

## 2. macOS Safety Invariants (S1 - S10)

- **S1. Approved-set-only deletion:** The executor accepts only a pre-approved `Plan`.
- **S2. System Integrity Protection (SIP) & Protected Paths:**
  Refuses to modify, delete, or recurse into:
  - System roots: `/System`, `/System/Library`, `/usr` (except `/usr/local`), `/bin`, `/sbin`, `/var`, `/private`, `/etc`, `/Library/Apple`, `/Library/SystemExtensions`.
  - APFS Firmlinks & System Volumes: `/System/Volumes/Data`, `/System/Volumes/Preboot`, `/System/Volumes/Update`, `/System/Volumes/VM`.
  - User Library Protected Containers: `~/Library` as a whole root, `~/Library/Keychains`, `~/Library/Mail`, `~/Library/Messages`, `~/Library/Accounts`, `~/Library/Safari` (cookies, passwords, history), `~/Library/Mobile Documents` (iCloud Drive), `~/Library/CloudStorage` (Dropbox/Google Drive/OneDrive).
  - User Personal Folders: `~/Desktop`, `~/Documents`, `~/Pictures`, `~/Music`, `~/Movies`, `~/Downloads` as folders.
- **S3. Symlinks & APFS Firmlinks never followed:** Directory traversals stop at symlinks and firmlinks; targets are never double-counted or recursed into.
- **S4. Re-validate before deleting:** Item metadata is re-verified immediately before removal. Volatile or modified files are skipped.
- **S5. Personal data to Trash:** Any user data or application bundle goes to `~/.Trash` with undo capability.
- **S6. No process killing:** If an application or file is in use, report it and ask the user to quit the application. Never terminate processes.
- **S7. Dataless Cloud Placeholders:** Detects dataless cloud files (`SF_DATALESS` attribute) in iCloud Drive and Dropbox to avoid triggering automatic network downloads.
- **S8. Elevation only when required:** Normal operations run as the standard user. Elevation (`sudo` / `osascript with administrator privileges`) is requested only for specific helper operations.
- **S9. Local audit logs:** Writes structured JSON execution logs to `~/Library/Logs/DiskStudioCleaner/`.
- **S10. Dry-run parity:** `--dry-run` executes the identical plan validation path without altering the disk.

---

## 3. macOS Cleanable Locations

Declared in declarative TOML rules (`core/rules/macos_*.toml`):

### Safe (Pre-selected)
- **User & System Temp:** `$TMPDIR/*`, `/tmp/*` (> 24 hours old).
- **macOS Trash:** `~/.Trash/*` (shown with calculated size).
- **Browser Caches:**
  - Safari: `~/Library/Caches/com.apple.Safari/*`, `~/Library/Containers/com.apple.Safari/Data/Library/Caches/*`. *(Never cookies, history, or bookmarks!)*
  - Google Chrome: `~/Library/Caches/Google/Chrome/*`
  - Mozilla Firefox: `~/Library/Caches/Firefox/Profiles/*/cache2/*`
  - Microsoft Edge: `~/Library/Caches/Microsoft Edge/*`
  - Brave: `~/Library/Caches/BraveSoftware/Brave-Browser/*`
- **Application Caches:**
  - Slack (`com.tinyspeck.slackmacgap`), Microsoft Teams (`com.microsoft.teams2`), Discord (`com.hnc.Discord`), Spotify (`com.spotify.client`), Zoom (`us.zoom.xos`).
- **Developer Caches:**
  - Xcode DerivedData: `~/Library/Developer/Xcode/DerivedData/*`
  - Xcode Archives & iOS DeviceSupport: `~/Library/Developer/Xcode/iOS DeviceSupport/*`
  - Homebrew Cache: `~/Library/Caches/Homebrew/*`
  - CocoaPods Cache: `~/Library/Caches/CocoaPods/*`
  - npm, pip, Cargo caches in `~/.npm/_cacache`, `~/Library/Caches/pip`, `~/.cargo/registry/cache`.
- **System Caches:**
  - DiagnosticReports & Crash Reporter: `~/Library/Logs/DiagnosticReports/*`
  - QuickLook Thumbnail Cache: `~/Library/Caches/com.apple.QuickLook.thumbnailcache/*`
  - User log files older than 7 days in `~/Library/Logs/*`.

### Your Files (Unticked by default, Trash only)
- **Old Downloaded Installers:** `~/Downloads/*.dmg`, `~/Downloads/*.pkg`, `~/Downloads/*.iso`, `~/Downloads/*.zip` older than 90 days.
- **Stale Project Dependency Folders:** `node_modules`, `target`, `.venv`, and `build` folders unmodified for 90+ days.

---

## 4. macOS Application Uninstaller & Leftover Sweep

1. **Discovery:**
   - Scans `/Applications` and `~/Applications` for `.app` bundles.
   - Extracts bundle metadata from `Contents/Info.plist`: `CFBundleName`, `CFBundleIdentifier`, `CFBundleShortVersionString`.
   - Filters out Apple system apps: Safari, Mail, Finder, System Settings, Music, Photos, Terminal, Preview, TextEdit, Calculator, etc.
2. **Uninstall Step 1:**
   - Moves the `.app` bundle to `~/.Trash`.
3. **Uninstall Step 2 (Leftover Sweep):**
   - Automatically searches for remnants using bundle identifier and product name:
     - `~/Library/Application Support/<BundleID | Name>`
     - `~/Library/Caches/<BundleID>`
     - `~/Library/Preferences/<BundleID>.plist`
     - `~/Library/Saved Application State/<BundleID>.savedState`
     - `~/Library/Containers/<BundleID>`
     - `~/Library/Group Containers/<GroupPrefix.BundleID>`
     - `~/Library/Logs/<BundleID | Name>`
   - Remnants are presented in a review list, unticked by default if containing user data (settings/saves), and moved to `~/.Trash`.
