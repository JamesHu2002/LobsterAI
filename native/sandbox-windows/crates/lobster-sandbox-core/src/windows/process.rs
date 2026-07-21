use std::collections::BTreeMap;
use std::ffi::c_void;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::windows::io::FromRawHandle;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use lobster_sandbox_protocol::{ExecutionOutcome, SandboxCommand};
use windows_sys::Win32::Foundation::{
    GetLastError, HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_FAILED, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, CTRL_C_EVENT, SetConsoleCtrlHandler};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessAsUserW,
    EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, PROCESS_INFORMATION, ResumeThread,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, WaitForSingleObject,
};

use crate::{SandboxError, SandboxResult};

use super::attributes::ProcessAttributeList;
use super::handle::OwnedHandle;
use super::job::KillOnCloseJob;
use super::path_policy::PreparedPolicy;
use super::wide::{argv_to_command_line, to_wide};

const TERMINATED_EXIT_CODE: u32 = 0xC000_013A;
const WAIT_POLL_MS: u32 = 50;

static CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);

unsafe extern "system" fn console_control_handler(control_type: u32) -> i32 {
    if control_type == CTRL_C_EVENT || control_type == CTRL_BREAK_EVENT {
        CANCEL_REQUESTED.store(true, Ordering::SeqCst);
        return 1;
    }
    0
}

pub struct ProcessResult {
    pub outcome: ExecutionOutcome,
    pub exit_code: Option<u32>,
    pub output_bytes: u64,
}

pub fn run_restricted_process(
    token: HANDLE,
    policy: &PreparedPolicy,
    command: &SandboxCommand,
) -> SandboxResult<ProcessResult> {
    CANCEL_REQUESTED.store(false, Ordering::SeqCst);
    let handler_installed = unsafe { SetConsoleCtrlHandler(Some(console_control_handler), 1) } != 0;
    let result = run_restricted_process_inner(token, policy, command);
    if handler_installed {
        unsafe {
            SetConsoleCtrlHandler(Some(console_control_handler), 0);
        }
    }
    result
}

fn run_restricted_process_inner(
    token: HANDLE,
    policy: &PreparedPolicy,
    command: &SandboxCommand,
) -> SandboxResult<ProcessResult> {
    let job = KillOnCloseJob::create(policy.limits.max_processes)?;
    let stdin_pipe = create_pipe()?;
    let mut stdout_pipe = create_pipe()?;
    let mut stderr_pipe = create_pipe()?;

    make_non_inheritable(stdin_pipe.write.raw())?;
    make_non_inheritable(stdout_pipe.read.raw())?;
    make_non_inheritable(stderr_pipe.read.raw())?;

    let mut command_line = to_wide(argv_to_command_line(&command.argv));
    let cwd = to_wide(policy.cwd.as_os_str());
    let environment = build_environment_block(command, policy);
    let mut desktop = to_wide(r"winsta0\default");
    let mut attributes = ProcessAttributeList::with_inherited_handles(vec![
        stdin_pipe.read.raw(),
        stdout_pipe.write.raw(),
        stderr_pipe.write.raw(),
    ])?;
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    // PowerShell can fail during DLL initialization under a restricted token when lpDesktop is
    // omitted, even for a no-window child. Bind explicitly to the caller's interactive desktop.
    startup.StartupInfo.lpDesktop = desktop.as_mut_ptr();
    startup.StartupInfo.hStdInput = stdin_pipe.read.raw();
    startup.StartupInfo.hStdOutput = stdout_pipe.write.raw();
    startup.StartupInfo.hStdError = stderr_pipe.write.raw();
    startup.lpAttributeList = attributes.raw();
    let mut process_info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let created = unsafe {
        CreateProcessAsUserW(
            token,
            std::ptr::null(),
            command_line.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            1,
            CREATE_SUSPENDED
                | CREATE_NO_WINDOW
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr() as *mut c_void,
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut process_info,
        )
    };
    if created == 0 {
        return Err(SandboxError::windows(
            "process-spawn-failed",
            "spawn-process",
            format!("could not start {}", command.argv[0]),
            unsafe { GetLastError() },
        ));
    }
    let process = OwnedHandle::new(
        process_info.hProcess,
        "process-spawn-failed",
        "spawn-process",
        "CreateProcessAsUserW returned an invalid process handle",
    )?;
    let thread = match OwnedHandle::new(
        process_info.hThread,
        "process-spawn-failed",
        "spawn-process",
        "CreateProcessAsUserW returned an invalid thread handle",
    ) {
        Ok(thread) => thread,
        Err(error) => {
            unsafe {
                windows_sys::Win32::System::Threading::TerminateProcess(
                    process.raw(),
                    TERMINATED_EXIT_CODE,
                );
            }
            return Err(error);
        }
    };

    if let Err(error) = job.assign(process.raw()) {
        unsafe {
            windows_sys::Win32::System::Threading::TerminateProcess(
                process.raw(),
                TERMINATED_EXIT_CODE,
            );
        }
        return Err(error);
    }
    let resumed = unsafe { ResumeThread(thread.raw()) };
    if resumed == u32::MAX {
        let error = unsafe { GetLastError() };
        let _ = job.terminate(TERMINATED_EXIT_CODE);
        return Err(SandboxError::windows(
            "process-resume-failed",
            "spawn-process",
            "ResumeThread failed",
            error,
        ));
    }

    drop(stdin_pipe.read);
    drop(stdin_pipe.write);
    drop(stdout_pipe.write);
    drop(stderr_pipe.write);

    let bytes = Arc::new(AtomicU64::new(0));
    let output_exceeded = Arc::new(AtomicBool::new(false));
    let stdout_reader = spawn_output_reader(
        stdout_pipe.read.take(),
        false,
        Arc::clone(&bytes),
        Arc::clone(&output_exceeded),
        policy.limits.max_output_bytes,
    );
    let stderr_reader = spawn_output_reader(
        stderr_pipe.read.take(),
        true,
        Arc::clone(&bytes),
        Arc::clone(&output_exceeded),
        policy.limits.max_output_bytes,
    );

    let started_at = Instant::now();
    let mut outcome = loop {
        let wait = unsafe { WaitForSingleObject(process.raw(), WAIT_POLL_MS) };
        if wait == WAIT_OBJECT_0 {
            break ExecutionOutcome::Completed;
        }
        if wait == WAIT_FAILED {
            let error = unsafe { GetLastError() };
            let _ = job.terminate(TERMINATED_EXIT_CODE);
            return Err(SandboxError::windows(
                "process-wait-failed",
                "wait-process",
                "WaitForSingleObject failed",
                error,
            ));
        }
        if wait != WAIT_TIMEOUT {
            let _ = job.terminate(TERMINATED_EXIT_CODE);
            return Err(SandboxError::new(
                "process-wait-failed",
                "wait-process",
                format!("unexpected wait result {wait}"),
            ));
        }
        if CANCEL_REQUESTED.load(Ordering::SeqCst) {
            job.terminate(TERMINATED_EXIT_CODE)?;
            break ExecutionOutcome::Cancelled;
        }
        if output_exceeded.load(Ordering::SeqCst) {
            job.terminate(TERMINATED_EXIT_CODE)?;
            break ExecutionOutcome::OutputLimitExceeded;
        }
        if started_at.elapsed() >= Duration::from_millis(policy.limits.timeout_ms) {
            job.terminate(TERMINATED_EXIT_CODE)?;
            break ExecutionOutcome::TimedOut;
        }
    };

    if outcome != ExecutionOutcome::Completed {
        let _ = unsafe { WaitForSingleObject(process.raw(), 5_000) };
    }
    let mut raw_exit_code = 0;
    let exit_code = if unsafe { GetExitCodeProcess(process.raw(), &mut raw_exit_code) } != 0 {
        Some(raw_exit_code)
    } else {
        None
    };
    // The root process has completed (or was stopped above). Closing/terminating the job at this
    // point guarantees that background descendants cannot outlive the CLI or keep stdio pipes open.
    let _ = job.terminate(exit_code.unwrap_or(TERMINATED_EXIT_CODE));
    drop(job);
    let stdout_result = stdout_reader.join().map_err(|_| {
        SandboxError::new(
            "stdio-bridge-failed",
            "read-output",
            "stdout reader thread panicked",
        )
    })?;
    let stderr_result = stderr_reader.join().map_err(|_| {
        SandboxError::new(
            "stdio-bridge-failed",
            "read-output",
            "stderr reader thread panicked",
        )
    })?;
    stdout_result?;
    stderr_result?;
    if outcome == ExecutionOutcome::Completed && output_exceeded.load(Ordering::SeqCst) {
        outcome = ExecutionOutcome::OutputLimitExceeded;
    }

    Ok(ProcessResult {
        outcome,
        exit_code,
        output_bytes: bytes.load(Ordering::SeqCst),
    })
}

struct PipePair {
    read: OwnedHandle,
    write: OwnedHandle,
}

fn create_pipe() -> SandboxResult<PipePair> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    let mut read = 0;
    let mut write = 0;
    let created = unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) };
    if created == 0 {
        return Err(SandboxError::windows(
            "stdio-bridge-failed",
            "create-pipes",
            "CreatePipe failed",
            unsafe { GetLastError() },
        ));
    }
    Ok(PipePair {
        read: OwnedHandle::new(
            read,
            "stdio-bridge-failed",
            "create-pipes",
            "CreatePipe returned an invalid read handle",
        )?,
        write: OwnedHandle::new(
            write,
            "stdio-bridge-failed",
            "create-pipes",
            "CreatePipe returned an invalid write handle",
        )?,
    })
}

fn make_non_inheritable(handle: HANDLE) -> SandboxResult<()> {
    let updated = unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) };
    if updated == 0 {
        return Err(SandboxError::windows(
            "stdio-bridge-failed",
            "create-pipes",
            "SetHandleInformation failed",
            unsafe { GetLastError() },
        ));
    }
    Ok(())
}

fn spawn_output_reader(
    handle: HANDLE,
    stderr: bool,
    bytes: Arc<AtomicU64>,
    exceeded: Arc<AtomicBool>,
    limit: u64,
) -> std::thread::JoinHandle<SandboxResult<()>> {
    std::thread::spawn(move || {
        let raw_handle = handle as *mut c_void;
        let mut file = unsafe { File::from_raw_handle(raw_handle) };
        let mut buffer = [0u8; 8 * 1024];
        loop {
            let count = file.read(&mut buffer).map_err(|error| {
                SandboxError::new(
                    "stdio-bridge-failed",
                    "read-output",
                    format!("could not read child output: {error}"),
                )
            })?;
            if count == 0 {
                return Ok(());
            }
            let previous = bytes.fetch_add(count as u64, Ordering::SeqCst);
            let remaining = limit.saturating_sub(previous) as usize;
            let write_count = count.min(remaining);
            if write_count > 0 {
                let write_result = if stderr {
                    let mut target = io::stderr().lock();
                    target.write_all(&buffer[..write_count])
                } else {
                    let mut target = io::stdout().lock();
                    target.write_all(&buffer[..write_count])
                };
                write_result.map_err(|error| {
                    SandboxError::new(
                        "stdio-bridge-failed",
                        "write-output",
                        format!("could not forward child output: {error}"),
                    )
                })?;
            }
            if previous.saturating_add(count as u64) > limit {
                exceeded.store(true, Ordering::SeqCst);
            }
        }
    })
}

fn build_environment_block(command: &SandboxCommand, policy: &PreparedPolicy) -> Vec<u16> {
    const PASSTHROUGH: &[&str] = &[
        "ComSpec",
        "NUMBER_OF_PROCESSORS",
        "NVM_HOME",
        "NVM_SYMLINK",
        "OS",
        "PATH",
        "PATHEXT",
        "PROCESSOR_ARCHITECTURE",
        "ProgramData",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "SystemDrive",
        "SystemRoot",
        "WINDIR",
    ];
    let mut environment = BTreeMap::<String, String>::new();
    for (key, value) in std::env::vars() {
        if PASSTHROUGH
            .iter()
            .any(|accepted| key.eq_ignore_ascii_case(accepted))
        {
            environment.insert(key, value);
        }
    }
    let scratch = policy.scratch_dir.display().to_string();
    environment.insert(
        "APPDATA".to_string(),
        policy
            .scratch_dir
            .join(r"AppData\Roaming")
            .display()
            .to_string(),
    );
    environment.insert("HOME".to_string(), scratch.clone());
    environment.insert(
        "LOCALAPPDATA".to_string(),
        policy
            .scratch_dir
            .join(r"AppData\Local")
            .display()
            .to_string(),
    );
    environment.insert("TEMP".to_string(), scratch.clone());
    environment.insert("TMP".to_string(), scratch.clone());
    environment.insert("USERPROFILE".to_string(), scratch);
    environment.insert("LOBSTER_SANDBOX".to_string(), "1".to_string());
    for (key, value) in &command.env {
        let existing = environment
            .keys()
            .find(|candidate| candidate.eq_ignore_ascii_case(key))
            .cloned();
        if let Some(existing) = existing {
            environment.remove(&existing);
        }
        environment.insert(key.clone(), value.clone());
    }

    let mut block = Vec::new();
    for (key, value) in environment {
        let mut pair = to_wide(format!("{key}={value}"));
        pair.pop();
        block.extend(pair);
        block.push(0);
    }
    block.push(0);
    block
}
