mod error;

pub use error::{SandboxError, SandboxResult};

#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub use windows::{cleanup, cleanup_with_identity, execute, prepare, verify, verify_prepared};

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

    pub fn cleanup_with_identity(
        _request: &RunRequest,
        _sandbox_identity_sid: Option<&str>,
    ) -> SandboxResult<()> {
        Err(error())
    }

    pub fn prepare(
        _request: &RunRequest,
        _sandbox_identity_sid: Option<&str>,
    ) -> SandboxResult<()> {
        Err(error())
    }

    pub fn verify_prepared(
        _request: &RunRequest,
        _dedicated_identity: bool,
        _network_isolated: bool,
        _runtime_integrity_verified: bool,
    ) -> SandboxResult<VerificationReport> {
        Err(error())
    }
}

#[cfg(not(windows))]
pub use unsupported::{cleanup, cleanup_with_identity, execute, prepare, verify, verify_prepared};
