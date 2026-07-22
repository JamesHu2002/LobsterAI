use std::ffi::{OsStr, c_void};
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows_sys::Win32::Foundation::{
    ERROR_MEMBER_IN_ALIAS, ERROR_MORE_DATA, GetLastError, HLOCAL, LocalFree,
};
use windows_sys::Win32::NetworkManagement::NetManagement::{
    LOCALGROUP_MEMBERS_INFO_0, MAX_PREFERRED_LENGTH, NERR_Success, NERR_UserExists,
    NERR_UserNotFound, NetApiBufferFree, NetLocalGroupAddMembers, NetLocalGroupGetMembers,
    NetUserAdd, NetUserDel, NetUserGetInfo, NetUserSetInfo, UF_ACCOUNTDISABLE,
    UF_DONT_EXPIRE_PASSWD, UF_ENCRYPTED_TEXT_PASSWORD_ALLOWED, UF_LOCKOUT, UF_NORMAL_ACCOUNT,
    UF_PASSWD_NOTREQD, UF_SCRIPT, UF_TRUSTED_FOR_DELEGATION,
    UF_TRUSTED_TO_AUTHENTICATE_FOR_DELEGATION, USER_INFO_1, USER_INFO_1003, USER_INFO_1008,
    USER_PRIV_USER,
};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
use windows_sys::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
    CryptUnprotectData,
};
use windows_sys::Win32::Security::{
    EqualSid, GetLengthSid, GetTokenInformation, IsValidSid, LookupAccountNameW, LookupAccountSidW,
    SID_NAME_USE, SidTypeAlias, SidTypeUser, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

use crate::error::{InstallationError, InstallationResult};
use crate::model::{CredentialsFile, SANDBOX_ACCOUNT_NAME, SETUP_SCHEMA_VERSION};

const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
const WINDOWS_LOCAL_ACCOUNT_NAME_MAX_UTF16_UNITS: usize = 20;
const SID_BUILTIN_USERS: &str = "S-1-5-32-545";

#[link(name = "advapi32")]
unsafe extern "system" {
    fn OpenProcessToken(
        process_handle: isize,
        desired_access: u32,
        token_handle: *mut isize,
    ) -> i32;
    #[link_name = "SystemFunction036"]
    fn rtl_gen_random(buffer: *mut c_void, length: u32) -> u8;
}

pub struct ProvisionedIdentity {
    pub account_name: String,
    pub account_sid: String,
    pub password: SecretPassword,
}

pub struct SecretPassword(Vec<u8>);

impl SecretPassword {
    pub fn from_utf8(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    pub fn as_str(&self) -> InstallationResult<&str> {
        std::str::from_utf8(&self.0).map_err(|error| {
            InstallationError::new(
                "sandbox-credentials-invalid",
                "load-identity",
                format!("sandbox password is not UTF-8: {error}"),
            )
        })
    }
}

impl Drop for SecretPassword {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

pub fn current_user_sid() -> InstallationResult<String> {
    let mut token = 0;
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(InstallationError::windows(
            "setup-caller-identity-failed",
            "resolve-caller",
            "OpenProcessToken failed",
            unsafe { GetLastError() },
        ));
    }
    let token = TokenHandle(token);
    let mut required = 0;
    unsafe {
        GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut required);
    }
    if required == 0 {
        return Err(InstallationError::windows(
            "setup-caller-identity-failed",
            "resolve-caller",
            "GetTokenInformation did not report a size",
            unsafe { GetLastError() },
        ));
    }
    let word = std::mem::size_of::<usize>();
    let mut buffer = vec![0usize; (required as usize).div_ceil(word)];
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
            "setup-caller-identity-failed",
            "resolve-caller",
            "GetTokenInformation(TokenUser) failed",
            unsafe { GetLastError() },
        ));
    }
    let user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
    sid_to_string(user.User.Sid)
}

pub fn ensure_setup_caller_authorized() -> InstallationResult<()> {
    let caller_sid = current_user_sid()?;
    let Some(_) = query_local_user(SANDBOX_ACCOUNT_NAME)? else {
        return Ok(());
    };
    let account_sid = resolve_account_sid(SANDBOX_ACCOUNT_NAME)?;
    if caller_sid == account_sid {
        Err(InstallationError::new(
            "setup-caller-not-authorized",
            "resolve-caller",
            "the managed sandbox identity cannot invoke setup operations",
        ))
    } else {
        Ok(())
    }
}

pub fn validate_setup_owner_sid(owner_sid: &str) -> InstallationResult<String> {
    let owner_wide = to_wide(owner_sid);
    let mut sid = std::ptr::null_mut();
    if unsafe { ConvertStringSidToSidW(owner_wide.as_ptr(), &mut sid) } == 0 || sid.is_null() {
        return Err(InstallationError::windows(
            "setup-owner-invalid",
            "resolve-caller",
            "the setup owner SID is invalid",
            unsafe { GetLastError() },
        ));
    }
    let sid = LocalSid(sid);
    if unsafe { IsValidSid(sid.0) } == 0 {
        return Err(InstallationError::new(
            "setup-owner-invalid",
            "resolve-caller",
            "the setup owner SID is not a valid Windows SID",
        ));
    }
    let canonical_sid = sid_to_string(sid.0)?;
    let mut name_length = 0;
    let mut domain_length = 0;
    let mut sid_use: SID_NAME_USE = 0;
    unsafe {
        LookupAccountSidW(
            std::ptr::null(),
            sid.0,
            std::ptr::null_mut(),
            &mut name_length,
            std::ptr::null_mut(),
            &mut domain_length,
            &mut sid_use,
        );
    }
    if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER || name_length == 0 {
        return Err(InstallationError::windows(
            "setup-owner-invalid",
            "resolve-caller",
            "the setup owner SID does not resolve to an account",
            unsafe { GetLastError() },
        ));
    }
    let mut name = vec![0u16; name_length as usize];
    let mut domain = vec![0u16; domain_length as usize];
    if unsafe {
        LookupAccountSidW(
            std::ptr::null(),
            sid.0,
            name.as_mut_ptr(),
            &mut name_length,
            domain.as_mut_ptr(),
            &mut domain_length,
            &mut sid_use,
        )
    } == 0
    {
        return Err(InstallationError::windows(
            "setup-owner-invalid",
            "resolve-caller",
            "the setup owner SID could not be resolved",
            unsafe { GetLastError() },
        ));
    }
    if sid_use != SidTypeUser {
        return Err(InstallationError::new(
            "setup-owner-invalid",
            "resolve-caller",
            "the setup owner SID must identify a Windows user account",
        ));
    }
    if resolve_account_sid(SANDBOX_ACCOUNT_NAME)
        .is_ok_and(|sandbox_sid| sandbox_sid == canonical_sid)
    {
        return Err(InstallationError::new(
            "setup-caller-not-authorized",
            "resolve-caller",
            "the managed sandbox identity cannot own or invoke setup operations",
        ));
    }
    Ok(canonical_sid)
}

pub fn resolve_account_sid(name: &str) -> InstallationResult<String> {
    let name_wide = to_wide(name);
    let mut sid_length = 0;
    let mut domain_length = 0;
    let mut sid_use: SID_NAME_USE = 0;
    unsafe {
        LookupAccountNameW(
            std::ptr::null(),
            name_wide.as_ptr(),
            std::ptr::null_mut(),
            &mut sid_length,
            std::ptr::null_mut(),
            &mut domain_length,
            &mut sid_use,
        );
    }
    if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER || sid_length == 0 {
        return Err(InstallationError::windows(
            "sandbox-identity-missing",
            "verify-identity",
            format!("could not resolve local account {name}"),
            unsafe { GetLastError() },
        ));
    }
    let mut sid = vec![0u8; sid_length as usize];
    let mut domain = vec![0u16; domain_length as usize];
    if unsafe {
        LookupAccountNameW(
            std::ptr::null(),
            name_wide.as_ptr(),
            sid.as_mut_ptr() as *mut c_void,
            &mut sid_length,
            domain.as_mut_ptr(),
            &mut domain_length,
            &mut sid_use,
        )
    } == 0
    {
        return Err(InstallationError::windows(
            "sandbox-identity-missing",
            "verify-identity",
            format!("could not resolve local account {name}"),
            unsafe { GetLastError() },
        ));
    }
    sid_to_string(sid.as_mut_ptr() as *mut c_void)
}

pub fn ensure_sandbox_identity(credentials_path: &Path) -> InstallationResult<ProvisionedIdentity> {
    let reusable = read_credentials(credentials_path)
        .ok()
        .and_then(|credentials| {
            if credentials.account_name != SANDBOX_ACCOUNT_NAME {
                return None;
            }
            let password = decrypt_password(&credentials).ok()?;
            resolve_account_sid(SANDBOX_ACCOUNT_NAME).ok()?;
            Some(password)
        });
    let password = match reusable {
        Some(password) => password,
        None => generate_password()?,
    };
    ensure_local_user(SANDBOX_ACCOUNT_NAME, password.as_str()?)?;
    ensure_identity_configuration(SANDBOX_ACCOUNT_NAME)?;
    let account_sid = resolve_account_sid(SANDBOX_ACCOUNT_NAME)?;
    write_credentials(credentials_path, SANDBOX_ACCOUNT_NAME, &password)?;
    Ok(ProvisionedIdentity {
        account_name: SANDBOX_ACCOUNT_NAME.to_string(),
        account_sid,
        password,
    })
}

pub fn load_sandbox_identity(credentials_path: &Path) -> InstallationResult<ProvisionedIdentity> {
    let credentials = read_credentials(credentials_path)?;
    if credentials.schema_version != SETUP_SCHEMA_VERSION
        || credentials.account_name != SANDBOX_ACCOUNT_NAME
    {
        return Err(InstallationError::new(
            "sandbox-credentials-invalid",
            "load-identity",
            "sandbox credentials have an incompatible schema or account",
        ));
    }
    ensure_identity_configuration(&credentials.account_name)?;
    let password = decrypt_password(&credentials)?;
    let account_sid = resolve_account_sid(&credentials.account_name)?;
    Ok(ProvisionedIdentity {
        account_name: credentials.account_name,
        account_sid,
        password,
    })
}

pub fn delete_sandbox_identity() -> InstallationResult<()> {
    let name = to_wide(SANDBOX_ACCOUNT_NAME);
    let status = unsafe { NetUserDel(std::ptr::null(), name.as_ptr()) };
    if status != NERR_Success && status != NERR_UserNotFound {
        return Err(InstallationError::windows(
            "sandbox-identity-delete-failed",
            "uninstall-identity",
            "NetUserDel failed",
            status,
        ));
    }
    Ok(())
}

pub fn free_local(value: *mut c_void) {
    if !value.is_null() {
        unsafe {
            LocalFree(value as HLOCAL);
        }
    }
}

fn ensure_local_user(name: &str, password: &str) -> InstallationResult<()> {
    validate_local_user_name(name)?;
    let name_wide = to_wide(name);
    let password_wide = to_wide(password);
    let info = USER_INFO_1 {
        usri1_name: name_wide.as_ptr() as *mut u16,
        usri1_password: password_wide.as_ptr() as *mut u16,
        usri1_password_age: 0,
        usri1_priv: USER_PRIV_USER,
        usri1_home_dir: std::ptr::null_mut(),
        usri1_comment: std::ptr::null_mut(),
        usri1_flags: sandbox_account_flags(),
        usri1_script_path: std::ptr::null_mut(),
    };
    let status = unsafe {
        NetUserAdd(
            std::ptr::null(),
            1,
            &info as *const _ as *mut u8,
            std::ptr::null_mut(),
        )
    };
    let disposition = classify_user_add_status(status, name)?;
    if disposition == UserAddDisposition::UpdateExisting {
        let password_info = USER_INFO_1003 {
            usri1003_password: password_wide.as_ptr() as *mut u16,
        };
        let updated = unsafe {
            NetUserSetInfo(
                std::ptr::null(),
                name_wide.as_ptr(),
                1003,
                &password_info as *const _ as *mut u8,
                std::ptr::null_mut(),
            )
        };
        if updated != NERR_Success {
            return Err(InstallationError::windows(
                "sandbox-identity-create-failed",
                "provision-identity",
                format!("could not update the password for {name}"),
                updated,
            ));
        }
    }
    ensure_local_group_member(SID_BUILTIN_USERS, name)?;
    let flags = USER_INFO_1008 {
        usri1008_flags: sandbox_account_flags(),
    };
    let flags_updated = unsafe {
        NetUserSetInfo(
            std::ptr::null(),
            name_wide.as_ptr(),
            1008,
            &flags as *const _ as *mut u8,
            std::ptr::null_mut(),
        )
    };
    if flags_updated != NERR_Success {
        return Err(InstallationError::windows(
            "sandbox-identity-create-failed",
            "provision-identity",
            format!("could not secure account flags for {name}"),
            flags_updated,
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UserAddDisposition {
    Created,
    UpdateExisting,
}

fn classify_user_add_status(status: u32, name: &str) -> InstallationResult<UserAddDisposition> {
    if status == NERR_Success {
        return Ok(UserAddDisposition::Created);
    }
    if status == NERR_UserExists {
        return Ok(UserAddDisposition::UpdateExisting);
    }
    Err(InstallationError::windows(
        "sandbox-identity-create-failed",
        "provision-identity",
        format!("could not create {name}"),
        status,
    ))
}

fn validate_local_user_name(name: &str) -> InstallationResult<()> {
    let length = name.encode_utf16().count();
    if name.is_empty() || length > WINDOWS_LOCAL_ACCOUNT_NAME_MAX_UTF16_UNITS {
        return Err(InstallationError::new(
            "sandbox-identity-name-invalid",
            "provision-identity",
            format!(
                "managed local account name must contain 1 to {} UTF-16 code units",
                WINDOWS_LOCAL_ACCOUNT_NAME_MAX_UTF16_UNITS
            ),
        ));
    }
    Ok(())
}

fn sandbox_account_flags() -> u32 {
    UF_SCRIPT | UF_NORMAL_ACCOUNT | UF_DONT_EXPIRE_PASSWD
}

fn ensure_local_group_member(group_sid: &str, member_name: &str) -> InstallationResult<()> {
    let group_name = resolve_local_alias_name(group_sid)?;
    let member_sid = resolve_account_sid(member_name)?;
    let member_sid_wide = to_wide(&member_sid);
    let mut member_sid_pointer = std::ptr::null_mut();
    if unsafe { ConvertStringSidToSidW(member_sid_wide.as_ptr(), &mut member_sid_pointer) } == 0
        || member_sid_pointer.is_null()
    {
        return Err(InstallationError::windows(
            "sandbox-identity-group-update-failed",
            "provision-identity",
            format!("could not parse the SID for managed account {member_name}"),
            unsafe { GetLastError() },
        ));
    }
    let member_sid_pointer = LocalSid(member_sid_pointer);
    let member = LOCALGROUP_MEMBERS_INFO_0 {
        lgrmi0_sid: member_sid_pointer.0,
    };
    let group_name_wide = to_wide(&group_name);
    let status = unsafe {
        NetLocalGroupAddMembers(
            std::ptr::null(),
            group_name_wide.as_ptr(),
            0,
            &member as *const _ as *const u8,
            1,
        )
    };
    classify_local_group_add_status(status, member_name, &group_name)
}

fn classify_local_group_add_status(
    status: u32,
    member_name: &str,
    group_name: &str,
) -> InstallationResult<()> {
    if status == NERR_Success || status == ERROR_MEMBER_IN_ALIAS {
        return Ok(());
    }
    Err(InstallationError::windows(
        "sandbox-identity-group-update-failed",
        "provision-identity",
        format!("could not add managed account {member_name} to local group {group_name}"),
        status,
    ))
}

fn resolve_local_alias_name(alias_sid: &str) -> InstallationResult<String> {
    let sid_wide = to_wide(alias_sid);
    let mut sid = std::ptr::null_mut();
    if unsafe { ConvertStringSidToSidW(sid_wide.as_ptr(), &mut sid) } == 0 || sid.is_null() {
        return Err(InstallationError::windows(
            "sandbox-identity-group-resolution-failed",
            "verify-identity",
            format!("could not parse local group SID {alias_sid}"),
            unsafe { GetLastError() },
        ));
    }
    let sid = LocalSid(sid);
    let mut name_length = 0;
    let mut domain_length = 0;
    let mut sid_use: SID_NAME_USE = 0;
    unsafe {
        LookupAccountSidW(
            std::ptr::null(),
            sid.0,
            std::ptr::null_mut(),
            &mut name_length,
            std::ptr::null_mut(),
            &mut domain_length,
            &mut sid_use,
        );
    }
    if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER || name_length == 0 {
        return Err(InstallationError::windows(
            "sandbox-identity-group-resolution-failed",
            "verify-identity",
            format!("local group SID {alias_sid} did not resolve to an account"),
            unsafe { GetLastError() },
        ));
    }
    let mut name = vec![0u16; name_length as usize];
    let mut domain = vec![0u16; domain_length as usize];
    if unsafe {
        LookupAccountSidW(
            std::ptr::null(),
            sid.0,
            name.as_mut_ptr(),
            &mut name_length,
            domain.as_mut_ptr(),
            &mut domain_length,
            &mut sid_use,
        )
    } == 0
    {
        return Err(InstallationError::windows(
            "sandbox-identity-group-resolution-failed",
            "verify-identity",
            format!("could not resolve the local group name for SID {alias_sid}"),
            unsafe { GetLastError() },
        ));
    }
    if sid_use != SidTypeAlias {
        return Err(InstallationError::new(
            "sandbox-identity-group-resolution-failed",
            "verify-identity",
            format!("SID {alias_sid} did not resolve to a local alias"),
        ));
    }
    let end = name
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(name.len());
    Ok(String::from_utf16_lossy(&name[..end]))
}

fn is_local_group_member(group_sid: &str, member_name: &str) -> InstallationResult<bool> {
    let group_name = resolve_local_alias_name(group_sid)?;
    let member_sid = resolve_account_sid(member_name)?;
    let member_sid_wide = to_wide(&member_sid);
    let mut member_sid_pointer = std::ptr::null_mut();
    if unsafe { ConvertStringSidToSidW(member_sid_wide.as_ptr(), &mut member_sid_pointer) } == 0
        || member_sid_pointer.is_null()
    {
        return Err(InstallationError::windows(
            "sandbox-identity-group-query-failed",
            "verify-identity",
            format!("could not parse the SID for managed account {member_name}"),
            unsafe { GetLastError() },
        ));
    }
    let member_sid_pointer = LocalSid(member_sid_pointer);
    let group_name_wide = to_wide(&group_name);
    let mut resume_handle = 0usize;
    loop {
        let mut buffer = std::ptr::null_mut();
        let mut entries_read = 0;
        let mut total_entries = 0;
        let status = unsafe {
            NetLocalGroupGetMembers(
                std::ptr::null(),
                group_name_wide.as_ptr(),
                0,
                &mut buffer,
                MAX_PREFERRED_LENGTH,
                &mut entries_read,
                &mut total_entries,
                &mut resume_handle,
            )
        };
        if status != NERR_Success && status != ERROR_MORE_DATA {
            return Err(InstallationError::windows(
                "sandbox-identity-group-query-failed",
                "verify-identity",
                format!("could not enumerate local group {group_name}"),
                status,
            ));
        }
        let buffer = NetApiBuffer(buffer);
        if !buffer.0.is_null() {
            let members = unsafe {
                std::slice::from_raw_parts(
                    buffer.0 as *const LOCALGROUP_MEMBERS_INFO_0,
                    entries_read as usize,
                )
            };
            if members
                .iter()
                .any(|member| unsafe { EqualSid(member.lgrmi0_sid, member_sid_pointer.0) != 0 })
            {
                return Ok(true);
            }
        }
        if status == NERR_Success {
            return Ok(false);
        }
    }
}

fn ensure_identity_configuration(name: &str) -> InstallationResult<()> {
    let Some(info) = query_local_user(name)? else {
        return Err(InstallationError::new(
            "sandbox-identity-missing",
            "verify-identity",
            format!("managed local account {name} is missing"),
        ));
    };
    let users_group_member = is_local_group_member(SID_BUILTIN_USERS, name)?;
    validate_local_user_configuration(&info, users_group_member)
}

fn validate_local_user_configuration(
    info: &LocalUserConfiguration,
    users_group_member: bool,
) -> InstallationResult<()> {
    let required = sandbox_account_flags();
    let forbidden = UF_ACCOUNTDISABLE
        | UF_LOCKOUT
        | UF_PASSWD_NOTREQD
        | UF_ENCRYPTED_TEXT_PASSWORD_ALLOWED
        | UF_TRUSTED_FOR_DELEGATION
        | UF_TRUSTED_TO_AUTHENTICATE_FOR_DELEGATION;
    let missing = required & !info.flags;
    let forbidden_present = forbidden & info.flags;
    if !users_group_member || missing != 0 || forbidden_present != 0 {
        return Err(InstallationError::new(
            "sandbox-identity-configuration-invalid",
            "verify-identity",
            format!(
                "managed sandbox account is not hardened: usersGroupMember={users_group_member}, reportedPrivilege={}, flags=0x{:08x}, missing=0x{missing:08x}, forbidden=0x{forbidden_present:08x}",
                info.privilege, info.flags,
            ),
        ));
    }
    Ok(())
}

fn query_local_user(name: &str) -> InstallationResult<Option<LocalUserConfiguration>> {
    let name = to_wide(name);
    let mut buffer = std::ptr::null_mut();
    let status = unsafe { NetUserGetInfo(std::ptr::null(), name.as_ptr(), 1, &mut buffer) };
    if status == NERR_UserNotFound {
        return Ok(None);
    }
    if status != NERR_Success || buffer.is_null() {
        return Err(InstallationError::windows(
            "sandbox-identity-query-failed",
            "verify-identity",
            "NetUserGetInfo failed for the managed sandbox account",
            status,
        ));
    }
    let buffer = NetApiBuffer(buffer);
    let info = unsafe { &*(buffer.0 as *const USER_INFO_1) };
    Ok(Some(LocalUserConfiguration {
        privilege: info.usri1_priv,
        flags: info.usri1_flags,
    }))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LocalUserConfiguration {
    privilege: u32,
    flags: u32,
}

fn read_credentials(path: &Path) -> InstallationResult<CredentialsFile> {
    let bytes = fs::read(path).map_err(|error| {
        InstallationError::new(
            "sandbox-credentials-missing",
            "load-identity",
            format!("could not read {}: {error}", path.display()),
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        InstallationError::new(
            "sandbox-credentials-invalid",
            "load-identity",
            format!("could not parse {}: {error}", path.display()),
        )
    })
}

fn write_credentials(
    path: &Path,
    account_name: &str,
    password: &SecretPassword,
) -> InstallationResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            InstallationError::new(
                "sandbox-credentials-write-failed",
                "provision-identity",
                format!("could not create {}: {error}", parent.display()),
            )
        })?;
    }
    let encrypted = dpapi_protect(password.0.as_slice())?;
    let record = CredentialsFile {
        schema_version: SETUP_SCHEMA_VERSION,
        account_name: account_name.to_string(),
        encrypted_password: encode_hex(&encrypted),
    };
    let bytes = serde_json::to_vec_pretty(&record).map_err(|error| {
        InstallationError::new(
            "sandbox-credentials-write-failed",
            "provision-identity",
            format!("could not serialize credentials: {error}"),
        )
    })?;
    fs::write(path, bytes).map_err(|error| {
        InstallationError::new(
            "sandbox-credentials-write-failed",
            "provision-identity",
            format!("could not write {}: {error}", path.display()),
        )
    })
}

fn decrypt_password(credentials: &CredentialsFile) -> InstallationResult<SecretPassword> {
    let encrypted = decode_hex(&credentials.encrypted_password)?;
    dpapi_unprotect(&encrypted).map(SecretPassword::from_utf8)
}

fn generate_password() -> InstallationResult<SecretPassword> {
    let mut random = [0u8; 32];
    let generated = unsafe { rtl_gen_random(random.as_mut_ptr() as *mut c_void, 32) } != 0;
    if !generated {
        return Err(InstallationError::windows(
            "sandbox-credentials-random-failed",
            "provision-identity",
            "RtlGenRandom failed",
            unsafe { GetLastError() },
        ));
    }
    let value = password_from_random(&random);
    random.fill(0);
    Ok(SecretPassword::from_utf8(value))
}

fn password_from_random(random: &[u8; 32]) -> Vec<u8> {
    const UPPERCASE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const LOWERCASE: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
    const DIGITS: &[u8] = b"0123456789";
    const SYMBOLS: &[u8] = b"!@#$%^&*()-_=+";
    const ALPHABET: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+";
    let required = [UPPERCASE, LOWERCASE, DIGITS, SYMBOLS];
    let mut password = Vec::with_capacity(random.len());
    for (value, alphabet) in random.iter().zip(required) {
        password.push(alphabet[*value as usize % alphabet.len()]);
    }
    password.extend(
        random[required.len()..]
            .iter()
            .map(|value| ALPHABET[*value as usize % ALPHABET.len()]),
    );
    password
}

fn dpapi_protect(data: &[u8]) -> InstallationResult<Vec<u8>> {
    crypt_data(data, true)
}

fn dpapi_unprotect(data: &[u8]) -> InstallationResult<Vec<u8>> {
    crypt_data(data, false)
}

fn crypt_data(data: &[u8], protect: bool) -> InstallationResult<Vec<u8>> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = if protect {
        unsafe {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN | CRYPTPROTECT_LOCAL_MACHINE,
                &mut output,
            )
        }
    } else {
        unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(InstallationError::windows(
            "sandbox-credentials-crypto-failed",
            "load-identity",
            if protect {
                "CryptProtectData failed"
            } else {
                "CryptUnprotectData failed"
            },
            unsafe { GetLastError() },
        ));
    }
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    free_local(output.pbData as *mut c_void);
    Ok(result)
}

pub(crate) fn sid_to_string(sid: *mut c_void) -> InstallationResult<String> {
    if sid.is_null() || unsafe { GetLengthSid(sid) } == 0 {
        return Err(InstallationError::new(
            "sandbox-sid-invalid",
            "resolve-identity",
            "Windows returned an invalid SID",
        ));
    }
    let mut value = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut value) } == 0 || value.is_null() {
        return Err(InstallationError::windows(
            "sandbox-sid-invalid",
            "resolve-identity",
            "ConvertSidToStringSidW failed",
            unsafe { GetLastError() },
        ));
    }
    let mut length = 0;
    while unsafe { *value.add(length) } != 0 {
        length += 1;
    }
    let result = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(value, length) });
    free_local(value as *mut c_void);
    Ok(result)
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn decode_hex(value: &str) -> InstallationResult<Vec<u8>> {
    if value.len() % 2 != 0 {
        return Err(InstallationError::new(
            "sandbox-credentials-invalid",
            "load-identity",
            "encrypted password is not valid hexadecimal",
        ));
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).map_err(|error| {
                InstallationError::new(
                    "sandbox-credentials-invalid",
                    "load-identity",
                    format!("encrypted password is invalid: {error}"),
                )
            })?;
            u8::from_str_radix(text, 16).map_err(|error| {
                InstallationError::new(
                    "sandbox-credentials-invalid",
                    "load-identity",
                    format!("encrypted password is invalid: {error}"),
                )
            })
        })
        .collect()
}

fn to_wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

struct LocalSid(*mut c_void);

impl Drop for LocalSid {
    fn drop(&mut self) {
        free_local(self.0);
    }
}

struct NetApiBuffer(*mut u8);

impl Drop for NetApiBuffer {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                NetApiBufferFree(self.0 as *const c_void);
            }
        }
    }
}

struct TokenHandle(isize);

impl Drop for TokenHandle {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::NetworkManagement::NetManagement::USER_PRIV_GUEST;

    #[test]
    fn hexadecimal_round_trip_preserves_binary_credentials() {
        let bytes = vec![0, 1, 127, 128, 255];
        assert_eq!(decode_hex(&encode_hex(&bytes)).ok(), Some(bytes));
    }

    #[test]
    fn generated_password_shape_always_satisfies_windows_complexity_classes() {
        let password = password_from_random(&[0; 32]);
        assert_eq!(password.len(), 32);
        assert!(password.iter().any(u8::is_ascii_uppercase));
        assert!(password.iter().any(u8::is_ascii_lowercase));
        assert!(password.iter().any(u8::is_ascii_digit));
        assert!(password.iter().any(|value| !value.is_ascii_alphanumeric()));
    }

    #[test]
    fn managed_account_name_fits_the_windows_local_account_limit() {
        assert!(validate_local_user_name(SANDBOX_ACCOUNT_NAME).is_ok());
        assert!(
            SANDBOX_ACCOUNT_NAME.encode_utf16().count()
                <= WINDOWS_LOCAL_ACCOUNT_NAME_MAX_UTF16_UNITS
        );
        assert!(validate_local_user_name("LobsterSandboxOffline").is_err());
    }

    #[test]
    fn user_add_only_falls_back_to_update_when_the_account_exists() {
        assert!(matches!(
            classify_user_add_status(NERR_Success, SANDBOX_ACCOUNT_NAME),
            Ok(UserAddDisposition::Created)
        ));
        assert!(matches!(
            classify_user_add_status(NERR_UserExists, SANDBOX_ACCOUNT_NAME),
            Ok(UserAddDisposition::UpdateExisting)
        ));

        let result = classify_user_add_status(2202, SANDBOX_ACCOUNT_NAME);
        let Err(error) = result else {
            panic!("an invalid user name status must not enter the update path");
        };
        assert_eq!(error.windows_error, Some(2202));
    }

    #[test]
    fn local_account_configuration_uses_group_membership_and_supported_flags() {
        let valid = LocalUserConfiguration {
            privilege: USER_PRIV_USER,
            flags: sandbox_account_flags(),
        };
        assert!(validate_local_user_configuration(&valid, true).is_ok());

        let legacy_guest_report = LocalUserConfiguration {
            privilege: USER_PRIV_GUEST,
            ..valid
        };
        assert!(validate_local_user_configuration(&legacy_guest_report, true).is_ok());
        assert!(validate_local_user_configuration(&valid, false).is_err());

        let missing_password_policy = LocalUserConfiguration {
            flags: valid.flags & !UF_DONT_EXPIRE_PASSWD,
            ..valid
        };
        assert!(validate_local_user_configuration(&missing_password_policy, true).is_err());

        let trusted_for_delegation = LocalUserConfiguration {
            flags: valid.flags | UF_TRUSTED_FOR_DELEGATION,
            ..valid
        };
        assert!(validate_local_user_configuration(&trusted_for_delegation, true).is_err());
    }

    #[test]
    fn builtin_users_group_resolves_without_assuming_an_english_windows_name() {
        assert!(
            !resolve_local_alias_name(SID_BUILTIN_USERS)
                .expect("the built-in Users alias should resolve")
                .is_empty()
        );
    }

    #[test]
    fn local_group_add_is_idempotent_but_preserves_other_windows_errors() {
        assert!(classify_local_group_add_status(NERR_Success, "user", "group").is_ok());
        assert!(classify_local_group_add_status(ERROR_MEMBER_IN_ALIAS, "user", "group").is_ok());
        let error = classify_local_group_add_status(2220, "user", "group")
            .expect_err("an unknown group must remain an installation failure");
        assert_eq!(error.windows_error, Some(2220));
    }

    #[test]
    fn current_user_is_an_eligible_setup_owner() {
        let current = current_user_sid();
        assert!(current.is_ok());
        let Some(current) = current.ok() else {
            return;
        };
        assert!(validate_setup_owner_sid(&current).is_ok());
    }
}
