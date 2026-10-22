use diskstudio_core::{
    analyze_docker_space, discover_installed_apps, execute_docker_prune, execute_system_action,
    load_all_builtin_rules, replace_with_hardlink, scan_app_leftovers, scan_big_media,
    scan_duplicates, scan_macos_app_leftovers, scan_old_installers, scan_system_space, Action,
    AppType, BigMediaFile, DockerAnalysis, DuplicateGroup, EnvironmentRoots, ExecutionResult,
    Executor, InstalledApp, ItemKind, OldInstaller, Outcome, Plan, PlannedItem, RealFs, Risk,
    ScanResult, Scanner, SystemSpaceReport, UninstallMethod,
};
use eframe::egui::{self, Color32, RichText};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum AppScreen {
    Cleanup,     // Tier 1 & 2: Safe Junk & Dev Caches
    Biggest,     // Tier 4: Apps, Files, Folders, Duplicates, Installers, Big Media
    SystemSpace, // Tier 3 & 5: System Space & In-Place Compression
    Done,        // Final execution report
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum BiggestTab {
    Apps,
    Files,
    Folders,
    Duplicates,
    Installers,
    BigMedia,
}

struct ScanProgressMessage {
    current_path: String,
    bytes_found: u64,
}

enum BackgroundMessage {
    Progress(ScanProgressMessage),
    ScanComplete(ScanResult),
    ExecutionComplete(ExecutionResult),
    BiggestProgress {
        path: String,
        file_count: usize,
        bytes_scanned: u64,
    },
    BiggestScanComplete(diskstudio_core::BiggestDiskUsage),
    AppsScanComplete(Vec<InstalledApp>),
    DuplicatesScanComplete(Vec<DuplicateGroup>),
    InstallersScanComplete(Vec<OldInstaller>),
    BigMediaScanComplete(Vec<BigMediaFile>),
    SystemSpaceComplete(SystemSpaceReport),
    SystemActionComplete(Result<String, String>),
    DockerAnalysisComplete(DockerAnalysis),
    DockerPruneComplete(Result<String, String>),
    UninstallComplete {
        app_name: String,
        result_msg: String,
        leftovers: Vec<PlannedItem>,
    },
}

struct DiskStudioApp {
    screen: AppScreen,
    current_tab: BiggestTab,
    env: EnvironmentRoots,

    // Cleanup scan state (Tiers 1 & 2)
    is_scanning: bool,
    scan_progress_path: String,
    scan_bytes_found: u64,
    cancel_token: Option<Arc<AtomicBool>>,
    scan_result: Option<ScanResult>,

    // Selection state
    selected_items: HashSet<String>,
    expanded_categories: HashSet<String>,

    // Confirmation dialog
    show_confirm_dialog: bool,
    pending_plan: Option<Plan>,

    // Execution state
    is_executing: bool,
    execution_result: Option<ExecutionResult>,

    // Biggest state (Tier 4)
    biggest_drive: String,
    available_drives: Vec<String>,
    biggest_files: Vec<diskstudio_core::BiggestFile>,
    selected_biggest_files: HashSet<PathBuf>,
    biggest_folders: Vec<diskstudio_core::BiggestFolder>,
    installed_apps: Vec<InstalledApp>,
    app_filter_text: String,
    is_scanning_biggest: bool,
    is_scanning_apps: bool,
    biggest_progress_path: String,
    biggest_files_count: usize,
    biggest_bytes_scanned: u64,

    // Tier 4: Duplicates, Old Installers, Big Media
    duplicates: Vec<DuplicateGroup>,
    selected_duplicate_files: HashSet<PathBuf>,
    is_scanning_duplicates: bool,

    old_installers: Vec<OldInstaller>,
    selected_installers: HashSet<PathBuf>,
    is_scanning_installers: bool,

    big_media: Vec<BigMediaFile>,
    selected_big_media: HashSet<PathBuf>,
    is_scanning_big_media: bool,

    // App uninstallation modal
    pending_uninstall_app: Option<InstalledApp>,
    uninstall_leftovers: Vec<PlannedItem>,
    show_leftovers_dialog: bool,

    // System Space & Shrinking (Tiers 3 & 5)
    system_report: Option<SystemSpaceReport>,
    is_scanning_system: bool,
    is_running_system_action: bool,
    system_status_msg: String,

    // Treemap View
    show_treemap_view: bool,

    // Docker Explain-Why
    docker_analysis: Option<DockerAnalysis>,
    is_analyzing_docker: bool,
    docker_status_msg: String,

    // Background messaging channel
    rx: mpsc::Receiver<BackgroundMessage>,
    tx: mpsc::Sender<BackgroundMessage>,
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

fn detect_available_drives() -> Vec<String> {
    let mut drives = Vec::new();
    #[cfg(windows)]
    {
        for letter in b'C'..=b'Z' {
            let drive_path = format!("{}:\\", letter as char);
            if std::path::Path::new(&drive_path).exists() {
                drives.push(drive_path);
            }
        }
    }
    if drives.is_empty() {
        #[cfg(windows)]
        drives.push("C:\\".into());
        #[cfg(not(windows))]
        {
            drives.push("/".into());
            if let Ok(home) = std::env::var("HOME") {
                drives.push(home);
            }
        }
    }
    drives
}

fn open_in_file_manager(path: &Path) {
    #[cfg(windows)]
    {
        if path.is_file() {
            let _ = std::process::Command::new("explorer")
                .arg(format!("/select,\"{}\"", path.display()))
                .spawn();
        } else {
            let _ = std::process::Command::new("explorer")
                .arg(path)
                .spawn();
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn();
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let target = if path.is_file() {
            path.parent().unwrap_or(path)
        } else {
            path
        };
        let _ = std::process::Command::new("xdg-open")
            .arg(target)
            .spawn();
    }
}

fn render_windirstat_treemap(ui: &mut egui::Ui, folders: &[diskstudio_core::BiggestFolder]) {
    if folders.is_empty() {
        return;
    }

    const PALETTE: &[Color32] = &[
        Color32::from_rgb(0, 180, 216),    // Cyan
        Color32::from_rgb(238, 96, 85),    // Coral Red
        Color32::from_rgb(114, 9, 183),    // Violet
        Color32::from_rgb(76, 201, 240),   // Light Blue
        Color32::from_rgb(247, 127, 0),    // Orange
        Color32::from_rgb(42, 157, 143),   // Emerald Teal
        Color32::from_rgb(233, 196, 106),  // Amber Gold
        Color32::from_rgb(244, 162, 97),   // Sand
        Color32::from_rgb(142, 202, 230),  // Sky
        Color32::from_rgb(219, 39, 119),   // Magenta
    ];

    let total_bytes: u64 = folders.iter().map(|f| f.size_bytes).sum();
    if total_bytes == 0 {
        return;
    }

    let width = ui.available_width().max(400.0);
    let height = 360.0;
    let (response, painter) = ui.allocate_painter(egui::vec2(width, height), egui::Sense::click());
    let canvas_rect = response.rect;

    // Draw background
    painter.rect_filled(canvas_rect, 4.0, Color32::from_rgb(24, 24, 28));
    painter.rect_stroke(canvas_rect, 4.0, egui::Stroke::new(1.0_f32, Color32::from_rgb(50, 50, 60)));

    // Slice-and-dice layout algorithm
    let mut remaining_rect = canvas_rect.shrink(4.0);
    let mut horizontal_split = true;

    for (idx, folder) in folders.iter().take(12).enumerate() {
        if remaining_rect.width() < 12.0 || remaining_rect.height() < 12.0 {
            break;
        }

        let fraction = (folder.size_bytes as f32 / total_bytes as f32).clamp(0.02, 0.95);
        let color = PALETTE[idx % PALETTE.len()];

        let tile_rect = if horizontal_split {
            let tile_w = (remaining_rect.width() * fraction).max(20.0).min(remaining_rect.width());
            let r = egui::Rect::from_min_size(remaining_rect.min, egui::vec2(tile_w, remaining_rect.height()));
            remaining_rect.min.x += tile_w;
            horizontal_split = false;
            r
        } else {
            let tile_h = (remaining_rect.height() * fraction).max(20.0).min(remaining_rect.height());
            let r = egui::Rect::from_min_size(remaining_rect.min, egui::vec2(remaining_rect.width(), tile_h));
            remaining_rect.min.y += tile_h;
            horizontal_split = true;
            r
        };

        let is_hovered = response.hover_pos().map(|pos| tile_rect.contains(pos)).unwrap_or(false);

        let fill_color = if is_hovered {
            Color32::from_rgb(
                color.r().saturating_add(40),
                color.g().saturating_add(40),
                color.b().saturating_add(40),
            )
        } else {
            color
        };

        painter.rect_filled(tile_rect.shrink(1.5), 2.0, fill_color);
        painter.rect_stroke(
            tile_rect.shrink(1.5),
            2.0,
            egui::Stroke::new(
                if is_hovered { 2.5_f32 } else { 1.0_f32 },
                if is_hovered { Color32::WHITE } else { Color32::from_rgb(20, 20, 20) },
            ),
        );

        if is_hovered {
            let pct = (folder.size_bytes as f64 / total_bytes as f64) * 100.0;
            response.clone().on_hover_ui_at_pointer(|ui| {
                ui.heading(RichText::new("📁 Folder Details").size(14.0));
                ui.label(RichText::new(folder.path.display().to_string()).strong());
                ui.label(format!("Size: {} ({:.1}% of aggregate)", format_bytes(folder.size_bytes), pct));
                ui.label(format!("Files: {}", folder.file_count));
                ui.label(RichText::new("Click to open in Explorer").color(Color32::GRAY).size(11.0));
            });

            if response.clicked() {
                open_in_file_manager(&folder.path);
            }
        }

        // Draw text label if box is large enough
        if tile_rect.width() > 60.0 && tile_rect.height() > 32.0 {
            let folder_name = folder.path.file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| folder.path.display().to_string());

            painter.text(
                tile_rect.min + egui::vec2(6.0, 5.0),
                egui::Align2::LEFT_TOP,
                folder_name,
                egui::FontId::proportional(12.0),
                Color32::WHITE,
            );
            if tile_rect.height() > 46.0 {
                painter.text(
                    tile_rect.min + egui::vec2(6.0, 21.0),
                    egui::Align2::LEFT_TOP,
                    format_bytes(folder.size_bytes),
                    egui::FontId::proportional(11.0),
                    Color32::from_rgb(220, 220, 220),
                );
            }
        }
    }
}

impl DiskStudioApp {
    fn new(_cc: &eframe::CreationContext<'_>) -> Self {
        let (tx, rx) = mpsc::channel();
        let env = EnvironmentRoots::default();
        let available_drives = detect_available_drives();
        let default_drive = available_drives.first().cloned().unwrap_or_else(|| "C:\\".into());

        Self {
            screen: AppScreen::Cleanup,
            current_tab: BiggestTab::Files,
            env,
            is_scanning: false,
            scan_progress_path: String::new(),
            scan_bytes_found: 0,
            cancel_token: None,
            scan_result: None,
            selected_items: HashSet::new(),
            expanded_categories: HashSet::new(),
            show_confirm_dialog: false,
            pending_plan: None,
            is_executing: false,
            execution_result: None,
            biggest_drive: default_drive,
            available_drives,
            biggest_files: Vec::new(),
            selected_biggest_files: HashSet::new(),
            biggest_folders: Vec::new(),
            installed_apps: Vec::new(),
            app_filter_text: String::new(),
            is_scanning_biggest: false,
            is_scanning_apps: false,
            biggest_progress_path: String::new(),
            biggest_files_count: 0,
            biggest_bytes_scanned: 0,
            duplicates: Vec::new(),
            selected_duplicate_files: HashSet::new(),
            is_scanning_duplicates: false,
            old_installers: Vec::new(),
            selected_installers: HashSet::new(),
            is_scanning_installers: false,
            big_media: Vec::new(),
            selected_big_media: HashSet::new(),
            is_scanning_big_media: false,
            pending_uninstall_app: None,
            uninstall_leftovers: Vec::new(),
            show_leftovers_dialog: false,
            system_report: None,
            is_scanning_system: false,
            is_running_system_action: false,
            system_status_msg: String::new(),
            show_treemap_view: false,
            docker_analysis: None,
            is_analyzing_docker: false,
            docker_status_msg: String::new(),
            rx,
            tx,
        }
    }

    fn start_scan(&mut self) {
        self.is_scanning = true;
        self.scan_progress_path = "Starting scan...".into();
        self.scan_bytes_found = 0;
        self.selected_items.clear();

        let cancel = Arc::new(AtomicBool::new(false));
        self.cancel_token = Some(cancel.clone());

        let tx = self.tx.clone();
        let env = self.env.clone();

        thread::spawn(move || {
            let fs = RealFs::new();
            let scanner = Scanner::with_cancellation(&fs, env, cancel);
            if let Ok(rules) = load_all_builtin_rules() {
                let progress_tx = tx.clone();
                let cb = move |path: &str, bytes: u64| {
                    let _ = progress_tx.send(BackgroundMessage::Progress(ScanProgressMessage {
                        current_path: path.to_string(),
                        bytes_found: bytes,
                    }));
                };
                if let Ok(result) = scanner.scan_rules(&rules, Some(&cb)) {
                    let _ = tx.send(BackgroundMessage::ScanComplete(result));
                }
            }
        });
    }

    fn start_biggest_scan(&mut self) {
        match self.current_tab {
            BiggestTab::Apps => self.start_apps_scan(),
            BiggestTab::Files | BiggestTab::Folders => self.start_files_folders_scan(),
            BiggestTab::Duplicates => self.start_duplicates_scan(),
            BiggestTab::Installers => self.start_installers_scan(),
            BiggestTab::BigMedia => self.start_big_media_scan(),
        }
    }

    fn start_files_folders_scan(&mut self) {
        self.is_scanning_biggest = true;
        self.biggest_progress_path = format!("Initializing scan on {}...", self.biggest_drive);
        self.biggest_files_count = 0;
        self.biggest_bytes_scanned = 0;

        let root = PathBuf::from(&self.biggest_drive);
        let tx = self.tx.clone();
        let env = self.env.clone();
        let cancel = Arc::new(AtomicBool::new(false));
        self.cancel_token = Some(cancel.clone());

        thread::spawn(move || {
            let fs = RealFs::new();
            let scanner = Scanner::with_cancellation(&fs, env, cancel);
            let progress_tx = tx.clone();
            let cb = move |path: &str, count: usize, bytes: u64| {
                let _ = progress_tx.send(BackgroundMessage::BiggestProgress {
                    path: path.to_string(),
                    file_count: count,
                    bytes_scanned: bytes,
                });
            };
            if let Ok(res) = scanner.scan_biggest_with_progress(&root, 100, Some(&cb)) {
                let _ = tx.send(BackgroundMessage::BiggestScanComplete(res));
            }
        });
    }

    fn start_duplicates_scan(&mut self) {
        self.is_scanning_duplicates = true;
        let drive = PathBuf::from(&self.biggest_drive);
        let user_prof = self.env.user_profile.clone();
        let tx = self.tx.clone();

        thread::spawn(move || {
            let fs = RealFs::new();
            let roots = vec![drive, user_prof];
            let groups = scan_duplicates(&fs, &roots, 1024 * 1024, 100, None);
            let _ = tx.send(BackgroundMessage::DuplicatesScanComplete(groups));
        });
    }

    fn start_installers_scan(&mut self) {
        self.is_scanning_installers = true;
        let downloads = self.env.user_profile.join("Downloads");
        let desktop = self.env.user_profile.join("Desktop");
        let tx = self.tx.clone();

        thread::spawn(move || {
            let fs = RealFs::new();
            let dirs = vec![downloads, desktop];
            let installers = scan_old_installers(&fs, &dirs, 30);
            let _ = tx.send(BackgroundMessage::InstallersScanComplete(installers));
        });
    }

    fn start_big_media_scan(&mut self) {
        self.is_scanning_big_media = true;
        let videos = self.env.user_profile.join("Videos");
        let downloads = self.env.user_profile.join("Downloads");
        let drive = PathBuf::from(&self.biggest_drive);
        let tx = self.tx.clone();

        thread::spawn(move || {
            let fs = RealFs::new();
            let dirs = vec![videos, downloads, drive];
            let media = scan_big_media(&fs, &dirs, 100 * 1024 * 1024);
            let _ = tx.send(BackgroundMessage::BigMediaScanComplete(media));
        });
    }

    fn start_apps_scan(&mut self) {
        self.is_scanning_apps = true;
        let tx = self.tx.clone();
        let env = self.env.clone();

        thread::spawn(move || {
            let fs = RealFs::new();
            let apps = discover_installed_apps(&env, &fs);
            let _ = tx.send(BackgroundMessage::AppsScanComplete(apps));
        });
    }

    fn start_system_space_scan(&mut self) {
        self.is_scanning_system = true;
        let tx = self.tx.clone();
        let env = self.env.clone();

        thread::spawn(move || {
            let fs = RealFs::new();
            let report = scan_system_space(&env, &fs);
            let _ = tx.send(BackgroundMessage::SystemSpaceComplete(report));
        });
    }

    fn run_system_action(&mut self, item_id: String, is_active: bool) {
        self.is_running_system_action = true;
        self.system_status_msg = format!("Executing action for {}...", item_id);
        let tx = self.tx.clone();

        thread::spawn(move || {
            let res = execute_system_action(&item_id, is_active);
            let _ = tx.send(BackgroundMessage::SystemActionComplete(res));
        });
    }

    fn start_docker_analysis(&mut self) {
        self.is_analyzing_docker = true;
        let tx = self.tx.clone();
        thread::spawn(move || {
            let analysis = analyze_docker_space();
            let _ = tx.send(BackgroundMessage::DockerAnalysisComplete(analysis));
        });
    }

    fn run_docker_prune(&mut self, prune_type: String) {
        self.is_running_system_action = true;
        self.docker_status_msg = format!("Pruning Docker {}...", prune_type);
        let tx = self.tx.clone();
        thread::spawn(move || {
            let res = execute_docker_prune(&prune_type);
            let _ = tx.send(BackgroundMessage::DockerPruneComplete(res));
        });
    }

    fn execute_hardlink_deduplication(&mut self) {
        let fs = RealFs::new();
        let mut total_reclaimed = 0u64;
        let mut count = 0usize;
        let mut errs = Vec::new();

        for group in &self.duplicates {
            if let Some(orig) = group.files.first() {
                for dup in group.files.iter().skip(1) {
                    if self.selected_duplicate_files.contains(dup) {
                        match replace_with_hardlink(&fs, orig, dup) {
                            Ok(reclaimed) => {
                                total_reclaimed += reclaimed;
                                count += 1;
                            }
                            Err(e) => {
                                errs.push(format!("{}: {}", dup.display(), e));
                            }
                        }
                    }
                }
            }
        }

        if errs.is_empty() {
            self.system_status_msg = format!(
                "Hardlink Deduplication: Replaced {} files with NTFS hardlinks! {} disk space reclaimed.",
                count, format_bytes(total_reclaimed)
            );
        } else {
            self.system_status_msg = format!(
                "Hardlinked {} files ({}), but {} encountered errors: {}",
                count, format_bytes(total_reclaimed), errs.len(), errs.join("; ")
            );
        }
        self.selected_duplicate_files.clear();
        self.start_duplicates_scan();
    }

    fn execute_app_uninstall(&mut self, app: InstalledApp) {
        let tx = self.tx.clone();
        let env = self.env.clone();

        thread::spawn(move || {
            let fs = RealFs::new();
            let app_name = app.display_name.clone();

            let result_msg = match diskstudio_core::resolve_uninstall_method(&app, &env) {
                Ok(method) => match method {
                    UninstallMethod::MsiExec { guid, arguments } => {
                        let mut cmd = std::process::Command::new("msiexec.exe");
                        cmd.args(&arguments);
                        match cmd.status() {
                            Ok(st) => format!("MSI uninstaller for {} finished with code {:?}", guid, st.code()),
                            Err(e) => format!("Failed to launch msiexec: {}", e),
                        }
                    }
                    UninstallMethod::Executable { exe_path, arguments } => {
                        let mut cmd = std::process::Command::new(&exe_path);
                        cmd.args(&arguments);
                        match cmd.status() {
                            Ok(st) => format!("Uninstaller finished with code {:?}", st.code()),
                            Err(e) => format!("Failed to run uninstaller: {}", e),
                        }
                    }
                    UninstallMethod::StorePackage { package_full_name } => {
                        #[cfg(windows)]
                        {
                            let ps_cmd = format!("Remove-AppxPackage -Package '{}'", package_full_name);
                            let _ = std::process::Command::new("powershell")
                                .args(["-NoProfile", "-Command", &ps_cmd])
                                .status();
                            format!("Store package {} removed.", package_full_name)
                        }
                        #[cfg(not(windows))]
                        {
                            format!("Store package removal simulated for {}.", package_full_name)
                        }
                    }
                    UninstallMethod::PortableFolder { folder_path } => {
                        // Section 8.2: Portable folder uninstallation goes to Recycle Bin
                        let plan = Plan::new(vec![PlannedItem {
                            id: format!("uninstall-{}", app.id),
                            path: folder_path,
                            size_bytes: app.estimated_size_bytes,
                            modified: None,
                            kind: ItemKind::Folder,
                            action: Action::Recycle,
                        }]);
                        let executor = Executor::new(&fs, env.clone());
                        let res = executor.execute(&plan, false);
                        format!("Portable app folder removed to Recycle Bin (freed {}).", format_bytes(res.bytes_freed_measured))
                    }
                    _ => "Launched standard launcher uninstallation helper.".into(),
                },
                Err(e) => format!("Unable to resolve uninstall method: {}", e),
            };

            // Leftover sweep (Section 8.3)
            let leftovers = if cfg!(target_os = "macos") {
                scan_macos_app_leftovers(&app, &fs, &env)
            } else {
                scan_app_leftovers(&app, &fs, &env)
            };

            let _ = tx.send(BackgroundMessage::UninstallComplete {
                app_name,
                result_msg,
                leftovers,
            });
        });
    }

    fn cancel_scan(&mut self) {
        if let Some(token) = &self.cancel_token {
            token.store(true, Ordering::Relaxed);
        }
        self.is_scanning = false;
        self.is_scanning_biggest = false;
        self.is_scanning_apps = false;
        self.is_scanning_duplicates = false;
        self.is_scanning_installers = false;
        self.is_scanning_big_media = false;
    }

    fn calculate_selected_bytes(&self) -> u64 {
        let mut total = 0u64;
        if let Some(res) = &self.scan_result {
            for cat in &res.categories {
                for it in &cat.items {
                    if self.selected_items.contains(&it.id) {
                        total += it.size_bytes;
                    }
                }
            }
        }
        total
    }

    fn build_plan_from_selection(&self) -> Plan {
        let mut planned = Vec::new();
        if let Some(res) = &self.scan_result {
            for cat in &res.categories {
                for it in &cat.items {
                    if self.selected_items.contains(&it.id) {
                        planned.push(PlannedItem {
                            id: it.id.clone(),
                            path: it.path.clone(),
                            size_bytes: it.size_bytes,
                            modified: it.modified,
                            kind: it.kind,
                            action: it.action,
                        });
                    }
                }
            }
        }
        Plan::new(planned)
    }

    fn build_plan_from_biggest_files(&self) -> Plan {
        let mut planned = Vec::new();
        for f in &self.biggest_files {
            if self.selected_biggest_files.contains(&f.path) {
                planned.push(PlannedItem {
                    id: format!("biggest-file-{}", planned.len()),
                    path: f.path.clone(),
                    size_bytes: f.size_bytes,
                    modified: f.modified,
                    kind: ItemKind::File,
                    // Invariant S5: User data defaults to Recycle Bin with full undo!
                    action: Action::Recycle,
                });
            }
        }
        Plan::new(planned)
    }

    fn build_plan_from_duplicates(&self) -> Plan {
        let mut planned = Vec::new();
        for group in &self.duplicates {
            for f in &group.files {
                if self.selected_duplicate_files.contains(f) {
                    planned.push(PlannedItem {
                        id: format!("dup-file-{}", planned.len()),
                        path: f.clone(),
                        size_bytes: group.size_bytes,
                        modified: None,
                        kind: ItemKind::File,
                        action: Action::Recycle,
                    });
                }
            }
        }
        Plan::new(planned)
    }

    fn build_plan_from_installers(&self) -> Plan {
        let mut planned = Vec::new();
        for inst in &self.old_installers {
            if self.selected_installers.contains(&inst.path) {
                planned.push(PlannedItem {
                    id: format!("installer-{}", planned.len()),
                    path: inst.path.clone(),
                    size_bytes: inst.size_bytes,
                    modified: inst.modified_time,
                    kind: ItemKind::File,
                    action: Action::Recycle,
                });
            }
        }
        Plan::new(planned)
    }

    fn build_plan_from_big_media(&self) -> Plan {
        let mut planned = Vec::new();
        for m in &self.big_media {
            if self.selected_big_media.contains(&m.path) {
                planned.push(PlannedItem {
                    id: format!("media-{}", planned.len()),
                    path: m.path.clone(),
                    size_bytes: m.size_bytes,
                    modified: m.modified_time,
                    kind: ItemKind::File,
                    action: Action::Recycle,
                });
            }
        }
        Plan::new(planned)
    }

    fn start_execution(&mut self, plan: Plan) {
        self.is_executing = true;
        self.show_confirm_dialog = false;

        let tx = self.tx.clone();
        let env = self.env.clone();

        thread::spawn(move || {
            let fs = RealFs::new();
            let executor = Executor::new(&fs, env);
            let res = executor.execute(&plan, false);
            let _ = tx.send(BackgroundMessage::ExecutionComplete(res));
        });
    }
}

impl eframe::App for DiskStudioApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Process background messages
        while let Ok(msg) = self.rx.try_recv() {
            match msg {
                BackgroundMessage::Progress(p) => {
                    self.scan_progress_path = p.current_path;
                    self.scan_bytes_found = p.bytes_found;
                }
                BackgroundMessage::ScanComplete(res) => {
                    self.is_scanning = false;
                    self.selected_items.clear();
                    for cat in &res.categories {
                        if cat.risk == Risk::Safe {
                            for item in &cat.items {
                                self.selected_items.insert(item.id.clone());
                            }
                        }
                    }
                    self.scan_result = Some(res);
                }
                BackgroundMessage::ExecutionComplete(res) => {
                    self.is_executing = false;
                    self.execution_result = Some(res);
                    self.screen = AppScreen::Done;
                }
                BackgroundMessage::BiggestProgress {
                    path,
                    file_count,
                    bytes_scanned,
                } => {
                    self.biggest_progress_path = path;
                    self.biggest_files_count = file_count;
                    self.biggest_bytes_scanned = bytes_scanned;
                }
                BackgroundMessage::BiggestScanComplete(usage) => {
                    self.is_scanning_biggest = false;
                    self.biggest_files = usage.top_files;
                    self.biggest_folders = usage.top_folders;
                    self.biggest_files_count = usage.total_scanned_files;
                    self.biggest_bytes_scanned = usage.total_scanned_bytes;
                }
                BackgroundMessage::AppsScanComplete(apps) => {
                    self.is_scanning_apps = false;
                    self.installed_apps = apps;
                }
                BackgroundMessage::DuplicatesScanComplete(dups) => {
                    self.is_scanning_duplicates = false;
                    self.duplicates = dups;
                    self.selected_duplicate_files.clear();
                }
                BackgroundMessage::InstallersScanComplete(insts) => {
                    self.is_scanning_installers = false;
                    self.old_installers = insts;
                    self.selected_installers.clear();
                }
                BackgroundMessage::BigMediaScanComplete(media) => {
                    self.is_scanning_big_media = false;
                    self.big_media = media;
                    self.selected_big_media.clear();
                }
                BackgroundMessage::SystemSpaceComplete(report) => {
                    self.is_scanning_system = false;
                    self.system_report = Some(report);
                }
                BackgroundMessage::SystemActionComplete(res) => {
                    self.is_running_system_action = false;
                    match res {
                        Ok(msg) => self.system_status_msg = msg,
                        Err(e) => self.system_status_msg = format!("Error: {}", e),
                    }
                    self.start_system_space_scan();
                }
                BackgroundMessage::DockerAnalysisComplete(analysis) => {
                    self.is_analyzing_docker = false;
                    self.docker_analysis = Some(analysis);
                }
                BackgroundMessage::DockerPruneComplete(res) => {
                    self.is_running_system_action = false;
                    match res {
                        Ok(msg) => self.docker_status_msg = msg,
                        Err(e) => self.docker_status_msg = format!("Docker error: {}", e),
                    }
                    self.start_docker_analysis();
                }
                BackgroundMessage::UninstallComplete {
                    app_name,
                    result_msg,
                    leftovers,
                } => {
                    self.system_status_msg = format!("{}: {}", app_name, result_msg);
                    self.uninstall_leftovers = leftovers;
                    if !self.uninstall_leftovers.is_empty() {
                        self.show_leftovers_dialog = true;
                    }
                    self.start_apps_scan();
                }
            }
        }

        // Top Navigation Bar
        egui::TopBottomPanel::top("top_nav").show(ctx, |ui| {
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                ui.heading(RichText::new("DiskStudio Cleaner").strong().size(20.0));
                ui.add_space(24.0);

                if ui
                    .selectable_label(self.screen == AppScreen::Cleanup, "🧹 1. Clean up")
                    .clicked()
                {
                    self.screen = AppScreen::Cleanup;
                }
                if ui
                    .selectable_label(
                        self.screen == AppScreen::Biggest,
                        "📊 2. Biggest space users",
                    )
                    .clicked()
                {
                    self.screen = AppScreen::Biggest;
                }
                if ui
                    .selectable_label(
                        self.screen == AppScreen::SystemSpace,
                        "⚙️ 3. System & Shrink",
                    )
                    .clicked()
                {
                    self.screen = AppScreen::SystemSpace;
                    if self.system_report.is_none() && !self.is_scanning_system {
                        self.start_system_space_scan();
                    }
                }
                if self.execution_result.is_some() {
                    if ui
                        .selectable_label(self.screen == AppScreen::Done, "✅ 4. Done")
                        .clicked()
                    {
                        self.screen = AppScreen::Done;
                    }
                }
            });
            ui.add_space(8.0);
        });

        // Bottom Action Panel for Screen 1
        if self.screen == AppScreen::Cleanup && self.scan_result.is_some() && !self.is_scanning {
            egui::TopBottomPanel::bottom("bottom_bar").show(ctx, |ui| {
                ui.add_space(10.0);
                ui.horizontal(|ui| {
                    let total_bytes = self.calculate_selected_bytes();
                    let count = self.selected_items.len();
                    ui.label(
                        RichText::new(format!(
                            "Selected: {} ({} items)",
                            format_bytes(total_bytes),
                            count
                        ))
                        .strong()
                        .size(16.0),
                    );

                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let btn_text = format!("Delete selected ({})", format_bytes(total_bytes));
                        let btn = ui.add_enabled(
                            count > 0 && !self.is_executing,
                            egui::Button::new(RichText::new(btn_text).strong().size(15.0))
                                .min_size(egui::vec2(180.0, 36.0)),
                        );

                        if btn.clicked() {
                            self.pending_plan = Some(self.build_plan_from_selection());
                            self.show_confirm_dialog = true;
                        }
                    });
                });
                ui.add_space(10.0);
            });
        }

        // Central Main Screen
        egui::CentralPanel::default().show(ctx, |ui| match self.screen {
            AppScreen::Cleanup => self.render_cleanup_screen(ui),
            AppScreen::Biggest => self.render_biggest_screen(ui),
            AppScreen::SystemSpace => self.render_system_space_screen(ui),
            AppScreen::Done => self.render_done_screen(ui),
        });

        // Confirmation Modal Dialog (P1 & S1)
        if self.show_confirm_dialog {
            self.render_confirm_modal(ctx);
        }

        // Uninstall Modal Dialog
        if self.pending_uninstall_app.is_some() {
            self.render_uninstall_modal(ctx);
        }

        // Leftovers Review Dialog
        if self.show_leftovers_dialog {
            self.render_leftovers_modal(ctx);
        }

        if self.is_scanning
            || self.is_scanning_biggest
            || self.is_scanning_apps
            || self.is_scanning_duplicates
            || self.is_scanning_installers
            || self.is_scanning_big_media
            || self.is_scanning_system
            || self.is_analyzing_docker
            || self.is_executing
            || self.is_running_system_action
        {
            ctx.request_repaint();
        }
    }
}

impl DiskStudioApp {
    fn render_cleanup_screen(&mut self, ui: &mut egui::Ui) {
        if self.scan_result.is_none() && !self.is_scanning {
            ui.vertical_centered(|ui| {
                ui.add_space(100.0);
                ui.label(
                    RichText::new("Find files you can safely remove to free up space.")
                        .size(18.0)
                        .color(Color32::from_rgb(180, 180, 190)),
                );
                ui.add_space(24.0);

                let scan_btn = ui.add(
                    egui::Button::new(RichText::new("Scan my PC").size(18.0).strong())
                        .min_size(egui::vec2(220.0, 48.0)),
                );
                if scan_btn.clicked() {
                    self.start_scan();
                }
            });
            return;
        }

        if self.is_scanning {
            ui.vertical_centered(|ui| {
                ui.add_space(80.0);
                ui.heading(RichText::new("Scanning for safe cleanable files...").size(20.0));
                ui.add_space(16.0);
                ui.add(egui::Spinner::new().size(36.0));
                ui.add_space(16.0);
                ui.label(
                    RichText::new(format!(
                        "Found so far: {}",
                        format_bytes(self.scan_bytes_found)
                    ))
                    .size(16.0)
                    .strong(),
                );
                ui.add_space(8.0);
                ui.label(
                    RichText::new(&self.scan_progress_path)
                        .size(13.0)
                        .color(Color32::GRAY),
                );
                ui.add_space(24.0);

                if ui
                    .add(egui::Button::new("Cancel").min_size(egui::vec2(120.0, 32.0)))
                    .clicked()
                {
                    self.cancel_scan();
                }
            });
            return;
        }

        // Render Results Table
        let mut trigger_rescan = false;
        if let Some(res) = &self.scan_result {
            egui::ScrollArea::vertical().show(ui, |ui| {
                ui.add_space(8.0);
                ui.horizontal(|ui| {
                    ui.label(RichText::new("Cleanable Categories").strong().size(17.0));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.button("Scan again").clicked() {
                            trigger_rescan = true;
                        }
                    });
                });
                ui.separator();

                let mut to_toggle_cat: Option<(String, bool)> = None;

                for cat in &res.categories {
                    let cat_id = &cat.id;
                    let is_expanded = self.expanded_categories.contains(cat_id);

                    let cat_items_all_selected = !cat.items.is_empty()
                        && cat
                            .items
                            .iter()
                            .all(|it| self.selected_items.contains(&it.id));
                    let mut cat_checked = cat_items_all_selected;

                    ui.group(|ui| {
                        ui.horizontal(|ui| {
                            if ui.checkbox(&mut cat_checked, "").changed() {
                                to_toggle_cat = Some((cat_id.clone(), cat_checked));
                            }

                            let arrow = if is_expanded { "▼" } else { "▶" };
                            if ui.button(arrow).clicked() {
                                if is_expanded {
                                    self.expanded_categories.remove(cat_id);
                                } else {
                                    self.expanded_categories.insert(cat_id.clone());
                                }
                            }

                            ui.vertical(|ui| {
                                ui.horizontal(|ui| {
                                    ui.label(RichText::new(&cat.title).strong().size(15.0));

                                    match cat.risk {
                                        Risk::Safe => {
                                            ui.colored_label(
                                                Color32::from_rgb(46, 160, 67),
                                                "[Safe]",
                                            );
                                        }
                                        Risk::UserData => {
                                            ui.colored_label(
                                                Color32::from_rgb(220, 140, 20),
                                                "[Your files - Recycle Bin]",
                                            );
                                        }
                                    }

                                    ui.with_layout(
                                        egui::Layout::right_to_left(egui::Align::Center),
                                        |ui| {
                                            ui.label(
                                                RichText::new(format_bytes(cat.total_bytes))
                                                    .strong()
                                                    .size(15.0),
                                            );
                                        },
                                    );
                                });

                                ui.label(
                                    RichText::new(&cat.description)
                                        .size(12.5)
                                        .color(Color32::GRAY),
                                );
                            });
                        });

                        // Expandable file list
                        if is_expanded {
                            ui.separator();
                            egui::ScrollArea::vertical().max_height(200.0).show(ui, |ui| {
                                for item in &cat.items {
                                    let mut item_checked = self.selected_items.contains(&item.id);
                                    ui.horizontal(|ui| {
                                        ui.add_space(24.0);
                                        if ui.checkbox(&mut item_checked, "").changed() {
                                            if item_checked {
                                                self.selected_items.insert(item.id.clone());
                                            } else {
                                                self.selected_items.remove(&item.id);
                                            }
                                        }
                                        ui.label(
                                            RichText::new(item.path.to_string_lossy().to_string())
                                                .size(12.0),
                                        );

                                        if item.flags.in_cloud_folder {
                                            ui.colored_label(
                                                Color32::from_rgb(70, 130, 180),
                                                "[Cloud]",
                                            );
                                        }

                                        ui.with_layout(
                                            egui::Layout::right_to_left(egui::Align::Center),
                                            |ui| {
                                                ui.label(format_bytes(item.size_bytes));
                                            },
                                        );
                                    });
                                }
                            });
                        }
                    });
                    ui.add_space(4.0);
                }

                if let Some((cid, check_val)) = to_toggle_cat {
                    if let Some(target_cat) = res.categories.iter().find(|c| c.id == cid) {
                        for it in &target_cat.items {
                            if check_val {
                                self.selected_items.insert(it.id.clone());
                            } else {
                                self.selected_items.remove(&it.id);
                            }
                        }
                    }
                }
            });
        }

        if trigger_rescan {
            self.start_scan();
        }
    }

    fn render_biggest_screen(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.selectable_value(&mut self.current_tab, BiggestTab::Apps, "📱 Apps");
            ui.selectable_value(&mut self.current_tab, BiggestTab::Files, "📄 Largest Files");
            ui.selectable_value(&mut self.current_tab, BiggestTab::Folders, "📁 Largest Folders");
            ui.selectable_value(&mut self.current_tab, BiggestTab::Duplicates, "👥 Duplicate Files");
            ui.selectable_value(&mut self.current_tab, BiggestTab::Installers, "💾 Old Installers");
            ui.selectable_value(&mut self.current_tab, BiggestTab::BigMedia, "🎬 Big Videos");

            let is_any_scanning = self.is_scanning_biggest
                || self.is_scanning_apps
                || self.is_scanning_duplicates
                || self.is_scanning_installers
                || self.is_scanning_big_media;

            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if is_any_scanning {
                    if ui.button("⏹ Cancel Scan").clicked() {
                        self.cancel_scan();
                    }
                } else {
                    let btn_text = match self.current_tab {
                        BiggestTab::Apps => "🔍 Scan Installed Apps",
                        BiggestTab::Files | BiggestTab::Folders => "🔍 Scan Drive",
                        BiggestTab::Duplicates => "🔍 Scan for Duplicates",
                        BiggestTab::Installers => "🔍 Scan Old Installers",
                        BiggestTab::BigMedia => "🔍 Scan Big Videos",
                    };
                    if ui.button(RichText::new(btn_text).strong()).clicked() {
                        self.start_biggest_scan();
                    }
                }

                if matches!(
                    self.current_tab,
                    BiggestTab::Files
                        | BiggestTab::Folders
                        | BiggestTab::Duplicates
                        | BiggestTab::BigMedia
                ) {
                    egui::ComboBox::from_label("")
                        .selected_text(&self.biggest_drive)
                        .show_ui(ui, |ui| {
                            for d in &self.available_drives {
                                ui.selectable_value(&mut self.biggest_drive, d.clone(), d);
                            }
                        });
                    ui.label("Target Drive:");
                }
            });
        });
        ui.separator();

        // Active scanning progress panel
        if self.is_scanning_biggest {
            ui.vertical_centered(|ui| {
                ui.add_space(40.0);
                ui.heading(
                    RichText::new(format!(
                        "Scanning {} for largest space users...",
                        self.biggest_drive
                    ))
                    .size(18.0),
                );
                ui.add_space(12.0);
                ui.add(egui::Spinner::new().size(32.0));
                ui.add_space(12.0);
                ui.label(
                    RichText::new(format!(
                        "Scanned {} files ({})",
                        self.biggest_files_count,
                        format_bytes(self.biggest_bytes_scanned)
                    ))
                    .strong(),
                );
                ui.add_space(6.0);
                ui.label(
                    RichText::new(&self.biggest_progress_path)
                        .size(12.0)
                        .color(Color32::GRAY),
                );
                ui.add_space(30.0);
            });
            return;
        }

        if self.is_scanning_apps {
            ui.vertical_centered(|ui| {
                ui.add_space(40.0);
                ui.heading(
                    RichText::new("Enumerating installed software and calculating sizes...")
                        .size(18.0),
                );
                ui.add_space(12.0);
                ui.add(egui::Spinner::new().size(32.0));
                ui.add_space(30.0);
            });
            return;
        }

        if self.is_scanning_duplicates {
            ui.vertical_centered(|ui| {
                ui.add_space(40.0);
                ui.heading(
                    RichText::new("Scanning for duplicate files with matching SHA-256 fingerprints...")
                        .size(18.0),
                );
                ui.add_space(12.0);
                ui.add(egui::Spinner::new().size(32.0));
                ui.add_space(30.0);
            });
            return;
        }

        if self.is_scanning_installers {
            ui.vertical_centered(|ui| {
                ui.add_space(40.0);
                ui.heading(
                    RichText::new("Scanning Downloads & Desktop for setup installers older than 30 days...")
                        .size(18.0),
                );
                ui.add_space(12.0);
                ui.add(egui::Spinner::new().size(32.0));
                ui.add_space(30.0);
            });
            return;
        }

        if self.is_scanning_big_media {
            ui.vertical_centered(|ui| {
                ui.add_space(40.0);
                ui.heading(
                    RichText::new("Scanning for large video and media files (> 100MB)...")
                        .size(18.0),
                );
                ui.add_space(12.0);
                ui.add(egui::Spinner::new().size(32.0));
                ui.add_space(30.0);
            });
            return;
        }

        // Render tab contents
        match self.current_tab {
            BiggestTab::Apps => {
                if self.installed_apps.is_empty() {
                    ui.vertical_centered(|ui| {
                        ui.add_space(60.0);
                        ui.label(
                            RichText::new(
                                "Click 'Scan Installed Apps' to discover installed programs on your system, sorted by size on disk.",
                            )
                            .size(16.0)
                            .color(Color32::from_rgb(170, 170, 180)),
                        );
                        ui.add_space(16.0);
                        if ui
                            .add(
                                egui::Button::new(
                                    RichText::new("🔍 Scan Installed Apps").size(16.0).strong(),
                                )
                                .min_size(egui::vec2(220.0, 40.0)),
                            )
                            .clicked()
                        {
                            self.start_apps_scan();
                        }
                    });
                } else {
                    let total_apps_size: u64 =
                        self.installed_apps.iter().map(|a| a.estimated_size_bytes).sum();
                    ui.horizontal(|ui| {
                        ui.label(
                            RichText::new(format!(
                                "Found {} installed applications (Total: {})",
                                self.installed_apps.len(),
                                format_bytes(total_apps_size)
                            ))
                            .strong(),
                        );
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            ui.text_edit_singleline(&mut self.app_filter_text);
                            ui.label("Filter:");
                        });
                    });
                    ui.add_space(4.0);

                    let filter_lower = self.app_filter_text.trim().to_ascii_lowercase();
                    let mut app_to_uninstall = None;

                    egui::ScrollArea::vertical().show(ui, |ui| {
                        for (idx, app) in self.installed_apps.iter().enumerate() {
                            if !filter_lower.is_empty()
                                && !app.display_name.to_ascii_lowercase().contains(&filter_lower)
                            {
                                continue;
                            }

                            ui.group(|ui| {
                                ui.horizontal(|ui| {
                                    ui.label(
                                        RichText::new(format!("{:2}.", idx + 1))
                                            .color(Color32::GRAY),
                                    );
                                    ui.label(RichText::new("📱").size(16.0));

                                    ui.vertical(|ui| {
                                        ui.horizontal(|ui| {
                                            ui.label(
                                                RichText::new(&app.display_name).strong().size(14.5),
                                            );

                                            let type_badge = match app.app_type {
                                                AppType::Msi => "[MSI]",
                                                AppType::Store => "[Store/MSIX]",
                                                AppType::Steam => "[Steam]",
                                                AppType::Epic => "[Epic]",
                                                AppType::Exe => "[Standard Exe]",
                                                AppType::Portable => "[Portable Folder]",
                                            };
                                            ui.colored_label(
                                                Color32::from_rgb(100, 149, 237),
                                                type_badge,
                                            );
                                        });

                                        let mut subtext = Vec::new();
                                        if let Some(publ) = &app.publisher {
                                            subtext.push(publ.clone());
                                        }
                                        if let Some(ver) = &app.display_version {
                                            subtext.push(format!("v{}", ver));
                                        }
                                        if let Some(date) = &app.install_date {
                                            subtext.push(format!("Installed: {}", date));
                                        }
                                        if !subtext.is_empty() {
                                            ui.label(
                                                RichText::new(subtext.join(" • "))
                                                    .size(11.5)
                                                    .color(Color32::GRAY),
                                            );
                                        }
                                    });

                                    ui.with_layout(
                                        egui::Layout::right_to_left(egui::Align::Center),
                                        |ui| {
                                            let uninst_btn = ui.add(
                                                egui::Button::new(
                                                    RichText::new("Uninstall").strong(),
                                                )
                                                .fill(Color32::from_rgb(180, 50, 50)),
                                            );
                                            if uninst_btn.clicked() {
                                                app_to_uninstall = Some(app.clone());
                                            }

                                            ui.label(
                                                RichText::new(format_bytes(
                                                    app.estimated_size_bytes,
                                                ))
                                                .strong()
                                                .size(14.5),
                                            );
                                        },
                                    );
                                });
                            });
                            ui.add_space(2.0);
                        }
                    });

                    if let Some(app) = app_to_uninstall {
                        self.pending_uninstall_app = Some(app);
                    }
                }
            }

            BiggestTab::Files => {
                if self.biggest_files.is_empty() {
                    ui.vertical_centered(|ui| {
                        ui.add_space(60.0);
                        ui.label(
                            RichText::new(format!(
                                "Click 'Scan Drive' to find the 100 largest individual files on {}.",
                                self.biggest_drive
                            ))
                            .size(16.0)
                            .color(Color32::from_rgb(170, 170, 180)),
                        );
                        ui.add_space(16.0);
                        if ui
                            .add(
                                egui::Button::new(
                                    RichText::new(format!("🔍 Scan {}", self.biggest_drive))
                                        .size(16.0)
                                        .strong(),
                                )
                                .min_size(egui::vec2(220.0, 40.0)),
                            )
                            .clicked()
                        {
                            self.start_biggest_scan();
                        }
                    });
                } else {
                    let total_top_size: u64 = self.biggest_files.iter().map(|f| f.size_bytes).sum();
                    let selected_count = self.selected_biggest_files.len();
                    let selected_bytes: u64 = self
                        .biggest_files
                        .iter()
                        .filter(|f| self.selected_biggest_files.contains(&f.path))
                        .map(|f| f.size_bytes)
                        .sum();

                    ui.horizontal(|ui| {
                        ui.label(
                            RichText::new(format!(
                                "Top {} largest files on {} (Total: {})",
                                self.biggest_files.len(),
                                self.biggest_drive,
                                format_bytes(total_top_size)
                            ))
                            .strong(),
                        );

                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if selected_count > 0 {
                                let del_btn = ui.add(
                                    egui::Button::new(
                                        RichText::new(format!(
                                            "Move Selected to Recycle Bin ({})",
                                            format_bytes(selected_bytes)
                                        ))
                                        .color(Color32::WHITE)
                                        .strong(),
                                    )
                                    .fill(Color32::from_rgb(180, 50, 50)),
                                );
                                if del_btn.clicked() {
                                    self.pending_plan =
                                        Some(self.build_plan_from_biggest_files());
                                    self.show_confirm_dialog = true;
                                }
                            }

                            if ui.button("Select None").clicked() {
                                self.selected_biggest_files.clear();
                            }
                        });
                    });
                    ui.separator();

                    egui::ScrollArea::vertical().show(ui, |ui| {
                        for (idx, f) in self.biggest_files.iter().enumerate() {
                            let mut is_selected = self.selected_biggest_files.contains(&f.path);
                            ui.horizontal(|ui| {
                                if ui.checkbox(&mut is_selected, "").changed() {
                                    if is_selected {
                                        self.selected_biggest_files.insert(f.path.clone());
                                    } else {
                                        self.selected_biggest_files.remove(&f.path);
                                    }
                                }

                                ui.label(
                                    RichText::new(format!("{:2}.", idx + 1)).color(Color32::GRAY),
                                );

                                let file_name = f
                                    .path
                                    .file_name()
                                    .map(|s| s.to_string_lossy().to_string())
                                    .unwrap_or_else(|| f.path.display().to_string());

                                ui.label(RichText::new(file_name).strong())
                                    .on_hover_text(f.path.display().to_string());

                                if f.in_cloud {
                                    ui.colored_label(
                                        Color32::from_rgb(70, 130, 180),
                                        "[Cloud Placeholder]",
                                    );
                                }

                                ui.with_layout(
                                    egui::Layout::right_to_left(egui::Align::Center),
                                    |ui| {
                                        if ui.button("📂 Open Folder").clicked() {
                                            open_in_file_manager(&f.path);
                                        }

                                        ui.label(
                                            RichText::new(format_bytes(f.size_bytes)).strong(),
                                        );
                                    },
                                );
                            });
                            ui.separator();
                        }
                    });
                }
            }

            BiggestTab::Folders => {
                if self.biggest_folders.is_empty() {
                    ui.vertical_centered(|ui| {
                        ui.add_space(60.0);
                        ui.label(
                            RichText::new(format!(
                                "Click 'Scan Drive' to find largest folders by aggregate disk usage on {}.",
                                self.biggest_drive
                            ))
                            .size(16.0)
                            .color(Color32::from_rgb(170, 170, 180)),
                        );
                        ui.add_space(16.0);
                        if ui
                            .add(
                                egui::Button::new(
                                    RichText::new(format!("🔍 Scan {}", self.biggest_drive))
                                        .size(16.0)
                                        .strong(),
                                )
                                .min_size(egui::vec2(220.0, 40.0)),
                            )
                            .clicked()
                        {
                            self.start_biggest_scan();
                        }
                    });
                } else {
                    let max_folder_size = self
                        .biggest_folders
                        .first()
                        .map(|f| f.size_bytes)
                        .unwrap_or(1);

                    ui.horizontal(|ui| {
                        ui.label(
                            RichText::new(format!(
                                "Largest Aggregate Folders on {}",
                                self.biggest_drive
                            ))
                            .strong(),
                        );

                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui
                                .selectable_label(self.show_treemap_view, "📊 WinDirStat Treemap")
                                .clicked()
                            {
                                self.show_treemap_view = true;
                            }
                            if ui
                                .selectable_label(!self.show_treemap_view, "📋 List View")
                                .clicked()
                            {
                                self.show_treemap_view = false;
                            }
                        });
                    });
                    ui.separator();

                    if self.show_treemap_view {
                        render_windirstat_treemap(ui, &self.biggest_folders);
                    } else {
                        egui::ScrollArea::vertical().show(ui, |ui| {
                            for (idx, folder) in self.biggest_folders.iter().enumerate() {
                                let fraction = (folder.size_bytes as f32 / max_folder_size as f32)
                                    .clamp(0.02, 1.0);

                                ui.group(|ui| {
                                    ui.horizontal(|ui| {
                                        ui.label(
                                            RichText::new(format!("{:2}.", idx + 1))
                                                .color(Color32::GRAY),
                                        );
                                        ui.label(RichText::new("📁").size(16.0));
                                        ui.label(RichText::new(folder.path.display().to_string()).strong());

                                        ui.with_layout(
                                            egui::Layout::right_to_left(egui::Align::Center),
                                            |ui| {
                                                if ui.button("📂 Open Folder").clicked() {
                                                    open_in_file_manager(&folder.path);
                                                }

                                                ui.label(
                                                    RichText::new(format_bytes(folder.size_bytes))
                                                        .strong(),
                                                );
                                                ui.label(
                                                    RichText::new(format!(
                                                        "{} files",
                                                        folder.file_count
                                                    ))
                                                    .color(Color32::GRAY)
                                                    .size(12.0),
                                                );
                                            },
                                        );
                                    });

                                    ui.add(
                                        egui::ProgressBar::new(fraction)
                                            .show_percentage()
                                            .animate(false),
                                    );
                                });
                                ui.add_space(2.0);
                            }
                        });
                    }
                }
            }

            BiggestTab::Duplicates => {
                if self.duplicates.is_empty() {
                    ui.vertical_centered(|ui| {
                        ui.add_space(60.0);
                        ui.label(
                            RichText::new("Find duplicate files with identical contents taking up wasted disk space.")
                                .size(16.0)
                                .color(Color32::from_rgb(170, 170, 180)),
                        );
                        ui.add_space(16.0);
                        if ui
                            .add(
                                egui::Button::new(
                                    RichText::new("🔍 Scan for Duplicates").size(16.0).strong(),
                                )
                                .min_size(egui::vec2(220.0, 40.0)),
                            )
                            .clicked()
                        {
                            self.start_duplicates_scan();
                        }
                    });
                } else {
                    let total_wasted: u64 = self.duplicates.iter().map(|g| g.wasted_bytes).sum();
                    let selected_count = self.selected_duplicate_files.len();
                    let selected_bytes: u64 = self
                        .duplicates
                        .iter()
                        .flat_map(|g| g.files.iter().map(move |f| (f, g.size_bytes)))
                        .filter(|(f, _)| self.selected_duplicate_files.contains(*f))
                        .map(|(_, sz)| sz)
                        .sum();

                    ui.horizontal(|ui| {
                        ui.label(
                            RichText::new(format!(
                                "Found {} duplicate groups (Wasted space: {})",
                                self.duplicates.len(),
                                format_bytes(total_wasted)
                            ))
                            .strong(),
                        );

                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if selected_count > 0 {
                                let del_btn = ui.add(
                                    egui::Button::new(
                                        RichText::new(format!(
                                            "Move Selected Duplicates to Recycle Bin ({})",
                                            format_bytes(selected_bytes)
                                        ))
                                        .color(Color32::WHITE)
                                        .strong(),
                                    )
                                    .fill(Color32::from_rgb(180, 50, 50)),
                                );
                                if del_btn.clicked() {
                                    self.pending_plan = Some(self.build_plan_from_duplicates());
                                    self.show_confirm_dialog = true;
                                }

                                let hardlink_btn = ui.add(
                                    egui::Button::new(
                                        RichText::new(format!(
                                            "🔗 Replace with Hardlinks (0 files lost, save {})",
                                            format_bytes(selected_bytes)
                                        ))
                                        .color(Color32::WHITE)
                                        .strong(),
                                    )
                                    .fill(Color32::from_rgb(46, 120, 180)),
                                );
                                if hardlink_btn.clicked() {
                                    self.execute_hardlink_deduplication();
                                }
                            }

                            if ui.button("Select None").clicked() {
                                self.selected_duplicate_files.clear();
                            }
                            if ui.button("Select All Duplicates (Keep 1st)").clicked() {
                                self.selected_duplicate_files.clear();
                                for g in &self.duplicates {
                                    for f in g.files.iter().skip(1) {
                                        self.selected_duplicate_files.insert(f.clone());
                                    }
                                }
                            }
                        });
                    });
                    ui.separator();

                    egui::ScrollArea::vertical().show(ui, |ui| {
                        for (g_idx, group) in self.duplicates.iter().enumerate() {
                            ui.group(|ui| {
                                ui.horizontal(|ui| {
                                    ui.label(RichText::new(format!("👥 Group #{}: {} identical copies", g_idx + 1, group.files.len())).strong());
                                    ui.colored_label(Color32::from_rgb(220, 160, 40), format!("{} each", format_bytes(group.size_bytes)));
                                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                        ui.label(RichText::new(format!("Wasted: {}", format_bytes(group.wasted_bytes))).strong().color(Color32::from_rgb(240, 100, 100)));
                                    });
                                });
                                ui.separator();

                                for (f_idx, file_path) in group.files.iter().enumerate() {
                                    let mut is_checked = self.selected_duplicate_files.contains(file_path);
                                    ui.horizontal(|ui| {
                                        ui.add_space(12.0);
                                        if ui.checkbox(&mut is_checked, "").changed() {
                                            if is_checked {
                                                self.selected_duplicate_files.insert(file_path.clone());
                                            } else {
                                                self.selected_duplicate_files.remove(file_path);
                                            }
                                        }

                                        let label = if f_idx == 0 {
                                            format!("Copy #{} (Original)", f_idx + 1)
                                        } else {
                                            format!("Copy #{}", f_idx + 1)
                                        };
                                        ui.colored_label(Color32::GRAY, label);
                                        ui.label(RichText::new(file_path.display().to_string()).size(13.0));

                                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                            if ui.button("📂 Open Folder").clicked() {
                                                open_in_file_manager(file_path);
                                            }
                                        });
                                    });
                                }
                            });
                            ui.add_space(4.0);
                        }
                    });
                }
            }

            BiggestTab::Installers => {
                if self.old_installers.is_empty() {
                    ui.vertical_centered(|ui| {
                        ui.add_space(60.0);
                        ui.label(
                            RichText::new("Scan Downloads and user folders for old setup installers (.exe, .msi, .iso, .zip) older than 30 days.")
                                .size(16.0)
                                .color(Color32::from_rgb(170, 170, 180)),
                        );
                        ui.add_space(16.0);
                        if ui
                            .add(
                                egui::Button::new(
                                    RichText::new("🔍 Scan Old Installers").size(16.0).strong(),
                                )
                                .min_size(egui::vec2(220.0, 40.0)),
                            )
                            .clicked()
                        {
                            self.start_installers_scan();
                        }
                    });
                } else {
                    let total_size: u64 = self.old_installers.iter().map(|i| i.size_bytes).sum();
                    let selected_count = self.selected_installers.len();
                    let selected_bytes: u64 = self
                        .old_installers
                        .iter()
                        .filter(|i| self.selected_installers.contains(&i.path))
                        .map(|i| i.size_bytes)
                        .sum();

                    ui.horizontal(|ui| {
                        ui.label(
                            RichText::new(format!(
                                "Found {} old installers (Total: {})",
                                self.old_installers.len(),
                                format_bytes(total_size)
                            ))
                            .strong(),
                        );

                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if selected_count > 0 {
                                let del_btn = ui.add(
                                    egui::Button::new(
                                        RichText::new(format!(
                                            "Move Selected Installers to Recycle Bin ({})",
                                            format_bytes(selected_bytes)
                                        ))
                                        .color(Color32::WHITE)
                                        .strong(),
                                    )
                                    .fill(Color32::from_rgb(180, 50, 50)),
                                );
                                if del_btn.clicked() {
                                    self.pending_plan = Some(self.build_plan_from_installers());
                                    self.show_confirm_dialog = true;
                                }
                            }

                            if ui.button("Select None").clicked() {
                                self.selected_installers.clear();
                            }
                            if ui.button("Select All").clicked() {
                                for i in &self.old_installers {
                                    self.selected_installers.insert(i.path.clone());
                                }
                            }
                        });
                    });
                    ui.separator();

                    egui::ScrollArea::vertical().show(ui, |ui| {
                        for (idx, inst) in self.old_installers.iter().enumerate() {
                            let mut is_checked = self.selected_installers.contains(&inst.path);
                            ui.group(|ui| {
                                ui.horizontal(|ui| {
                                    if ui.checkbox(&mut is_checked, "").changed() {
                                        if is_checked {
                                            self.selected_installers.insert(inst.path.clone());
                                        } else {
                                            self.selected_installers.remove(&inst.path);
                                        }
                                    }

                                    ui.label(RichText::new(format!("{:2}.", idx + 1)).color(Color32::GRAY));
                                    ui.label(RichText::new("💾").size(16.0));
                                    ui.vertical(|ui| {
                                        ui.horizontal(|ui| {
                                            ui.label(RichText::new(&inst.name).strong().size(14.0));
                                            ui.colored_label(Color32::from_rgb(220, 160, 40), format!("[{} days old]", inst.age_days));
                                        });
                                        ui.label(RichText::new(inst.path.display().to_string()).size(11.5).color(Color32::GRAY));
                                    });

                                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                        if ui.button("📂 Open Folder").clicked() {
                                            open_in_file_manager(&inst.path);
                                        }
                                        ui.label(RichText::new(format_bytes(inst.size_bytes)).strong());
                                    });
                                });
                            });
                            ui.add_space(2.0);
                        }
                    });
                }
            }

            BiggestTab::BigMedia => {
                if self.big_media.is_empty() {
                    ui.vertical_centered(|ui| {
                        ui.add_space(60.0);
                        ui.label(
                            RichText::new("Scan drives and user folders for large video and media files (> 100MB).")
                                .size(16.0)
                                .color(Color32::from_rgb(170, 170, 180)),
                        );
                        ui.add_space(16.0);
                        if ui
                            .add(
                                egui::Button::new(
                                    RichText::new("🔍 Scan Big Videos").size(16.0).strong(),
                                )
                                .min_size(egui::vec2(220.0, 40.0)),
                            )
                            .clicked()
                        {
                            self.start_big_media_scan();
                        }
                    });
                } else {
                    let total_size: u64 = self.big_media.iter().map(|m| m.size_bytes).sum();
                    let selected_count = self.selected_big_media.len();
                    let selected_bytes: u64 = self
                        .big_media
                        .iter()
                        .filter(|m| self.selected_big_media.contains(&m.path))
                        .map(|m| m.size_bytes)
                        .sum();

                    ui.horizontal(|ui| {
                        ui.label(
                            RichText::new(format!(
                                "Found {} large media files (Total: {})",
                                self.big_media.len(),
                                format_bytes(total_size)
                            ))
                            .strong(),
                        );

                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if selected_count > 0 {
                                let del_btn = ui.add(
                                    egui::Button::new(
                                        RichText::new(format!(
                                            "Move Selected Media to Recycle Bin ({})",
                                            format_bytes(selected_bytes)
                                        ))
                                        .color(Color32::WHITE)
                                        .strong(),
                                    )
                                    .fill(Color32::from_rgb(180, 50, 50)),
                                );
                                if del_btn.clicked() {
                                    self.pending_plan = Some(self.build_plan_from_big_media());
                                    self.show_confirm_dialog = true;
                                }
                            }

                            if ui.button("Select None").clicked() {
                                self.selected_big_media.clear();
                            }
                            if ui.button("Select All").clicked() {
                                for m in &self.big_media {
                                    self.selected_big_media.insert(m.path.clone());
                                }
                            }
                        });
                    });
                    ui.separator();

                    egui::ScrollArea::vertical().show(ui, |ui| {
                        for (idx, media) in self.big_media.iter().enumerate() {
                            let mut is_checked = self.selected_big_media.contains(&media.path);
                            ui.group(|ui| {
                                ui.horizontal(|ui| {
                                    if ui.checkbox(&mut is_checked, "").changed() {
                                        if is_checked {
                                            self.selected_big_media.insert(media.path.clone());
                                        } else {
                                            self.selected_big_media.remove(&media.path);
                                        }
                                    }

                                    ui.label(RichText::new(format!("{:2}.", idx + 1)).color(Color32::GRAY));
                                    ui.label(RichText::new("🎬").size(16.0));
                                    ui.vertical(|ui| {
                                        ui.horizontal(|ui| {
                                            ui.label(RichText::new(&media.name).strong().size(14.0));
                                            ui.colored_label(Color32::from_rgb(100, 149, 237), format!("[{}]", media.file_type));
                                        });
                                        ui.label(RichText::new(media.path.display().to_string()).size(11.5).color(Color32::GRAY));
                                    });

                                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                        if ui.button("📂 Open Folder").clicked() {
                                            open_in_file_manager(&media.path);
                                        }
                                        ui.label(RichText::new(format_bytes(media.size_bytes)).strong());
                                    });
                                });
                            });
                            ui.add_space(2.0);
                        }
                    });
                }
            }
        }
    }

    fn render_system_space_screen(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.heading(
                RichText::new("⚙️ System Space & In-Place Compression (Tier 3 & Tier 5)").size(18.0),
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if self.is_scanning_system {
                    ui.spinner();
                    ui.label("Scanning system...");
                } else if ui.button("🔄 Refresh System Status").clicked() {
                    self.start_system_space_scan();
                }
            });
        });
        ui.label(
            RichText::new(
                "Clean up OS recovery caches, component store, and compress system files without deleting user documents.",
            )
            .color(Color32::GRAY),
        );
        ui.separator();

        if !self.system_status_msg.is_empty() {
            ui.group(|ui| {
                ui.horizontal(|ui| {
                    ui.label(RichText::new("ℹ Status:").strong());
                    ui.label(RichText::new(&self.system_status_msg).color(Color32::from_rgb(100, 180, 240)));
                });
            });
            ui.add_space(8.0);
        }

        let report = match &self.system_report {
            Some(r) => r.clone(),
            None => {
                ui.vertical_centered(|ui| {
                    ui.add_space(40.0);
                    ui.spinner();
                    ui.label("Gathering system space analytics...");
                });
                return;
            }
        };

        // Summary Card
        ui.group(|ui| {
            ui.horizontal(|ui| {
                ui.label(RichText::new("Total Potential System Gain:").strong().size(15.0));
                ui.label(
                    RichText::new(format_bytes(report.total_potential_gain_bytes))
                        .size(16.0)
                        .strong()
                        .color(Color32::from_rgb(46, 160, 67)),
                );
            });
        });
        ui.add_space(8.0);

        let mut action_to_run: Option<(String, bool)> = None;

        egui::ScrollArea::vertical().show(ui, |ui| {
            for item in &report.items {
                ui.group(|ui| {
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.horizontal(|ui| {
                                ui.label(RichText::new(&item.title).strong().size(15.0));
                                ui.colored_label(Color32::from_rgb(140, 140, 220), format!("[{}]", item.tier));
                                ui.colored_label(Color32::from_rgb(220, 160, 40), format!("[{}]", item.risk_level));
                            });

                            ui.label(RichText::new(&item.description).size(12.5).color(Color32::from_rgb(190, 190, 200)));
                            ui.add_space(4.0);

                            ui.horizontal(|ui| {
                                ui.label(RichText::new("Status:").strong().size(12.0));
                                ui.label(RichText::new(&item.current_status).size(12.0).color(Color32::from_rgb(100, 180, 240)));
                            });
                        });

                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            let btn = ui.add_enabled(
                                !self.is_running_system_action,
                                egui::Button::new(RichText::new(&item.action_label).strong())
                                    .min_size(egui::vec2(220.0, 36.0)),
                            );

                            if btn.clicked() {
                                action_to_run = Some((item.id.clone(), item.is_active));
                            }

                            ui.label(RichText::new(format_bytes(item.estimated_size_bytes)).strong().size(15.0));
                        });
                    });
                });
                ui.add_space(4.0);
            }

            // Explain-Why Docker Prune Section (Tier 2)
            ui.add_space(8.0);
            let mut docker_prune_to_run: Option<String> = None;
            ui.group(|ui| {
                ui.horizontal(|ui| {
                    ui.label(RichText::new("🐳 Docker Space Analysis & Explain-Why Prune").strong().size(15.5));
                    ui.colored_label(Color32::from_rgb(100, 149, 237), "[Tier 2: Developer]");
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if self.is_analyzing_docker {
                            ui.spinner();
                        } else if ui.button("🔍 Check Docker Space").clicked() {
                            self.start_docker_analysis();
                        }
                    });
                });

                if !self.docker_status_msg.is_empty() {
                    ui.label(RichText::new(&self.docker_status_msg).color(Color32::from_rgb(100, 180, 240)).size(12.5));
                }

                if let Some(docker) = &self.docker_analysis {
                    if !docker.is_installed {
                        ui.label(RichText::new("Docker is not installed on this system.").color(Color32::GRAY));
                    } else if !docker.is_running {
                        ui.label(RichText::new("Docker is installed, but the Docker daemon/service is currently stopped.").color(Color32::from_rgb(220, 160, 40)));
                    } else {
                        ui.label(
                            RichText::new(format!(
                                "Docker is active. Total Reclaimable Cache: {}",
                                format_bytes(docker.total_reclaimable_bytes)
                            ))
                            .strong()
                            .color(Color32::from_rgb(46, 160, 67)),
                        );

                        for cat in &docker.categories {
                            ui.separator();
                            ui.horizontal(|ui| {
                                ui.vertical(|ui| {
                                    ui.horizontal(|ui| {
                                        ui.label(RichText::new(&cat.name).strong().size(14.0));
                                        ui.colored_label(Color32::from_rgb(220, 160, 40), format!("[Safety: {}]", cat.safety_level));
                                        ui.label(RichText::new(format!("Reclaimable: {}", format_bytes(cat.reclaimable_bytes))).strong());
                                    });
                                    ui.label(RichText::new(&cat.explanation).size(12.0).color(Color32::from_rgb(190, 190, 200)));
                                });

                                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                    let prune_action = match cat.name.as_str() {
                                        "Build Cache" => "builder",
                                        "Images" => "image",
                                        "Containers" => "container",
                                        "Local Volumes" => "volume",
                                        _ => "all",
                                    };
                                    let btn = ui.add_enabled(
                                        !self.is_running_system_action && cat.can_prune,
                                        egui::Button::new(RichText::new(format!("Prune {}", cat.name)).strong())
                                            .min_size(egui::vec2(160.0, 32.0)),
                                    );
                                    if btn.clicked() {
                                        docker_prune_to_run = Some(prune_action.to_string());
                                    }
                                });
                            });
                        }
                    }
                } else {
                    ui.label(RichText::new("Click 'Check Docker Space' to analyze Docker build layers, dangling images, and stopped containers with plain-language safety explanations.").color(Color32::GRAY).size(12.5));
                }
            });

            if let Some(prune_act) = docker_prune_to_run {
                self.run_docker_prune(prune_act);
            }
        });

        if let Some((id, is_act)) = action_to_run {
            self.run_system_action(id, is_act);
        }
    }

    fn render_confirm_modal(&mut self, ctx: &egui::Context) {
        let plan = match &self.pending_plan {
            Some(p) => p.clone(),
            None => return,
        };

        egui::Window::new("Confirm Deletion")
            .collapsible(false)
            .resizable(false)
            .anchor(egui::Align2::CENTER_CENTER, egui::vec2(0.0, 0.0))
            .show(ctx, |ui| {
                ui.set_width(480.0);
                ui.add_space(8.0);

                let title = format!(
                    "Remove {} items ({})?",
                    plan.items.len(),
                    format_bytes(plan.total_bytes)
                );
                ui.heading(RichText::new(title).size(18.0).strong());
                ui.add_space(12.0);

                ui.label(
                    "Files marked Your files go to the Recycle Bin (with undo).\n\
                     Everything else is removed permanently and cannot be undone.",
                );
                ui.add_space(16.0);

                ui.horizontal(|ui| {
                    if ui
                        .add(egui::Button::new("Cancel").min_size(egui::vec2(100.0, 32.0)))
                        .clicked()
                    {
                        self.show_confirm_dialog = false;
                        self.pending_plan = None;
                    }

                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let remove_btn = ui.add(
                            egui::Button::new(
                                RichText::new("Remove")
                                    .color(Color32::WHITE)
                                    .strong(),
                            )
                            .fill(Color32::from_rgb(190, 40, 40))
                            .min_size(egui::vec2(110.0, 32.0)),
                        );

                        if remove_btn.clicked() {
                            self.start_execution(plan);
                        }
                    });
                });
                ui.add_space(8.0);
            });
    }

    fn render_uninstall_modal(&mut self, ctx: &egui::Context) {
        let app = match &self.pending_uninstall_app {
            Some(a) => a.clone(),
            None => return,
        };

        egui::Window::new("Confirm Uninstallation")
            .collapsible(false)
            .resizable(false)
            .anchor(egui::Align2::CENTER_CENTER, egui::vec2(0.0, 0.0))
            .show(ctx, |ui| {
                ui.set_width(460.0);
                ui.add_space(8.0);

                ui.heading(RichText::new(format!("Uninstall {}?", app.display_name)).size(18.0).strong());
                ui.add_space(10.0);

                ui.label(format!("Size on disk: {}", format_bytes(app.estimated_size_bytes)));
                if let Some(publ) = &app.publisher {
                    ui.label(format!("Publisher: {}", publ));
                }
                ui.add_space(8.0);

                ui.label(
                    "DiskStudio Cleaner will invoke the official application uninstaller safely.\n\
                     After uninstallation finishes, we will scan for leftover caches and settings.",
                );
                ui.add_space(16.0);

                ui.horizontal(|ui| {
                    if ui.button("Cancel").clicked() {
                        self.pending_uninstall_app = None;
                    }

                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let uninstall_btn = ui.add(
                            egui::Button::new(RichText::new("Proceed with Uninstall").color(Color32::WHITE).strong())
                                .fill(Color32::from_rgb(180, 50, 50)),
                        );

                        if uninstall_btn.clicked() {
                            let target_app = self.pending_uninstall_app.take().unwrap();
                            self.execute_app_uninstall(target_app);
                        }
                    });
                });
                ui.add_space(8.0);
            });
    }

    fn render_leftovers_modal(&mut self, ctx: &egui::Context) {
        egui::Window::new("Application Leftover Sweep")
            .collapsible(false)
            .resizable(false)
            .anchor(egui::Align2::CENTER_CENTER, egui::vec2(0.0, 0.0))
            .show(ctx, |ui| {
                ui.set_width(480.0);
                ui.add_space(8.0);

                ui.heading(RichText::new("Leftover Files Found").size(18.0).strong());
                ui.add_space(8.0);
                ui.label("The following remnant folders were found. You can safely move them to the Recycle Bin:");
                ui.add_space(8.0);

                for item in &self.uninstall_leftovers {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(item.path.display().to_string()).size(12.0));
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            ui.label(format_bytes(item.size_bytes));
                        });
                    });
                }
                ui.add_space(16.0);

                ui.horizontal(|ui| {
                    if ui.button("Keep Leftovers (Close)").clicked() {
                        self.show_leftovers_dialog = false;
                        self.uninstall_leftovers.clear();
                    }

                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let clean_btn = ui.add(
                            egui::Button::new(RichText::new("Move Leftovers to Recycle Bin").color(Color32::WHITE).strong())
                                .fill(Color32::from_rgb(180, 50, 50)),
                        );

                        if clean_btn.clicked() {
                            let plan = Plan::new(self.uninstall_leftovers.clone());
                            self.show_leftovers_dialog = false;
                            self.uninstall_leftovers.clear();
                            self.start_execution(plan);
                        }
                    });
                });
                ui.add_space(8.0);
            });
    }

    fn render_done_screen(&mut self, ui: &mut egui::Ui) {
        let mut trigger_rescan = false;
        if let Some(res) = &self.execution_result {
            ui.vertical_centered(|ui| {
                ui.add_space(40.0);
                ui.heading(
                    RichText::new(format!(
                        "Freed {}",
                        format_bytes(res.bytes_freed_measured)
                    ))
                    .size(24.0)
                    .color(Color32::from_rgb(46, 160, 67)),
                );
                ui.add_space(8.0);

                let removed_count = res
                    .per_item
                    .iter()
                    .filter(|i| i.outcome == Outcome::Removed)
                    .count();
                let recycled_count = res
                    .per_item
                    .iter()
                    .filter(|i| i.outcome == Outcome::Recycled)
                    .count();

                ui.label(format!(
                    "{} items permanently removed, {} moved to Recycle Bin.",
                    removed_count, recycled_count
                ));
                ui.add_space(16.0);

                ui.horizontal(|ui| {
                    ui.add_space(ui.available_width() / 2.0 - 110.0);
                    if ui.button("Open log").clicked() {
                        let _ = res.log_path.clone();
                    }
                    if ui.button("Scan again").clicked() {
                        trigger_rescan = true;
                    }
                });
            });

            ui.add_space(30.0);
            let skipped_items: Vec<_> = res
                .per_item
                .iter()
                .filter_map(|i| match &i.outcome {
                    Outcome::Skipped(reason) => Some((&i.path, reason)),
                    _ => None,
                })
                .collect();

            if !skipped_items.is_empty() {
                ui.label(
                    RichText::new(format!("Skipped Items ({})", skipped_items.len()))
                        .strong()
                        .size(15.0),
                );
                ui.separator();
                egui::ScrollArea::vertical().show(ui, |ui| {
                    for (path, reason) in skipped_items {
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(path.to_string_lossy().to_string()).size(12.0));
                            ui.with_layout(
                                egui::Layout::right_to_left(egui::Align::Center),
                                |ui| {
                                    ui.colored_label(
                                        Color32::from_rgb(200, 100, 100),
                                        format!("{:?}", reason),
                                    );
                                },
                            );
                        });
                    }
                });
            }
        }

        if trigger_rescan {
            self.screen = AppScreen::Cleanup;
            self.start_scan();
        }
    }
}

fn main() -> eframe::Result {
    let native_options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([940.0, 680.0])
            .with_min_inner_size([800.0, 520.0])
            .with_title("DiskStudio Cleaner"),
        ..Default::default()
    };

    eframe::run_native(
        "DiskStudio Cleaner",
        native_options,
        Box::new(|cc| Ok(Box::new(DiskStudioApp::new(cc)))),
    )
}
