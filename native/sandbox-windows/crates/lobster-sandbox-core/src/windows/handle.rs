use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};

use crate::{SandboxError, SandboxResult};

pub struct OwnedHandle(HANDLE);

impl OwnedHandle {
    pub fn new(
        handle: HANDLE,
        code: &'static str,
        stage: &'static str,
        context: &'static str,
    ) -> SandboxResult<Self> {
        if handle == 0 || handle == INVALID_HANDLE_VALUE {
            let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            return Err(SandboxError::windows(code, stage, context, error));
        }
        Ok(Self(handle))
    }

    pub fn raw(&self) -> HANDLE {
        self.0
    }

    pub fn take(&mut self) -> HANDLE {
        let handle = self.0;
        self.0 = 0;
        handle
    }
}

unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if self.0 != 0 && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
