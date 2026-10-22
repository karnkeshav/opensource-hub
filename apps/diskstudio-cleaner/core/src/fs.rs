use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::SystemTime;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsError {
    NotFound(String),
    AccessDenied(String),
    SharingViolation(String),
    ReparsePointRefused(String),
    ProtectedPathRefused(String),
    ChangedSincePlan(String),
    Other(String),
}

impl fmt::Display for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FsError::NotFound(p) => write!(f, "Path not found: {}", p),
            FsError::AccessDenied(p) => write!(f, "Access denied: {}", p),
            FsError::SharingViolation(p) => write!(f, "File is in use / sharing violation: {}", p),
            FsError::ReparsePointRefused(p) => {
                write!(f, "Reparse point / symlink refusal (S3): {}", p)
            }
            FsError::ProtectedPathRefused(p) => {
                write!(f, "Protected path refusal (S2): {}", p)
            }
            FsError::ChangedSincePlan(p) => {
                write!(f, "File changed or re-validation failed (S4): {}", p)
            }
            FsError::Other(msg) => write!(f, "Filesystem error: {}", msg),
        }
    }
}

impl std::error::Error for FsError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileMetadata {
    pub len: u64,
    pub is_dir: bool,
    pub is_file: bool,
    pub is_reparse_point: bool,
    pub is_readonly: bool,
    pub is_cloud_placeholder: bool,
    pub modified: Option<SystemTime>,
    pub created: Option<SystemTime>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntry {
    pub path: PathBuf,
    pub name: String,
    pub metadata: FileMetadata,
}

pub trait ReadFs: Send + Sync {
    fn metadata(&self, path: &Path) -> Result<FileMetadata, FsError>;
    fn read_dir(&self, path: &Path) -> Result<Vec<DirEntry>, FsError>;
    fn free_space(&self, path: &Path) -> Result<u64, FsError>;
    fn exists(&self, path: &Path) -> bool {
        self.metadata(path).is_ok()
    }
    fn is_dir(&self, path: &Path) -> bool {
        self.metadata(path).map(|m| m.is_dir).unwrap_or(false)
    }
    fn canonicalize(&self, path: &Path) -> Result<PathBuf, FsError>;
}

pub trait WriteFs: ReadFs {
    fn remove_file(&self, path: &Path) -> Result<(), FsError>;
    fn remove_dir(&self, path: &Path) -> Result<(), FsError>;
    fn remove_dir_all(&self, path: &Path) -> Result<(), FsError>;
    fn recycle(&self, path: &Path) -> Result<(), FsError>;
}

// ---------------------------------------------------------------------------
// RealFs: Real Windows / POSIX Filesystem implementation
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone)]
pub struct RealFs;

impl RealFs {
    pub fn new() -> Self {
        Self
    }
}

impl ReadFs for RealFs {
    fn metadata(&self, path: &Path) -> Result<FileMetadata, FsError> {
        let symlink_meta = std::fs::symlink_metadata(path).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => FsError::NotFound(path.display().to_string()),
            std::io::ErrorKind::PermissionDenied => {
                FsError::AccessDenied(path.display().to_string())
            }
            _ => FsError::Other(format!("{}: {}", path.display(), e)),
        })?;

        let is_symlink = symlink_meta.file_type().is_symlink();

        #[cfg(windows)]
        let (is_reparse_point, is_readonly, is_cloud_placeholder) = {
            use std::os::windows::fs::MetadataExt;
            let attrs = symlink_meta.file_attributes();
            // FILE_ATTRIBUTE_REPARSE_POINT = 0x400
            let is_reparse = (attrs & 0x00000400) != 0 || is_symlink;
            // FILE_ATTRIBUTE_READONLY = 0x1
            let is_ro = (attrs & 0x00000001) != 0;
            // FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x00400000
            // FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x00040000
            // FILE_ATTRIBUTE_OFFLINE = 0x00001000
            let is_cloud = (attrs & 0x00441000) != 0;
            (is_reparse, is_ro, is_cloud)
        };

        #[cfg(not(windows))]
        let (is_reparse_point, is_readonly, is_cloud_placeholder) = {
            let is_ro = symlink_meta.permissions().readonly();
            (is_symlink, is_ro, false)
        };

        Ok(FileMetadata {
            len: symlink_meta.len(),
            is_dir: symlink_meta.is_dir(),
            is_file: symlink_meta.is_file(),
            is_reparse_point,
            is_readonly,
            is_cloud_placeholder,
            modified: symlink_meta.modified().ok(),
            created: symlink_meta.created().ok(),
        })
    }

    fn read_dir(&self, path: &Path) -> Result<Vec<DirEntry>, FsError> {
        // Enforce safety invariant S3: never follow reparse points during directory traversal
        let meta = self.metadata(path)?;
        if meta.is_reparse_point {
            return Err(FsError::ReparsePointRefused(path.display().to_string()));
        }

        let read_dir = std::fs::read_dir(path).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => FsError::NotFound(path.display().to_string()),
            std::io::ErrorKind::PermissionDenied => {
                FsError::AccessDenied(path.display().to_string())
            }
            _ => FsError::Other(format!("{}: {}", path.display(), e)),
        })?;

        let mut entries = Vec::new();
        for entry_res in read_dir {
            let entry = match entry_res {
                Ok(e) => e,
                Err(_) => continue, // tolerate individual unreadable entries gracefully
            };
            let entry_path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if let Ok(m) = self.metadata(&entry_path) {
                entries.push(DirEntry {
                    path: entry_path,
                    name,
                    metadata: m,
                });
            }
        }
        Ok(entries)
    }

    fn free_space(&self, path: &Path) -> Result<u64, FsError> {
        #[cfg(windows)]
        {
            use std::ffi::OsStr;
            use std::os::windows::ffi::OsStrExt;
            use windows::core::PCWSTR;
            use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

            let path_str = path.to_string_lossy();
            let root = if path_str.len() >= 3 && path_str.chars().nth(1) == Some(':') {
                format!("{}:\\", &path_str[0..1])
            } else {
                "C:\\".to_string()
            };

            let wide: Vec<u16> = OsStr::new(&root)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let mut free_bytes_avail: u64 = 0;
            let mut total_bytes: u64 = 0;
            let mut total_free: u64 = 0;

            unsafe {
                if GetDiskFreeSpaceExW(
                    PCWSTR(wide.as_ptr()),
                    Some(&mut free_bytes_avail),
                    Some(&mut total_bytes),
                    Some(&mut total_free),
                )
                .is_ok()
                {
                    return Ok(free_bytes_avail);
                }
            }
        }

        #[cfg(not(windows))]
        {
            // Fallback for Linux dev/testing environment
            // Return dummy or 100GB
            let _ = path;
            return Ok(100 * 1024 * 1024 * 1024);
        }

        #[allow(unreachable_code)]
        Ok(100 * 1024 * 1024 * 1024)
    }

    fn canonicalize(&self, path: &Path) -> Result<PathBuf, FsError> {
        std::fs::canonicalize(path).map_err(|e| FsError::Other(format!("{}: {}", path.display(), e)))
    }
}

impl WriteFs for RealFs {
    fn remove_file(&self, path: &Path) -> Result<(), FsError> {
        let meta = self.metadata(path)?;
        if meta.is_readonly {
            let mut perms = std::fs::metadata(path)
                .map_err(|e| FsError::Other(e.to_string()))?
                .permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            let _ = std::fs::set_permissions(path, perms);
        }

        std::fs::remove_file(path).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => FsError::NotFound(path.display().to_string()),
            std::io::ErrorKind::PermissionDenied => {
                FsError::AccessDenied(path.display().to_string())
            }
            _ => {
                let err_str = e.to_string();
                if err_str.contains("used by another process") || err_str.contains("Sharing violation") {
                    FsError::SharingViolation(path.display().to_string())
                } else {
                    FsError::Other(format!("{}: {}", path.display(), e))
                }
            }
        })
    }

    fn remove_dir(&self, path: &Path) -> Result<(), FsError> {
        let meta = self.metadata(path)?;
        if meta.is_reparse_point {
            return Err(FsError::ReparsePointRefused(path.display().to_string()));
        }
        std::fs::remove_dir(path).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => FsError::NotFound(path.display().to_string()),
            std::io::ErrorKind::PermissionDenied => {
                FsError::AccessDenied(path.display().to_string())
            }
            _ => FsError::Other(format!("{}: {}", path.display(), e)),
        })
    }

    fn remove_dir_all(&self, path: &Path) -> Result<(), FsError> {
        // Enforce safety invariant S3: never recurse into reparse points!
        let meta = self.metadata(path)?;
        if meta.is_reparse_point {
            return Err(FsError::ReparsePointRefused(path.display().to_string()));
        }

        // Iterate entries manually to never cross junctions/symlinks
        let entries = self.read_dir(path)?;
        for entry in entries {
            if entry.metadata.is_reparse_point {
                // Do not recurse into reparse points
                return Err(FsError::ReparsePointRefused(entry.path.display().to_string()));
            } else if entry.metadata.is_dir {
                self.remove_dir_all(&entry.path)?;
            } else {
                self.remove_file(&entry.path)?;
            }
        }
        self.remove_dir(path)
    }

    fn recycle(&self, path: &Path) -> Result<(), FsError> {
        #[cfg(windows)]
        {
            use std::ffi::OsStr;
            use std::os::windows::ffi::OsStrExt;
            use windows::Win32::UI::Shell::{
                SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
                FO_DELETE, SHFILEOPSTRUCTW,
            };

            let path_str = path.to_string_lossy();
            let mut wide: Vec<u16> = OsStr::new(&*path_str)
                .encode_wide()
                .chain(std::iter::once(0))
                .chain(std::iter::once(0)) // Double-null terminated for SHFILEOPSTRUCTW
                .collect();

            let mut op = SHFILEOPSTRUCTW {
                hwnd: windows::Win32::Foundation::HWND(0 as _),
                wFunc: FO_DELETE,
                pFrom: windows::core::PCWSTR(wide.as_mut_ptr()),
                pTo: windows::core::PCWSTR(std::ptr::null()),
                fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI).0 as u16,
                fAnyOperationsAborted: false.into(),
                hNameMappings: std::ptr::null_mut(),
                lpszProgressTitle: windows::core::PCWSTR(std::ptr::null()),
            };

            let ret = unsafe { SHFileOperationW(&mut op) };
            if ret != 0 {
                return Err(FsError::Other(format!(
                    "SHFileOperationW recycle error: 0x{:X}",
                    ret
                )));
            }
            return Ok(());
        }

        #[cfg(not(windows))]
        {
            // On non-Windows platforms, fallback to remove_file/remove_dir for testing
            let meta = self.metadata(path)?;
            if meta.is_dir {
                self.remove_dir_all(path)
            } else {
                self.remove_file(path)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// FakeFs: In-Memory deterministic filesystem for safety testing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum FakeNode {
    File {
        size: u64,
        modified: SystemTime,
        readonly: bool,
        cloud_placeholder: bool,
        in_use: bool,
        access_denied: bool,
    },
    Dir {
        access_denied: bool,
        reparse_target: Option<PathBuf>,
    },
}

#[derive(Debug, Default)]
pub struct FakeFsState {
    pub nodes: BTreeMap<PathBuf, FakeNode>,
    pub free_space: u64,
    pub removed_files: Vec<PathBuf>,
    pub removed_dirs: Vec<PathBuf>,
    pub recycled_items: Vec<PathBuf>,
    pub reparse_points: HashSet<PathBuf>,
}

#[derive(Debug, Clone, Default)]
pub struct FakeFs {
    state: Arc<RwLock<FakeFsState>>,
}

impl FakeFs {
    pub fn new() -> Self {
        let mut state = FakeFsState::default();
        state.free_space = 100 * 1024 * 1024 * 1024; // 100 GB default
        // Ensure root exists
        state.nodes.insert(
            PathBuf::from("/"),
            FakeNode::Dir {
                access_denied: false,
                reparse_target: None,
            },
        );
        Self {
            state: Arc::new(RwLock::new(state)),
        }
    }

    pub fn add_file(&self, path: impl AsRef<Path>, size: u64, modified: SystemTime) {
        let mut st = self.state.write().unwrap();
        st.nodes.insert(
            path.as_ref().to_path_buf(),
            FakeNode::File {
                size,
                modified,
                readonly: false,
                cloud_placeholder: false,
                in_use: false,
                access_denied: false,
            },
        );
    }

    pub fn add_dir(&self, path: impl AsRef<Path>) {
        let mut st = self.state.write().unwrap();
        st.nodes.insert(
            path.as_ref().to_path_buf(),
            FakeNode::Dir {
                access_denied: false,
                reparse_target: None,
            },
        );
    }

    pub fn add_reparse_point(&self, path: impl AsRef<Path>, target: impl AsRef<Path>) {
        let mut st = self.state.write().unwrap();
        let p = path.as_ref().to_path_buf();
        st.reparse_points.insert(p.clone());
        st.nodes.insert(
            p,
            FakeNode::Dir {
                access_denied: false,
                reparse_target: Some(target.as_ref().to_path_buf()),
            },
        );
    }

    pub fn set_in_use(&self, path: impl AsRef<Path>, in_use: bool) {
        let mut st = self.state.write().unwrap();
        if let Some(FakeNode::File { in_use: u, .. }) = st.nodes.get_mut(path.as_ref()) {
            *u = in_use;
        }
    }

    pub fn set_access_denied(&self, path: impl AsRef<Path>, denied: bool) {
        let mut st = self.state.write().unwrap();
        if let Some(node) = st.nodes.get_mut(path.as_ref()) {
            match node {
                FakeNode::File { access_denied, .. } => *access_denied = denied,
                FakeNode::Dir { access_denied, .. } => *access_denied = denied,
            }
        }
    }

    pub fn set_cloud_placeholder(&self, path: impl AsRef<Path>, cloud: bool) {
        let mut st = self.state.write().unwrap();
        if let Some(FakeNode::File {
            cloud_placeholder, ..
        }) = st.nodes.get_mut(path.as_ref())
        {
            *cloud_placeholder = cloud;
        }
    }

    pub fn set_free_space(&self, bytes: u64) {
        let mut st = self.state.write().unwrap();
        st.free_space = bytes;
    }

    pub fn get_removed_files(&self) -> Vec<PathBuf> {
        self.state.read().unwrap().removed_files.clone()
    }

    pub fn get_recycled_items(&self) -> Vec<PathBuf> {
        self.state.read().unwrap().recycled_items.clone()
    }
}

impl ReadFs for FakeFs {
    fn metadata(&self, path: &Path) -> Result<FileMetadata, FsError> {
        let st = self.state.read().unwrap();
        let node = st
            .nodes
            .get(path)
            .ok_or_else(|| FsError::NotFound(path.display().to_string()))?;

        match node {
            FakeNode::File {
                size,
                modified,
                readonly,
                cloud_placeholder,
                in_use: _,
                access_denied,
            } => {
                if *access_denied {
                    return Err(FsError::AccessDenied(path.display().to_string()));
                }
                Ok(FileMetadata {
                    len: *size,
                    is_dir: false,
                    is_file: true,
                    is_reparse_point: st.reparse_points.contains(path),
                    is_readonly: *readonly,
                    is_cloud_placeholder: *cloud_placeholder,
                    modified: Some(*modified),
                    created: Some(*modified),
                })
            }
            FakeNode::Dir {
                access_denied,
                reparse_target,
            } => {
                if *access_denied {
                    return Err(FsError::AccessDenied(path.display().to_string()));
                }
                Ok(FileMetadata {
                    len: 0,
                    is_dir: true,
                    is_file: false,
                    is_reparse_point: reparse_target.is_some() || st.reparse_points.contains(path),
                    is_readonly: false,
                    is_cloud_placeholder: false,
                    modified: None,
                    created: None,
                })
            }
        }
    }

    fn read_dir(&self, path: &Path) -> Result<Vec<DirEntry>, FsError> {
        let meta = self.metadata(path)?;
        if meta.is_reparse_point {
            return Err(FsError::ReparsePointRefused(path.display().to_string()));
        }

        let st = self.state.read().unwrap();
        let mut entries = Vec::new();

        for (p, node) in st.nodes.iter() {
            if let Some(parent) = p.parent() {
                if parent == path && p != path {
                    let name = p
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let (len, is_dir, is_file, ro, cp, m) = match node {
                        FakeNode::File {
                            size,
                            modified,
                            readonly,
                            cloud_placeholder,
                            access_denied,
                            ..
                        } => {
                            if *access_denied {
                                continue;
                            }
                            (*size, false, true, *readonly, *cloud_placeholder, Some(*modified))
                        }
                        FakeNode::Dir { access_denied, .. } => {
                            if *access_denied {
                                continue;
                            }
                            (0, true, false, false, false, None)
                        }
                    };

                    entries.push(DirEntry {
                        path: p.clone(),
                        name,
                        metadata: FileMetadata {
                            len,
                            is_dir,
                            is_file,
                            is_reparse_point: st.reparse_points.contains(p),
                            is_readonly: ro,
                            is_cloud_placeholder: cp,
                            modified: m,
                            created: m,
                        },
                    });
                }
            }
        }

        Ok(entries)
    }

    fn free_space(&self, _path: &Path) -> Result<u64, FsError> {
        Ok(self.state.read().unwrap().free_space)
    }

    fn canonicalize(&self, path: &Path) -> Result<PathBuf, FsError> {
        if self.exists(path) {
            Ok(path.to_path_buf())
        } else {
            Err(FsError::NotFound(path.display().to_string()))
        }
    }
}

impl WriteFs for FakeFs {
    fn remove_file(&self, path: &Path) -> Result<(), FsError> {
        let mut st = self.state.write().unwrap();
        let node = st
            .nodes
            .get(path)
            .ok_or_else(|| FsError::NotFound(path.display().to_string()))?;

        if let FakeNode::File {
            in_use,
            access_denied,
            size,
            ..
        } = node
        {
            if *in_use {
                return Err(FsError::SharingViolation(path.display().to_string()));
            }
            if *access_denied {
                return Err(FsError::AccessDenied(path.display().to_string()));
            }
            let s = *size;
            st.free_space += s;
        } else {
            return Err(FsError::Other("Not a file".into()));
        }

        st.nodes.remove(path);
        st.removed_files.push(path.to_path_buf());
        Ok(())
    }

    fn remove_dir(&self, path: &Path) -> Result<(), FsError> {
        let mut st = self.state.write().unwrap();
        let node = st
            .nodes
            .get(path)
            .ok_or_else(|| FsError::NotFound(path.display().to_string()))?;

        if let FakeNode::Dir { access_denied, .. } = node {
            if *access_denied {
                return Err(FsError::AccessDenied(path.display().to_string()));
            }
        }

        // Check if empty
        let has_children = st
            .nodes
            .keys()
            .any(|p| p.parent() == Some(path) && p != path);
        if has_children {
            return Err(FsError::Other("Directory not empty".into()));
        }

        st.nodes.remove(path);
        st.removed_dirs.push(path.to_path_buf());
        Ok(())
    }

    fn remove_dir_all(&self, path: &Path) -> Result<(), FsError> {
        let meta = self.metadata(path)?;
        if meta.is_reparse_point {
            return Err(FsError::ReparsePointRefused(path.display().to_string()));
        }

        let entries = self.read_dir(path)?;
        for entry in entries {
            if entry.metadata.is_reparse_point {
                return Err(FsError::ReparsePointRefused(entry.path.display().to_string()));
            } else if entry.metadata.is_dir {
                self.remove_dir_all(&entry.path)?;
            } else {
                self.remove_file(&entry.path)?;
            }
        }
        self.remove_dir(path)
    }

    fn recycle(&self, path: &Path) -> Result<(), FsError> {
        let mut st = self.state.write().unwrap();
        if !st.nodes.contains_key(path) {
            return Err(FsError::NotFound(path.display().to_string()));
        }
        st.nodes.remove(path);
        st.recycled_items.push(path.to_path_buf());
        // Note: recycling does not increase free space until Recycle Bin is emptied (S4/Section 7.4)
        Ok(())
    }
}
