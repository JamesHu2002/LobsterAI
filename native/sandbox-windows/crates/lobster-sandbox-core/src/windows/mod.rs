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
    writable_capability_count: usize,
}

fn resolve(request: &RunRequest) -> SandboxResult<PreparedSandbox> {
    request.validate().map_err(|error| {
        SandboxError::new("protocol-invalid", "validate-request", error.to_string())
    })?;
    let policy = prepare_policy(&request.policy)?;
    let writable_capabilities = policy
        .writable_roots
        .iter()
        .map(|root| CapabilitySid::for_path(root))
        .collect::<SandboxResult<Vec<_>>>()?;
    let readable_capabilities = policy
        .readable_roots
        .iter()
        .map(|root| CapabilitySid::for_path(root))
        .collect::<SandboxResult<Vec<_>>>()?;
    let writable_capability_count = writable_capabilities.len();
    let mut capabilities = writable_capabilities;
    capabilities.extend(readable_capabilities);
    Ok(PreparedSandbox {
        policy,
        capabilities,
        writable_capability_count,
    })
}

pub fn prepare(request: &RunRequest, sandbox_identity_sid: Option<&str>) -> SandboxResult<()> {
    let prepared = resolve(request)?;
    let (writable_capabilities, readable_capabilities) = prepared
        .capabilities
        .split_at(prepared.writable_capability_count);
    // ACL mutation belongs to policy preparation. The ACEs persist for the runtime cycle and
    // are revoked by cleanup(), so command execution must not propagate the same inherited ACEs
    // through large roots (for example npm-cache) on every exec call.
    let sandbox_identity = sandbox_identity_sid
        .map(|sid| CapabilitySid::from_text(sid.to_string()))
        .transpose()?;
    apply_policy_acl(
        &prepared.policy,
        writable_capabilities,
        readable_capabilities,
        sandbox_identity.as_ref(),
    )?;
    Ok(())
}

pub fn verify_prepared(
    request: &RunRequest,
    dedicated_identity: bool,
    network_isolated: bool,
    runtime_integrity_verified: bool,
) -> SandboxResult<VerificationReport> {
    let prepared = resolve(request)?;
    let (writable_capabilities, readable_capabilities) = prepared
        .capabilities
        .split_at(prepared.writable_capability_count);
    let token = RestrictedToken::create(writable_capabilities, readable_capabilities)?;
    let diagnostics = token.diagnostics(writable_capabilities, readable_capabilities)?;
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
        readable_roots: prepared
            .policy
            .readable_roots
            .iter()
            .map(|path| path.display().to_string())
            .collect(),
        protected_paths: prepared
            .policy
            .protected_paths
            .iter()
            .map(|path| path.display().to_string())
            .collect(),
        profile_mode: prepared.policy.profile.mode,
        restricted_token: diagnostics.restricted_sid_count >= prepared.capabilities.len() as u32,
        write_restricted: true,
        owner_preserved: true,
        dedicated_identity,
        runtime_integrity_verified,
        network_isolated,
        read_isolated: false,
        // M3 proves the hardened runtime boundary. Product release readiness still depends on
        // the M4/M5 audit, upgrade, packaging, and security-review gates.
        production_ready: false,
    })
}

pub fn verify(request: &RunRequest) -> SandboxResult<VerificationReport> {
    prepare(request, None)?;
    verify_prepared(request, false, false, false)
}

pub fn execute(request: &RunRequest) -> SandboxResult<ExecutionReport> {
    let started_at = Instant::now();
    // Re-resolve and validate every path for each command, but consume the ACL capabilities that
    // verify() prepared for this runtime cycle instead of rewriting persistent directory ACLs.
    // Missing preparation therefore fails closed at the Windows access check.
    let prepared = resolve(request)?;
    let (writable_capabilities, readable_capabilities) = prepared
        .capabilities
        .split_at(prepared.writable_capability_count);
    let token = RestrictedToken::create(writable_capabilities, readable_capabilities)?;
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

pub fn cleanup_with_identity(
    request: &RunRequest,
    sandbox_identity_sid: Option<&str>,
) -> SandboxResult<()> {
    request.validate().map_err(|error| {
        SandboxError::new("protocol-invalid", "validate-request", error.to_string())
    })?;
    let policy = prepare_policy(&request.policy)?;
    let writable_capabilities = policy
        .writable_roots
        .iter()
        .map(|root| CapabilitySid::for_path(root))
        .collect::<SandboxResult<Vec<_>>>()?;
    let readable_capabilities = policy
        .readable_roots
        .iter()
        .map(|root| CapabilitySid::for_path(root))
        .collect::<SandboxResult<Vec<_>>>()?;
    let sandbox_identity = sandbox_identity_sid
        .map(|sid| CapabilitySid::from_text(sid.to_string()))
        .transpose()?;
    revoke_policy_acl(
        &policy,
        &writable_capabilities,
        &readable_capabilities,
        sandbox_identity.as_ref(),
    )
}

pub fn cleanup(request: &RunRequest) -> SandboxResult<()> {
    cleanup_with_identity(request, None)
}
