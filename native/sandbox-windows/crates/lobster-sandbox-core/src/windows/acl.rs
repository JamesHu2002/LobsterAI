use std::ffi::c_void;
use std::path::Path;

use windows_sys::Win32::Foundation::{ERROR_SUCCESS, HLOCAL, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    EXPLICIT_ACCESS_W, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW,
    TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    ACL, DACL_SECURITY_INFORMATION, GetLengthSid, OWNER_SECURITY_INFORMATION,
};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_APPEND_DATA, FILE_DELETE_CHILD, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ,
    FILE_GENERIC_WRITE, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, FILE_WRITE_EA, WRITE_DAC,
    WRITE_OWNER,
};

use crate::{SandboxError, SandboxResult};

use super::capability::CapabilitySid;
use super::path_policy::PreparedPolicy;
use super::wide::to_wide;

const SE_FILE_OBJECT: i32 = 1;
const SET_ACCESS: i32 = 2;
const DENY_ACCESS: i32 = 3;
const REVOKE_ACCESS: i32 = 4;
const SUB_CONTAINERS_AND_OBJECTS_INHERIT: u32 = 0x3;

const WORKSPACE_ACCESS_MASK: u32 =
    FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE;
const READ_ROOT_ACCESS_MASK: u32 = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
const PROTECTED_WRITE_MASK: u32 = FILE_WRITE_DATA
    | FILE_APPEND_DATA
    | FILE_WRITE_EA
    | FILE_WRITE_ATTRIBUTES
    | DELETE
    | FILE_DELETE_CHILD
    | WRITE_DAC
    | WRITE_OWNER;

pub fn apply_policy_acl(
    policy: &PreparedPolicy,
    writable_capabilities: &[CapabilitySid],
    readable_capabilities: &[CapabilitySid],
) -> SandboxResult<()> {
    if policy.writable_roots.len() != writable_capabilities.len()
        || policy.readable_roots.len() != readable_capabilities.len()
    {
        return Err(SandboxError::new(
            "acl-prepare-failed",
            "prepare-acl",
            "writable root and capability counts do not match",
        ));
    }

    for (root, capability) in policy.writable_roots.iter().zip(writable_capabilities) {
        mutate_acl(
            root,
            capability,
            SET_ACCESS,
            WORKSPACE_ACCESS_MASK,
            SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        )?;
    }
    for (root, capability) in policy.readable_roots.iter().zip(readable_capabilities) {
        mutate_acl(
            root,
            capability,
            SET_ACCESS,
            READ_ROOT_ACCESS_MASK,
            SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        )?;
    }
    for protected_path in &policy.protected_paths {
        for capability in writable_capabilities.iter().chain(readable_capabilities) {
            // DENY_ACCESS appends by design. Revoke a prior explicit Lobster ACE first so repeated
            // command preparation stays idempotent while inherited root grants remain intact.
            mutate_acl(protected_path, capability, REVOKE_ACCESS, 0, 0)?;
            mutate_acl(
                protected_path,
                capability,
                DENY_ACCESS,
                PROTECTED_WRITE_MASK,
                SUB_CONTAINERS_AND_OBJECTS_INHERIT,
            )?;
        }
    }
    Ok(())
}

pub fn revoke_policy_acl(
    policy: &PreparedPolicy,
    writable_capabilities: &[CapabilitySid],
    readable_capabilities: &[CapabilitySid],
) -> SandboxResult<()> {
    for protected_path in &policy.protected_paths {
        for capability in writable_capabilities.iter().chain(readable_capabilities) {
            mutate_acl(protected_path, capability, REVOKE_ACCESS, 0, 0)?;
        }
    }
    for (root, capability) in policy.readable_roots.iter().zip(readable_capabilities) {
        mutate_acl(root, capability, REVOKE_ACCESS, 0, 0)?;
    }
    for (root, capability) in policy.writable_roots.iter().zip(writable_capabilities) {
        mutate_acl(root, capability, REVOKE_ACCESS, 0, 0)?;
    }
    Ok(())
}

fn mutate_acl(
    path: &Path,
    capability: &CapabilitySid,
    access_mode: i32,
    access_mask: u32,
    inheritance: u32,
) -> SandboxResult<()> {
    let mut path_wide = to_wide(path.as_os_str());
    let mut owner = std::ptr::null_mut();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut security_descriptor = std::ptr::null_mut();
    let query_result = unsafe {
        GetNamedSecurityInfoW(
            path_wide.as_mut_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut security_descriptor,
        )
    };
    if query_result != ERROR_SUCCESS {
        return Err(SandboxError::windows(
            "acl-query-failed",
            "prepare-acl",
            format!("could not read ACL for {}", path.display()),
            query_result,
        ));
    }
    let _security_descriptor = LocalAllocation(security_descriptor);
    let owner_before = copy_sid(owner)?;

    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: access_mask,
        grfAccessMode: access_mode,
        grfInheritance: inheritance,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: 0,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: capability.as_ptr() as *mut u16,
        },
    };
    let mut new_dacl: *mut ACL = std::ptr::null_mut();
    let acl_result = unsafe { SetEntriesInAclW(1, &entry, dacl, &mut new_dacl) };
    if acl_result != ERROR_SUCCESS {
        return Err(SandboxError::windows(
            "acl-prepare-failed",
            "prepare-acl",
            format!("could not prepare ACL for {}", path.display()),
            acl_result,
        ));
    }
    let _new_dacl = LocalAllocation(new_dacl as *mut c_void);
    let set_result = unsafe {
        SetNamedSecurityInfoW(
            path_wide.as_mut_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            new_dacl,
            std::ptr::null_mut(),
        )
    };
    if set_result != ERROR_SUCCESS {
        return Err(SandboxError::windows(
            "acl-prepare-failed",
            "prepare-acl",
            format!("could not update ACL for {}", path.display()),
            set_result,
        ));
    }

    let owner_after = query_owner(path)?;
    if owner_before != owner_after {
        return Err(SandboxError::new(
            "owner-changed",
            "prepare-acl",
            format!("ACL preparation changed the owner of {}", path.display()),
        ));
    }
    Ok(())
}

fn query_owner(path: &Path) -> SandboxResult<Vec<u8>> {
    let mut path_wide = to_wide(path.as_os_str());
    let mut owner = std::ptr::null_mut();
    let mut security_descriptor = std::ptr::null_mut();
    let result = unsafe {
        GetNamedSecurityInfoW(
            path_wide.as_mut_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut security_descriptor,
        )
    };
    if result != ERROR_SUCCESS {
        return Err(SandboxError::windows(
            "acl-query-failed",
            "prepare-acl",
            format!("could not verify owner for {}", path.display()),
            result,
        ));
    }
    let _security_descriptor = LocalAllocation(security_descriptor);
    copy_sid(owner)
}

fn copy_sid(sid: *mut c_void) -> SandboxResult<Vec<u8>> {
    if sid.is_null() {
        return Err(SandboxError::new(
            "acl-query-failed",
            "prepare-acl",
            "security descriptor did not contain an owner SID",
        ));
    }
    let length = unsafe { GetLengthSid(sid) };
    if length == 0 {
        let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        return Err(SandboxError::windows(
            "acl-query-failed",
            "prepare-acl",
            "could not measure owner SID",
            error,
        ));
    }
    let bytes = unsafe { std::slice::from_raw_parts(sid as *const u8, length as usize) };
    Ok(bytes.to_vec())
}

struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0 as HLOCAL);
            }
        }
    }
}
