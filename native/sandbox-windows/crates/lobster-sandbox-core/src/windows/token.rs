use std::ffi::c_void;

use windows_sys::Win32::Foundation::{
    ERROR_SUCCESS, GetLastError, HANDLE, HLOCAL, LocalFree, SetLastError,
};
use windows_sys::Win32::Security::Authorization::{
    EXPLICIT_ACCESS_W, GRANT_ACCESS, SetEntriesInAclW, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN,
    TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    ACL, AdjustTokenPrivileges, CopySid, CreateRestrictedToken, CreateWellKnownSid, EqualSid,
    GetLengthSid, GetTokenInformation, LookupPrivilegeValueW, SID_AND_ATTRIBUTES,
    TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_PRIVILEGES, TOKEN_ADJUST_SESSIONID, TOKEN_ASSIGN_PRIMARY,
    TOKEN_DUPLICATE, TOKEN_GROUPS, TOKEN_PRIVILEGES, TOKEN_QUERY, TOKEN_USER, TokenDefaultDacl,
    TokenGroups, TokenRestrictedSids, TokenUser, WinBuiltinAdministratorsSid, WinWorldSid,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

use crate::{SandboxError, SandboxResult};

use super::capability::CapabilitySid;
use super::handle::OwnedHandle;
use super::wide::to_wide;

const DISABLE_MAX_PRIVILEGE: u32 = 0x01;
const LUA_TOKEN: u32 = 0x04;
const WRITE_RESTRICTED: u32 = 0x08;
const GENERIC_ALL: u32 = 0x1000_0000;
const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_EXECUTE: u32 = 0x2000_0000;
const SE_PRIVILEGE_ENABLED: u32 = 0x0000_0002;
const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;

#[link(name = "advapi32")]
unsafe extern "system" {
    fn OpenProcessToken(
        process_handle: HANDLE,
        desired_access: u32,
        token_handle: *mut HANDLE,
    ) -> i32;
}

#[repr(C)]
struct TokenDefaultDaclInfo {
    default_dacl: *mut ACL,
}

pub struct RestrictedToken {
    handle: OwnedHandle,
}

pub struct TokenDiagnostics {
    pub restricted_sid_count: u32,
}

impl RestrictedToken {
    pub fn create(
        writable_capabilities: &[CapabilitySid],
        readable_capabilities: &[CapabilitySid],
    ) -> SandboxResult<Self> {
        if writable_capabilities.is_empty() && readable_capabilities.is_empty() {
            return Err(SandboxError::new(
                "token-create-failed",
                "create-token",
                "at least one capability SID is required",
            ));
        }
        let base = open_current_process_token()?;
        let admin_sid = well_known_sid(WinBuiltinAdministratorsSid)?;
        let mut logon_sid = get_logon_sid(base.raw())?;
        let mut world_sid = well_known_sid(WinWorldSid)?;
        let mut disabled = [SID_AND_ATTRIBUTES {
            Sid: admin_sid.as_ptr() as *mut c_void,
            Attributes: 0,
        }];
        let mut restricting = writable_capabilities
            .iter()
            .chain(readable_capabilities)
            .map(|capability| SID_AND_ATTRIBUTES {
                Sid: capability.as_ptr(),
                Attributes: 0,
            })
            .collect::<Vec<_>>();
        // The ephemeral logon SID is required for access to the interactive desktop and a small
        // set of per-logon kernel objects used by PowerShell. It is deliberately not the user's
        // account SID, Users, or Authenticated Users.
        restricting.push(SID_AND_ATTRIBUTES {
            Sid: logon_sid.as_mut_ptr() as *mut c_void,
            Attributes: 0,
        });
        // Windows PowerShell's CLR initialization also opens per-machine synchronization
        // objects whose DACL grants Everyone. The world SID is an OS compatibility SID only;
        // workspace authorization still comes from the per-root capability ACE. M1 tests cover
        // the important broad Users/Authenticated Users filesystem cases separately.
        restricting.push(SID_AND_ATTRIBUTES {
            Sid: world_sid.as_mut_ptr() as *mut c_void,
            Attributes: 0,
        });
        let mut restricted_handle = 0;
        let created = unsafe {
            CreateRestrictedToken(
                base.raw(),
                DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
                disabled.len() as u32,
                disabled.as_mut_ptr(),
                0,
                std::ptr::null_mut(),
                restricting.len() as u32,
                restricting.as_mut_ptr(),
                &mut restricted_handle,
            )
        };
        if created == 0 {
            return Err(SandboxError::windows(
                "token-create-failed",
                "create-token",
                "CreateRestrictedToken failed",
                unsafe { GetLastError() },
            ));
        }
        let handle = OwnedHandle::new(
            restricted_handle,
            "token-create-failed",
            "create-token",
            "CreateRestrictedToken returned an invalid handle",
        )?;
        set_default_dacl(handle.raw(), writable_capabilities, readable_capabilities)?;
        enable_traverse_privilege(handle.raw())?;
        Ok(Self { handle })
    }

    pub fn raw(&self) -> HANDLE {
        self.handle.raw()
    }

    pub fn diagnostics(
        &self,
        writable_capabilities: &[CapabilitySid],
        readable_capabilities: &[CapabilitySid],
    ) -> SandboxResult<TokenDiagnostics> {
        let groups = token_information(self.raw(), TokenRestrictedSids)?;
        let token_groups = unsafe { &*(groups.as_ptr() as *const TOKEN_GROUPS) };
        let count = token_groups.GroupCount;
        for capability in writable_capabilities.iter().chain(readable_capabilities) {
            let present = (0..count as usize).any(|index| {
                let entry = unsafe { token_groups.Groups.as_ptr().add(index).read() };
                unsafe { EqualSid(entry.Sid, capability.as_ptr()) != 0 }
            });
            if !present {
                return Err(SandboxError::new(
                    "token-verification-failed",
                    "verify-token",
                    format!(
                        "restricted token is missing capability {}",
                        capability.text()
                    ),
                ));
            }
        }
        Ok(TokenDiagnostics {
            restricted_sid_count: count,
        })
    }
}

fn open_current_process_token() -> SandboxResult<OwnedHandle> {
    let desired_access = TOKEN_DUPLICATE
        | TOKEN_QUERY
        | TOKEN_ASSIGN_PRIMARY
        | TOKEN_ADJUST_DEFAULT
        | TOKEN_ADJUST_SESSIONID
        | TOKEN_ADJUST_PRIVILEGES;
    let mut handle = 0;
    let opened = unsafe { OpenProcessToken(GetCurrentProcess(), desired_access, &mut handle) };
    if opened == 0 {
        return Err(SandboxError::windows(
            "token-open-failed",
            "create-token",
            "OpenProcessToken failed",
            unsafe { GetLastError() },
        ));
    }
    OwnedHandle::new(
        handle,
        "token-open-failed",
        "create-token",
        "OpenProcessToken returned an invalid handle",
    )
}

fn well_known_sid(kind: i32) -> SandboxResult<Vec<u8>> {
    let mut size = 0;
    unsafe {
        CreateWellKnownSid(kind, std::ptr::null_mut(), std::ptr::null_mut(), &mut size);
    }
    if size == 0 {
        return Err(SandboxError::windows(
            "token-create-failed",
            "create-token",
            "could not determine well-known SID size",
            unsafe { GetLastError() },
        ));
    }
    let mut sid = vec![0u8; size as usize];
    let created = unsafe {
        CreateWellKnownSid(
            kind,
            std::ptr::null_mut(),
            sid.as_mut_ptr() as *mut c_void,
            &mut size,
        )
    };
    if created == 0 {
        return Err(SandboxError::windows(
            "token-create-failed",
            "create-token",
            "CreateWellKnownSid failed",
            unsafe { GetLastError() },
        ));
    }
    Ok(sid)
}

fn set_default_dacl(
    token: HANDLE,
    writable_capabilities: &[CapabilitySid],
    readable_capabilities: &[CapabilitySid],
) -> SandboxResult<()> {
    let user_buffer = token_information(token, TokenUser)?;
    let token_user = unsafe { &*(user_buffer.as_ptr() as *const TOKEN_USER) };
    let mut logon_sid = get_logon_sid(token)?;
    let mut trustees =
        Vec::with_capacity(writable_capabilities.len() + readable_capabilities.len() + 2);
    trustees.push((token_user.User.Sid, GENERIC_ALL));
    trustees.push((logon_sid.as_mut_ptr() as *mut c_void, GENERIC_ALL));
    trustees.extend(
        writable_capabilities
            .iter()
            .map(|capability| (capability.as_ptr(), GENERIC_ALL)),
    );
    trustees.extend(
        readable_capabilities
            .iter()
            .map(|capability| (capability.as_ptr(), GENERIC_READ | GENERIC_EXECUTE)),
    );
    let mut entries = trustees
        .into_iter()
        .map(|(sid, access)| EXPLICIT_ACCESS_W {
            grfAccessPermissions: access,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: 0,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid as *mut u16,
            },
        })
        .collect::<Vec<_>>();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let result = unsafe {
        SetEntriesInAclW(
            entries.len() as u32,
            entries.as_mut_ptr(),
            std::ptr::null_mut(),
            &mut dacl,
        )
    };
    if result != ERROR_SUCCESS {
        return Err(SandboxError::windows(
            "token-default-dacl-failed",
            "create-token",
            "SetEntriesInAclW failed for token default DACL",
            result,
        ));
    }
    let _dacl = LocalAllocation(dacl as *mut c_void);
    let mut info = TokenDefaultDaclInfo { default_dacl: dacl };
    let updated = unsafe {
        windows_sys::Win32::Security::SetTokenInformation(
            token,
            TokenDefaultDacl,
            &mut info as *mut _ as *mut c_void,
            std::mem::size_of::<TokenDefaultDaclInfo>() as u32,
        )
    };
    if updated == 0 {
        return Err(SandboxError::windows(
            "token-default-dacl-failed",
            "create-token",
            "SetTokenInformation(TokenDefaultDacl) failed",
            unsafe { GetLastError() },
        ));
    }
    Ok(())
}

fn get_logon_sid(token: HANDLE) -> SandboxResult<Vec<u8>> {
    let groups_buffer = token_information(token, TokenGroups)?;
    let groups = unsafe { &*(groups_buffer.as_ptr() as *const TOKEN_GROUPS) };
    for index in 0..groups.GroupCount as usize {
        let entry = unsafe { groups.Groups.as_ptr().add(index).read() };
        if entry.Attributes & SE_GROUP_LOGON_ID == SE_GROUP_LOGON_ID {
            let length = unsafe { GetLengthSid(entry.Sid) };
            if length == 0 {
                break;
            }
            let mut sid = vec![0u8; length as usize];
            let copied = unsafe { CopySid(length, sid.as_mut_ptr() as *mut c_void, entry.Sid) };
            if copied != 0 {
                return Ok(sid);
            }
            break;
        }
    }
    Err(SandboxError::new(
        "token-logon-sid-missing",
        "create-token",
        "current token does not contain a logon SID",
    ))
}

fn enable_traverse_privilege(token: HANDLE) -> SandboxResult<()> {
    let privilege_name = to_wide("SeChangeNotifyPrivilege");
    let mut privileges: TOKEN_PRIVILEGES = unsafe { std::mem::zeroed() };
    let looked_up = unsafe {
        LookupPrivilegeValueW(
            std::ptr::null(),
            privilege_name.as_ptr(),
            &mut privileges.Privileges[0].Luid,
        )
    };
    if looked_up == 0 {
        return Err(SandboxError::windows(
            "token-privilege-failed",
            "create-token",
            "LookupPrivilegeValueW failed for SeChangeNotifyPrivilege",
            unsafe { GetLastError() },
        ));
    }
    privileges.PrivilegeCount = 1;
    privileges.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
    unsafe {
        SetLastError(ERROR_SUCCESS);
    }
    let adjusted = unsafe {
        AdjustTokenPrivileges(
            token,
            0,
            &privileges,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    let last_error = unsafe { GetLastError() };
    if adjusted == 0 || last_error != ERROR_SUCCESS {
        return Err(SandboxError::windows(
            "token-privilege-failed",
            "create-token",
            "could not enable SeChangeNotifyPrivilege on restricted token",
            last_error,
        ));
    }
    Ok(())
}

fn token_information(token: HANDLE, class: i32) -> SandboxResult<Vec<usize>> {
    let mut required = 0;
    unsafe {
        GetTokenInformation(token, class, std::ptr::null_mut(), 0, &mut required);
    }
    if required == 0 {
        return Err(SandboxError::windows(
            "token-query-failed",
            "verify-token",
            "GetTokenInformation did not return a buffer size",
            unsafe { GetLastError() },
        ));
    }
    let word_size = std::mem::size_of::<usize>();
    let mut buffer = vec![0usize; (required as usize).div_ceil(word_size)];
    let queried = unsafe {
        GetTokenInformation(
            token,
            class,
            buffer.as_mut_ptr() as *mut c_void,
            required,
            &mut required,
        )
    };
    if queried == 0 {
        return Err(SandboxError::windows(
            "token-query-failed",
            "verify-token",
            "GetTokenInformation failed",
            unsafe { GetLastError() },
        ));
    }
    Ok(buffer)
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
