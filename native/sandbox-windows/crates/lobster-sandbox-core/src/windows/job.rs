use std::ffi::c_void;

use windows_sys::Win32::Foundation::{GetLastError, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_UILIMIT_EXITWINDOWS, JOB_OBJECT_UILIMIT_HANDLES, JOB_OBJECT_UILIMIT_READCLIPBOARD,
    JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS, JOB_OBJECT_UILIMIT_WRITECLIPBOARD,
    JOBOBJECT_BASIC_UI_RESTRICTIONS, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicUIRestrictions, JobObjectExtendedLimitInformation, SetInformationJobObject,
    TerminateJobObject,
};

use crate::{SandboxError, SandboxResult};

use super::handle::OwnedHandle;

pub struct KillOnCloseJob {
    handle: OwnedHandle,
}

impl KillOnCloseJob {
    pub fn create(max_processes: u32) -> SandboxResult<Self> {
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        let handle = OwnedHandle::new(
            raw,
            "job-create-failed",
            "create-job",
            "CreateJobObjectW failed",
        )?;
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        limits.BasicLimitInformation.ActiveProcessLimit = max_processes;
        let configured = unsafe {
            SetInformationJobObject(
                handle.raw(),
                JobObjectExtendedLimitInformation,
                &mut limits as *mut _ as *mut c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(SandboxError::windows(
                "job-configure-failed",
                "create-job",
                "SetInformationJobObject failed",
                unsafe { GetLastError() },
            ));
        }
        let mut ui_limits = JOBOBJECT_BASIC_UI_RESTRICTIONS {
            UIRestrictionsClass: JOB_OBJECT_UILIMIT_HANDLES
                | JOB_OBJECT_UILIMIT_READCLIPBOARD
                | JOB_OBJECT_UILIMIT_WRITECLIPBOARD
                | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS
                | JOB_OBJECT_UILIMIT_EXITWINDOWS,
        };
        let ui_configured = unsafe {
            SetInformationJobObject(
                handle.raw(),
                JobObjectBasicUIRestrictions,
                &mut ui_limits as *mut _ as *mut c_void,
                std::mem::size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32,
            )
        };
        if ui_configured == 0 {
            return Err(SandboxError::windows(
                "job-configure-failed",
                "create-job",
                "SetInformationJobObject(UI restrictions) failed",
                unsafe { GetLastError() },
            ));
        }
        Ok(Self { handle })
    }

    pub fn assign(&self, process: HANDLE) -> SandboxResult<()> {
        let assigned = unsafe { AssignProcessToJobObject(self.handle.raw(), process) };
        if assigned == 0 {
            return Err(SandboxError::windows(
                "job-assignment-failed",
                "assign-job",
                "AssignProcessToJobObject failed",
                unsafe { GetLastError() },
            ));
        }
        Ok(())
    }

    pub fn terminate(&self, exit_code: u32) -> SandboxResult<()> {
        let terminated = unsafe { TerminateJobObject(self.handle.raw(), exit_code) };
        if terminated == 0 {
            return Err(SandboxError::windows(
                "job-termination-failed",
                "terminate-job",
                "TerminateJobObject failed",
                unsafe { GetLastError() },
            ));
        }
        Ok(())
    }
}
