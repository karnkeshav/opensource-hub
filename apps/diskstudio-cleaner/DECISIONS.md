# Architecture & Technology Decisions: DiskStudio Cleaner

This document records key design decisions and justifies all dependencies in accordance with Section 0 and Section 3 of `SPEC.md`.

## 1. Programming Language & Rust Edition
- **Decision:** Rust 2021 edition (stable).
- **Justification:** Memory safety, predictable execution characteristics, zero-overhead FFI to Windows APIs without runtime dependencies, and lean native binary size meeting the <= 8 MB target.

## 2. Workspace Modularization
- **Decision:** Split into 3 crates:
  1. `core`: Pure library crate holding safety invariants (S1-S10), protected path validator, filesystem abstractions (`Fs`, `RealFs`, `FakeFs`), rule parser, data models (`ScanResult`, `Plan`, `ExecutionResult`), scanner engine, executor engine, and uninstall engine. Contains zero GUI dependencies.
  2. `cli`: Command-line interface providing `scan`, `plan`, and `clean` with `--dry-run` and `--json` support for headless automation and automated testing.
  3. `gui`: Native lightweight desktop GUI built with `eframe`/`egui`.
- **Justification:** Guarantees strict decoupling of safety-critical logic from presentation, facilitates thorough headless test coverage, and fulfills spec requirement 3.2.

## 3. Dependency Justifications
Every external crate is carefully chosen to minimize size and eliminate attack surface:

- **`serde` & `serde_json`**: Required for data models, plan hashing serialization, CLI JSON outputs, and structured audit logs. Industry standard, zero network overhead.
- **`toml`**: For parsing declarative cleanable location rules stored in `core/rules/*.toml`.
- **`sha2`**: For computing deterministic SHA-256 plan hashes (`plan_hash`) to ensure approved plans are tamper-evident and audit-verifiable.
- **`rayon`**: For parallel directory walking across drives without UI freezing.
- **`clap`** (in `cli`): Type-safe CLI argument parsing with minimal feature flags.
- **`eframe` / `egui`** (in `gui`): Immediate-mode lightweight GUI compiled directly into the binary. Zero WebView2 or Node.js runtime overhead, ensuring cold starts < 1s and keeping the total executable size within <= 8 MB.
- **`windows`** (conditional on Windows targets): Microsoft's official Win32 crate for registry access, shell file operations (`SHFileOperation` / Recycle Bin), and reparse point inspection.
- **`tempfile` & `proptest`** (test-only): For reproducible isolated temporary directory testing and property-based verification of path normalisation and protected paths.
- **Strictly Excluded**: Network/HTTP libraries, telemetry frameworks, automatic background update daemons, and shell-string concatenation.

## 4. Cross-Platform Compilation & Testability
- **Decision:** All safety invariants, path rules, and filesystem interactions are abstracted through `ReadFs` and `WriteFs`.
- **Justification:** Enables 100% of the safety unit tests, property tests, plan generation, and executor safety checks to execute reliably across both native Windows environments and automated CI/Linux environments via `FakeFs` and platform-agnostic path normalizers.
