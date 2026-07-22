use std::ffi::c_void;
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    DACL_SECURITY_INFORMATION, EqualSid, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
    GetSecurityDescriptorOwner, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    SE_DACL_PROTECTED,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, GetFileAttributesW, INVALID_FILE_ATTRIBUTES,
};

use crate::error::{InstallationError, InstallationResult};
use crate::identity::free_local;
use crate::paths::InstallationPaths;

const SE_FILE_OBJECT: i32 = 1;

#[link(name = "advapi32")]
unsafe extern "system" {
    fn SetNamedSecurityInfoW(
        object_name: *mut u16,
        object_type: i32,
        security_info: u32,
        owner: *mut c_void,
        group: *mut c_void,
        dacl: *mut c_void,
        sacl: *mut c_void,
    ) -> u32;
    fn GetNamedSecurityInfoW(
        object_name: *mut u16,
        object_type: i32,
        security_info: u32,
        owner: *mut *mut c_void,
        group: *mut *mut c_void,
        dacl: *mut *mut c_void,
        sacl: *mut *mut c_void,
        descriptor: *mut *mut c_void,
    ) -> u32;
}

pub fn protect_installation(
    paths: &InstallationPaths,
    owner_sid: &str,
    sandbox_sid: &str,
) -> InstallationResult<()> {
    let runtime_sddl = runtime_sddl(owner_sid, sandbox_sid);
    apply_tree_security(&paths.current, &runtime_sddl)?;
    if paths.previous.exists() {
        apply_tree_security(&paths.previous, &runtime_sddl)?;
    }
    if let Some(logs) = paths.setup_log.parent().filter(|logs| logs.exists()) {
        apply_tree_security(logs, &runtime_sddl)?;
    }
    protect_installation_base(paths, owner_sid, sandbox_sid)
}

pub fn protect_installation_base(
    paths: &InstallationPaths,
    owner_sid: &str,
    sandbox_sid: &str,
) -> InstallationResult<()> {
    fs::create_dir_all(&paths.state_dir).map_err(|error| {
        InstallationError::new(
            "runtime-protection-failed",
            "protect-installation",
            format!("could not create {}: {error}", paths.state_dir.display()),
        )
    })?;
    let state_sddl = state_sddl(owner_sid, sandbox_sid);
    set_path_security(&paths.state_dir, &state_sddl)?;
    if paths.credentials.exists() {
        let credentials_sddl = credentials_sddl(owner_sid, sandbox_sid);
        set_path_security(&paths.credentials, &credentials_sddl)?;
    }
    let root_sddl = runtime_sddl(owner_sid, sandbox_sid);
    set_path_security(&paths.root, &root_sddl)?;
    Ok(())
}

pub fn verify_runtime_protection(
    paths: &InstallationPaths,
    owner_sid: &str,
    sandbox_sid: &str,
) -> InstallationResult<bool> {
    let runtime_sddl = runtime_sddl(owner_sid, sandbox_sid);
    let state_sddl = state_sddl(owner_sid, sandbox_sid);
    Ok(
        path_matches_security_descriptor(&paths.root, &runtime_sddl)?
            && tree_matches_security_descriptor(&paths.current, &runtime_sddl)?
            && path_matches_security_descriptor(&paths.state_dir, &state_sddl)?,
    )
}

pub fn verify_installation_protection(
    paths: &InstallationPaths,
    owner_sid: &str,
    sandbox_sid: &str,
) -> InstallationResult<(bool, bool)> {
    let runtime_protected = verify_runtime_protection(paths, owner_sid, sandbox_sid)?
        && (!paths.previous.exists()
            || tree_matches_security_descriptor(
                &paths.previous,
                &runtime_sddl(owner_sid, sandbox_sid),
            )?)
        && match paths.setup_log.parent() {
            Some(logs) if logs.exists() => {
                tree_matches_security_descriptor(logs, &runtime_sddl(owner_sid, sandbox_sid))?
            }
            _ => true,
        };
    let credentials_protected = path_matches_security_descriptor(
        &paths.credentials,
        &credentials_sddl(owner_sid, sandbox_sid),
    )?;
    Ok((runtime_protected, credentials_protected))
}

pub fn protect_setup_result(
    paths: &InstallationPaths,
    owner_sid: &str,
    sandbox_sid: Option<&str>,
) -> InstallationResult<()> {
    if !paths.setup_result.exists() {
        return Ok(());
    }
    if !paths.current.exists() {
        let sandbox_read = sandbox_sid
            .map(|sid| format!("(A;OICI;0x120089;;;{sid})"))
            .unwrap_or_default();
        let directory_sddl = format!(
            "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x120089;;;{owner_sid}){sandbox_read}"
        );
        set_path_security(&paths.root, &directory_sddl)?;
        set_path_security(&paths.state_dir, &directory_sddl)?;
        if let Some(logs) = paths.setup_log.parent().filter(|logs| logs.exists()) {
            apply_tree_security(logs, &directory_sddl)?;
        }
    } else if let (Some(logs), Some(sandbox_sid)) = (
        paths.setup_log.parent().filter(|logs| logs.exists()),
        sandbox_sid,
    ) {
        apply_tree_security(logs, &runtime_sddl(owner_sid, sandbox_sid))?;
    }
    let deny_sandbox = sandbox_sid
        .map(|sid| format!("(D;;GA;;;{sid})"))
        .unwrap_or_default();
    let sddl = format!("O:BAD:P{deny_sandbox}(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;{owner_sid})");
    set_path_security(&paths.setup_result, &sddl)
}

fn path_matches_security_descriptor(path: &Path, expected_sddl: &str) -> InstallationResult<bool> {
    let actual = read_security_descriptor(path)?;
    if !security_descriptor_has_protected_dacl(actual.0)? {
        return Ok(false);
    }
    let expected = security_descriptor_from_sddl(expected_sddl)?;
    let actual_owner = security_descriptor_owner(actual.0)?;
    let expected_owner = security_descriptor_owner(expected.0)?;
    if unsafe { EqualSid(actual_owner, expected_owner) } == 0 {
        return Ok(false);
    }
    let actual_dacl = security_descriptor_dacl(actual.0)?;
    let expected_dacl = security_descriptor_dacl(expected.0)?;
    Ok(acl_bytes(actual_dacl)? == acl_bytes(expected_dacl)?)
}

fn tree_matches_security_descriptor(root: &Path, expected_sddl: &str) -> InstallationResult<bool> {
    reject_reparse(root)?;
    if !path_matches_security_descriptor(root, expected_sddl)? {
        return Ok(false);
    }
    if !root.is_dir() {
        return Ok(true);
    }
    for entry in fs::read_dir(root).map_err(|error| {
        InstallationError::new(
            "runtime-protection-invalid",
            "verify-protection",
            format!("could not enumerate {}: {error}", root.display()),
        )
    })? {
        let path = entry
            .map_err(|error| {
                InstallationError::new(
                    "runtime-protection-invalid",
                    "verify-protection",
                    format!("could not enumerate {}: {error}", root.display()),
                )
            })?
            .path();
        if !tree_matches_security_descriptor(&path, expected_sddl)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn read_security_descriptor(path: &Path) -> InstallationResult<LocalAllocation> {
    let mut wide = to_wide(path);
    let mut descriptor = std::ptr::null_mut();
    let mut owner = std::ptr::null_mut();
    let result = unsafe {
        GetNamedSecurityInfoW(
            wide.as_mut_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if result != ERROR_SUCCESS {
        return Err(InstallationError::windows(
            "runtime-protection-invalid",
            "verify-protection",
            format!("could not read ACL for {}", path.display()),
            result,
        ));
    }
    Ok(LocalAllocation(descriptor))
}

fn security_descriptor_from_sddl(sddl: &str) -> InstallationResult<LocalAllocation> {
    let sddl_wide = to_wide(std::ffi::OsStr::new(sddl));
    let mut descriptor = std::ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_wide.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(InstallationError::windows(
            "runtime-protection-invalid",
            "verify-protection",
            "could not parse the expected runtime security descriptor",
            unsafe { windows_sys::Win32::Foundation::GetLastError() },
        ));
    }
    Ok(LocalAllocation(descriptor))
}

fn security_descriptor_has_protected_dacl(descriptor: *mut c_void) -> InstallationResult<bool> {
    let mut control = 0u16;
    let mut revision = 0u32;
    if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 {
        return Err(InstallationError::windows(
            "runtime-protection-invalid",
            "verify-protection",
            "could not inspect runtime ACL control",
            unsafe { windows_sys::Win32::Foundation::GetLastError() },
        ));
    }
    Ok(control & SE_DACL_PROTECTED != 0)
}

fn security_descriptor_dacl(
    descriptor: *mut c_void,
) -> InstallationResult<*mut windows_sys::Win32::Security::ACL> {
    let mut dacl = std::ptr::null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    if unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) }
        == 0
        || present == 0
        || dacl.is_null()
    {
        return Err(InstallationError::new(
            "runtime-protection-invalid",
            "verify-protection",
            "runtime security descriptor did not contain a DACL",
        ));
    }
    Ok(dacl)
}

fn security_descriptor_owner(descriptor: *mut c_void) -> InstallationResult<*mut c_void> {
    let mut owner = std::ptr::null_mut();
    let mut defaulted = 0;
    if unsafe { GetSecurityDescriptorOwner(descriptor, &mut owner, &mut defaulted) } == 0
        || owner.is_null()
    {
        return Err(InstallationError::new(
            "runtime-protection-invalid",
            "verify-protection",
            "runtime security descriptor did not contain an owner",
        ));
    }
    Ok(owner)
}

fn acl_bytes(dacl: *mut windows_sys::Win32::Security::ACL) -> InstallationResult<Vec<u8>> {
    let acl = unsafe { &*dacl };
    let size = usize::from(acl.AclSize);
    if size < std::mem::size_of::<windows_sys::Win32::Security::ACL>() {
        return Err(InstallationError::new(
            "runtime-protection-invalid",
            "verify-protection",
            "runtime DACL has an invalid size",
        ));
    }
    Ok(unsafe { std::slice::from_raw_parts(dacl as *const u8, size) }.to_vec())
}

fn runtime_sddl(owner_sid: &str, sandbox_sid: &str) -> String {
    format!(
        "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;{owner_sid})(A;OICI;0x1200a9;;;{sandbox_sid})"
    )
}

fn state_sddl(owner_sid: &str, sandbox_sid: &str) -> String {
    format!(
        "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x120089;;;{owner_sid})(A;OICI;0x120089;;;{sandbox_sid})"
    )
}

fn credentials_sddl(owner_sid: &str, sandbox_sid: &str) -> String {
    format!("O:BAD:P(D;;GA;;;{sandbox_sid})(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;{owner_sid})")
}

fn apply_tree_security(root: &Path, sddl: &str) -> InstallationResult<()> {
    reject_reparse(root)?;
    set_path_security(root, sddl)?;
    if !root.is_dir() {
        return Ok(());
    }
    let entries = fs::read_dir(root).map_err(|error| {
        InstallationError::new(
            "runtime-protection-failed",
            "protect-installation",
            format!("could not enumerate {}: {error}", root.display()),
        )
    })?;
    for entry in entries {
        let path = entry
            .map_err(|error| {
                InstallationError::new(
                    "runtime-protection-failed",
                    "protect-installation",
                    format!("could not enumerate {}: {error}", root.display()),
                )
            })?
            .path();
        reject_reparse(&path)?;
        if path.is_dir() {
            apply_tree_security(&path, sddl)?;
        } else {
            set_path_security(&path, sddl)?;
        }
    }
    Ok(())
}

fn set_path_security(path: &Path, sddl: &str) -> InstallationResult<()> {
    let sddl_wide = to_wide(std::ffi::OsStr::new(sddl));
    let mut descriptor = std::ptr::null_mut();
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_wide.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    };
    if converted == 0 {
        return Err(InstallationError::windows(
            "runtime-protection-failed",
            "protect-installation",
            "could not parse the runtime security descriptor",
            unsafe { windows_sys::Win32::Foundation::GetLastError() },
        ));
    }
    let allocation = LocalAllocation(descriptor);
    let owner = security_descriptor_owner(allocation.0).map_err(|_| {
        InstallationError::new(
            "runtime-protection-failed",
            "protect-installation",
            "runtime security descriptor did not contain an owner",
        )
    })?;
    let mut dacl = std::ptr::null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    if unsafe { GetSecurityDescriptorDacl(allocation.0, &mut present, &mut dacl, &mut defaulted) }
        == 0
        || present == 0
        || dacl.is_null()
    {
        return Err(InstallationError::new(
            "runtime-protection-failed",
            "protect-installation",
            "runtime security descriptor did not contain a DACL",
        ));
    }
    let mut path_wide = to_wide(path);
    let result = unsafe {
        SetNamedSecurityInfoW(
            path_wide.as_mut_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION
                | DACL_SECURITY_INFORMATION
                | PROTECTED_DACL_SECURITY_INFORMATION,
            owner,
            std::ptr::null_mut(),
            dacl as *mut c_void,
            std::ptr::null_mut(),
        )
    };
    if result != ERROR_SUCCESS {
        return Err(InstallationError::windows(
            "runtime-protection-failed",
            "protect-installation",
            format!("could not protect {}", path.display()),
            result,
        ));
    }
    Ok(())
}

pub(crate) fn reject_reparse(path: &Path) -> InstallationResult<()> {
    let wide = to_wide(path);
    let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
    if attributes == INVALID_FILE_ATTRIBUTES {
        return Err(InstallationError::windows(
            "runtime-protection-failed",
            "protect-installation",
            format!("could not inspect {}", path.display()),
            unsafe { windows_sys::Win32::Foundation::GetLastError() },
        ));
    }
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(InstallationError::new(
            "runtime-reparse-point-denied",
            "protect-installation",
            format!("runtime installation cannot traverse {}", path.display()),
        ));
    }
    Ok(())
}

fn to_wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        free_local(self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_dacl_verification_detects_a_changed_access_mask() {
        let temporary = tempfile::tempdir();
        assert!(temporary.is_ok());
        let Some(temporary) = temporary.ok() else {
            return;
        };
        let sid = crate::identity::current_user_sid();
        assert!(sid.is_ok());
        let Some(sid) = sid.ok() else {
            return;
        };
        let full_access = format!("O:{sid}D:P(A;OICI;FA;;;{sid})");
        let read_access = format!("O:{sid}D:P(A;OICI;FR;;;{sid})");

        assert!(set_path_security(temporary.path(), &full_access).is_ok());
        assert_eq!(
            path_matches_security_descriptor(temporary.path(), &full_access).ok(),
            Some(true)
        );
        assert_eq!(
            path_matches_security_descriptor(temporary.path(), &read_access).ok(),
            Some(false)
        );
    }
}
