use diskstudio_core::{
    load_all_builtin_rules, EnvironmentRoots, ExecutionResult, Executor, ItemKind, Outcome,
    Plan, PlannedItem, RealFs, Risk, ScanResult, Scanner,
};
use eframe::egui::{self, Color32, RichText};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum AppScreen {
    Cleanup,
    Biggest,
    Done,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum BiggestTab {
    Apps,
    Files,
    Folders,
}

struct ScanProgressMessage {
    current_path: String,
    bytes_found: u64,
}

enum BackgroundMessage {
    Progress(ScanProgressMessage),
    ScanComplete(ScanResult),
    ExecutionComplete(ExecutionResult),
}

struct DiskStudioApp {
    screen: AppScreen,
    current_tab: BiggestTab,
    env: EnvironmentRoots,

    // Scan state
    is_scanning: bool,
    scan_progress_path: String,
    scan_bytes_found: u64,
    cancel_token: Option<Arc<AtomicBool>>,
    scan_result: Option<ScanResult>,

    // Selection state: set of item IDs selected for cleaning
    selected_items: HashSet<String>,
    expanded_categories: HashSet<String>,

    // Confirmation dialog
    show_confirm_dialog: bool,
    pending_plan: Option<Plan>,

    // Execution state
    is_executing: bool,
    execution_result: Option<ExecutionResult>,

    // Biggest state
    biggest_drive: String,
    _biggest_min_size_mb: u64,
    biggest_files: Vec<diskstudio_core::BiggestFile>,
    biggest_folders: Vec<diskstudio_core::BiggestFolder>,
    is_scanning_biggest: bool,

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

impl DiskStudioApp {
    fn new(_cc: &eframe::CreationContext<'_>) -> Self {
        let (tx, rx) = mpsc::channel();
        let env = EnvironmentRoots::default();
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
            biggest_drive: "C:\\".into(),
            _biggest_min_size_mb: 50,
            biggest_files: Vec::new(),
            biggest_folders: Vec::new(),
            is_scanning_biggest: false,
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

    fn cancel_scan(&mut self) {
        if let Some(token) = &self.cancel_token {
            token.store(true, Ordering::Relaxed);
        }
        self.is_scanning = false;
        self.is_scanning_biggest = false;
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

    fn start_biggest_scan(&mut self) {
        self.is_scanning_biggest = true;
        let root = PathBuf::from(&self.biggest_drive);
        let tx = self.tx.clone();
        let env = self.env.clone();
        let cancel = Arc::new(AtomicBool::new(false));
        self.cancel_token = Some(cancel.clone());

        thread::spawn(move || {
            let fs = RealFs::new();
            let scanner = Scanner::with_cancellation(&fs, env, cancel);
            if let Ok(res) = scanner.scan_biggest(&root, 100) {
                // Return via channel or local store
                let _ = (tx, res);
            }
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
                    // Default safe items to selected, UserData to unticked (Invariant S5)
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
            }
        }

        // Top Navigation Bar
        egui::TopBottomPanel::top("top_nav").show(ctx, |ui| {
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                ui.heading(RichText::new("DiskStudio Cleaner").strong().size(20.0));
                ui.add_space(30.0);

                if ui
                    .selectable_label(self.screen == AppScreen::Cleanup, "1. Clean up")
                    .clicked()
                {
                    self.screen = AppScreen::Cleanup;
                }
                if ui
                    .selectable_label(self.screen == AppScreen::Biggest, "2. Biggest space users")
                    .clicked()
                {
                    self.screen = AppScreen::Biggest;
                }
                if self.execution_result.is_some() {
                    if ui
                        .selectable_label(self.screen == AppScreen::Done, "3. Done")
                        .clicked()
                    {
                        self.screen = AppScreen::Done;
                    }
                }
            });
            ui.add_space(8.0);
        });

        // Bottom Action Panel
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
        egui::CentralPanel::default().show(ctx, |ui| {
            match self.screen {
                AppScreen::Cleanup => self.render_cleanup_screen(ui),
                AppScreen::Biggest => self.render_biggest_screen(ui),
                AppScreen::Done => self.render_done_screen(ui),
            }
        });

        // Confirmation Modal Dialog (P1 & S1)
        if self.show_confirm_dialog {
            self.render_confirm_modal(ctx);
        }

        if self.is_scanning || self.is_executing {
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

                    let cat_items_all_selected =
                        !cat.items.is_empty() && cat.items.iter().all(|it| self.selected_items.contains(&it.id));
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
                                });
                                ui.label(
                                    RichText::new(&cat.description)
                                        .size(13.0)
                                        .color(Color32::GRAY),
                                );
                            });

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

                        // Expanded file list
                        if is_expanded {
                            ui.separator();
                            ui.indent("items_indent", |ui| {
                                for item in &cat.items {
                                    let mut item_checked = self.selected_items.contains(&item.id);
                                    ui.horizontal(|ui| {
                                        if ui.checkbox(&mut item_checked, "").changed() {
                                            if item_checked {
                                                self.selected_items.insert(item.id.clone());
                                            } else {
                                                self.selected_items.remove(&item.id);
                                            }
                                        }

                                        let icon = match item.kind {
                                            ItemKind::File => "📄",
                                            ItemKind::Folder => "📁",
                                            ItemKind::App => "📦",
                                        };

                                        ui.label(format!("{} {}", icon, item.path.display()));
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
                ui.set_width(460.0);
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

    fn render_biggest_screen(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.selectable_value(&mut self.current_tab, BiggestTab::Apps, "Apps");
            ui.selectable_value(&mut self.current_tab, BiggestTab::Files, "Files");
            ui.selectable_value(&mut self.current_tab, BiggestTab::Folders, "Folders");

            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("Scan Drive").clicked() {
                    self.start_biggest_scan();
                }
                ui.label("Drive: C:\\");
            });
        });
        ui.separator();

        match self.current_tab {
            BiggestTab::Files => {
                ui.label("Largest individual files on this drive (Top 100):");
                ui.add_space(8.0);
                egui::ScrollArea::vertical().show(ui, |ui| {
                    if self.biggest_files.is_empty() {
                        ui.label("Click 'Scan Drive' to find the largest files.");
                    } else {
                        for (idx, f) in self.biggest_files.iter().enumerate() {
                            ui.horizontal(|ui| {
                                ui.label(format!("{:2}. {}", idx + 1, f.path.display()));
                                if f.in_cloud {
                                    ui.colored_label(Color32::from_rgb(70, 130, 180), "[Cloud]");
                                }
                                ui.with_layout(
                                    egui::Layout::right_to_left(egui::Align::Center),
                                    |ui| {
                                        ui.label(RichText::new(format_bytes(f.size_bytes)).strong());
                                    },
                                );
                            });
                            ui.separator();
                        }
                    }
                });
            }
            BiggestTab::Folders => {
                ui.label("Folders taking up the most space (aggregates):");
                ui.add_space(8.0);
                egui::ScrollArea::vertical().show(ui, |ui| {
                    if self.biggest_folders.is_empty() {
                        ui.label("Click 'Scan Drive' to find largest folders.");
                    } else {
                        for (idx, folder) in self.biggest_folders.iter().enumerate() {
                            ui.horizontal(|ui| {
                                ui.label(format!("{:2}. {}", idx + 1, folder.path.display()));
                                ui.with_layout(
                                    egui::Layout::right_to_left(egui::Align::Center),
                                    |ui| {
                                        ui.label(
                                            RichText::new(format_bytes(folder.size_bytes)).strong(),
                                        );
                                    },
                                );
                            });
                            ui.separator();
                        }
                    }
                });
            }
            BiggestTab::Apps => {
                ui.label("Installed software sorted by disk space used:");
                ui.add_space(8.0);
                ui.label(
                    "System components, drivers, and runtime dependencies are hidden for safety.",
                );
            }
        }
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
                ui.separator();
                ui.label(RichText::new("Skipped items:").strong().size(15.0));
                egui::ScrollArea::vertical().show(ui, |ui| {
                    for (path, reason) in skipped_items {
                        ui.horizontal(|ui| {
                            ui.label(format!("• {}", path.display()));
                            ui.colored_label(Color32::GRAY, format!("({})", reason));
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

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([900.0, 600.0])
            .with_min_inner_size([700.0, 450.0])
            .with_title("DiskStudio Cleaner"),
        ..Default::default()
    };

    eframe::run_native(
        "DiskStudio Cleaner",
        options,
        Box::new(|cc| Ok(Box::new(DiskStudioApp::new(cc)))),
    )
}
