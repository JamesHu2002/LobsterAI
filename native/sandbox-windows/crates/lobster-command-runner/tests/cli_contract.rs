#![cfg(windows)]

use std::collections::BTreeMap;
use std::fmt::Debug;
use std::process::Command;

use lobster_sandbox_core::{cleanup, verify};
use lobster_sandbox_protocol::{
    ExecutionOutcome, ExecutionReport, NATIVE_SANDBOX_POLICY_VERSION,
    NATIVE_SANDBOX_PROTOCOL_VERSION, NetworkMode, RunRequest, RunnerErrorResponse, SandboxCommand,
    SandboxHostProfile, SandboxPolicySnapshot, SandboxProfileMode, SandboxResourceLimits,
    VerificationReport,
};

const REPORT_PREFIX: &str = "LOBSTER_SANDBOX_REPORT ";

#[test]
fn malformed_request_returns_a_machine_readable_error() {
    let directory = must(tempfile::tempdir(), "create temp directory");
    let request = directory.path().join("invalid.json");
    must(std::fs::write(&request, "{}"), "write invalid request");

    let output = must(
        Command::new(env!("CARGO_BIN_EXE_lobster-command-runner"))
            .env("LOBSTER_NATIVE_SANDBOX_DEV_DIRECT", "1")
            .arg("verify")
            .arg(&request)
            .output(),
        "run command runner",
    );
    assert_eq!(output.status.code(), Some(70));
    let response: RunnerErrorResponse = must(
        serde_json::from_slice(&output.stderr),
        "parse runner error response",
    );
    assert!(!response.ok);
    assert_eq!(response.code, "request-json-invalid");
    assert_eq!(response.stage, "read-request");
}

#[test]
fn json_cli_verifies_runs_and_cleans_up_a_workspace() {
    let workspace = must(tempfile::tempdir(), "create workspace");
    let profile = create_host_profile(workspace.path());
    let request_path = workspace.path().join("request.json");
    let request = RunRequest {
        protocol_version: NATIVE_SANDBOX_PROTOCOL_VERSION,
        policy: SandboxPolicySnapshot {
            policy_version: NATIVE_SANDBOX_POLICY_VERSION.to_string(),
            task_id: "cli-contract".to_string(),
            agent_id: "main".to_string(),
            cwd: workspace.path().display().to_string(),
            writable_roots: vec![workspace.path().display().to_string()],
            readable_roots: Vec::new(),
            protected_paths: Vec::new(),
            profile,
            scratch_dir: workspace.path().join(".scratch").display().to_string(),
            network_mode: NetworkMode::Disabled,
            limits: SandboxResourceLimits::default(),
        },
        command: SandboxCommand {
            argv: vec![
                "cmd.exe".to_string(),
                "/d".to_string(),
                "/c".to_string(),
                "echo cli>cli-result.txt".to_string(),
            ],
            env: BTreeMap::new(),
        },
    };
    must(
        std::fs::write(
            &request_path,
            must(serde_json::to_vec(&request), "serialize request"),
        ),
        "write request",
    );

    let verify_output = invoke("verify", &request_path);
    assert!(verify_output.status.success());
    let verification: VerificationReport = must(
        serde_json::from_slice(&verify_output.stdout),
        "parse verification report",
    );
    assert!(verification.write_restricted);
    assert!(!verification.production_ready);

    let run_output = invoke("run", &request_path);
    assert!(run_output.status.success());
    let stderr = String::from_utf8_lossy(&run_output.stderr);
    let report_json = stderr
        .lines()
        .find_map(|line| line.strip_prefix(REPORT_PREFIX))
        .unwrap_or_else(|| panic!("run output should contain a report: {stderr}"));
    let report: ExecutionReport = must(serde_json::from_str(report_json), "parse execution report");
    assert_eq!(report.outcome, ExecutionOutcome::Completed);
    assert_eq!(report.exit_code, Some(0));
    assert_eq!(
        must(
            std::fs::read_to_string(workspace.path().join("cli-result.txt")),
            "read CLI-created file",
        )
        .trim(),
        "cli",
    );

    let cleanup_output = invoke("cleanup", &request_path);
    assert!(cleanup_output.status.success());
}

#[test]
fn run_can_write_the_machine_report_to_a_sidecar_without_polluting_stderr() {
    let workspace = must(tempfile::tempdir(), "create workspace");
    let profile = create_host_profile(workspace.path());
    let request_path = workspace.path().join("request.json");
    let report_path = workspace.path().join("report.json");
    let request = RunRequest {
        protocol_version: NATIVE_SANDBOX_PROTOCOL_VERSION,
        policy: SandboxPolicySnapshot {
            policy_version: NATIVE_SANDBOX_POLICY_VERSION.to_string(),
            task_id: "cli-sidecar".to_string(),
            agent_id: "main".to_string(),
            cwd: workspace.path().display().to_string(),
            writable_roots: vec![workspace.path().display().to_string()],
            readable_roots: Vec::new(),
            protected_paths: Vec::new(),
            profile,
            scratch_dir: workspace.path().join(".scratch").display().to_string(),
            network_mode: NetworkMode::Disabled,
            limits: SandboxResourceLimits::default(),
        },
        command: SandboxCommand {
            argv: vec![
                "cmd.exe".to_string(),
                "/d".to_string(),
                "/c".to_string(),
                "echo sidecar-out & echo sidecar-err 1>&2".to_string(),
            ],
            env: BTreeMap::new(),
        },
    };
    must(
        std::fs::write(
            &request_path,
            must(serde_json::to_vec(&request), "serialize request"),
        ),
        "write request",
    );
    must(verify(&request), "prepare sidecar request");

    let output = must(
        Command::new(env!("CARGO_BIN_EXE_lobster-command-runner"))
            .env("LOBSTER_NATIVE_SANDBOX_DEV_DIRECT", "1")
            .arg("run")
            .arg(&request_path)
            .arg("--report-file")
            .arg(&report_path)
            .output(),
        "run command runner with sidecar",
    );

    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("sidecar-out"));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("sidecar-err"));
    assert!(!stderr.contains(REPORT_PREFIX));
    let report: ExecutionReport = must(
        serde_json::from_slice(&must(std::fs::read(&report_path), "read sidecar")),
        "parse sidecar report",
    );
    assert_eq!(report.outcome, ExecutionOutcome::Completed);
    assert_eq!(report.exit_code, Some(0));
    must(cleanup(&request), "cleanup sidecar request");
}

fn invoke(command: &str, request: &std::path::Path) -> std::process::Output {
    must(
        Command::new(env!("CARGO_BIN_EXE_lobster-command-runner"))
            .env("LOBSTER_NATIVE_SANDBOX_DEV_DIRECT", "1")
            .arg(command)
            .arg(request)
            .output(),
        "run command runner",
    )
}

fn create_host_profile(root: &std::path::Path) -> SandboxHostProfile {
    let app_data = root.join("AppData").join("Roaming");
    let local_app_data = root.join("AppData").join("Local");
    must(std::fs::create_dir_all(&app_data), "create APPDATA");
    must(
        std::fs::create_dir_all(&local_app_data),
        "create LOCALAPPDATA",
    );
    SandboxHostProfile {
        mode: SandboxProfileMode::InheritHost,
        home_dir: root.display().to_string(),
        user_profile_dir: root.display().to_string(),
        app_data_dir: app_data.display().to_string(),
        local_app_data_dir: local_app_data.display().to_string(),
    }
}

fn must<T, E: Debug>(result: Result<T, E>, context: &str) -> T {
    match result {
        Ok(value) => value,
        Err(error) => panic!("{context}: {error:?}"),
    }
}
