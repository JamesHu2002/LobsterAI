mod acl;
mod attributes;
mod capability;
mod handle;
mod job;
mod path_policy;
mod process;
mod token;
mod wide;

use std::time::Instant;

use lobster_sandbox_protocol::{
    ExecutionReport, NATIVE_SANDBOX_POLICY_VERSION, NATIVE_SANDBOX_PROTOCOL_VERSION, RunRequest,
    VerificationReport,
};

use crate::{SandboxError, SandboxResult};
use acl::{apply_policy_acl, revoke_policy_acl};
use capability::CapabilitySid;
use path_policy::{PreparedPolicy, prepare_policy};
use process::run_restricted_process;
use token::RestrictedToken;

struct PreparedSandbox {
    policy: PreparedPolicy,
    capabilities: Vec<CapabilitySid>,
}

fn prepare(request: &RunRequest) -> SandboxResult<PreparedSandbox> {
    request.validate().map_err(|error| {
        SandboxError::new("protocol-invalid", "validate-request", error.to_string())
    })?;
    let policy = prepare_policy(&request.policy)?;
    let capabilities = policy
        .writable_roots
        .iter()
        .map(|root| CapabilitySid::for_path(root))
        .collect::<SandboxResult<Vec<_>>>()?;
    apply_policy_acl(&policy, &capabilities)?;
    Ok(PreparedSandbox {
        policy,
        capabilities,
    })
}

pub fn verify(request: &RunRequest) -> SandboxResult<VerificationReport> {
    let prepared = prepare(request)?;
    let token = RestrictedToken::create(&prepared.capabilities)?;
    let diagnostics = token.diagnostics(&prepared.capabilities)?;
    Ok(VerificationReport {
        protocol_version: NATIVE_SANDBOX_PROTOCOL_VERSION,
        policy_version: NATIVE_SANDBOX_POLICY_VERSION.to_string(),
        capability_sids: prepared
            .capabilities
            .iter()
            .map(|capability| capability.text().to_string())
            .collect(),
        writable_roots: prepared
            .policy
            .writable_roots
            .iter()
            .map(|path| path.display().to_string())
            .collect(),
        protected_paths: prepared
            .policy
            .protected_paths
            .iter()
            .map(|path| path.display().to_string())
            .collect(),
        restricted_token: diagnostics.restricted_sid_count >= prepared.capabilities.len() as u32,
        write_restricted: true,
        owner_preserved: true,
        network_isolated: false,
        read_isolated: false,
        production_ready: false,
    })
}

pub fn execute(request: &RunRequest) -> SandboxResult<ExecutionReport> {
    let started_at = Instant::now();
    let prepared = prepare(request)?;
    let token = RestrictedToken::create(&prepared.capabilities)?;
    let result = run_restricted_process(token.raw(), &prepared.policy, &request.command)?;
    Ok(ExecutionReport {
        protocol_version: NATIVE_SANDBOX_PROTOCOL_VERSION,
        outcome: result.outcome,
        exit_code: result.exit_code,
        duration_ms: started_at.elapsed().as_millis() as u64,
        output_bytes: result.output_bytes,
        capability_sids: prepared
            .capabilities
            .iter()
            .map(|capability| capability.text().to_string())
            .collect(),
        writable_roots: prepared
            .policy
            .writable_roots
            .iter()
            .map(|path| path.display().to_string())
            .collect(),
    })
}

pub fn cleanup(request: &RunRequest) -> SandboxResult<()> {
    request.validate().map_err(|error| {
        SandboxError::new("protocol-invalid", "validate-request", error.to_string())
    })?;
    let policy = prepare_policy(&request.policy)?;
    let capabilities = policy
        .writable_roots
        .iter()
        .map(|root| CapabilitySid::for_path(root))
        .collect::<SandboxResult<Vec<_>>>()?;
    revoke_policy_acl(&policy, &capabilities)
}
