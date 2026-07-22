mod account_visibility;
mod audit;
mod broker;
mod desktop_access;
mod elevation;
mod error;
mod firewall;
mod identity;
mod integrity;
mod lifecycle;
mod model;
mod paths;
mod protection;
mod supervision;
mod wfp;

pub use audit::record_setup_audit;
pub use broker::launch_worker;
pub use elevation::{
    ElevationDisposition, elevate_and_wait, is_process_elevated, write_elevated_result,
};
pub use error::{InstallationError, InstallationResult};
pub use identity::{current_user_sid, ensure_setup_caller_authorized, validate_setup_owner_sid};
pub use integrity::harden_current_process_dll_search;
pub use lifecycle::{
    RuntimeSecurityContext, perform_operation, verify_runtime_for_broker, verify_runtime_for_worker,
};
pub use model::{
    InstallState, RUNNER_FILENAME, RUNTIME_MANIFEST_FILENAME, SETUP_FILENAME, SETUP_SCHEMA_VERSION,
    SetupOperation, SetupReport,
};
pub use paths::{InstallationPaths, bootstrap_directory};
pub use protection::protect_setup_result;
pub use supervision::start_broker_watchdog;
