#![cfg(windows)]

use std::collections::BTreeMap;
use std::fmt::Debug;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use lobster_sandbox_core::{cleanup, execute, verify};
use lobster_sandbox_protocol::{
    ExecutionOutcome, NATIVE_SANDBOX_POLICY_VERSION, NATIVE_SANDBOX_PROTOCOL_VERSION, NetworkMode,
    RunRequest, SandboxCommand, SandboxHostProfile, SandboxPolicySnapshot, SandboxProfileMode,
    SandboxResourceLimits,
};
use tempfile::TempDir;

static TEST_LOCK: Mutex<()> = Mutex::new(());

struct Fixture {
    workspace: TempDir,
    host_profile: TempDir,
    skills: TempDir,
    outside: TempDir,
    request: RunRequest,
}

impl Fixture {
    fn new() -> Self {
        let workspace = must(tempfile::tempdir(), "workspace tempdir");
        let host_profile = must(tempfile::tempdir(), "host profile tempdir");
        let skills = must(tempfile::tempdir(), "skills tempdir");
        let outside = must(tempfile::tempdir(), "outside tempdir");
        grant_broad_non_world_access(workspace.path());
        grant_broad_non_world_access(host_profile.path());
        grant_broad_non_world_access(skills.path());
        grant_broad_non_world_access(outside.path());
        let scratch = workspace.path().join(".lobster-scratch");
        let app_data = host_profile.path().join("AppData").join("Roaming");
        let local_app_data = host_profile.path().join("AppData").join("Local");
        must(std::fs::create_dir_all(&app_data), "create host APPDATA");
        must(
            std::fs::create_dir_all(&local_app_data),
            "create host LOCALAPPDATA",
        );
        let request = RunRequest {
            protocol_version: NATIVE_SANDBOX_PROTOCOL_VERSION,
            policy: SandboxPolicySnapshot {
                policy_version: NATIVE_SANDBOX_POLICY_VERSION.to_string(),
                task_id: "m1-boundary-test".to_string(),
                agent_id: "main".to_string(),
                cwd: display(workspace.path()),
                writable_roots: vec![display(workspace.path())],
                readable_roots: vec![display(skills.path())],
                protected_paths: Vec::new(),
                profile: SandboxHostProfile {
                    mode: SandboxProfileMode::InheritHost,
                    home_dir: display(host_profile.path()),
                    user_profile_dir: display(host_profile.path()),
                    app_data_dir: display(&app_data),
                    local_app_data_dir: display(&local_app_data),
                },
                scratch_dir: display(&scratch),
                network_mode: NetworkMode::Disabled,
                limits: SandboxResourceLimits {
                    timeout_ms: 60_000,
                    max_processes: 16,
                    max_output_bytes: 1024 * 1024,
                },
            },
            command: SandboxCommand {
                argv: vec![
                    "cmd.exe".to_string(),
                    "/d".to_string(),
                    "/c".to_string(),
                    "exit 0".to_string(),
                ],
                env: BTreeMap::new(),
            },
        };
        Self {
            workspace,
            host_profile,
            skills,
            outside,
            request,
        }
    }

    fn run(&mut self, argv: Vec<String>) -> lobster_sandbox_protocol::ExecutionReport {
        self.request.command.argv = argv;
        must(execute(&self.request), "sandbox command should start")
    }
}

#[test]
fn declared_skills_root_is_readable_but_not_writable() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut fixture = Fixture::new();
    let skill_file = fixture.skills.path().join("SKILL.md");
    must(
        std::fs::write(&skill_file, "skill-content"),
        "write skill fixture",
    );

    let read = fixture.run(vec![
        powershell_exe(),
        "-NoLogo".to_string(),
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-Command".to_string(),
        format!(
            "Get-Content -LiteralPath '{}' | Set-Content -LiteralPath 'skill-copy.txt'",
            powershell_literal(&skill_file),
        ),
    ]);
    assert_eq!(read.outcome, ExecutionOutcome::Completed);
    assert_eq!(read.exit_code, Some(0));
    assert_eq!(
        must(
            std::fs::read_to_string(fixture.workspace.path().join("skill-copy.txt")),
            "read copied skill",
        )
        .trim(),
        "skill-content",
    );

    let denied_path = fixture.skills.path().join("generated.txt");
    let write = fixture.run(vec![
        powershell_exe(),
        "-NoLogo".to_string(),
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-Command".to_string(),
        format!(
            "$ErrorActionPreference='Stop'; Set-Content -LiteralPath '{}' -Value 'denied'",
            powershell_literal(&denied_path),
        ),
    ]);
    assert_eq!(write.outcome, ExecutionOutcome::Completed);
    assert_ne!(write.exit_code, Some(0));
    assert!(!denied_path.exists());
}

#[test]
fn profile_environment_inherits_host_paths_without_granting_profile_write() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut fixture = Fixture::new();
    let profile_file = fixture.host_profile.path().join("profile-value.txt");
    must(
        std::fs::write(&profile_file, "host-value"),
        "write host profile fixture",
    );
    let read = fixture.run(vec![
        powershell_exe(),
        "-NoLogo".to_string(),
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-Command".to_string(),
        "$value = Get-Content -LiteralPath (Join-Path $env:USERPROFILE 'profile-value.txt'); Set-Content -LiteralPath 'profile-copy.txt' -Value $value".to_string(),
    ]);
    assert_eq!(read.outcome, ExecutionOutcome::Completed);
    assert_eq!(read.exit_code, Some(0));
    assert_eq!(
        must(
            std::fs::read_to_string(fixture.workspace.path().join("profile-copy.txt")),
            "read copied profile value",
        )
        .trim(),
        "host-value",
    );
    let write = fixture.run(vec![
        powershell_exe(),
        "-NoLogo".to_string(),
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-Command".to_string(),
        "$ErrorActionPreference='Stop'; Set-Content -LiteralPath (Join-Path $env:HOME 'profile-value.txt') -Value 'changed'".to_string(),
    ]);
    assert_eq!(write.outcome, ExecutionOutcome::Completed);
    assert_ne!(write.exit_code, Some(0));
    assert_eq!(
        must(
            std::fs::read_to_string(profile_file),
            "read unchanged host profile"
        )
        .trim(),
        "host-value",
    );
}

#[test]
fn explicit_shared_cache_root_is_writable_without_opening_local_app_data() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut fixture = Fixture::new();
    let local_app_data = fixture.host_profile.path().join("AppData").join("Local");
    let npm_cache = local_app_data.join("npm-cache");
    let unrelated = local_app_data.join("unrelated");
    must(std::fs::create_dir_all(&npm_cache), "create npm cache");
    must(
        std::fs::create_dir_all(&unrelated),
        "create unrelated cache",
    );
    fixture
        .request
        .policy
        .writable_roots
        .push(display(&npm_cache));

    let allowed = fixture.run(vec![
        powershell_exe(),
        "-NoLogo".to_string(),
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-Command".to_string(),
        "Set-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'npm-cache\\sandbox.txt') -Value 'cached'".to_string(),
    ]);
    assert_eq!(allowed.outcome, ExecutionOutcome::Completed);
    assert_eq!(allowed.exit_code, Some(0));
    assert!(npm_cache.join("sandbox.txt").exists());

    let denied = fixture.run(vec![
        powershell_exe(),
        "-NoLogo".to_string(),
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-Command".to_string(),
        "$ErrorActionPreference='Stop'; Set-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'unrelated\\sandbox.txt') -Value 'denied'".to_string(),
    ]);
    assert_eq!(denied.outcome, ExecutionOutcome::Completed);
    assert_ne!(denied.exit_code, Some(0));
    assert!(!unrelated.join("sandbox.txt").exists());
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = cleanup(&self.request);
    }
}

#[test]
fn existing_workspace_is_writable_but_another_user_directory_is_not() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut fixture = Fixture::new();
    let verification = must(verify(&fixture.request), "sandbox should verify");
    assert!(verification.restricted_token);
    assert!(verification.write_restricted);
    assert!(verification.owner_preserved);
    assert!(!verification.network_isolated);
    assert!(!verification.read_isolated);
    assert!(!verification.production_ready);
    must(
        std::fs::write(
            fixture.workspace.path().join("normal-user.txt"),
            "still-writable",
        ),
        "signed-in user should retain normal workspace access",
    );

    let inside = fixture.workspace.path().join("inside.txt");
    let inside_report = fixture.run(vec![
        "cmd.exe".to_string(),
        "/d".to_string(),
        "/c".to_string(),
        "echo inside>inside.txt".to_string(),
    ]);
    assert_eq!(inside_report.outcome, ExecutionOutcome::Completed);
    assert_eq!(inside_report.exit_code, Some(0));
    assert_eq!(
        must(std::fs::read_to_string(&inside), "inside file should exist",).trim(),
        "inside",
    );

    let outside = fixture.outside.path().join("outside.txt");
    let outside_report = fixture.run(vec![
        "cmd.exe".to_string(),
        "/d".to_string(),
        "/c".to_string(),
        format!("echo denied>{}", outside.display()),
    ]);
    assert_eq!(outside_report.outcome, ExecutionOutcome::Completed);
    assert_ne!(outside_report.exit_code, Some(0));
    assert!(!outside.exists(), "outside write must not create a file");
}

#[test]
fn powershell_child_process_cannot_escape_the_workspace() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut fixture = Fixture::new();
    let inside = fixture.workspace.path().join("child-inside.txt");
    let outside = fixture.outside.path().join("child-outside.txt");
    let command = format!(
        "$inside = '{}'; $outside = '{}'; \
         & cmd.exe /d /c \"echo child-inside>$inside\"; \
         & cmd.exe /d /c \"echo child-outside>$outside\"; \
         if (Test-Path -LiteralPath $outside) {{ exit 9 }}; \
         if (-not (Test-Path -LiteralPath $inside)) {{ exit 8 }}; \
         exit 0",
        powershell_literal(&inside),
        powershell_literal(&outside),
    );
    let report = fixture.run(vec![
        powershell_exe(),
        "-NoLogo".to_string(),
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-Command".to_string(),
        command,
    ]);
    assert_eq!(report.outcome, ExecutionOutcome::Completed);
    assert_eq!(report.exit_code, Some(0));
    assert!(inside.exists(), "child should write inside workspace");
    assert!(
        !outside.exists(),
        "child process must not write outside workspace"
    );
}

#[test]
fn junction_escape_and_protected_path_writes_are_denied() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut fixture = Fixture::new();
    let junction = fixture.workspace.path().join("escape");
    let junction_status = must(
        Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction)
            .arg(fixture.outside.path())
            .status(),
        "create junction",
    );
    assert!(junction_status.success(), "junction setup should succeed");

    let escaped = fixture.outside.path().join("junction-write.txt");
    let junction_report = fixture.run(vec![
        "cmd.exe".to_string(),
        "/d".to_string(),
        "/c".to_string(),
        "echo escaped>escape\\junction-write.txt".to_string(),
    ]);
    assert_eq!(junction_report.outcome, ExecutionOutcome::Completed);
    assert_ne!(junction_report.exit_code, Some(0));
    assert!(!escaped.exists(), "junction target must remain unchanged");

    let protected = fixture.workspace.path().join(".git");
    must(std::fs::create_dir_all(&protected), "create protected path");
    must(
        std::fs::write(protected.join("readable.txt"), "readable"),
        "create protected fixture",
    );
    fixture.request.policy.protected_paths = vec![display(&protected)];
    let readable_report = fixture.run(vec![
        "cmd.exe".to_string(),
        "/d".to_string(),
        "/c".to_string(),
        "type .git\\readable.txt>protected-read-copy.txt".to_string(),
    ]);
    assert_eq!(readable_report.outcome, ExecutionOutcome::Completed);
    assert_eq!(readable_report.exit_code, Some(0));
    assert_eq!(
        must(
            std::fs::read_to_string(fixture.workspace.path().join("protected-read-copy.txt")),
            "read protected path",
        ),
        "readable",
    );
    let protected_report = fixture.run(vec![
        "cmd.exe".to_string(),
        "/d".to_string(),
        "/c".to_string(),
        "echo denied>.git\\sandbox-write.txt".to_string(),
    ]);
    assert_eq!(protected_report.outcome, ExecutionOutcome::Completed);
    assert_ne!(protected_report.exit_code, Some(0));
    assert!(
        !protected.join("sandbox-write.txt").exists(),
        "protected path must remain read-only",
    );
}

#[test]
fn node_python_and_npm_use_the_same_write_boundary() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut fixture = Fixture::new();
    let outside_node = fixture.outside.path().join("node-outside.txt");
    if let Some(node) = find_executable("node.exe") {
        let script = format!(
            "const fs=require('fs');\
             fs.writeFileSync('node-inside.txt','ok');\
             try{{fs.writeFileSync({:?},'bad');process.exit(9)}}\
             catch(error){{if(!['EPERM','EACCES'].includes(error.code))throw error}}",
            display(&outside_node),
        );
        let report = fixture.run(vec![node, "-e".to_string(), script]);
        assert_eq!(report.outcome, ExecutionOutcome::Completed);
        assert_eq!(report.exit_code, Some(0));
        assert!(fixture.workspace.path().join("node-inside.txt").exists());
        assert!(!outside_node.exists());
    }

    let outside_python = fixture.outside.path().join("python-outside.txt");
    if let Some(python) = find_executable("python.exe") {
        let script = format!(
            "from pathlib import Path\n\
             Path('python-inside.txt').write_text('ok')\n\
             try:\n    Path({:?}).write_text('bad')\n    raise SystemExit(9)\n\
             except PermissionError:\n    pass\n",
            display(&outside_python),
        );
        let report = fixture.run(vec![python, "-c".to_string(), script]);
        assert_eq!(report.outcome, ExecutionOutcome::Completed);
        assert_eq!(report.exit_code, Some(0));
        assert!(fixture.workspace.path().join("python-inside.txt").exists());
        assert!(!outside_python.exists());
    }

    if find_executable("npm.cmd").is_some() {
        must(
            std::fs::write(
                fixture.workspace.path().join("package.json"),
                r#"{"private":true,"scripts":{"test":"node -e \"require('fs').writeFileSync('npm-test.txt','ok')\""}}"#,
            ),
            "create npm smoke package",
        );
        let report = fixture.run(vec![
            "cmd.exe".to_string(),
            "/d".to_string(),
            "/c".to_string(),
            "npm.cmd test --silent".to_string(),
        ]);
        assert_eq!(report.outcome, ExecutionOutcome::Completed);
        assert_eq!(report.exit_code, Some(0));
        assert!(fixture.workspace.path().join("npm-test.txt").exists());
    }
}

#[test]
fn timeout_terminates_the_complete_process_tree() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut fixture = Fixture::new();
    fixture.request.policy.limits.timeout_ms = 500;
    let report = fixture.run(vec![
        "cmd.exe".to_string(),
        "/d".to_string(),
        "/c".to_string(),
        "start \"\" /b cmd.exe /d /c \"ping -n 3 127.0.0.1 >nul & echo late>late.txt\" & ping -n 31 127.0.0.1 >nul".to_string(),
    ]);
    assert_eq!(report.outcome, ExecutionOutcome::TimedOut);
    std::thread::sleep(std::time::Duration::from_secs(3));
    assert!(
        !fixture.workspace.path().join("late.txt").exists(),
        "a descendant must not survive timeout",
    );
}

#[test]
fn invalid_cwd_policy_fails_before_creating_scratch() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut fixture = Fixture::new();
    let scratch = fixture.outside.path().join("must-not-exist");
    fixture.request.policy.cwd = display(fixture.outside.path());
    fixture.request.policy.scratch_dir = display(&scratch);
    let error = match verify(&fixture.request) {
        Ok(_) => panic!("invalid cwd policy should fail"),
        Err(error) => error,
    };
    assert_eq!(error.code, "cwd-outside-writable-roots");
    assert!(!scratch.exists(), "invalid policy must not create scratch");
}

#[test]
fn read_only_roots_must_not_overlap_writable_roots() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut fixture = Fixture::new();
    fixture.request.policy.readable_roots = vec![display(fixture.workspace.path())];
    let error = match verify(&fixture.request) {
        Ok(_) => panic!("overlapping root policy should fail"),
        Err(error) => error,
    };
    assert_eq!(error.code, "readable-root-overlaps-writable-root");
}

fn powershell_exe() -> String {
    let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    PathBuf::from(system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
        .display()
        .to_string()
}

fn powershell_literal(path: &Path) -> String {
    display(path).replace('\'', "''")
}

fn display(path: &Path) -> String {
    path.display().to_string()
}

fn grant_broad_non_world_access(path: &Path) {
    for sid in ["*S-1-5-32-545", "*S-1-5-11"] {
        let output = must(
            Command::new("icacls.exe")
                .arg(path)
                .arg("/grant")
                .arg(format!("{sid}:(OI)(CI)F"))
                .output(),
            "run icacls",
        );
        assert!(
            output.status.success(),
            "icacls should grant {sid} on {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr),
        );
    }
}

fn find_executable(name: &str) -> Option<String> {
    let output = Command::new("where.exe").arg(name).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn must<T, E: Debug>(result: Result<T, E>, context: &str) -> T {
    match result {
        Ok(value) => value,
        Err(error) => panic!("{context}: {error:?}"),
    }
}
