use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use windows_sys::Win32::Foundation::{CloseHandle, ERROR_CANCELLED, GetLastError, WAIT_OBJECT_0};
use windows_sys::Win32::Security::{
    GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetExitCodeProcess, INFINITE, WaitForSingleObject,
};
use windows_sys::Win32::UI::Shell::{SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

use crate::error::{InstallationError, InstallationResult};
use crate::model::{SetupOperation, SetupReport};
use crate::paths::InstallationPaths;

#[link(name = "advapi32")]
unsafe extern "system" {
    fn OpenProcessToken(
        process_handle: isize,
        desired_access: u32,
        token_handle: *mut isize,
    ) -> i32;
}

pub enum ElevationDisposition {
    AlreadyElevated,
    Completed(Box<SetupReport>),
}

pub fn is_process_elevated() -> InstallationResult<bool> {
    let mut token = 0;
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(InstallationError::windows(
            "setup-elevation-check-failed",
            "request-elevation",
            "OpenProcessToken failed",
            unsafe { GetLastError() },
        ));
    }
    let token = Handle(token);
    let mut elevation: TOKEN_ELEVATION = unsafe { std::mem::zeroed() };
    let mut returned = 0;
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenElevation,
            &mut elevation as *mut _ as *mut std::ffi::c_void,
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
    } == 0
    {
        return Err(InstallationError::windows(
            "setup-elevation-check-failed",
            "request-elevation",
            "GetTokenInformation(TokenElevation) failed",
            unsafe { GetLastError() },
        ));
    }
    Ok(elevation.TokenIsElevated != 0)
}

pub fn elevate_and_wait(
    executable: &Path,
    operation: SetupOperation,
    require_signature: bool,
    owner_sid: &str,
) -> InstallationResult<ElevationDisposition> {
    if is_process_elevated()? {
        return Ok(ElevationDisposition::AlreadyElevated);
    }
    let paths = InstallationPaths::discover();
    let operation_name = operation_name(operation);
    let request_id = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default(),
    );
    let parameters = if require_signature {
        format!(
            "{operation_name} --elevated --require-signature --owner-sid {owner_sid} --request-id {request_id}"
        )
    } else {
        format!("{operation_name} --elevated --owner-sid {owner_sid} --request-id {request_id}")
    };
    let verb = wide("runas");
    let executable_wide = executable
        .as_os_str()
        .encode_wide()
        .chain([0])
        .collect::<Vec<_>>();
    let parameters_wide = wide(&parameters);
    let directory_wide = executable
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .as_os_str()
        .encode_wide()
        .chain([0])
        .collect::<Vec<_>>();
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = executable_wide.as_ptr();
    info.lpParameters = parameters_wide.as_ptr();
    info.lpDirectory = directory_wide.as_ptr();
    info.nShow = SW_HIDE;
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        let error = unsafe { GetLastError() };
        if error == ERROR_CANCELLED {
            return Err(InstallationError::cancelled(
                "Windows administrator approval was cancelled.",
            ));
        }
        return Err(InstallationError::windows(
            "setup-elevation-failed",
            "request-elevation",
            "ShellExecuteExW failed",
            error,
        ));
    }
    let process = Handle(info.hProcess);
    if unsafe { WaitForSingleObject(process.0, INFINITE) } != WAIT_OBJECT_0 {
        return Err(InstallationError::windows(
            "setup-elevation-failed",
            "request-elevation",
            "waiting for elevated setup failed",
            unsafe { GetLastError() },
        ));
    }
    let mut exit_code = 0;
    if unsafe { GetExitCodeProcess(process.0, &mut exit_code) } == 0 {
        return Err(InstallationError::windows(
            "setup-elevation-failed",
            "request-elevation",
            "GetExitCodeProcess failed",
            unsafe { GetLastError() },
        ));
    }
    let bytes = fs::read(&paths.setup_result).map_err(|error| {
        InstallationError::new(
            "setup-result-missing",
            "request-elevation",
            format!(
                "elevated setup exited with code {exit_code} without a readable result: {error}"
            ),
        )
    })?;
    let report: SetupReport = serde_json::from_slice(&bytes).map_err(|error| {
        InstallationError::new(
            "setup-result-invalid",
            "request-elevation",
            format!("elevated setup returned invalid JSON: {error}"),
        )
    })?;
    if report.operation != operation {
        return Err(InstallationError::new(
            "setup-result-invalid",
            "request-elevation",
            "elevated setup result did not match the requested operation",
        ));
    }
    if report.request_id.as_deref() != Some(request_id.as_str()) {
        return Err(InstallationError::new(
            "setup-result-invalid",
            "request-elevation",
            "elevated setup result did not match the current request",
        ));
    }
    Ok(ElevationDisposition::Completed(Box::new(report)))
}

pub fn write_elevated_result(report: &SetupReport) -> InstallationResult<()> {
    let paths = InstallationPaths::discover();
    fs::create_dir_all(&paths.state_dir).map_err(|error| {
        InstallationError::new(
            "setup-result-write-failed",
            "write-result",
            format!("could not create {}: {error}", paths.state_dir.display()),
        )
    })?;
    let bytes = serde_json::to_vec(report).map_err(|error| {
        InstallationError::new(
            "setup-result-write-failed",
            "write-result",
            format!("could not serialize setup result: {error}"),
        )
    })?;
    fs::write(&paths.setup_result, bytes).map_err(|error| {
        InstallationError::new(
            "setup-result-write-failed",
            "write-result",
            format!("could not write {}: {error}", paths.setup_result.display()),
        )
    })
}

fn operation_name(operation: SetupOperation) -> &'static str {
    match operation {
        SetupOperation::Install => "install",
        SetupOperation::Verify => "verify",
        SetupOperation::Repair => "repair",
        SetupOperation::Upgrade => "upgrade",
        SetupOperation::Rollback => "rollback",
        SetupOperation::Uninstall => "uninstall",
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}

struct Handle(isize);

impl Drop for Handle {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
