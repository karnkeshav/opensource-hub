# Releasing and Code Signing Guide: DiskStudio Cleaner

This guide documents the build, signing, and release verification process for **DiskStudio Cleaner** in accordance with Section 9 of `SPEC.md`.

---

## 1. Reproducible Release Build

DiskStudio Cleaner uses standard Rust toolchains and can be built either natively on Windows or cross-compiled from Linux using `cargo-xwin`.

### Building on Windows (MSVC)
```powershell
# From the workspace root: apps/diskstudio-cleaner
cargo build --release --bin DiskStudio-Cleaner
```

### Cross-Compiling from Linux to Windows (via `cargo-xwin`)
```bash
cargo xwin build --release --target x86_64-pc-windows-msvc --bin DiskStudio-Cleaner
```

### Compiler Optimization Profiles
The release profile in `Cargo.toml` optimizes aggressively for binary size and performance:
```toml
[profile.release]
opt-level = "z"        # Optimize for smallest binary size
lto = true             # Whole-program link-time optimization
codegen-units = 1      # Single unit for maximum dead-code elimination
strip = true           # Strip symbol tables and debug information
panic = "abort"        # Eliminate panic unwinding runtime footprint
```

---

## 2. Windows Application Manifest

The release binary embeds an application manifest configured for least privilege and modern Windows subsystems:
- **`requestedExecutionLevel`:** `level="asInvoker"` (never requires administrative elevation to launch)
- **DPI Aware:** Per-Monitor V2 (`<dpiAwareness>PerMonitorV2</dpiAwareness>`)
- **Long Path Aware:** Enables Windows paths exceeding MAX_PATH (260 characters)
- **Common Controls v6:** Ensures native visual styling across Windows 10 and 11
- **Supported OS GUIDs:** Declares compatibility with Windows 10 and Windows 11

---

## 3. Code Signing Process

> [!IMPORTANT]
> Unsigned binaries that delete files or uninstall programs will encounter Windows SmartScreen warnings and third-party AV false positives. Production releases must be digitally signed with a trusted code-signing certificate. Never commit private keys or certificate secrets to the repository.

### Option A: Azure Trusted Signing (Recommended for Open Source & Cloud CI)
Azure Trusted Signing (formerly Microsoft Identity Verification) provides managed certificate rotation with HSM protection.

1. Configure environment variables in GitHub Actions / Azure Pipelines:
   - `AZURE_TENANT_ID`
   - `AZURE_CLIENT_ID`
   - `AZURE_CLIENT_SECRET`
   - `TRUSTED_SIGNING_ENDPOINT`
   - `CODE_SIGNING_ACCOUNT_NAME`
   - `CERTIFICATE_PROFILE_NAME`
2. Run `TrustedSigning.Client`:
   ```powershell
   trusted-signing sign `
       --endpoint $env:TRUSTED_SIGNING_ENDPOINT `
       --account-name $env:CODE_SIGNING_ACCOUNT_NAME `
       --profile-name $env:CERTIFICATE_PROFILE_NAME `
       --file "target/x86_64-pc-windows-msvc/release/DiskStudio-Cleaner.exe"
   ```

### Option B: Standard OV/EV Hardware Token (SignTool.exe)
```powershell
& "C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe" sign `
    /tr http://timestamp.digicert.com `
    /td sha256 `
    /fd sha256 `
    /sha1 <THUMBPRINT> `
    "target/release/DiskStudio-Cleaner.exe"
```

---

## 4. Integrity and Checksums

Before publishing any release asset, compute and publish its SHA-256 hash:

```powershell
# PowerShell
Get-FileHash -Algorithm SHA256 .\DiskStudio-Cleaner.exe
```

```bash
# Linux / macOS
sha256sum DiskStudio-Cleaner.exe
```

Include the SHA-256 hash in the release notes and the proposed `apps.json` entry.
