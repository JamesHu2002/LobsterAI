use std::collections::HashSet;
use std::path::{Component, Path, PathBuf, Prefix};

use lobster_sandbox_protocol::{SandboxPolicySnapshot, SandboxProfileMode, SandboxResourceLimits};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, GetFileAttributesW, INVALID_FILE_ATTRIBUTES,
};

use crate::{SandboxError, SandboxResult};

use super::wide::to_wide;

#[derive(Debug)]
pub struct PreparedPolicy {
    pub cwd: PathBuf,
    pub writable_roots: Vec<PathBuf>,
    pub readable_roots: Vec<PathBuf>,
    pub protected_paths: Vec<PathBuf>,
    pub profile: PreparedHostProfile,
    pub scratch_dir: PathBuf,
    pub limits: SandboxResourceLimits,
}

#[derive(Debug)]
pub struct PreparedHostProfile {
    pub mode: SandboxProfileMode,
    pub home_dir: PathBuf,
    pub user_profile_dir: PathBuf,
    pub app_data_dir: PathBuf,
    pub local_app_data_dir: PathBuf,
}

pub fn prepare_policy(snapshot: &SandboxPolicySnapshot) -> SandboxResult<PreparedPolicy> {
    let cwd = canonical_existing(&PathBuf::from(&snapshot.cwd), "cwd")?;
    let mut writable_roots = Vec::new();
    let mut seen_roots = HashSet::new();
    for raw_root in snapshot.writable_roots.iter().map(PathBuf::from) {
        let root = canonical_existing(&raw_root, "writable root")?;
        if is_drive_root(&root) {
            return Err(SandboxError::new(
                "path-invalid",
                "prepare-paths",
                format!("a drive root cannot be writable: {}", root.display()),
            ));
        }
        if seen_roots.insert(path_key(&root)) {
            writable_roots.push(root);
        }
    }

    // The working directory must be authorized by an explicit product root. Scratch is prepared
    // separately and must never make an otherwise invalid cwd policy pass.
    if !writable_roots.iter().any(|root| is_within(&cwd, root)) {
        return Err(SandboxError::new(
            "cwd-outside-writable-roots",
            "prepare-paths",
            format!(
                "cwd {} is not inside any declared writable root",
                cwd.display()
            ),
        ));
    }

    let mut readable_roots = Vec::new();
    let mut seen_readable = HashSet::new();
    for raw_root in snapshot.readable_roots.iter().map(PathBuf::from) {
        let root = canonical_existing(&raw_root, "readable root")?;
        if is_drive_root(&root) {
            return Err(SandboxError::new(
                "path-invalid",
                "prepare-paths",
                format!("a drive root cannot be readable: {}", root.display()),
            ));
        }
        if writable_roots
            .iter()
            .any(|writable| is_within(&root, writable) || is_within(writable, &root))
        {
            return Err(SandboxError::new(
                "readable-root-overlaps-writable-root",
                "prepare-paths",
                format!(
                    "readable root {} overlaps a declared writable root",
                    root.display()
                ),
            ));
        }
        if seen_readable.insert(path_key(&root)) {
            readable_roots.push(root);
        }
    }

    let profile = PreparedHostProfile {
        mode: snapshot.profile.mode,
        home_dir: canonical_profile_directory(
            &PathBuf::from(&snapshot.profile.home_dir),
            "profile.homeDir",
        )?,
        user_profile_dir: canonical_profile_directory(
            &PathBuf::from(&snapshot.profile.user_profile_dir),
            "profile.userProfileDir",
        )?,
        app_data_dir: canonical_profile_directory(
            &PathBuf::from(&snapshot.profile.app_data_dir),
            "profile.appDataDir",
        )?,
        local_app_data_dir: canonical_profile_directory(
            &PathBuf::from(&snapshot.profile.local_app_data_dir),
            "profile.localAppDataDir",
        )?,
    };

    let mut protected_paths = Vec::new();
    let mut seen_protected = HashSet::new();
    for raw_path in &snapshot.protected_paths {
        let path = canonical_existing(&PathBuf::from(raw_path), "protected path")?;
        if !writable_roots.iter().any(|root| is_within(&path, root)) {
            return Err(SandboxError::new(
                "protected-path-outside-writable-roots",
                "prepare-paths",
                format!(
                    "protected path {} is not inside a writable root",
                    path.display()
                ),
            ));
        }
        if seen_protected.insert(path_key(&path)) {
            protected_paths.push(path);
        }
    }

    // Delay scratch creation until all existing user-controlled policy paths have passed
    // validation. This keeps malformed requests from creating arbitrary directories.
    let scratch_input = PathBuf::from(&snapshot.scratch_dir);
    validate_local_absolute_path(&scratch_input, "scratchDir")?;
    reject_reparse_components(&scratch_input, true)?;
    std::fs::create_dir_all(&scratch_input).map_err(|error| {
        SandboxError::new(
            "scratch-prepare-failed",
            "prepare-paths",
            format!(
                "could not create scratch directory {}: {error}",
                scratch_input.display()
            ),
        )
    })?;
    let scratch_dir = canonical_existing(&scratch_input, "scratchDir")?;
    if is_drive_root(&scratch_dir) {
        return Err(SandboxError::new(
            "path-invalid",
            "prepare-paths",
            format!(
                "a drive root cannot be used as scratchDir: {}",
                scratch_dir.display()
            ),
        ));
    }
    if protected_paths
        .iter()
        .any(|protected| is_within(&scratch_dir, protected))
    {
        return Err(SandboxError::new(
            "scratch-inside-protected-path",
            "prepare-paths",
            format!(
                "scratchDir {} is inside a protected path",
                scratch_dir.display()
            ),
        ));
    }
    if seen_roots.insert(path_key(&scratch_dir)) {
        writable_roots.push(scratch_dir.clone());
    }

    Ok(PreparedPolicy {
        cwd,
        writable_roots,
        readable_roots,
        protected_paths,
        profile,
        scratch_dir,
        limits: snapshot.limits.clone(),
    })
}

fn canonical_existing(path: &Path, label: &str) -> SandboxResult<PathBuf> {
    validate_local_absolute_path(path, label)?;
    reject_reparse_components(path, false)?;
    let canonical = dunce::canonicalize(path).map_err(|error| {
        SandboxError::new(
            "path-invalid",
            "prepare-paths",
            format!("{label} {} cannot be resolved: {error}", path.display()),
        )
    })?;
    validate_local_absolute_path(&canonical, label)?;
    reject_reparse_components(&canonical, false)?;
    Ok(canonical)
}

fn canonical_profile_directory(path: &Path, label: &str) -> SandboxResult<PathBuf> {
    let directory = canonical_existing(path, label)?;
    if is_drive_root(&directory) || !directory.is_dir() {
        return Err(SandboxError::new(
            "path-invalid",
            "prepare-paths",
            format!(
                "{label} must be a non-root directory: {}",
                directory.display()
            ),
        ));
    }
    Ok(directory)
}

fn validate_local_absolute_path(path: &Path, label: &str) -> SandboxResult<()> {
    if !path.is_absolute() {
        return Err(SandboxError::new(
            "path-invalid",
            "prepare-paths",
            format!(
                "{label} must be an absolute local drive path: {}",
                path.display()
            ),
        ));
    }
    let accepted_prefix = path.components().next().is_some_and(|component| {
        matches!(
            component,
            Component::Prefix(prefix)
                if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
        )
    });
    if !accepted_prefix {
        return Err(SandboxError::new(
            "path-invalid",
            "prepare-paths",
            format!(
                "{label} must not use a UNC, device, or volume path: {}",
                path.display()
            ),
        ));
    }
    Ok(())
}

fn reject_reparse_components(path: &Path, allow_missing_leaf: bool) -> SandboxResult<()> {
    let ancestors = path.ancestors().collect::<Vec<_>>();
    for (index, ancestor) in ancestors.iter().rev().enumerate() {
        if index == 0 {
            continue;
        }
        let attributes = unsafe { GetFileAttributesW(to_wide(ancestor.as_os_str()).as_ptr()) };
        if attributes == INVALID_FILE_ATTRIBUTES {
            if allow_missing_leaf {
                continue;
            }
            let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            return Err(SandboxError::windows(
                "path-invalid",
                "prepare-paths",
                format!("could not inspect path component {}", ancestor.display()),
                error,
            ));
        }
        if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(SandboxError::new(
                "reparse-point-denied",
                "prepare-paths",
                format!(
                    "sandbox paths cannot traverse a junction or symbolic link: {}",
                    ancestor.display()
                ),
            ));
        }
    }
    Ok(())
}

fn is_drive_root(path: &Path) -> bool {
    path.parent().is_none() || path.parent().is_some_and(|parent| parent == path)
}

pub fn path_key(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('/', "\\");
    normalized
        .strip_prefix(r"\\?\")
        .unwrap_or(&normalized)
        .trim_end_matches('\\')
        .to_lowercase()
}

pub fn is_within(path: &Path, root: &Path) -> bool {
    let path = path_key(path);
    let root = path_key(root);
    path == root
        || path
            .strip_prefix(&root)
            .is_some_and(|remainder| remainder.starts_with('\\'))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn path_membership_is_case_insensitive_and_component_aware() {
        assert!(is_within(
            Path::new(r"D:\Work\Project\src"),
            Path::new(r"d:\work\project"),
        ));
        assert!(!is_within(
            Path::new(r"D:\Work\Project-copy"),
            Path::new(r"D:\Work\Project"),
        ));
    }
}
