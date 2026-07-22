use std::fs::{self, OpenOptions};
use std::io::Write;

use windows_sys::Win32::System::EventLog::{
    DeregisterEventSource, EVENTLOG_ERROR_TYPE, EVENTLOG_INFORMATION_TYPE, RegisterEventSourceW,
    ReportEventW,
};

use crate::model::SetupReport;
use crate::paths::InstallationPaths;

pub fn record_setup_audit(report: &SetupReport) {
    let paths = InstallationPaths::discover();
    if let Some(parent) = paths.setup_log.parent() {
        if fs::create_dir_all(parent).is_ok() {
            if let Ok(mut file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&paths.setup_log)
            {
                if let Ok(json) = serde_json::to_string(report) {
                    let _ = writeln!(file, "{json}");
                }
            }
        }
    }
    let source = wide("LobsterAI Sandbox");
    let message = wide(&format!(
        "operation={:?} success={} cancelled={} errorCode={}",
        report.operation,
        report.success,
        report.cancelled,
        report.error_code.as_deref().unwrap_or("none")
    ));
    let handle = unsafe { RegisterEventSourceW(std::ptr::null(), source.as_ptr()) };
    if handle != 0 {
        let strings = [message.as_ptr()];
        let event_type = if report.success {
            EVENTLOG_INFORMATION_TYPE
        } else {
            EVENTLOG_ERROR_TYPE
        };
        unsafe {
            ReportEventW(
                handle,
                event_type,
                0,
                1000,
                std::ptr::null_mut(),
                1,
                0,
                strings.as_ptr(),
                std::ptr::null(),
            );
            DeregisterEventSource(handle);
        }
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}
