use std::path::Path;

use clap::{Parser, Subcommand};
use lobster_sandbox_installation::{
    ElevationDisposition, InstallationError, InstallationPaths, SetupOperation, SetupReport,
    bootstrap_directory, elevate_and_wait, ensure_setup_caller_authorized,
    harden_current_process_dll_search, is_process_elevated, perform_operation,
    protect_setup_result, validate_setup_owner_sid, write_elevated_result,
};

#[derive(Debug, Parser)]
#[command(
    name = "lobster-sandbox-setup",
    version,
    about = "LobsterAI Windows Sandbox fixed-operation setup helper"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
    #[arg(long, global = true, hide = true)]
    elevated: bool,
    #[arg(long, global = true, hide = true)]
    owner_sid: Option<String>,
    #[arg(long, global = true, hide = true)]
    request_id: Option<String>,
    #[arg(long, global = true)]
    require_signature: bool,
}

#[derive(Clone, Copy, Debug, Subcommand)]
enum Command {
    Install,
    Verify,
    Repair,
    Upgrade,
    Rollback,
    Uninstall,
}

fn main() {
    let cli = Cli::parse();
    let operation = cli.command.operation();
    let mut report = match run(&cli) {
        Ok(report) => report,
        Err(error) => error_report(operation, error),
    };
    report.request_id.clone_from(&cli.request_id);
    if operation != SetupOperation::Verify || !report.success {
        lobster_sandbox_installation::record_setup_audit(&report);
    }
    if cli.elevated {
        let _ = write_elevated_result(&report);
        let owner_sid = cli
            .owner_sid
            .as_deref()
            .map(validate_setup_owner_sid)
            .transpose();
        if let Ok(Some(owner_sid)) = owner_sid {
            let account_sid = (!report.identity.account_sid.is_empty())
                .then_some(report.identity.account_sid.as_str());
            let paths = InstallationPaths::discover();
            let _ = protect_setup_result(&paths, &owner_sid, account_sid);
        }
    }
    match serde_json::to_string(&report) {
        Ok(json) => println!("{json}"),
        Err(_) => println!(
            "{{\"schemaVersion\":1,\"operation\":\"verify\",\"success\":false,\"errorCode\":\"setup-result-invalid\"}}"
        ),
    }
    std::process::exit(if report.success {
        0
    } else if report.cancelled {
        2
    } else {
        1
    });
}

fn run(cli: &Cli) -> Result<SetupReport, InstallationError> {
    harden_current_process_dll_search()?;
    ensure_setup_caller_authorized()?;
    let operation = cli.command.operation();
    if operation == SetupOperation::Verify {
        return Ok(perform_operation(
            operation,
            None,
            cli.require_signature,
            None,
        ));
    }
    let executable = std::env::current_exe().map_err(|error| {
        InstallationError::new(
            "setup-path-unavailable",
            "prepare-installation",
            format!("could not resolve setup executable: {error}"),
        )
    })?;
    if !cli.elevated {
        let owner_sid =
            validate_setup_owner_sid(&lobster_sandbox_installation::current_user_sid()?)?;
        return match elevate_and_wait(&executable, operation, cli.require_signature, &owner_sid)? {
            ElevationDisposition::AlreadyElevated => {
                run_elevated(operation, &executable, cli, &owner_sid)
            }
            ElevationDisposition::Completed(report) => Ok(*report),
        };
    }
    if !is_process_elevated()? {
        return Err(InstallationError::new(
            "setup-elevation-invalid",
            "request-elevation",
            "the internal elevated flag cannot bypass Windows administrator approval",
        ));
    }
    let owner_sid = match cli.owner_sid.as_deref() {
        Some(owner_sid) => validate_setup_owner_sid(owner_sid)?,
        None => validate_setup_owner_sid(&lobster_sandbox_installation::current_user_sid()?)?,
    };
    run_elevated(operation, &executable, cli, &owner_sid)
}

fn run_elevated(
    operation: SetupOperation,
    executable: &Path,
    cli: &Cli,
    owner_sid: &str,
) -> Result<SetupReport, InstallationError> {
    let source = bootstrap_directory(executable);
    Ok(perform_operation(
        operation,
        matches!(
            operation,
            SetupOperation::Install | SetupOperation::Repair | SetupOperation::Upgrade
        )
        .then_some(source.as_path()),
        cli.require_signature,
        Some(owner_sid),
    ))
}

fn error_report(operation: SetupOperation, error: InstallationError) -> SetupReport {
    let paths = InstallationPaths::discover();
    let mut report = SetupReport::empty(operation, &paths.display_root());
    report.cancelled = error.cancelled;
    report.error_code = Some(error.code.to_string());
    report.message = Some(error.message);
    report
}

impl Command {
    fn operation(self) -> SetupOperation {
        match self {
            Self::Install => SetupOperation::Install,
            Self::Verify => SetupOperation::Verify,
            Self::Repair => SetupOperation::Repair,
            Self::Upgrade => SetupOperation::Upgrade,
            Self::Rollback => SetupOperation::Rollback,
            Self::Uninstall => SetupOperation::Uninstall,
        }
    }
}
