use std::collections::BTreeMap;
use std::ffi::{OsStr, c_void};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, GetExitCodeProcess, INFINITE, LOGON_WITH_PROFILE,
    PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW, WaitForSingleObject,
};

use crate::desktop_access::{ensure_current_desktop_access, ensure_current_process_wait_access};
use crate::error::{InstallationError, InstallationResult};
use crate::identity::ProvisionedIdentity;
use crate::paths::InstallationPaths;

#[link(name = "advapi32")]
unsafe extern "system" {
    fn CreateProcessWithLogonW(
        username: *const u16,
        domain: *const u16,
        password: *const u16,
        logon_flags: u32,
        application_name: *const u16,
        command_line: *mut u16,
        creation_flags: u32,
        environment: *mut c_void,
        current_directory: *const u16,
        startup_info: *const STARTUPINFOW,
        process_information: *mut PROCESS_INFORMATION,
    ) -> i32;
}

pub fn launch_worker(
    arguments: &[String],
    identity: &ProvisionedIdentity,
    io_directory: &Path,
) -> InstallationResult<u32> {
    let paths = InstallationPaths::discover();
    let executable = paths.runner();
    if !executable.is_file() {
        return Err(InstallationError::new(
            "runtime-file-missing",
            "launch-worker",
            format!("installed runner is missing: {}", executable.display()),
        ));
    }
    let broker_pid = ensure_current_process_wait_access(&identity.account_sid)?;
    ensure_current_desktop_access(&identity.account_sid)?;
    let username = to_wide(&identity.account_name);
    let domain = to_wide(".");
    let mut password = to_wide(identity.password.as_str()?);
    let application = to_wide(executable.as_os_str());
    let mut argv = vec![executable.display().to_string()];
    argv.extend(arguments.iter().cloned());
    argv.push("--broker-pid".to_string());
    argv.push(broker_pid.to_string());
    let mut command_line = to_wide(argv_to_command_line(&argv));
    let current_directory = to_wide(paths.current.as_os_str());
    let io_bridge = WorkerIoBridge::create(io_directory)?;
    let mut environment = build_worker_environment(&io_bridge);
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
    startup.hStdOutput = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    startup.hStdError = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let created = unsafe {
        CreateProcessWithLogonW(
            username.as_ptr(),
            domain.as_ptr(),
            password.as_ptr(),
            LOGON_WITH_PROFILE,
            application.as_ptr(),
            command_line.as_mut_ptr(),
            CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
            environment.as_mut_ptr() as *mut c_void,
            current_directory.as_ptr(),
            &startup,
            &mut process,
        )
    };
    password.fill(0);
    if created == 0 {
        return Err(InstallationError::windows(
            "sandbox-worker-launch-failed",
            "launch-worker",
            "CreateProcessWithLogonW failed",
            unsafe { GetLastError() },
        ));
    }
    let process_handle = Handle(process.hProcess);
    let _thread_handle = Handle(process.hThread);
    if unsafe { WaitForSingleObject(process_handle.0, INFINITE) }
        != windows_sys::Win32::Foundation::WAIT_OBJECT_0
    {
        return Err(InstallationError::windows(
            "sandbox-worker-wait-failed",
            "launch-worker",
            "WaitForSingleObject failed",
            unsafe { GetLastError() },
        ));
    }
    let mut exit_code = 0;
    if unsafe { GetExitCodeProcess(process_handle.0, &mut exit_code) } == 0 {
        return Err(InstallationError::windows(
            "sandbox-worker-wait-failed",
            "launch-worker",
            "GetExitCodeProcess failed",
            unsafe { GetLastError() },
        ));
    }
    io_bridge.forward()?;
    Ok(exit_code)
}

fn build_worker_environment(io_bridge: &WorkerIoBridge) -> Vec<u16> {
    const ALLOWED: &[&str] = &[
        "ComSpec",
        "LOBSTER_NATIVE_SANDBOX_INSTALL_ROOT",
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
    let mut values = BTreeMap::new();
    for (key, value) in std::env::vars() {
        if ALLOWED
            .iter()
            .any(|allowed| key.eq_ignore_ascii_case(allowed))
        {
            values.insert(key, value);
        }
    }
    values.insert("LOBSTER_SANDBOX_WORKER".to_string(), "1".to_string());
    values.insert(
        "LOBSTER_SANDBOX_WORKER_STDOUT".to_string(),
        io_bridge.stdout.display().to_string(),
    );
    values.insert(
        "LOBSTER_SANDBOX_WORKER_STDERR".to_string(),
        io_bridge.stderr.display().to_string(),
    );
    let mut block = Vec::new();
    for (key, value) in values {
        let mut pair = to_wide(format!("{key}={value}"));
        pair.pop();
        block.extend(pair);
        block.push(0);
    }
    block.push(0);
    block
}

static WORKER_IO_SEQUENCE: AtomicU64 = AtomicU64::new(1);

struct WorkerIoBridge {
    stdout: PathBuf,
    stderr: PathBuf,
}

impl WorkerIoBridge {
    fn create(directory: &Path) -> InstallationResult<Self> {
        if !directory.is_dir() {
            return Err(InstallationError::new(
                "sandbox-worker-io-failed",
                "prepare-worker-io",
                format!(
                    "worker request directory is unavailable: {}",
                    directory.display()
                ),
            ));
        }
        for _ in 0..32 {
            let sequence = WORKER_IO_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let stem = format!(".lobster-worker-{}-{sequence}", std::process::id());
            let stdout = directory.join(format!("{stem}.stdout"));
            let stderr = directory.join(format!("{stem}.stderr"));
            match create_bridge_file(&stdout) {
                Ok(()) => match create_bridge_file(&stderr) {
                    Ok(()) => return Ok(Self { stdout, stderr }),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        let _ = fs::remove_file(&stdout);
                    }
                    Err(error) => {
                        let _ = fs::remove_file(&stdout);
                        return Err(worker_io_error("create", &stderr, error));
                    }
                },
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(worker_io_error("create", &stdout, error)),
            }
        }
        Err(InstallationError::new(
            "sandbox-worker-io-failed",
            "prepare-worker-io",
            "could not allocate unique worker output files",
        ))
    }

    fn forward(&self) -> InstallationResult<()> {
        let stdout =
            fs::read(&self.stdout).map_err(|error| worker_io_error("read", &self.stdout, error))?;
        let stderr =
            fs::read(&self.stderr).map_err(|error| worker_io_error("read", &self.stderr, error))?;
        io::stdout()
            .write_all(&stdout)
            .map_err(|error| worker_io_error("forward", &self.stdout, error))?;
        io::stderr()
            .write_all(&stderr)
            .map_err(|error| worker_io_error("forward", &self.stderr, error))?;
        Ok(())
    }
}

impl Drop for WorkerIoBridge {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.stdout);
        let _ = fs::remove_file(&self.stderr);
    }
}

fn create_bridge_file(path: &Path) -> io::Result<()> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(|_| ())
}

fn worker_io_error(action: &str, path: &Path, error: io::Error) -> InstallationError {
    InstallationError::new(
        "sandbox-worker-io-failed",
        "prepare-worker-io",
        format!("could not {action} {}: {error}", path.display()),
    )
}

fn argv_to_command_line(argv: &[String]) -> String {
    argv.iter()
        .map(|argument| quote_argument(argument))
        .collect::<Vec<_>>()
        .join(" ")
}

fn quote_argument(argument: &str) -> String {
    if !argument.is_empty()
        && !argument
            .chars()
            .any(|character| character.is_whitespace() || character == '"')
    {
        return argument.to_string();
    }
    let mut output = String::from("\"");
    let mut backslashes = 0;
    for character in argument.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                output.push_str(&"\\".repeat(backslashes * 2 + 1));
                output.push('"');
                backslashes = 0;
            }
            _ => {
                output.push_str(&"\\".repeat(backslashes));
                backslashes = 0;
                output.push(character);
            }
        }
    }
    output.push_str(&"\\".repeat(backslashes * 2));
    output.push('"');
    output
}

fn to_wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

struct Handle(isize);

impl Drop for Handle {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_line_quoting_preserves_spaces_and_quotes() {
        assert_eq!(quote_argument("plain"), "plain");
        assert_eq!(quote_argument("two words"), "\"two words\"");
        assert_eq!(quote_argument("a\\\"b"), "\"a\\\\\\\"b\"");
    }

    #[test]
    fn worker_io_bridge_uses_unique_files_and_cleans_them_up() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let first = WorkerIoBridge::create(temporary.path()).expect("first bridge");
        let second = WorkerIoBridge::create(temporary.path()).expect("second bridge");
        assert_ne!(first.stdout, second.stdout);
        assert_ne!(first.stderr, second.stderr);
        assert!(first.stdout.is_file());
        assert!(first.stderr.is_file());
        let first_stdout = first.stdout.clone();
        let first_stderr = first.stderr.clone();
        drop(first);
        assert!(!first_stdout.exists());
        assert!(!first_stderr.exists());
    }
}
