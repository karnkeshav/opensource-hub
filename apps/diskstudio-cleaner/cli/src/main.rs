use clap::{Parser, Subcommand};
use diskstudio_core::{
    load_all_builtin_rules, EnvironmentRoots, Executor, ItemKind, Outcome, Plan, PlannedItem,
    RealFs, Risk, Scanner,
};
use std::fs::File;
use std::io::{BufReader, Write};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "diskstudio-cli")]
#[command(about = "DiskStudio Cleaner CLI - Safe, transparent disk cleaning utility")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Scan for cleanable items using built-in safe rules (read-only)
    Scan {
        /// Output scan results as JSON
        #[arg(long)]
        json: bool,

        /// Optional custom rules TOML file path
        #[arg(long)]
        rules: Option<PathBuf>,
    },

    /// Create an execution Plan from scan results (immutable, hashed)
    Plan {
        /// Select safe categories only (default true)
        #[arg(long, default_value_t = true)]
        safe_only: bool,

        /// Output path for the plan file (JSON)
        #[arg(short, long, default_value = "plan.json")]
        output: PathBuf,
    },

    /// Execute an approved Plan
    Clean {
        /// Path to the approved Plan JSON file
        #[arg(short, long, default_value = "plan.json")]
        plan: PathBuf,

        /// Simulate actions without deleting any files (Invariant S10)
        #[arg(long)]
        dry_run: bool,

        /// Confirm execution
        #[arg(short = 'y', long)]
        yes: bool,
    },

    /// Scan and display the largest files and folders on the system
    Biggest {
        /// Root path to scan
        #[arg(short, long, default_value = "C:\\")]
        root: PathBuf,

        /// Number of top items to display
        #[arg(short, long, default_value_t = 20)]
        limit: usize,
    },
}

fn format_bytes(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;

    if bytes >= GB {
        format!("{:.2} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.2} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.2} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} B", bytes)
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let fs = RealFs::new();
    let env = EnvironmentRoots::default();

    match cli.command {
        Commands::Scan { json, rules } => {
            let loaded_rules = if let Some(path) = rules {
                let content = std::fs::read_to_string(&path)?;
                diskstudio_core::load_rules_from_str(&content)?
            } else {
                load_all_builtin_rules()?
            };

            let scanner = Scanner::new(&fs, env);
            let result = scanner.scan_rules(&loaded_rules, None)?;

            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                println!("============================================================");
                println!(" DiskStudio Cleaner - Scan Results (Read-Only)");
                println!("============================================================");
                let mut total_bytes = 0u64;
                let mut total_items = 0usize;

                for cat in &result.categories {
                    let risk_label = match cat.risk {
                        Risk::Safe => "[Safe - Pre-selected]",
                        Risk::UserData => "[Your Files - Recycle Bin]",
                    };

                    println!("\n* {} {}", cat.title, risk_label);
                    println!("  Description: {}", cat.description);
                    println!(
                        "  Items: {} | Size: {}",
                        cat.items.len(),
                        format_bytes(cat.total_bytes)
                    );

                    for item in &cat.items {
                        let kind_str = match item.kind {
                            ItemKind::File => "File",
                            ItemKind::Folder => "Folder",
                            ItemKind::App => "App",
                        };
                        println!(
                            "    - [{}] {} ({})",
                            kind_str,
                            item.path.display(),
                            format_bytes(item.size_bytes)
                        );
                    }

                    total_bytes += cat.total_bytes;
                    total_items += cat.items.len();
                }

                println!("\n------------------------------------------------------------");
                println!(
                    "Total cleanable space found: {} across {} items",
                    format_bytes(total_bytes),
                    total_items
                );
                println!(
                    "System drive ({}) free space: {}",
                    result.drive_stats.mount_point,
                    format_bytes(result.drive_stats.free_bytes)
                );
                println!("============================================================");
            }
        }

        Commands::Plan { safe_only, output } => {
            let rules = load_all_builtin_rules()?;
            let scanner = Scanner::new(&fs, env);
            let result = scanner.scan_rules(&rules, None)?;

            let mut planned_items = Vec::new();
            for cat in result.categories {
                if safe_only && cat.risk != Risk::Safe {
                    continue;
                }
                for item in cat.items {
                    planned_items.push(PlannedItem {
                        id: item.id,
                        path: item.path,
                        size_bytes: item.size_bytes,
                        modified: item.modified,
                        kind: item.kind,
                        action: item.action,
                    });
                }
            }

            let plan = Plan::new(planned_items);
            let json = serde_json::to_string_pretty(&plan)?;
            let mut file = File::create(&output)?;
            file.write_all(json.as_bytes())?;

            println!("Approved Plan created successfully:");
            println!("  Output: {}", output.display());
            println!("  Total items: {}", plan.items.len());
            println!("  Total size: {}", format_bytes(plan.total_bytes));
            println!("  Plan SHA-256 Hash: {}", plan.plan_hash);
        }

        Commands::Clean {
            plan: plan_path,
            dry_run,
            yes,
        } => {
            if !dry_run && !yes {
                eprintln!("Error: Confirmation required. Pass `--yes` to proceed with deletion, or use `--dry-run` to test safely.");
                std::process::exit(1);
            }

            let file = File::open(&plan_path)?;
            let reader = BufReader::new(file);
            let plan: Plan = serde_json::from_reader(reader)?;

            println!("============================================================");
            if dry_run {
                println!(" Executing Plan in DRY-RUN mode (touching no files)");
            } else {
                println!(" Executing Approved Plan (Invariant S1)");
            }
            println!(" Plan Hash: {}", plan.plan_hash);
            println!(" Total items: {}", plan.items.len());
            println!(" Target size: {}", format_bytes(plan.total_bytes));
            println!("============================================================");

            let executor = Executor::new(&fs, env);
            let exec_result = executor.execute(&plan, dry_run);

            let mut removed_cnt = 0;
            let mut recycled_cnt = 0;
            let mut skipped_cnt = 0;
            let mut failed_cnt = 0;

            for it in &exec_result.per_item {
                match &it.outcome {
                    Outcome::Removed => removed_cnt += 1,
                    Outcome::Recycled => recycled_cnt += 1,
                    Outcome::Skipped(reason) => {
                        skipped_cnt += 1;
                        println!("  [SKIPPED] {}: {}", it.path.display(), reason);
                    }
                    Outcome::Failed(err) => {
                        failed_cnt += 1;
                        println!("  [FAILED] {}: {}", it.path.display(), err);
                    }
                }
            }

            println!("\nExecution Complete:");
            println!("  Removed (permanent): {}", removed_cnt);
            println!("  Recycled (undoable):  {}", recycled_cnt);
            println!("  Skipped:             {}", skipped_cnt);
            println!("  Failed:              {}", failed_cnt);
            println!(
                "  Measured freed space: {}",
                format_bytes(exec_result.bytes_freed_measured)
            );
            println!("  Audit log written to: {}", exec_result.log_path.display());
        }

        Commands::Biggest { root, limit } => {
            println!("Scanning largest items under {} (streaming top {})...", root.display(), limit);
            let scanner = Scanner::new(&fs, env);
            let res = scanner.scan_biggest(&root, limit)?;

            println!("\nTop Largest Files:");
            for (idx, f) in res.top_files.iter().enumerate() {
                let cloud_tag = if f.in_cloud { " [Cloud Synced]" } else { "" };
                println!(
                    "  {:2}. {} - {}{}",
                    idx + 1,
                    format_bytes(f.size_bytes),
                    f.path.display(),
                    cloud_tag
                );
            }

            println!("\nTop Largest Folders (aggregate):");
            for (idx, folder) in res.top_folders.iter().enumerate() {
                println!(
                    "  {:2}. {} ({} files) - {}",
                    idx + 1,
                    format_bytes(folder.size_bytes),
                    folder.file_count,
                    folder.path.display()
                );
            }
        }
    }

    Ok(())
}
