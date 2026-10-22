import os
import shutil
import hashlib
import tarfile
import zipfile

root = "/mnt/c/Users/keysh/github/opensource-hub/apps/diskstudio-cleaner"
dist = os.path.join(root, "dist")
os.makedirs(dist, exist_ok=True)

# 1. Windows x64 .exe
win_src = os.path.join(root, "target/x86_64-pc-windows-msvc/release/DiskStudio-Cleaner.exe")
win_dst = os.path.join(dist, "DiskStudio-Cleaner-Windows-x64.exe")
if os.path.exists(win_src):
    shutil.copy2(win_src, win_dst)
    print(f"Updated {win_dst}")

# 2. Linux x64 tar.gz
linux_bin = os.path.join(root, "target/release/DiskStudio-Cleaner")
tar_dst = os.path.join(dist, "DiskStudio-Cleaner-Linux-x64.tar.gz")

if os.path.exists(linux_bin):
    linux_stage = os.path.join(root, "target/linux_stage")
    os.makedirs(linux_stage, exist_ok=True)
    shutil.copy2(linux_bin, os.path.join(linux_stage, "DiskStudio-Cleaner"))
    os.chmod(os.path.join(linux_stage, "DiskStudio-Cleaner"), 0o755)

    desktop_entry = """[Desktop Entry]
Name=DiskStudio Cleaner
Comment=Safe, transparent disk cleaner and space manager
Exec=DiskStudio-Cleaner
Icon=system-file-manager
Terminal=false
Type=Application
Categories=Utility;System;Filesystem;
"""
    with open(os.path.join(linux_stage, "diskstudio-cleaner.desktop"), "w") as f:
        f.write(desktop_entry)

    shutil.copy2(os.path.join(root, "README.md"), os.path.join(linux_stage, "README.md"))

    with tarfile.open(tar_dst, "w:gz") as tar:
        tar.add(os.path.join(linux_stage, "DiskStudio-Cleaner"), arcname="DiskStudio-Cleaner")
        tar.add(os.path.join(linux_stage, "diskstudio-cleaner.desktop"), arcname="diskstudio-cleaner.desktop")
        tar.add(os.path.join(linux_stage, "README.md"), arcname="README.md")
    print(f"Updated {tar_dst}")

# 3. macOS bundle zip
macos_zip = os.path.join(dist, "DiskStudio-Cleaner-macOS.zip")
with zipfile.ZipFile(macos_zip, "w", zipfile.ZIP_DEFLATED) as z:
    info_plist = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>diskstudio-cleaner</string>
    <key>CFBundleIdentifier</key>
    <string>com.diskstudio.cleaner</string>
    <key>CFBundleName</key>
    <string>DiskStudio Cleaner</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>LSMinimumSystemVersion</key>
    <string>11.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
"""
    install_sh = """#!/bin/bash
set -e
echo "================================================"
echo "DiskStudio Cleaner - macOS Quick Setup & Build"
echo "================================================"
if ! command -v cargo &> /dev/null; then
    echo "Rust is required to build DiskStudio native binary on Apple Silicon / Intel."
    echo "Installing rustup..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
fi
echo "Building native macOS optimized release binary..."
cd "$(dirname "$0")/src"
cargo build --release --bin DiskStudio-Cleaner
mkdir -p "../DiskStudio Cleaner.app/Contents/MacOS"
cp target/release/DiskStudio-Cleaner "../DiskStudio Cleaner.app/Contents/MacOS/diskstudio-cleaner"
chmod +x "../DiskStudio Cleaner.app/Contents/MacOS/diskstudio-cleaner"
echo ""
echo "Build complete! DiskStudio Cleaner.app is ready in this directory."
echo "You can move DiskStudio Cleaner.app to /Applications."
"""
    z.writestr("DiskStudio Cleaner.app/Contents/Info.plist", info_plist)
    z.writestr("DiskStudio Cleaner.app/Contents/PkgInfo", "APPL????")
    z.writestr("install.sh", install_sh)
    z.write(os.path.join(root, "SPEC_MACOS.md"), arcname="MACOS_INSTRUCTIONS.md")
    z.write(os.path.join(root, "README.md"), arcname="README.md")
    for r, d, files in os.walk(root):
        d[:] = [x for x in d if x not in ("target", ".git", "dist")]
        rel = os.path.relpath(r, root)
        for f in files:
            full_p = os.path.join(r, f)
            arc_p = os.path.join("src", rel, f) if rel != "." else os.path.join("src", f)
            z.write(full_p, arcname=arc_p)
print(f"Updated {macos_zip}")

print("\n--- Artifact Hashes & Sizes ---")
for f in sorted(os.listdir(dist)):
    p = os.path.join(dist, f)
    if os.path.isfile(p):
        with open(p, "rb") as fp:
            data = fp.read()
            sha = hashlib.sha256(data).hexdigest()
            print(f"{f}: {len(data):,} bytes ({len(data)/(1024*1024):.2f} MB), SHA-256: {sha}")
