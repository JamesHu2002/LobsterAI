use std::ffi::c_void;
use std::path::Path;

use sha2::{Digest, Sha256};
use windows_sys::Win32::Foundation::{HLOCAL, LocalFree};

use crate::{SandboxError, SandboxResult};

use super::path_policy::path_key;
use super::wide::to_wide;

// Keep root identities stable across protocol upgrades so a newer runtime can
// replace or revoke ACEs left by an older compatible policy revision.
const CAPABILITY_NAMESPACE: &[u8] = b"lobster-native-sandbox/workspace-write-v1\0";

#[link(name = "advapi32")]
unsafe extern "system" {
    fn ConvertStringSidToSidW(string_sid: *const u16, sid: *mut *mut c_void) -> i32;
}

pub struct CapabilitySid {
    text: String,
    pointer: *mut c_void,
}

impl CapabilitySid {
    pub fn for_path(path: &Path) -> SandboxResult<Self> {
        let mut hasher = Sha256::new();
        hasher.update(CAPABILITY_NAMESPACE);
        hasher.update(path_key(path).as_bytes());
        let digest = hasher.finalize();
        let mut parts = [0u32; 4];
        for (index, part) in parts.iter_mut().enumerate() {
            let offset = index * 4;
            *part = u32::from_le_bytes(digest[offset..offset + 4].try_into().map_err(|_| {
                SandboxError::new(
                    "capability-generation-failed",
                    "derive-capability",
                    "could not derive a workspace capability identifier",
                )
            })?);
            if *part == 0 {
                *part = index as u32 + 1;
            }
        }
        let text = format!(
            "S-1-5-21-{}-{}-{}-{}",
            parts[0], parts[1], parts[2], parts[3],
        );
        Self::from_text(text)
    }

    pub fn from_text(text: String) -> SandboxResult<Self> {
        let wide = to_wide(&text);
        let mut pointer = std::ptr::null_mut();
        let converted = unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut pointer) };
        if converted == 0 || pointer.is_null() {
            let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            return Err(SandboxError::windows(
                "capability-generation-failed",
                "derive-capability",
                format!("could not convert capability SID {text}"),
                error,
            ));
        }
        Ok(Self { text, pointer })
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn as_ptr(&self) -> *mut c_void {
        self.pointer
    }
}

impl Drop for CapabilitySid {
    fn drop(&mut self) {
        if !self.pointer.is_null() {
            unsafe {
                LocalFree(self.pointer as HLOCAL);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn capability_is_stable_for_case_variants() {
        let first = CapabilitySid::for_path(Path::new(r"D:\Work\Project"));
        let second = CapabilitySid::for_path(Path::new(r"d:\work\project"));
        assert!(first.is_ok());
        assert!(second.is_ok());
        assert_eq!(
            first.ok().map(|capability| capability.text().to_string()),
            second.ok().map(|capability| capability.text().to_string()),
        );
    }
}
