use std::fmt;

use thiserror::Error;

#[derive(Debug, Error)]
#[error("{message}")]
pub struct InstallationError {
    pub code: &'static str,
    pub stage: &'static str,
    pub message: String,
    pub windows_error: Option<u32>,
    pub cancelled: bool,
}

impl InstallationError {
    pub fn new(code: &'static str, stage: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            stage,
            message: message.into(),
            windows_error: None,
            cancelled: false,
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
            cancelled: false,
        }
    }

    pub fn cancelled(message: impl Into<String>) -> Self {
        Self {
            code: "setup-uac-cancelled",
            stage: "request-elevation",
            message: message.into(),
            windows_error: Some(1223),
            cancelled: true,
        }
    }
}

pub type InstallationResult<T> = Result<T, InstallationError>;
