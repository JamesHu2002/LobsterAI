use serde::{Deserialize, Serialize};

pub const SETUP_SCHEMA_VERSION: u32 = 1;
pub const RUNTIME_MANIFEST_FILENAME: &str = "lobster-sandbox-manifest.json";
pub const RUNTIME_STATE_FILENAME: &str = "install-state.json";
pub const CREDENTIALS_FILENAME: &str = "credentials.json";
pub const RUNNER_FILENAME: &str = "lobster-command-runner.exe";
pub const SETUP_FILENAME: &str = "lobster-sandbox-setup.exe";
pub const THIRD_PARTY_NOTICES_FILENAME: &str = "THIRD_PARTY_NOTICES.txt";
pub const SANDBOX_ACCOUNT_NAME: &str = "LobsterSandboxUser";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SetupOperation {
    Install,
    Verify,
    Repair,
    Upgrade,
    Rollback,
    Uninstall,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifest {
    pub schema_version: u32,
    pub runtime_version: String,
    pub protocol_version: u32,
    pub policy_version: String,
    pub architecture: String,
    pub git_commit: String,
    pub built_at: String,
    pub minimum_lobster_version: String,
    pub signature_policy: String,
    pub files: Vec<RuntimeManifestFile>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifestFile {
    pub name: String,
    pub sha256: String,
    pub authenticode: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallState {
    pub schema_version: u32,
    pub runtime_version: String,
    pub protocol_version: u32,
    pub policy_version: String,
    pub architecture: String,
    pub account_name: String,
    pub account_sid: String,
    pub owner_sid: String,
    pub require_signature: bool,
    pub network_policy_version: u32,
    pub protection_version: u32,
    pub installed_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialsFile {
    pub schema_version: u32,
    pub account_name: String,
    pub encrypted_password: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupIdentityReport {
    pub account_name: String,
    pub account_sid: String,
    pub ready: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupIntegrityReport {
    pub manifest_verified: bool,
    pub hashes_verified: bool,
    pub signatures_required: bool,
    pub signatures_verified: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupNetworkReport {
    pub mode: String,
    pub rules_installed: bool,
    pub rules_effective: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupProtectionReport {
    pub protected_install: bool,
    pub credentials_protected: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupReport {
    pub schema_version: u32,
    pub operation: SetupOperation,
    pub success: bool,
    pub cancelled: bool,
    pub installed: bool,
    pub healthy: bool,
    pub runtime_version: String,
    pub protocol_version: u32,
    pub policy_version: String,
    pub install_root: String,
    pub runner_path: String,
    pub setup_path: String,
    pub identity: SetupIdentityReport,
    pub integrity: SetupIntegrityReport,
    pub network: SetupNetworkReport,
    pub protection: SetupProtectionReport,
    pub reboot_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl SetupReport {
    pub fn empty(operation: SetupOperation, install_root: &str) -> Self {
        Self {
            schema_version: SETUP_SCHEMA_VERSION,
            operation,
            success: false,
            cancelled: false,
            installed: false,
            healthy: false,
            runtime_version: env!("CARGO_PKG_VERSION").to_string(),
            protocol_version: 0,
            policy_version: String::new(),
            install_root: install_root.to_string(),
            runner_path: String::new(),
            setup_path: String::new(),
            identity: SetupIdentityReport::default(),
            integrity: SetupIntegrityReport::default(),
            network: SetupNetworkReport {
                mode: "disabled".to_string(),
                ..SetupNetworkReport::default()
            },
            protection: SetupProtectionReport::default(),
            reboot_required: false,
            request_id: None,
            error_code: None,
            message: None,
        }
    }
}
