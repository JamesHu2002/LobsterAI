use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const NATIVE_SANDBOX_PROTOCOL_VERSION: u32 = 1;
pub const NATIVE_SANDBOX_POLICY_VERSION: &str = "workspace-write-v1";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub protocol_version: u32,
    pub policy: SandboxPolicySnapshot,
    pub command: SandboxCommand,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxPolicySnapshot {
    pub policy_version: String,
    pub task_id: String,
    pub agent_id: String,
    pub cwd: String,
    pub writable_roots: Vec<String>,
    #[serde(default)]
    pub readable_roots: Vec<String>,
    #[serde(default)]
    pub protected_paths: Vec<String>,
    pub scratch_dir: String,
    pub network_mode: NetworkMode,
    #[serde(default)]
    pub limits: SandboxResourceLimits,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxCommand {
    pub argv: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NetworkMode {
    Disabled,
    ManagedProxy,
    Allowlist,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxResourceLimits {
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_max_processes")]
    pub max_processes: u32,
    #[serde(default = "default_max_output_bytes")]
    pub max_output_bytes: u64,
}

impl Default for SandboxResourceLimits {
    fn default() -> Self {
        Self {
            timeout_ms: default_timeout_ms(),
            max_processes: default_max_processes(),
            max_output_bytes: default_max_output_bytes(),
        }
    }
}

const fn default_timeout_ms() -> u64 {
    120_000
}

const fn default_max_processes() -> u32 {
    64
}

const fn default_max_output_bytes() -> u64 {
    64 * 1024 * 1024
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutionOutcome {
    Completed,
    TimedOut,
    Cancelled,
    OutputLimitExceeded,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionReport {
    pub protocol_version: u32,
    pub outcome: ExecutionOutcome,
    pub exit_code: Option<u32>,
    pub duration_ms: u64,
    pub output_bytes: u64,
    pub capability_sids: Vec<String>,
    pub writable_roots: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationReport {
    pub protocol_version: u32,
    pub policy_version: String,
    pub capability_sids: Vec<String>,
    pub writable_roots: Vec<String>,
    pub protected_paths: Vec<String>,
    pub restricted_token: bool,
    pub write_restricted: bool,
    pub owner_preserved: bool,
    pub network_isolated: bool,
    pub read_isolated: bool,
    pub production_ready: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerErrorResponse {
    pub protocol_version: u32,
    pub ok: bool,
    pub code: String,
    pub stage: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub windows_error: Option<u32>,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum ProtocolValidationError {
    #[error("unsupported protocol version {received}; expected {expected}")]
    UnsupportedProtocol { expected: u32, received: u32 },
    #[error("unsupported policy version {0}")]
    UnsupportedPolicy(String),
    #[error("taskId must not be empty")]
    EmptyTaskId,
    #[error("agentId must not be empty")]
    EmptyAgentId,
    #[error("cwd must not be empty")]
    EmptyCwd,
    #[error("at least one writable root is required")]
    EmptyWritableRoots,
    #[error("scratchDir must not be empty")]
    EmptyScratchDir,
    #[error("path field is empty or contains a NUL byte: {0}")]
    InvalidPath(String),
    #[error("command argv must not be empty")]
    EmptyArgv,
    #[error("only networkMode=disabled is supported by the M1 runner")]
    UnsupportedNetworkMode,
    #[error("timeoutMs must be between 1 and 3600000")]
    InvalidTimeout,
    #[error("maxProcesses must be between 1 and 1024")]
    InvalidProcessLimit,
    #[error("maxOutputBytes must be between 1024 and 1073741824")]
    InvalidOutputLimit,
    #[error("environment variable name is invalid: {0}")]
    InvalidEnvironmentName(String),
    #[error("environment variable value contains a NUL byte: {0}")]
    InvalidEnvironmentValue(String),
    #[error("command argument at index {0} contains a NUL byte")]
    InvalidArgument(usize),
}

impl RunRequest {
    pub fn validate(&self) -> Result<(), ProtocolValidationError> {
        if self.protocol_version != NATIVE_SANDBOX_PROTOCOL_VERSION {
            return Err(ProtocolValidationError::UnsupportedProtocol {
                expected: NATIVE_SANDBOX_PROTOCOL_VERSION,
                received: self.protocol_version,
            });
        }
        if self.policy.policy_version != NATIVE_SANDBOX_POLICY_VERSION {
            return Err(ProtocolValidationError::UnsupportedPolicy(
                self.policy.policy_version.clone(),
            ));
        }
        if self.policy.task_id.trim().is_empty() {
            return Err(ProtocolValidationError::EmptyTaskId);
        }
        if self.policy.agent_id.trim().is_empty() {
            return Err(ProtocolValidationError::EmptyAgentId);
        }
        if self.policy.cwd.trim().is_empty() {
            return Err(ProtocolValidationError::EmptyCwd);
        }
        if self.policy.writable_roots.is_empty() {
            return Err(ProtocolValidationError::EmptyWritableRoots);
        }
        if self.policy.scratch_dir.trim().is_empty() {
            return Err(ProtocolValidationError::EmptyScratchDir);
        }
        validate_path("cwd", &self.policy.cwd)?;
        validate_path("scratchDir", &self.policy.scratch_dir)?;
        for (index, path) in self.policy.writable_roots.iter().enumerate() {
            validate_path(&format!("writableRoots[{index}]"), path)?;
        }
        for (index, path) in self.policy.readable_roots.iter().enumerate() {
            validate_path(&format!("readableRoots[{index}]"), path)?;
        }
        for (index, path) in self.policy.protected_paths.iter().enumerate() {
            validate_path(&format!("protectedPaths[{index}]"), path)?;
        }
        if self.command.argv.is_empty() || self.command.argv[0].trim().is_empty() {
            return Err(ProtocolValidationError::EmptyArgv);
        }
        for (index, argument) in self.command.argv.iter().enumerate() {
            if argument.contains('\0') {
                return Err(ProtocolValidationError::InvalidArgument(index));
            }
        }
        if self.policy.network_mode != NetworkMode::Disabled {
            return Err(ProtocolValidationError::UnsupportedNetworkMode);
        }
        if !(1..=3_600_000).contains(&self.policy.limits.timeout_ms) {
            return Err(ProtocolValidationError::InvalidTimeout);
        }
        if !(1..=1024).contains(&self.policy.limits.max_processes) {
            return Err(ProtocolValidationError::InvalidProcessLimit);
        }
        if !(1024..=1024 * 1024 * 1024).contains(&self.policy.limits.max_output_bytes) {
            return Err(ProtocolValidationError::InvalidOutputLimit);
        }
        for name in self.command.env.keys() {
            if !is_valid_environment_name(name) {
                return Err(ProtocolValidationError::InvalidEnvironmentName(
                    name.clone(),
                ));
            }
        }
        for (name, value) in &self.command.env {
            if value.contains('\0') {
                return Err(ProtocolValidationError::InvalidEnvironmentValue(
                    name.clone(),
                ));
            }
        }
        Ok(())
    }
}

fn is_valid_environment_name(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(first) if first == '_' || first.is_ascii_alphabetic())
        && chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn validate_path(field: &str, value: &str) -> Result<(), ProtocolValidationError> {
    if value.trim().is_empty() || value.contains('\0') {
        return Err(ProtocolValidationError::InvalidPath(field.to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> RunRequest {
        RunRequest {
            protocol_version: NATIVE_SANDBOX_PROTOCOL_VERSION,
            policy: SandboxPolicySnapshot {
                policy_version: NATIVE_SANDBOX_POLICY_VERSION.to_string(),
                task_id: "task-1".to_string(),
                agent_id: "main".to_string(),
                cwd: r"D:\workspace".to_string(),
                writable_roots: vec![r"D:\workspace".to_string()],
                readable_roots: Vec::new(),
                protected_paths: Vec::new(),
                scratch_dir: r"D:\workspace\.scratch".to_string(),
                network_mode: NetworkMode::Disabled,
                limits: SandboxResourceLimits::default(),
            },
            command: SandboxCommand {
                argv: vec![
                    "cmd.exe".to_string(),
                    "/c".to_string(),
                    "echo ok".to_string(),
                ],
                env: BTreeMap::new(),
            },
        }
    }

    #[test]
    fn validates_the_m1_contract() {
        assert_eq!(request().validate(), Ok(()));
    }

    #[test]
    fn rejects_future_protocol_versions() {
        let mut value = request();
        value.protocol_version += 1;
        assert_eq!(
            value.validate(),
            Err(ProtocolValidationError::UnsupportedProtocol {
                expected: NATIVE_SANDBOX_PROTOCOL_VERSION,
                received: NATIVE_SANDBOX_PROTOCOL_VERSION + 1,
            }),
        );
    }

    #[test]
    fn rejects_network_modes_not_implemented_by_m1() {
        let mut value = request();
        value.policy.network_mode = NetworkMode::Allowlist;
        assert_eq!(
            value.validate(),
            Err(ProtocolValidationError::UnsupportedNetworkMode),
        );
    }

    #[test]
    fn rejects_environment_names_that_can_corrupt_the_windows_block() {
        let mut value = request();
        value
            .command
            .env
            .insert("BAD=NAME".to_string(), "value".to_string());
        assert_eq!(
            value.validate(),
            Err(ProtocolValidationError::InvalidEnvironmentName(
                "BAD=NAME".to_string(),
            )),
        );
    }

    #[test]
    fn rejects_nul_bytes_before_building_windows_buffers() {
        let mut argument = request();
        argument.command.argv[0].push('\0');
        assert_eq!(
            argument.validate(),
            Err(ProtocolValidationError::InvalidArgument(0)),
        );

        let mut environment = request();
        environment
            .command
            .env
            .insert("VALUE".to_string(), "before\0after".to_string());
        assert_eq!(
            environment.validate(),
            Err(ProtocolValidationError::InvalidEnvironmentValue(
                "VALUE".to_string(),
            )),
        );

        let mut path = request();
        path.policy.writable_roots[0].push('\0');
        assert_eq!(
            path.validate(),
            Err(ProtocolValidationError::InvalidPath(
                "writableRoots[0]".to_string(),
            )),
        );
    }
}
