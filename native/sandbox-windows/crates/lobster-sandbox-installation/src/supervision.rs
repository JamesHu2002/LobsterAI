use std::ffi::c_void;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::{GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcessId, INFINITE, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    WaitForSingleObject,
};

use crate::error::{InstallationError, InstallationResult};
use crate::identity::sid_to_string;

const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;
const SUPERVISOR_LOST_EXIT_CODE: i32 = 70;

#[link(name = "advapi32")]
unsafe extern "system" {
    fn OpenProcessToken(
        process_handle: isize,
        desired_access: u32,
        token_handle: *mut isize,
    ) -> i32;
}

pub fn start_broker_watchdog(broker_pid: u32, expected_owner_sid: &str) -> InstallationResult<()> {
    if broker_pid == 0 || broker_pid == unsafe { GetCurrentProcessId() } {
        return Err(InstallationError::new(
            "sandbox-broker-invalid",
            "supervise-worker",
            "the sandbox worker received an invalid broker process identifier",
        ));
    }
    let parent_pid = current_parent_process_id()?;
    if parent_pid != broker_pid {
        return Err(InstallationError::new(
            "sandbox-broker-invalid",
            "supervise-worker",
            "the sandbox worker was not created directly by the declared broker",
        ));
    }
    let handle = unsafe {
        OpenProcess(
            SYNCHRONIZE_ACCESS | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            broker_pid,
        )
    };
    if handle == 0 {
        return Err(InstallationError::windows(
            "sandbox-broker-unavailable",
            "supervise-worker",
            "the sandbox worker could not open its broker process",
            unsafe { GetLastError() },
        ));
    }
    let handle = ProcessHandle(handle);
    let broker_sid = process_user_sid(handle.0)?;
    if !broker_sid.eq_ignore_ascii_case(expected_owner_sid) {
        return Err(InstallationError::new(
            "sandbox-broker-identity-invalid",
            "supervise-worker",
            "the sandbox worker broker does not run as the installed product owner",
        ));
    }
    std::thread::Builder::new()
        .name("lobster-sandbox-broker-watchdog".to_string())
        .spawn(move || {
            let _ = unsafe { WaitForSingleObject(handle.0, INFINITE) };
            // A signalled or failed wait means supervision can no longer be proven. Exit so the
            // worker's kill-on-close command Job cannot become an orphaned execution path.
            std::process::exit(SUPERVISOR_LOST_EXIT_CODE);
        })
        .map_err(|error| {
            InstallationError::new(
                "sandbox-broker-watchdog-failed",
                "supervise-worker",
                format!("could not start the sandbox broker watchdog: {error}"),
            )
        })?;
    Ok(())
}

fn current_parent_process_id() -> InstallationResult<u32> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(InstallationError::windows(
            "sandbox-broker-query-failed",
            "supervise-worker",
            "CreateToolhelp32Snapshot failed",
            unsafe { GetLastError() },
        ));
    }
    let snapshot = ProcessHandle(snapshot);
    let current_pid = unsafe { GetCurrentProcessId() };
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut available = unsafe { Process32FirstW(snapshot.0, &mut entry) } != 0;
    while available {
        if entry.th32ProcessID == current_pid {
            if entry.th32ParentProcessID == 0 {
                break;
            }
            return Ok(entry.th32ParentProcessID);
        }
        available = unsafe { Process32NextW(snapshot.0, &mut entry) } != 0;
    }
    Err(InstallationError::new(
        "sandbox-broker-query-failed",
        "supervise-worker",
        "Windows did not report the sandbox worker parent process",
    ))
}

fn process_user_sid(process: isize) -> InstallationResult<String> {
    let mut token = 0;
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(InstallationError::windows(
            "sandbox-broker-identity-invalid",
            "supervise-worker",
            "OpenProcessToken failed for the sandbox broker",
            unsafe { GetLastError() },
        ));
    }
    let token = ProcessHandle(token);
    let mut required = 0;
    unsafe {
        GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut required);
    }
    if required == 0 {
        return Err(InstallationError::windows(
            "sandbox-broker-identity-invalid",
            "supervise-worker",
            "GetTokenInformation did not report a broker token size",
            unsafe { GetLastError() },
        ));
    }
    let mut buffer = vec![0u8; required as usize];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr() as *mut c_void,
            required,
            &mut required,
        )
    } == 0
    {
        return Err(InstallationError::windows(
            "sandbox-broker-identity-invalid",
            "supervise-worker",
            "GetTokenInformation(TokenUser) failed for the sandbox broker",
            unsafe { GetLastError() },
        ));
    }
    let token_user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
    sid_to_string(token_user.User.Sid)
}

struct ProcessHandle(isize);

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        if self.0 != 0 && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watchdog_rejects_missing_and_self_process_ids() {
        assert_eq!(
            start_broker_watchdog(0, "S-1-0-0")
                .err()
                .map(|error| error.code),
            Some("sandbox-broker-invalid")
        );
        assert_eq!(
            start_broker_watchdog(unsafe { GetCurrentProcessId() }, "S-1-0-0")
                .err()
                .map(|error| error.code),
            Some("sandbox-broker-invalid")
        );
    }
}
