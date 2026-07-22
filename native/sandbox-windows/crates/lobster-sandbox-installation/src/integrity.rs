use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::Path;

use lobster_sandbox_protocol::{NATIVE_SANDBOX_POLICY_VERSION, NATIVE_SANDBOX_PROTOCOL_VERSION};
use sha2::{Digest, Sha256};
use windows_sys::Win32::Security::WinTrust::{
    WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO,
    WTD_CACHE_ONLY_URL_RETRIEVAL, WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_SAFER_FLAG,
    WTD_STATEACTION_IGNORE, WTD_UI_NONE, WinVerifyTrust,
};
use windows_sys::Win32::System::LibraryLoader::{
    LOAD_LIBRARY_SEARCH_SYSTEM32, LOAD_LIBRARY_SEARCH_USER_DIRS, SetDefaultDllDirectories,
    SetDllDirectoryW,
};

use crate::error::{InstallationError, InstallationResult};
use crate::model::{
    RUNNER_FILENAME, RUNTIME_MANIFEST_FILENAME, RUNTIME_STATE_FILENAME, RuntimeManifest,
    SETUP_FILENAME, SETUP_SCHEMA_VERSION, SetupIntegrityReport, THIRD_PARTY_NOTICES_FILENAME,
};

pub fn harden_current_process_dll_search() -> InstallationResult<()> {
    let configured = unsafe {
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_USER_DIRS)
    };
    if configured == 0 {
        return Err(InstallationError::windows(
            "runtime-dll-policy-failed",
            "harden-process",
            "SetDefaultDllDirectories failed",
            unsafe { windows_sys::Win32::Foundation::GetLastError() },
        ));
    }
    let empty = [0u16];
    if unsafe { SetDllDirectoryW(empty.as_ptr()) } == 0 {
        return Err(InstallationError::windows(
            "runtime-dll-policy-failed",
            "harden-process",
            "SetDllDirectoryW failed",
            unsafe { windows_sys::Win32::Foundation::GetLastError() },
        ));
    }
    Ok(())
}

pub fn read_manifest(directory: &Path) -> InstallationResult<RuntimeManifest> {
    let path = directory.join(RUNTIME_MANIFEST_FILENAME);
    let bytes = fs::read(&path).map_err(|error| {
        InstallationError::new(
            "runtime-manifest-missing",
            "verify-manifest",
            format!("could not read {}: {error}", path.display()),
        )
    })?;
    let manifest: RuntimeManifest = serde_json::from_slice(&bytes).map_err(|error| {
        InstallationError::new(
            "runtime-manifest-invalid",
            "verify-manifest",
            format!(
                "{} is not a valid runtime manifest: {error}",
                path.display()
            ),
        )
    })?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

pub fn verify_runtime_directory(
    directory: &Path,
    require_signature: bool,
) -> InstallationResult<(RuntimeManifest, SetupIntegrityReport)> {
    ensure_regular_directory(directory)?;
    let manifest = read_manifest(directory)?;
    let mut signatures_verified = true;
    for file in &manifest.files {
        if file.name.contains(['/', '\\']) || file.name == "." || file.name == ".." {
            return Err(InstallationError::new(
                "runtime-manifest-invalid",
                "verify-manifest",
                format!("manifest contains an unsafe filename: {}", file.name),
            ));
        }
        let path = directory.join(&file.name);
        ensure_regular_file(&path)?;
        let actual_hash = sha256_file(&path)?;
        if !actual_hash.eq_ignore_ascii_case(&file.sha256) {
            return Err(InstallationError::new(
                "runtime-hash-invalid",
                "verify-integrity",
                format!(
                    "runtime file hash does not match the manifest: {}",
                    file.name
                ),
            ));
        }
        if require_signature && file.authenticode {
            verify_authenticode(&path)?;
        } else if file.authenticode {
            signatures_verified = false;
        }
    }
    Ok((
        manifest,
        SetupIntegrityReport {
            manifest_verified: true,
            hashes_verified: true,
            signatures_required: require_signature,
            signatures_verified: require_signature && signatures_verified,
        },
    ))
}

pub fn verify_installed_runtime_directory(
    directory: &Path,
    require_signature: bool,
) -> InstallationResult<(RuntimeManifest, SetupIntegrityReport)> {
    let verified = verify_runtime_directory(directory, require_signature)?;
    verify_installed_file_set(directory)?;
    Ok(verified)
}

fn verify_installed_file_set(directory: &Path) -> InstallationResult<()> {
    let expected = [
        RUNNER_FILENAME,
        SETUP_FILENAME,
        THIRD_PARTY_NOTICES_FILENAME,
        RUNTIME_MANIFEST_FILENAME,
        RUNTIME_STATE_FILENAME,
    ]
    .into_iter()
    .map(|name| name.to_ascii_lowercase())
    .collect::<HashSet<_>>();
    let mut actual = HashSet::new();
    for entry in fs::read_dir(directory).map_err(|error| {
        InstallationError::new(
            "runtime-file-set-invalid",
            "verify-integrity",
            format!("could not enumerate {}: {error}", directory.display()),
        )
    })? {
        let entry = entry.map_err(|error| {
            InstallationError::new(
                "runtime-file-set-invalid",
                "verify-integrity",
                format!("could not enumerate {}: {error}", directory.display()),
            )
        })?;
        ensure_regular_file(&entry.path())?;
        let name = entry.file_name().into_string().map_err(|_| {
            InstallationError::new(
                "runtime-file-set-invalid",
                "verify-integrity",
                "installed runtime contains a filename that cannot be represented safely",
            )
        })?;
        if !actual.insert(name.to_ascii_lowercase()) {
            return Err(InstallationError::new(
                "runtime-file-set-invalid",
                "verify-integrity",
                "installed runtime contains duplicate case-insensitive filenames",
            ));
        }
    }
    if actual != expected {
        return Err(InstallationError::new(
            "runtime-file-set-invalid",
            "verify-integrity",
            "installed runtime does not contain the exact managed file set",
        ));
    }
    Ok(())
}

fn ensure_regular_directory(path: &Path) -> InstallationResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        InstallationError::new(
            "runtime-reparse-point-denied",
            "verify-integrity",
            format!("could not inspect {}: {error}", path.display()),
        )
    })?;
    crate::protection::reject_reparse(path)?;
    if !metadata.file_type().is_dir() {
        return Err(InstallationError::new(
            "runtime-reparse-point-denied",
            "verify-integrity",
            format!(
                "runtime directory must not be a reparse point: {}",
                path.display()
            ),
        ));
    }
    Ok(())
}

fn ensure_regular_file(path: &Path) -> InstallationResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        InstallationError::new(
            "runtime-file-missing",
            "verify-integrity",
            format!("could not inspect {}: {error}", path.display()),
        )
    })?;
    crate::protection::reject_reparse(path)?;
    if !metadata.file_type().is_file() {
        return Err(InstallationError::new(
            "runtime-reparse-point-denied",
            "verify-integrity",
            format!("runtime file must be a regular file: {}", path.display()),
        ));
    }
    Ok(())
}

fn validate_manifest(manifest: &RuntimeManifest) -> InstallationResult<()> {
    if manifest.schema_version != SETUP_SCHEMA_VERSION {
        return Err(InstallationError::new(
            "runtime-manifest-incompatible",
            "verify-manifest",
            format!(
                "manifest schema {} is incompatible with setup schema {}",
                manifest.schema_version, SETUP_SCHEMA_VERSION
            ),
        ));
    }
    if manifest.runtime_version != env!("CARGO_PKG_VERSION") {
        return Err(InstallationError::new(
            "runtime-version-incompatible",
            "verify-manifest",
            format!(
                "manifest runtime {} does not match setup {}",
                manifest.runtime_version,
                env!("CARGO_PKG_VERSION")
            ),
        ));
    }
    if manifest.protocol_version != NATIVE_SANDBOX_PROTOCOL_VERSION
        || manifest.policy_version != NATIVE_SANDBOX_POLICY_VERSION
    {
        return Err(InstallationError::new(
            "runtime-manifest-incompatible",
            "verify-manifest",
            format!(
                "manifest protocol/policy {}/{} does not match runtime {}/{}",
                manifest.protocol_version,
                manifest.policy_version,
                NATIVE_SANDBOX_PROTOCOL_VERSION,
                NATIVE_SANDBOX_POLICY_VERSION,
            ),
        ));
    }
    if manifest.architecture != "win32-x64" {
        return Err(InstallationError::new(
            "runtime-architecture-incompatible",
            "verify-manifest",
            format!("unsupported runtime architecture {}", manifest.architecture),
        ));
    }
    let required = [
        ("lobster-command-runner.exe", true),
        ("lobster-sandbox-setup.exe", true),
        (THIRD_PARTY_NOTICES_FILENAME, false),
    ];
    if manifest.files.len() != required.len() {
        return Err(InstallationError::new(
            "runtime-manifest-invalid",
            "verify-manifest",
            "manifest must contain exactly the required runtime files",
        ));
    }
    let mut seen = HashSet::new();
    for file in &manifest.files {
        if !seen.insert(file.name.as_str()) {
            return Err(InstallationError::new(
                "runtime-manifest-invalid",
                "verify-manifest",
                format!("manifest contains a duplicate file: {}", file.name),
            ));
        }
        let Some((_, authenticode_required)) = required
            .iter()
            .find(|(required_name, _)| *required_name == file.name)
        else {
            return Err(InstallationError::new(
                "runtime-manifest-invalid",
                "verify-manifest",
                format!("manifest contains an unexpected file: {}", file.name),
            ));
        };
        if file.authenticode != *authenticode_required {
            return Err(InstallationError::new(
                "runtime-manifest-invalid",
                "verify-manifest",
                format!(
                    "manifest contains an invalid Authenticode policy for {}",
                    file.name
                ),
            ));
        }
    }
    for (name, authenticode_required) in required {
        let Some(file) = manifest.files.iter().find(|file| file.name == name) else {
            return Err(InstallationError::new(
                "runtime-manifest-invalid",
                "verify-manifest",
                format!("manifest does not declare {name}"),
            ));
        };
        if file.authenticode != authenticode_required {
            return Err(InstallationError::new(
                "runtime-manifest-invalid",
                "verify-manifest",
                format!("manifest contains an invalid Authenticode policy for {name}"),
            ));
        }
    }
    if manifest.signature_policy != "authenticode" {
        return Err(InstallationError::new(
            "runtime-manifest-incompatible",
            "verify-manifest",
            "manifest signature policy must be authenticode",
        ));
    }
    Ok(())
}

fn sha256_file(path: &Path) -> InstallationResult<String> {
    let mut file = fs::File::open(path).map_err(|error| {
        InstallationError::new(
            "runtime-file-missing",
            "verify-integrity",
            format!("could not open {}: {error}", path.display()),
        )
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| {
            InstallationError::new(
                "runtime-hash-failed",
                "verify-integrity",
                format!("could not hash {}: {error}", path.display()),
            )
        })?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn verify_authenticode(path: &Path) -> InstallationResult<()> {
    use std::os::windows::ffi::OsStrExt;

    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut file_info: WINTRUST_FILE_INFO = unsafe { std::mem::zeroed() };
    file_info.cbStruct = std::mem::size_of::<WINTRUST_FILE_INFO>() as u32;
    file_info.pcwszFilePath = wide.as_ptr();
    let mut trust_data: WINTRUST_DATA = unsafe { std::mem::zeroed() };
    trust_data.cbStruct = std::mem::size_of::<WINTRUST_DATA>() as u32;
    trust_data.dwUIChoice = WTD_UI_NONE;
    trust_data.fdwRevocationChecks = WTD_REVOKE_NONE;
    trust_data.dwUnionChoice = WTD_CHOICE_FILE;
    trust_data.Anonymous = WINTRUST_DATA_0 {
        pFile: &mut file_info,
    };
    trust_data.dwStateAction = WTD_STATEACTION_IGNORE;
    trust_data.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_SAFER_FLAG;
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let status = unsafe {
        WinVerifyTrust(
            0,
            &mut action,
            &mut trust_data as *mut _ as *mut std::ffi::c_void,
        )
    };
    if status != 0 {
        return Err(InstallationError::windows(
            "runtime-signature-invalid",
            "verify-signature",
            format!("Authenticode verification failed for {}", path.display()),
            status as u32,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compatible_manifest() -> RuntimeManifest {
        RuntimeManifest {
            schema_version: SETUP_SCHEMA_VERSION,
            runtime_version: env!("CARGO_PKG_VERSION").to_string(),
            protocol_version: NATIVE_SANDBOX_PROTOCOL_VERSION,
            policy_version: NATIVE_SANDBOX_POLICY_VERSION.to_string(),
            architecture: "win32-x64".to_string(),
            git_commit: "test".to_string(),
            built_at: "test".to_string(),
            minimum_lobster_version: "0".to_string(),
            signature_policy: "authenticode".to_string(),
            files: [
                ("lobster-command-runner.exe", true),
                ("lobster-sandbox-setup.exe", true),
                (THIRD_PARTY_NOTICES_FILENAME, false),
            ]
            .into_iter()
            .map(|(name, authenticode)| crate::model::RuntimeManifestFile {
                name: name.to_string(),
                sha256: "0".repeat(64),
                authenticode,
            })
            .collect(),
        }
    }

    #[test]
    fn rejects_a_manifest_that_omits_a_required_binary() {
        let mut manifest = compatible_manifest();
        manifest.files.pop();
        let result = validate_manifest(&manifest);
        assert_eq!(
            result.err().map(|error| error.code),
            Some("runtime-manifest-invalid")
        );
    }

    #[test]
    fn rejects_extra_or_duplicate_runtime_files() {
        let mut extra = compatible_manifest();
        extra.files.push(crate::model::RuntimeManifestFile {
            name: "unexpected.dll".to_string(),
            sha256: "0".repeat(64),
            authenticode: false,
        });
        assert_eq!(
            validate_manifest(&extra).err().map(|error| error.code),
            Some("runtime-manifest-invalid")
        );

        let mut duplicate = compatible_manifest();
        duplicate.files[2] = duplicate.files[0].clone();
        assert_eq!(
            validate_manifest(&duplicate).err().map(|error| error.code),
            Some("runtime-manifest-invalid")
        );
    }

    #[test]
    fn installed_runtime_rejects_extra_files() {
        let temporary = tempfile::tempdir();
        assert!(temporary.is_ok());
        let Some(temporary) = temporary.ok() else {
            return;
        };
        for name in [
            RUNNER_FILENAME,
            SETUP_FILENAME,
            THIRD_PARTY_NOTICES_FILENAME,
            RUNTIME_MANIFEST_FILENAME,
            RUNTIME_STATE_FILENAME,
        ] {
            assert!(fs::write(temporary.path().join(name), []).is_ok());
        }
        assert!(verify_installed_file_set(temporary.path()).is_ok());
        assert!(fs::write(temporary.path().join("unexpected.dll"), []).is_ok());
        assert_eq!(
            verify_installed_file_set(temporary.path())
                .err()
                .map(|error| error.code),
            Some("runtime-file-set-invalid")
        );
    }
}
