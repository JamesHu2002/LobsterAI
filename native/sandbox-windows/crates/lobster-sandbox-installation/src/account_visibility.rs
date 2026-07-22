use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_SET_VALUE, KEY_WOW64_64KEY, REG_DWORD,
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
};

use crate::error::{InstallationError, InstallationResult};
use crate::model::SANDBOX_ACCOUNT_NAME;

const USER_LIST_KEY: &str =
    r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList";

pub fn ensure_sandbox_account_hidden() -> InstallationResult<()> {
    let subkey = wide(USER_LIST_KEY);
    let mut key = 0;
    let status = unsafe {
        RegCreateKeyExW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            0,
            std::ptr::null(),
            0,
            KEY_SET_VALUE | KEY_WOW64_64KEY,
            std::ptr::null(),
            &mut key,
            std::ptr::null_mut(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(registry_error(
            "sandbox-identity-hide-failed",
            "provision-identity",
            "could not open the Windows account visibility policy",
            status,
        ));
    }
    let key = RegistryKey(key);
    let value_name = wide(SANDBOX_ACCOUNT_NAME);
    let hidden = 0u32;
    let status = unsafe {
        RegSetValueExW(
            key.0,
            value_name.as_ptr(),
            0,
            REG_DWORD,
            &hidden as *const _ as *const u8,
            std::mem::size_of::<u32>() as u32,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(registry_error(
            "sandbox-identity-hide-failed",
            "provision-identity",
            "could not hide the managed sandbox account",
            status,
        ));
    }
    Ok(())
}

pub fn verify_sandbox_account_hidden() -> InstallationResult<bool> {
    let subkey = wide(USER_LIST_KEY);
    let mut key = 0;
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            0,
            KEY_QUERY_VALUE | KEY_WOW64_64KEY,
            &mut key,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(false);
    }
    if status != ERROR_SUCCESS {
        return Err(registry_error(
            "sandbox-identity-visibility-invalid",
            "verify-identity",
            "could not inspect the Windows account visibility policy",
            status,
        ));
    }
    let key = RegistryKey(key);
    let value_name = wide(SANDBOX_ACCOUNT_NAME);
    let mut value_type = 0;
    let mut hidden = u32::MAX;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegQueryValueExW(
            key.0,
            value_name.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            &mut hidden as *mut _ as *mut u8,
            &mut size,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(false);
    }
    if status != ERROR_SUCCESS {
        return Err(registry_error(
            "sandbox-identity-visibility-invalid",
            "verify-identity",
            "could not inspect the managed sandbox account visibility",
            status,
        ));
    }
    Ok(value_type == REG_DWORD && size == std::mem::size_of::<u32>() as u32 && hidden == 0)
}

pub fn remove_sandbox_account_visibility() -> InstallationResult<()> {
    let subkey = wide(USER_LIST_KEY);
    let mut key = 0;
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            0,
            KEY_SET_VALUE | KEY_WOW64_64KEY,
            &mut key,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(());
    }
    if status != ERROR_SUCCESS {
        return Err(registry_error(
            "sandbox-identity-visibility-remove-failed",
            "uninstall-identity",
            "could not open the Windows account visibility policy",
            status,
        ));
    }
    let key = RegistryKey(key);
    let value_name = wide(SANDBOX_ACCOUNT_NAME);
    let status = unsafe { RegDeleteValueW(key.0, value_name.as_ptr()) };
    if status != ERROR_SUCCESS && status != ERROR_FILE_NOT_FOUND {
        return Err(registry_error(
            "sandbox-identity-visibility-remove-failed",
            "uninstall-identity",
            "could not remove the managed sandbox account visibility policy",
            status,
        ));
    }
    Ok(())
}

fn registry_error(
    code: &'static str,
    stage: &'static str,
    context: &'static str,
    status: u32,
) -> InstallationError {
    InstallationError::windows(code, stage, context, status)
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}

struct RegistryKey(HKEY);

impl Drop for RegistryKey {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }
}
