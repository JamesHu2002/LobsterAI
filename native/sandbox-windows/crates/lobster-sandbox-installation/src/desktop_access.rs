use std::ffi::{OsStr, c_void};
use std::os::windows::ffi::OsStrExt;

use windows_sys::Win32::Foundation::{ERROR_SUCCESS, GENERIC_ALL, GetLastError, HLOCAL, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    EXPLICIT_ACCESS_W, GetSecurityInfo, NO_MULTIPLE_TRUSTEE, SE_KERNEL_OBJECT, SE_OBJECT_TYPE,
    SE_WINDOW_OBJECT, SET_ACCESS, SetEntriesInAclW, SetSecurityInfo, TRUSTEE_IS_SID,
    TRUSTEE_IS_USER, TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    ACL, DACL_SECURITY_INFORMATION, NO_INHERITANCE, PSECURITY_DESCRIPTOR,
};
use windows_sys::Win32::System::StationsAndDesktops::{GetProcessWindowStation, GetThreadDesktop};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId,
};

use crate::error::{InstallationError, InstallationResult};

const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;
const PROCESS_QUERY_LIMITED_INFORMATION_ACCESS: u32 = 0x0000_1000;

/// Gives the managed sandbox identity access to the interactive objects inherited by the worker.
///
/// Windows requires an alternate-credential process to have access to both its window station and
/// desktop even when it is created without a visible window. The signed broker repeats this
/// operation before each worker launch so a replaced DACL fails closed instead of making process
/// startup dependent on installer-time session state.
pub fn ensure_current_desktop_access(account_sid: &str) -> InstallationResult<()> {
    let sid = LocalAllocation::from_string_sid(account_sid)?;
    let window_station = unsafe { GetProcessWindowStation() };
    if window_station == 0 {
        return Err(InstallationError::windows(
            "sandbox-window-station-missing",
            "prepare-worker-desktop",
            "GetProcessWindowStation failed",
            unsafe { GetLastError() },
        ));
    }
    grant_access(
        window_station,
        SE_WINDOW_OBJECT,
        sid.as_ptr(),
        GENERIC_ALL,
        "window station",
    )?;

    let desktop = unsafe { GetThreadDesktop(GetCurrentThreadId()) };
    if desktop == 0 {
        return Err(InstallationError::windows(
            "sandbox-desktop-missing",
            "prepare-worker-desktop",
            "GetThreadDesktop failed",
            unsafe { GetLastError() },
        ));
    }
    grant_access(
        desktop,
        SE_WINDOW_OBJECT,
        sid.as_ptr(),
        GENERIC_ALL,
        "desktop",
    )
}

/// Lets the dedicated worker wait on its signed broker and terminate fail-closed if that broker
/// is cancelled or killed. Process object lifetime makes this grant self-cleaning.
pub fn ensure_current_process_wait_access(account_sid: &str) -> InstallationResult<u32> {
    let sid = LocalAllocation::from_string_sid(account_sid)?;
    grant_access(
        unsafe { GetCurrentProcess() },
        SE_KERNEL_OBJECT,
        sid.as_ptr(),
        SYNCHRONIZE_ACCESS | PROCESS_QUERY_LIMITED_INFORMATION_ACCESS,
        "broker process",
    )?;
    Ok(unsafe { GetCurrentProcessId() })
}

fn grant_access(
    handle: isize,
    object_type: SE_OBJECT_TYPE,
    sid: *mut c_void,
    access_mask: u32,
    object_name: &'static str,
) -> InstallationResult<()> {
    let mut current_dacl: *mut ACL = std::ptr::null_mut();
    let mut security_descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let query_result = unsafe {
        GetSecurityInfo(
            handle,
            object_type,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut current_dacl,
            std::ptr::null_mut(),
            &mut security_descriptor,
        )
    };
    if query_result != ERROR_SUCCESS {
        return Err(InstallationError::windows(
            "sandbox-desktop-acl-query-failed",
            "prepare-worker-desktop",
            format!("GetSecurityInfo failed for the current {object_name}"),
            query_result,
        ));
    }
    let _security_descriptor = LocalAllocation(security_descriptor);
    let entry = explicit_access_for_sid(sid, access_mask);
    let mut updated_dacl: *mut ACL = std::ptr::null_mut();
    let acl_result = unsafe { SetEntriesInAclW(1, &entry, current_dacl, &mut updated_dacl) };
    if acl_result != ERROR_SUCCESS {
        return Err(InstallationError::windows(
            "sandbox-desktop-acl-prepare-failed",
            "prepare-worker-desktop",
            format!("SetEntriesInAclW failed for the current {object_name}"),
            acl_result,
        ));
    }
    let _updated_dacl = LocalAllocation(updated_dacl as *mut c_void);
    let update_result = unsafe {
        SetSecurityInfo(
            handle,
            object_type,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            updated_dacl,
            std::ptr::null_mut(),
        )
    };
    if update_result != ERROR_SUCCESS {
        return Err(InstallationError::windows(
            "sandbox-desktop-acl-update-failed",
            "prepare-worker-desktop",
            format!("SetSecurityInfo failed for the current {object_name}"),
            update_result,
        ));
    }
    Ok(())
}

fn explicit_access_for_sid(sid: *mut c_void, access_mask: u32) -> EXPLICIT_ACCESS_W {
    EXPLICIT_ACCESS_W {
        grfAccessPermissions: access_mask,
        grfAccessMode: SET_ACCESS,
        grfInheritance: NO_INHERITANCE,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_USER,
            ptstrName: sid as *mut u16,
        },
    }
}

fn to_wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

struct LocalAllocation(*mut c_void);

impl LocalAllocation {
    fn from_string_sid(value: &str) -> InstallationResult<Self> {
        let value = to_wide(value);
        let mut sid = std::ptr::null_mut();
        if unsafe {
            windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW(
                value.as_ptr(),
                &mut sid,
            )
        } == 0
            || sid.is_null()
        {
            return Err(InstallationError::windows(
                "sandbox-identity-invalid",
                "prepare-worker-desktop",
                "ConvertStringSidToSidW failed for the managed identity",
                unsafe { GetLastError() },
            ));
        }
        Ok(Self(sid))
    }

    fn as_ptr(&self) -> *mut c_void {
        self.0
    }
}

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0 as HLOCAL);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_access_entry_targets_the_user_sid_without_inheritance() {
        let sid = 0x1234usize as *mut c_void;
        let entry = explicit_access_for_sid(sid, GENERIC_ALL);

        assert_eq!(entry.grfAccessPermissions, GENERIC_ALL);
        assert_eq!(entry.grfAccessMode, SET_ACCESS);
        assert_eq!(entry.grfInheritance, NO_INHERITANCE);
        assert_eq!(entry.Trustee.TrusteeForm, TRUSTEE_IS_SID);
        assert_eq!(entry.Trustee.TrusteeType, TRUSTEE_IS_USER);
        assert_eq!(entry.Trustee.ptstrName, sid as *mut u16);
    }
}
