use std::ffi::c_void;

use windows_sys::Win32::Foundation::{GetLastError, HANDLE};
use windows_sys::Win32::System::Threading::{
    DeleteProcThreadAttributeList, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    UpdateProcThreadAttribute,
};

use crate::{SandboxError, SandboxResult};

const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x0002_0002;

pub struct ProcessAttributeList {
    buffer: Vec<usize>,
    handles: Vec<HANDLE>,
    initialized: bool,
}

impl ProcessAttributeList {
    pub fn with_inherited_handles(handles: Vec<HANDLE>) -> SandboxResult<Self> {
        let mut required = 0usize;
        unsafe {
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut required);
        }
        if required == 0 {
            return Err(SandboxError::windows(
                "process-attributes-failed",
                "spawn-process",
                "could not determine process attribute list size",
                unsafe { GetLastError() },
            ));
        }
        let mut list = Self {
            buffer: vec![0usize; required.div_ceil(std::mem::size_of::<usize>())],
            handles,
            initialized: false,
        };
        let initialized =
            unsafe { InitializeProcThreadAttributeList(list.raw(), 1, 0, &mut required) };
        if initialized == 0 {
            return Err(SandboxError::windows(
                "process-attributes-failed",
                "spawn-process",
                "InitializeProcThreadAttributeList failed",
                unsafe { GetLastError() },
            ));
        }
        list.initialized = true;
        let updated = unsafe {
            UpdateProcThreadAttribute(
                list.raw(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                list.handles.as_mut_ptr() as *mut c_void,
                std::mem::size_of_val(list.handles.as_slice()),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if updated == 0 {
            return Err(SandboxError::windows(
                "process-attributes-failed",
                "spawn-process",
                "UpdateProcThreadAttribute(handle list) failed",
                unsafe { GetLastError() },
            ));
        }
        Ok(list)
    }

    pub fn raw(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buffer.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST
    }
}

impl Drop for ProcessAttributeList {
    fn drop(&mut self) {
        if self.initialized {
            unsafe {
                DeleteProcThreadAttributeList(self.raw());
            }
        }
    }
}
