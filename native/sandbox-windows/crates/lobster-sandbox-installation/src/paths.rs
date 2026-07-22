use std::path::{Path, PathBuf};

use crate::model::{
    CREDENTIALS_FILENAME, RUNNER_FILENAME, RUNTIME_MANIFEST_FILENAME, RUNTIME_STATE_FILENAME,
    SETUP_FILENAME,
};

#[cfg(debug_assertions)]
const INSTALL_ROOT_OVERRIDE_ENV: &str = "LOBSTER_NATIVE_SANDBOX_INSTALL_ROOT";
const INSTALL_DIRECTORY_NAME: &str = "LobsterAI-SandboxRuntime";

#[derive(Clone, Debug)]
pub struct InstallationPaths {
    pub root: PathBuf,
    pub current: PathBuf,
    pub previous: PathBuf,
    pub staging: PathBuf,
    pub state_dir: PathBuf,
    pub credentials: PathBuf,
    pub setup_result: PathBuf,
    pub setup_log: PathBuf,
}

impl InstallationPaths {
    pub fn discover() -> Self {
        #[cfg(debug_assertions)]
        if let Some(root) = std::env::var_os(INSTALL_ROOT_OVERRIDE_ENV)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
        {
            return Self::from_root(root);
        }

        let program_data = std::env::var_os("ProgramData")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        let root = program_data.join(INSTALL_DIRECTORY_NAME);
        Self::from_root(root)
    }

    pub fn from_root(root: PathBuf) -> Self {
        let process_id = std::process::id();
        let state_dir = root.join("state");
        Self {
            current: root.join("current"),
            previous: root.join("previous"),
            staging: root.join(format!(".staging-{process_id}")),
            credentials: state_dir.join(CREDENTIALS_FILENAME),
            setup_result: state_dir.join("setup-result.json"),
            setup_log: root.join("logs").join("setup.jsonl"),
            state_dir,
            root,
        }
    }

    pub fn manifest(&self) -> PathBuf {
        self.current.join(RUNTIME_MANIFEST_FILENAME)
    }

    pub fn state(&self) -> PathBuf {
        self.current.join(RUNTIME_STATE_FILENAME)
    }

    pub fn runner(&self) -> PathBuf {
        self.current.join(RUNNER_FILENAME)
    }

    pub fn setup(&self) -> PathBuf {
        self.current.join(SETUP_FILENAME)
    }

    pub fn display_root(&self) -> String {
        self.root.display().to_string()
    }
}

pub fn bootstrap_directory(executable: &Path) -> PathBuf {
    executable
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}
