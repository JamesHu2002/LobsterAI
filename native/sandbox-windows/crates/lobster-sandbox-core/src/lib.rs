mod error;

pub use error::{SandboxError, SandboxResult};

#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub use windows::{cleanup, execute, verify};

#[cfg(not(windows))]
mod unsupported {
    use lobster_sandbox_protocol::{ExecutionReport, RunRequest, VerificationReport};

    use crate::{SandboxError, SandboxResult};

    fn error() -> SandboxError {
        SandboxError::new(
            "unsupported-platform",
            "select-runtime",
            "lobster-sandbox-core M1 supports Windows only",
        )
    }

    pub fn verify(_request: &RunRequest) -> SandboxResult<VerificationReport> {
        Err(error())
    }

    pub fn execute(_request: &RunRequest) -> SandboxResult<ExecutionReport> {
        Err(error())
    }

    pub fn cleanup(_request: &RunRequest) -> SandboxResult<()> {
        Err(error())
    }
}

#[cfg(not(windows))]
pub use unsupported::{cleanup, execute, verify};
