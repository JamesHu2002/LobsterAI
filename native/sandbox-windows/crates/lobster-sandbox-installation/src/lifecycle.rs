use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::account_visibility::{
    ensure_sandbox_account_hidden, remove_sandbox_account_visibility, verify_sandbox_account_hidden,
};
use crate::error::{InstallationError, InstallationResult};
use crate::firewall::{
    NETWORK_POLICY_VERSION, ensure_offline_firewall, remove_offline_firewall,
    verify_offline_firewall,
};
use crate::identity::{
    ProvisionedIdentity, current_user_sid, delete_sandbox_identity, ensure_sandbox_identity,
    load_sandbox_identity, resolve_account_sid,
};
use crate::integrity::{verify_installed_runtime_directory, verify_runtime_directory};
use crate::model::{
    InstallState, RUNTIME_MANIFEST_FILENAME, RUNTIME_STATE_FILENAME, SETUP_SCHEMA_VERSION,
    SetupIdentityReport, SetupNetworkReport, SetupOperation, SetupProtectionReport, SetupReport,
};
use crate::paths::InstallationPaths;
use crate::protection::{
    protect_installation, protect_installation_base, reject_reparse,
    verify_installation_protection, verify_runtime_protection,
};

const PROTECTION_VERSION: u32 = 2;

pub struct RuntimeSecurityContext {
    pub state: InstallState,
    pub identity: ProvisionedIdentity,
}

pub fn perform_operation(
    operation: SetupOperation,
    bootstrap_directory: Option<&Path>,
    require_signature: bool,
    requested_owner_sid: Option<&str>,
) -> SetupReport {
    let paths = InstallationPaths::discover();
    let result = match operation {
        SetupOperation::Verify => verify_installation(&paths, operation, require_signature),
        SetupOperation::Install | SetupOperation::Repair | SetupOperation::Upgrade => {
            let Some(bootstrap_directory) = bootstrap_directory else {
                return error_report(
                    &paths,
                    operation,
                    InstallationError::new(
                        "setup-source-missing",
                        "prepare-installation",
                        "setup bootstrap directory was not provided",
                    ),
                );
            };
            deploy_runtime(
                &paths,
                bootstrap_directory,
                require_signature,
                operation,
                requested_owner_sid,
            )
        }
        SetupOperation::Rollback => rollback_runtime(&paths, require_signature),
        SetupOperation::Uninstall => uninstall_runtime(&paths).map(|()| {
            let mut report = SetupReport::empty(operation, &paths.display_root());
            report.success = true;
            report.message = Some("Windows Sandbox runtime was removed.".to_string());
            report
        }),
    };
    match result {
        Ok(report) => report,
        Err(error) => error_report(&paths, operation, error),
    }
}

pub fn verify_runtime_for_broker() -> InstallationResult<RuntimeSecurityContext> {
    let paths = InstallationPaths::discover();
    let report = verify_installation(&paths, SetupOperation::Verify, false)?;
    if !report.healthy {
        return Err(InstallationError::new(
            "runtime-installation-invalid",
            "verify-runtime",
            report
                .message
                .unwrap_or_else(|| "Windows Sandbox runtime is not healthy".to_string()),
        ));
    }
    let state = read_install_state(&paths.state())?;
    let identity = load_sandbox_identity(&paths.credentials)?;
    if identity.account_sid != state.account_sid {
        return Err(InstallationError::new(
            "sandbox-identity-mismatch",
            "verify-runtime",
            "installed credentials do not match the protected runtime identity",
        ));
    }
    Ok(RuntimeSecurityContext { state, identity })
}

pub fn verify_runtime_for_worker() -> InstallationResult<InstallState> {
    let paths = InstallationPaths::discover();
    if crate::elevation::is_process_elevated()? {
        return Err(InstallationError::new(
            "sandbox-worker-identity-invalid",
            "verify-runtime",
            "the managed sandbox worker must not run with an elevated token",
        ));
    }
    let current_executable = std::env::current_exe().map_err(|error| {
        InstallationError::new(
            "runtime-path-invalid",
            "verify-runtime",
            format!("could not resolve the current runner: {error}"),
        )
    })?;
    let expected_executable = fs::canonicalize(paths.runner()).map_err(|error| {
        InstallationError::new(
            "runtime-file-missing",
            "verify-runtime",
            format!("could not resolve the installed runner: {error}"),
        )
    })?;
    let actual_executable = fs::canonicalize(current_executable).map_err(|error| {
        InstallationError::new(
            "runtime-path-invalid",
            "verify-runtime",
            format!("could not canonicalize the current runner: {error}"),
        )
    })?;
    if actual_executable != expected_executable {
        return Err(InstallationError::new(
            "runtime-path-invalid",
            "verify-runtime",
            "internal runner mode is only available from the protected installation",
        ));
    }
    let state = read_install_state(&paths.state())?;
    verify_state_compatibility(&state)?;
    verify_installed_runtime_directory(&paths.current, state.require_signature)?;
    if !verify_runtime_protection(&paths, &state.owner_sid, &state.account_sid)? {
        return Err(InstallationError::new(
            "runtime-protection-invalid",
            "verify-runtime",
            "runtime directory does not have a protected DACL",
        ));
    }
    let current_sid = current_user_sid()?;
    if current_sid != state.account_sid {
        return Err(InstallationError::new(
            "sandbox-worker-identity-invalid",
            "verify-runtime",
            "internal runner mode requires the installed sandbox identity",
        ));
    }
    if !verify_offline_firewall(&state.account_sid)? {
        return Err(InstallationError::new(
            "network-rule-invalid",
            "verify-runtime",
            "offline network rules are not effective",
        ));
    }
    Ok(state)
}

fn deploy_runtime(
    paths: &InstallationPaths,
    bootstrap_directory: &Path,
    require_signature: bool,
    operation: SetupOperation,
    requested_owner_sid: Option<&str>,
) -> InstallationResult<SetupReport> {
    ensure_elevated()?;
    let caller_sid = current_user_sid()?;
    reject_sandbox_caller(paths, &caller_sid)?;
    let owner_sid =
        crate::identity::validate_setup_owner_sid(requested_owner_sid.unwrap_or(&caller_sid))?;
    reject_managed_reparse_points(paths)?;
    let had_installation = paths.current.exists();
    let (manifest, _) = verify_runtime_directory(bootstrap_directory, require_signature)?;
    if !had_installation && paths.root.exists() {
        remove_directory_if_present(&paths.root)?;
    }
    fs::create_dir_all(&paths.root).map_err(|error| {
        InstallationError::new(
            "setup-directory-create-failed",
            "prepare-installation",
            format!("could not create {}: {error}", paths.root.display()),
        )
    })?;
    let identity = match ensure_sandbox_identity(&paths.credentials) {
        Ok(identity) => identity,
        Err(error) => {
            if !had_installation {
                cleanup_new_installation(paths);
            } else {
                remove_directory_if_present(&paths.staging)?;
            }
            return Err(error);
        }
    };
    if let Err(error) = ensure_sandbox_account_hidden() {
        if !had_installation {
            cleanup_new_installation(paths);
        }
        return Err(error);
    }
    if let Err(error) = protect_installation_base(paths, &owner_sid, &identity.account_sid) {
        if !had_installation {
            cleanup_new_installation(paths);
        }
        return Err(error);
    }
    if let Err(error) = ensure_offline_firewall(&identity.account_sid, &owner_sid) {
        if !had_installation {
            cleanup_new_installation(paths);
        }
        return Err(error);
    }
    remove_directory_if_present(&paths.staging)?;
    if let Err(error) = copy_runtime(bootstrap_directory, &paths.staging, &manifest.files) {
        cleanup_failed_deployment(paths, had_installation);
        return Err(error);
    }

    let state = InstallState {
        schema_version: SETUP_SCHEMA_VERSION,
        runtime_version: manifest.runtime_version.clone(),
        protocol_version: manifest.protocol_version,
        policy_version: manifest.policy_version.clone(),
        architecture: manifest.architecture.clone(),
        account_name: identity.account_name.clone(),
        account_sid: identity.account_sid.clone(),
        owner_sid: owner_sid.clone(),
        require_signature,
        network_policy_version: NETWORK_POLICY_VERSION,
        protection_version: PROTECTION_VERSION,
        installed_at: unix_timestamp(),
    };
    if let Err(error) = write_install_state(&paths.staging.join(RUNTIME_STATE_FILENAME), &state) {
        cleanup_failed_deployment(paths, had_installation);
        return Err(error);
    }
    if let Err(error) = verify_installed_runtime_directory(&paths.staging, require_signature) {
        cleanup_failed_deployment(paths, had_installation);
        return Err(error);
    }

    let swap_result = swap_runtime_directories(paths);
    if let Err(error) = swap_result {
        if !had_installation {
            cleanup_new_installation(paths);
        } else {
            let _ = remove_directory_if_present(&paths.staging);
        }
        return Err(error);
    }
    if let Err(error) = protect_installation(paths, &owner_sid, &identity.account_sid) {
        let rollback_result = restore_previous_runtime(paths);
        let final_error = if rollback_result.is_err() {
            InstallationError::new(
                "setup-partial-failure",
                "rollback-installation",
                format!(
                    "runtime protection failed and the previous runtime could not be restored: {}",
                    error.message
                ),
            )
        } else {
            error
        };
        if !had_installation {
            cleanup_failed_deployment(paths, false);
        }
        return Err(final_error);
    }
    match verify_installation(paths, operation, require_signature) {
        Ok(report) if report.healthy => Ok(report),
        Ok(_) => rollback_failed_deployment(
            paths,
            had_installation,
            InstallationError::new(
                "setup-partial-failure",
                "verify-installation",
                "the activated Windows Sandbox runtime did not pass its health check",
            ),
        ),
        Err(error) => rollback_failed_deployment(paths, had_installation, error),
    }
}

fn verify_installation(
    paths: &InstallationPaths,
    operation: SetupOperation,
    require_signature: bool,
) -> InstallationResult<SetupReport> {
    reject_managed_reparse_points(paths)?;
    if !paths.current.is_dir() || !paths.state().is_file() || !paths.manifest().is_file() {
        let mut report = SetupReport::empty(operation, &paths.display_root());
        report.success = true;
        report.error_code = Some("runtime-not-installed".to_string());
        report.message = Some("Windows Sandbox runtime is not installed.".to_string());
        return Ok(report);
    }
    let state = read_install_state(&paths.state())?;
    verify_state_compatibility(&state)?;
    if require_signature && !state.require_signature {
        return Err(InstallationError::new(
            "runtime-signature-invalid",
            "verify-signature",
            "the installed runtime was not provisioned with the required signature policy",
        ));
    }
    let (manifest, integrity) =
        verify_installed_runtime_directory(&paths.current, state.require_signature)?;
    let account_sid = resolve_account_sid(&state.account_name)?;
    if account_sid != state.account_sid {
        return Err(InstallationError::new(
            "sandbox-identity-mismatch",
            "verify-identity",
            "the installed sandbox account SID has changed",
        ));
    }
    let identity = load_sandbox_identity(&paths.credentials)?;
    if identity.account_sid != state.account_sid {
        return Err(InstallationError::new(
            "sandbox-credentials-invalid",
            "verify-identity",
            "sandbox credentials do not match the installed identity",
        ));
    }
    if !verify_sandbox_account_hidden()? {
        return Err(InstallationError::new(
            "sandbox-identity-visibility-invalid",
            "verify-identity",
            "the managed sandbox account is visible on the Windows sign-in screen",
        ));
    }
    let network_ready = verify_offline_firewall(&state.account_sid)?;
    let (runtime_protected, credentials_protected) =
        verify_installation_protection(paths, &state.owner_sid, &state.account_sid)?;
    if !runtime_protected || !credentials_protected {
        return Err(InstallationError::new(
            "runtime-protection-invalid",
            "verify-protection",
            format!(
                "installed ACL policy does not match: runtimeProtected={runtime_protected}, credentialsProtected={credentials_protected}"
            ),
        ));
    }
    let mut report = SetupReport::empty(operation, &paths.display_root());
    report.success = true;
    report.installed = true;
    report.healthy = network_ready && runtime_protected && credentials_protected;
    report.runtime_version = manifest.runtime_version;
    report.protocol_version = manifest.protocol_version;
    report.policy_version = manifest.policy_version;
    report.runner_path = paths.runner().display().to_string();
    report.setup_path = paths.setup().display().to_string();
    report.identity = SetupIdentityReport {
        account_name: state.account_name,
        account_sid: state.account_sid,
        ready: true,
    };
    report.integrity = integrity;
    report.network = SetupNetworkReport {
        mode: "disabled".to_string(),
        rules_installed: network_ready,
        rules_effective: network_ready,
    };
    report.protection = SetupProtectionReport {
        protected_install: runtime_protected,
        credentials_protected,
    };
    Ok(report)
}

fn rollback_runtime(
    paths: &InstallationPaths,
    require_signature: bool,
) -> InstallationResult<SetupReport> {
    ensure_elevated()?;
    reject_managed_reparse_points(paths)?;
    if !paths.previous.is_dir() {
        return Err(InstallationError::new(
            "runtime-rollback-unavailable",
            "rollback-installation",
            "no previous Windows Sandbox runtime is available",
        ));
    }
    let failed = paths.root.join("failed-current");
    remove_directory_if_present(&failed)?;
    if paths.current.exists() {
        fs::rename(&paths.current, &failed).map_err(|error| {
            InstallationError::new(
                "runtime-rollback-failed",
                "rollback-installation",
                format!("could not preserve current runtime: {error}"),
            )
        })?;
    }
    if let Err(error) = fs::rename(&paths.previous, &paths.current) {
        let _ = fs::rename(&failed, &paths.current);
        return Err(InstallationError::new(
            "runtime-rollback-failed",
            "rollback-installation",
            format!("could not activate previous runtime: {error}"),
        ));
    }
    match verify_installation(paths, SetupOperation::Rollback, require_signature) {
        Ok(report) if report.healthy => {
            remove_directory_if_present(&paths.previous)?;
            if failed.exists() {
                fs::rename(&failed, &paths.previous).map_err(|error| {
                    InstallationError::new(
                        "runtime-rollback-failed",
                        "rollback-installation",
                        format!("could not preserve the replaced runtime: {error}"),
                    )
                })?;
            }
            Ok(report)
        }
        Ok(_) => {
            restore_failed_rollback(paths, &failed)?;
            Err(InstallationError::new(
                "runtime-rollback-failed",
                "rollback-installation",
                "the previous runtime did not pass its health check",
            ))
        }
        Err(error) => {
            restore_failed_rollback(paths, &failed)?;
            Err(error)
        }
    }
}

fn uninstall_runtime(paths: &InstallationPaths) -> InstallationResult<()> {
    ensure_elevated()?;
    reject_managed_reparse_points(paths)?;
    let network_result = remove_offline_firewall();
    let visibility_result = remove_sandbox_account_visibility();
    let identity_result = delete_sandbox_identity();
    remove_directory_if_present(&paths.current)?;
    remove_directory_if_present(&paths.previous)?;
    remove_directory_if_present(&paths.staging)?;
    if paths.root.exists() {
        fs::remove_dir_all(&paths.root).map_err(|error| {
            InstallationError::new(
                "runtime-uninstall-failed",
                "uninstall-runtime",
                format!("could not remove {}: {error}", paths.root.display()),
            )
        })?;
    }
    network_result?;
    visibility_result?;
    identity_result
}

fn swap_runtime_directories(paths: &InstallationPaths) -> InstallationResult<()> {
    remove_directory_if_present(&paths.previous)?;
    if paths.current.exists() {
        fs::rename(&paths.current, &paths.previous).map_err(|error| {
            InstallationError::new(
                "setup-partial-failure",
                "activate-installation",
                format!("could not preserve current runtime: {error}"),
            )
        })?;
    }
    if let Err(error) = fs::rename(&paths.staging, &paths.current) {
        let _ = restore_previous_runtime(paths);
        return Err(InstallationError::new(
            "setup-partial-failure",
            "activate-installation",
            format!("could not activate staged runtime: {error}"),
        ));
    }
    Ok(())
}

fn restore_previous_runtime(paths: &InstallationPaths) -> InstallationResult<()> {
    if paths.current.exists() {
        remove_directory_if_present(&paths.current)?;
    }
    if paths.previous.exists() {
        fs::rename(&paths.previous, &paths.current).map_err(|error| {
            InstallationError::new(
                "runtime-rollback-failed",
                "rollback-installation",
                format!("could not restore previous runtime: {error}"),
            )
        })?;
    }
    Ok(())
}

fn restore_failed_rollback(paths: &InstallationPaths, failed: &Path) -> InstallationResult<()> {
    if failed.exists() {
        remove_directory_if_present(&paths.current)?;
        fs::rename(failed, &paths.current).map_err(|error| {
            InstallationError::new(
                "runtime-rollback-failed",
                "rollback-installation",
                format!("could not restore the replaced runtime: {error}"),
            )
        })?;
    } else if paths.current.exists() {
        fs::rename(&paths.current, &paths.previous).map_err(|error| {
            InstallationError::new(
                "runtime-rollback-failed",
                "rollback-installation",
                format!("could not restore the previous runtime slot: {error}"),
            )
        })?;
    }
    Ok(())
}

fn copy_runtime(
    source: &Path,
    destination: &Path,
    manifest_files: &[crate::model::RuntimeManifestFile],
) -> InstallationResult<()> {
    fs::create_dir_all(destination).map_err(|error| {
        InstallationError::new(
            "setup-copy-failed",
            "stage-installation",
            format!("could not create {}: {error}", destination.display()),
        )
    })?;
    let mut names = manifest_files
        .iter()
        .map(|file| file.name.as_str())
        .collect::<Vec<_>>();
    names.push(RUNTIME_MANIFEST_FILENAME);
    for name in names {
        if name.contains('/') || name.contains('\\') || name == "." || name == ".." {
            return Err(InstallationError::new(
                "runtime-manifest-invalid",
                "stage-installation",
                format!("manifest contains an unsafe filename: {name}"),
            ));
        }
        let from = source.join(name);
        let metadata = fs::symlink_metadata(&from).map_err(|error| {
            InstallationError::new(
                "setup-copy-failed",
                "stage-installation",
                format!("could not inspect {}: {error}", from.display()),
            )
        })?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(InstallationError::new(
                "runtime-reparse-point-denied",
                "stage-installation",
                format!("runtime source must be a regular file: {}", from.display()),
            ));
        }
        let to = destination.join(name);
        fs::copy(&from, &to).map_err(|error| {
            InstallationError::new(
                "setup-copy-failed",
                "stage-installation",
                format!("could not copy {}: {error}", from.display()),
            )
        })?;
    }
    Ok(())
}

fn read_install_state(path: &Path) -> InstallationResult<InstallState> {
    let bytes = fs::read(path).map_err(|error| {
        InstallationError::new(
            "runtime-state-missing",
            "verify-runtime",
            format!("could not read {}: {error}", path.display()),
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        InstallationError::new(
            "runtime-state-invalid",
            "verify-runtime",
            format!("could not parse {}: {error}", path.display()),
        )
    })
}

fn write_install_state(path: &Path, state: &InstallState) -> InstallationResult<()> {
    let bytes = serde_json::to_vec_pretty(state).map_err(|error| {
        InstallationError::new(
            "runtime-state-write-failed",
            "stage-installation",
            format!("could not serialize runtime state: {error}"),
        )
    })?;
    fs::write(path, bytes).map_err(|error| {
        InstallationError::new(
            "runtime-state-write-failed",
            "stage-installation",
            format!("could not write {}: {error}", path.display()),
        )
    })
}

fn verify_state_compatibility(state: &InstallState) -> InstallationResult<()> {
    if state.schema_version != SETUP_SCHEMA_VERSION
        || state.runtime_version != env!("CARGO_PKG_VERSION")
        || state.protocol_version != lobster_sandbox_protocol::NATIVE_SANDBOX_PROTOCOL_VERSION
        || state.policy_version != lobster_sandbox_protocol::NATIVE_SANDBOX_POLICY_VERSION
        || state.network_policy_version != NETWORK_POLICY_VERSION
        || state.protection_version != PROTECTION_VERSION
    {
        return Err(InstallationError::new(
            "runtime-state-incompatible",
            "verify-runtime",
            "installed runtime state is incompatible with this helper",
        ));
    }
    Ok(())
}

fn reject_sandbox_caller(paths: &InstallationPaths, caller_sid: &str) -> InstallationResult<()> {
    if !paths.state().is_file() {
        return Ok(());
    }
    if let Ok(state) = read_install_state(&paths.state()) {
        if state.account_sid == caller_sid {
            return Err(InstallationError::new(
                "setup-caller-not-authorized",
                "resolve-caller",
                "the managed sandbox identity cannot invoke setup operations",
            ));
        }
    }
    Ok(())
}

fn ensure_elevated() -> InstallationResult<()> {
    if crate::elevation::is_process_elevated()? {
        return Ok(());
    }
    Err(InstallationError::new(
        "setup-elevation-required",
        "request-elevation",
        "this setup operation requires Windows administrator approval",
    ))
}

fn remove_directory_if_present(path: &Path) -> InstallationResult<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(InstallationError::new(
            "setup-cleanup-failed",
            "prepare-installation",
            format!("could not remove {}: {error}", path.display()),
        )),
    }
}

fn reject_managed_reparse_points(paths: &InstallationPaths) -> InstallationResult<()> {
    for path in [
        &paths.root,
        &paths.current,
        &paths.previous,
        &paths.state_dir,
        &paths.credentials,
        &paths.setup_result,
    ] {
        match fs::symlink_metadata(path) {
            Ok(_) => reject_reparse(path)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(InstallationError::new(
                    "runtime-path-invalid",
                    "verify-runtime",
                    format!("could not inspect {}: {error}", path.display()),
                ));
            }
        }
    }
    Ok(())
}

fn cleanup_failed_deployment(paths: &InstallationPaths, had_installation: bool) {
    let _ = remove_directory_if_present(&paths.staging);
    if !had_installation {
        cleanup_new_installation(paths);
    }
}

fn cleanup_new_installation(paths: &InstallationPaths) {
    let _ = remove_offline_firewall();
    let _ = remove_sandbox_account_visibility();
    let _ = delete_sandbox_identity();
    let _ = remove_directory_if_present(&paths.root);
}

fn rollback_failed_deployment(
    paths: &InstallationPaths,
    had_installation: bool,
    original_error: InstallationError,
) -> InstallationResult<SetupReport> {
    let rollback_result = if had_installation {
        restore_previous_runtime(paths)
    } else {
        cleanup_failed_deployment(paths, false);
        Ok(())
    };
    match rollback_result {
        Ok(()) => Err(original_error),
        Err(rollback_error) => Err(InstallationError::new(
            "setup-partial-failure",
            "rollback-installation",
            format!(
                "runtime verification failed and rollback also failed: {}; {}",
                original_error.message, rollback_error.message
            ),
        )),
    }
}

fn error_report(
    paths: &InstallationPaths,
    operation: SetupOperation,
    error: InstallationError,
) -> SetupReport {
    let mut report = SetupReport::empty(operation, &paths.display_root());
    report.cancelled = error.cancelled;
    report.error_code = Some(error.code.to_string());
    report.message = Some(error.message);
    report
}

fn unix_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_installation_is_a_stable_non_healthy_status() {
        let temporary = tempfile::tempdir();
        assert!(temporary.is_ok());
        let Some(temporary) = temporary.ok() else {
            return;
        };
        let paths = InstallationPaths::from_root(temporary.path().join("runtime"));
        let report = verify_installation(&paths, SetupOperation::Verify, false);
        assert!(report.is_ok());
        let Some(report) = report.ok() else {
            return;
        };
        assert!(report.success);
        assert!(!report.installed);
        assert_eq!(report.error_code.as_deref(), Some("runtime-not-installed"));
    }
}
