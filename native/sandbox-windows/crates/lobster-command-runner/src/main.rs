use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use clap::{Parser, Subcommand};
use lobster_sandbox_core::{SandboxError, cleanup, execute, verify};
use lobster_sandbox_protocol::{
    ExecutionOutcome, NATIVE_SANDBOX_PROTOCOL_VERSION, RunRequest, RunnerErrorResponse,
};

#[derive(Debug, Parser)]
#[command(
    name = "lobster-command-runner",
    version,
    about = "LobsterAI Windows native sandbox M1 harness"
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
}

fn main() {
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
            let request = read_request(&request)?;
            let report = verify(&request)?;
            print_json(&report, false)?;
            Ok(0)
        }
        Command::Run {
            request,
            report_file,
        } => {
            let request = read_request(&request)?;
            let report = execute(&request)?;
            print_execution_report(&report, report_file.as_deref())?;
            Ok(match report.outcome {
                ExecutionOutcome::Completed => report.exit_code.unwrap_or(1).min(255) as i32,
                ExecutionOutcome::TimedOut => 124,
                ExecutionOutcome::Cancelled => 130,
                ExecutionOutcome::OutputLimitExceeded => 125,
            })
        }
        Command::Cleanup { request } => {
            let request = read_request(&request)?;
            cleanup(&request)?;
            println!(
                "{{\"protocolVersion\":{},\"ok\":true}}",
                NATIVE_SANDBOX_PROTOCOL_VERSION
            );
            Ok(0)
        }
    }
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
        Ok(json) => eprintln!("{json}"),
        Err(_) => eprintln!(
            "{{\"protocolVersion\":{},\"ok\":false,\"code\":\"response-json-failed\"}}",
            NATIVE_SANDBOX_PROTOCOL_VERSION
        ),
    }
}
