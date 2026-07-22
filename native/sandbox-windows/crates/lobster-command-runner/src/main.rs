use std::fs;
use std::fs::{File, OpenOptions};
use std::io::{self, Read};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};

use clap::{Parser, Subcommand};
use lobster_sandbox_core::{
    SandboxError, cleanup, cleanup_with_identity, execute, prepare, verify, verify_prepared,
};
use lobster_sandbox_installation::{
    InstallationError, harden_current_process_dll_search, launch_worker, start_broker_watchdog,
    verify_runtime_for_broker, verify_runtime_for_worker,
};
use lobster_sandbox_protocol::{
    ExecutionOutcome, NATIVE_SANDBOX_PROTOCOL_VERSION, RunRequest, RunnerErrorResponse,
};

#[derive(Debug, Parser)]
#[command(
    name = "lobster-command-runner",
    version,
    about = "LobsterAI Windows native sandbox runtime broker"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Validate paths, prepare ACLs, and prove that the restricted token contains the capabilities.
    Verify {
        /// Request JSON file, or '-' to read stdin.
        request: PathBuf,
    },
    /// Execute the exact argv from a request under the restricted token and Job Object.
    Run {
        /// Request JSON file, or '-' to read stdin.
        request: PathBuf,
        /// Optional sidecar for the final machine report. Child stderr stays unmodified.
        #[arg(long)]
        report_file: Option<PathBuf>,
    },
    /// Revoke the capability ACEs created for a request.
    Cleanup {
        /// Request JSON file, or '-' to read stdin.
        request: PathBuf,
    },
    #[command(name = "__worker-verify", hide = true)]
    WorkerVerify {
        request: PathBuf,
        #[arg(long, hide = true)]
        broker_pid: u32,
    },
    #[command(name = "__worker-run", hide = true)]
    WorkerRun {
        request: PathBuf,
        #[arg(long)]
        report_file: Option<PathBuf>,
        #[arg(long, hide = true)]
        broker_pid: u32,
    },
}

fn main() {
    let _worker_stdio = match redirect_worker_stdio() {
        Ok(worker_stdio) => worker_stdio,
        Err(error) => {
            write_worker_bootstrap_error(&error);
            std::process::exit(70);
        }
    };
    if let Err(error) = harden_current_process_dll_search() {
        print_error(&installation_error(error));
        std::process::exit(70);
    }
    let exit_code = match run(Cli::parse()) {
        Ok(exit_code) => exit_code,
        Err(error) => {
            print_error(&error);
            70
        }
    };
    std::process::exit(exit_code);
}

fn run(cli: Cli) -> Result<i32, SandboxError> {
    match cli.command {
        Command::Verify { request } => {
            if request == Path::new("-") {
                return Err(SandboxError::new(
                    "request-path-required",
                    "launch-worker",
                    "installed runtime does not accept a verification request from stdin",
                ));
            }
            let parsed_request = read_request(&request)?;
            if dev_direct_mode() {
                let report = verify(&parsed_request)?;
                print_json(&report, false)?;
                return Ok(0);
            }
            let context = verify_runtime_for_broker().map_err(installation_error)?;
            prepare(&parsed_request, Some(&context.state.account_sid))?;
            launch_worker(
                &["__worker-verify".to_string(), path_argument(&request)],
                &context.identity,
                request_parent(&request)?,
            )
            .map(|code| code.min(255) as i32)
            .map_err(installation_error)
        }
        Command::Run {
            request,
            report_file,
        } => {
            if dev_direct_mode() {
                let request = read_request(&request)?;
                let report = execute(&request)?;
                print_execution_report(&report, report_file.as_deref())?;
                return Ok(match report.outcome {
                    ExecutionOutcome::Completed => report.exit_code.unwrap_or(1).min(255) as i32,
                    ExecutionOutcome::TimedOut => 124,
                    ExecutionOutcome::Cancelled => 130,
                    ExecutionOutcome::OutputLimitExceeded => 125,
                });
            }
            let context = verify_runtime_for_broker().map_err(installation_error)?;
            let mut arguments = vec!["__worker-run".to_string(), path_argument(&request)];
            if let Some(report_file) = report_file {
                arguments.push("--report-file".to_string());
                arguments.push(path_argument(&report_file));
            }
            launch_worker(&arguments, &context.identity, request_parent(&request)?)
                .map(|code| code.min(255) as i32)
                .map_err(installation_error)
        }
        Command::Cleanup { request } => {
            let request = read_request(&request)?;
            if dev_direct_mode() {
                cleanup(&request)?;
                println!(
                    "{{\"protocolVersion\":{},\"ok\":true}}",
                    NATIVE_SANDBOX_PROTOCOL_VERSION
                );
                return Ok(0);
            }
            let context = verify_runtime_for_broker().map_err(installation_error)?;
            cleanup_with_identity(&request, Some(&context.state.account_sid))?;
            println!(
                "{{\"protocolVersion\":{},\"ok\":true}}",
                NATIVE_SANDBOX_PROTOCOL_VERSION
            );
            Ok(0)
        }
        Command::WorkerVerify {
            request,
            broker_pid,
        } => {
            let state = verify_runtime_for_worker().map_err(installation_error)?;
            start_broker_watchdog(broker_pid, &state.owner_sid).map_err(installation_error)?;
            let request = read_request(&request)?;
            if state.protocol_version != NATIVE_SANDBOX_PROTOCOL_VERSION {
                return Err(SandboxError::new(
                    "runtime-version-incompatible",
                    "verify-runtime",
                    "installed runtime protocol does not match the command runner",
                ));
            }
            let report = verify_prepared(&request, true, true, true)?;
            print_json(&report, false)?;
            Ok(0)
        }
        Command::WorkerRun {
            request,
            report_file,
            broker_pid,
        } => {
            let state = verify_runtime_for_worker().map_err(installation_error)?;
            start_broker_watchdog(broker_pid, &state.owner_sid).map_err(installation_error)?;
            let request = read_request(&request)?;
            if state.protocol_version != NATIVE_SANDBOX_PROTOCOL_VERSION {
                return Err(SandboxError::new(
                    "runtime-version-incompatible",
                    "verify-runtime",
                    "installed runtime protocol does not match the command runner",
                ));
            }
            let report = execute(&request)?;
            print_execution_report(&report, report_file.as_deref())?;
            Ok(match report.outcome {
                ExecutionOutcome::Completed => report.exit_code.unwrap_or(1).min(255) as i32,
                ExecutionOutcome::TimedOut => 124,
                ExecutionOutcome::Cancelled => 130,
                ExecutionOutcome::OutputLimitExceeded => 125,
            })
        }
    }
}

fn path_argument(path: &Path) -> String {
    path.as_os_str().to_string_lossy().to_string()
}

fn request_parent(path: &Path) -> Result<&Path, SandboxError> {
    path.parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| {
            SandboxError::new(
                "request-path-invalid",
                "launch-worker",
                format!("request directory is unavailable: {}", path.display()),
            )
        })
}

struct WorkerStdio {
    _stdout: File,
    _stderr: File,
}

fn redirect_worker_stdio() -> Result<Option<WorkerStdio>, SandboxError> {
    let stdout_path = std::env::var_os("LOBSTER_SANDBOX_WORKER_STDOUT");
    let stderr_path = std::env::var_os("LOBSTER_SANDBOX_WORKER_STDERR");
    let (Some(stdout_path), Some(stderr_path)) = (stdout_path, stderr_path) else {
        return Ok(None);
    };
    let stdout = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&stdout_path)
        .map_err(|error| {
            SandboxError::new(
                "worker-stdio-failed",
                "prepare-worker-stdio",
                format!("could not open worker stdout bridge: {error}"),
            )
        })?;
    let stderr = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&stderr_path)
        .map_err(|error| {
            SandboxError::new(
                "worker-stdio-failed",
                "prepare-worker-stdio",
                format!("could not open worker stderr bridge: {error}"),
            )
        })?;
    if unsafe {
        windows_sys::Win32::System::Console::SetStdHandle(
            windows_sys::Win32::System::Console::STD_OUTPUT_HANDLE,
            stdout.as_raw_handle() as isize,
        )
    } == 0
    {
        return Err(SandboxError::windows(
            "worker-stdio-failed",
            "prepare-worker-stdio",
            "SetStdHandle(STD_OUTPUT_HANDLE) failed",
            unsafe { windows_sys::Win32::Foundation::GetLastError() },
        ));
    }
    if unsafe {
        windows_sys::Win32::System::Console::SetStdHandle(
            windows_sys::Win32::System::Console::STD_ERROR_HANDLE,
            stderr.as_raw_handle() as isize,
        )
    } == 0
    {
        return Err(SandboxError::windows(
            "worker-stdio-failed",
            "prepare-worker-stdio",
            "SetStdHandle(STD_ERROR_HANDLE) failed",
            unsafe { windows_sys::Win32::Foundation::GetLastError() },
        ));
    }
    Ok(Some(WorkerStdio {
        _stdout: stdout,
        _stderr: stderr,
    }))
}

fn write_worker_bootstrap_error(error: &SandboxError) {
    let Some(stderr_path) = std::env::var_os("LOBSTER_SANDBOX_WORKER_STDERR") else {
        return;
    };
    let response = RunnerErrorResponse {
        protocol_version: NATIVE_SANDBOX_PROTOCOL_VERSION,
        ok: false,
        code: error.code.to_string(),
        stage: error.stage.to_string(),
        message: error.message.clone(),
        windows_error: error.windows_error,
    };
    if let Ok(json) = serde_json::to_vec(&response) {
        let _ = fs::write(stderr_path, json);
    }
}

fn installation_error(error: InstallationError) -> SandboxError {
    SandboxError {
        code: error.code,
        stage: error.stage,
        message: error.message,
        windows_error: error.windows_error,
    }
}

fn dev_direct_mode() -> bool {
    cfg!(debug_assertions)
        && std::env::var("LOBSTER_NATIVE_SANDBOX_DEV_DIRECT").as_deref() == Ok("1")
}

fn read_request(path: &Path) -> Result<RunRequest, SandboxError> {
    let contents = if path == Path::new("-") {
        let mut contents = String::new();
        io::stdin().read_to_string(&mut contents).map_err(|error| {
            SandboxError::new(
                "request-read-failed",
                "read-request",
                format!("could not read request from stdin: {error}"),
            )
        })?;
        contents
    } else {
        fs::read_to_string(path).map_err(|error| {
            SandboxError::new(
                "request-read-failed",
                "read-request",
                format!("could not read {}: {error}", path.display()),
            )
        })?
    };
    serde_json::from_str(&contents).map_err(|error| {
        SandboxError::new(
            "request-json-invalid",
            "read-request",
            format!("request is not valid JSON: {error}"),
        )
    })
}

fn print_json<T: serde::Serialize>(value: &T, to_stderr: bool) -> Result<(), SandboxError> {
    let json = serde_json::to_string(value).map_err(|error| {
        SandboxError::new(
            "response-json-failed",
            "write-response",
            format!("could not serialize response: {error}"),
        )
    })?;
    let worker_bridge = if to_stderr {
        std::env::var_os("LOBSTER_SANDBOX_WORKER_STDERR")
    } else {
        std::env::var_os("LOBSTER_SANDBOX_WORKER_STDOUT")
    };
    if let Some(worker_bridge) = worker_bridge {
        let contents = if to_stderr {
            format!("LOBSTER_SANDBOX_REPORT {json}\n")
        } else {
            format!("{json}\n")
        };
        fs::write(worker_bridge, contents).map_err(|error| {
            SandboxError::new(
                "response-write-failed",
                "write-response",
                format!("could not write the worker control response: {error}"),
            )
        })?;
        return Ok(());
    }
    if to_stderr {
        eprintln!("LOBSTER_SANDBOX_REPORT {json}");
    } else {
        println!("{json}");
    }
    Ok(())
}

fn print_execution_report<T: serde::Serialize>(
    value: &T,
    report_file: Option<&Path>,
) -> Result<(), SandboxError> {
    if let Some(report_file) = report_file {
        let json = serde_json::to_vec(value).map_err(|error| {
            SandboxError::new(
                "response-json-failed",
                "write-response",
                format!("could not serialize response: {error}"),
            )
        })?;
        fs::write(report_file, json).map_err(|error| {
            SandboxError::new(
                "response-write-failed",
                "write-response",
                format!("could not write {}: {error}", report_file.display()),
            )
        })?;
        return Ok(());
    }
    print_json(value, true)
}

fn print_error(error: &SandboxError) {
    let response = RunnerErrorResponse {
        protocol_version: NATIVE_SANDBOX_PROTOCOL_VERSION,
        ok: false,
        code: error.code.to_string(),
        stage: error.stage.to_string(),
        message: error.message.clone(),
        windows_error: error.windows_error,
    };
    match serde_json::to_string(&response) {
        Ok(json) => {
            if let Some(stderr_path) = std::env::var_os("LOBSTER_SANDBOX_WORKER_STDERR") {
                let _ = fs::write(stderr_path, format!("{json}\n"));
            } else {
                eprintln!("{json}");
            }
        }
        Err(_) => eprintln!(
            "{{\"protocolVersion\":{},\"ok\":false,\"code\":\"response-json-failed\"}}",
            NATIVE_SANDBOX_PROTOCOL_VERSION
        ),
    }
}
