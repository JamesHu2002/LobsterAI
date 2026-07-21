use std::fmt;

use thiserror::Error;

#[derive(Debug, Error)]
#[error("{message}")]
pub struct SandboxError {
    pub code: &'static str,
    pub stage: &'static str,
    pub message: String,
    pub windows_error: Option<u32>,
}

impl SandboxError {
    pub fn new(code: &'static str, stage: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            stage,
            message: message.into(),
            windows_error: None,
        }
    }

    pub fn windows(
        code: &'static str,
        stage: &'static str,
        context: impl fmt::Display,
        windows_error: u32,
    ) -> Self {
        Self {
            code,
            stage,
            message: format!("{context} (Windows error {windows_error})"),
            windows_error: Some(windows_error),
        }
    }
}

pub type SandboxResult<T> = Result<T, SandboxError>;
