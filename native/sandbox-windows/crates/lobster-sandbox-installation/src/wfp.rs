use std::ffi::c_void;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{
    FWP_E_ALREADY_EXISTS, FWP_E_FILTER_NOT_FOUND, FWP_E_NOT_FOUND, FWP_E_PROVIDER_NOT_FOUND,
    FWP_E_SUBLAYER_NOT_FOUND, GetLastError, HANDLE, HLOCAL, LocalFree,
};
use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::{
    FWP_ACTION_BLOCK, FWP_BYTE_BLOB, FWP_CONDITION_VALUE0, FWP_CONDITION_VALUE0_0, FWP_EMPTY,
    FWP_MATCH_EQUAL, FWP_SECURITY_DESCRIPTOR_TYPE, FWP_UINT8, FWP_VALUE0, FWP_VALUE0_0,
    FWPM_ACTION0, FWPM_ACTION0_0, FWPM_CONDITION_ALE_USER_ID, FWPM_CONDITION_IP_PROTOCOL,
    FWPM_DISPLAY_DATA0, FWPM_FILTER_CONDITION0, FWPM_FILTER_FLAG_PERSISTENT, FWPM_FILTER0,
    FWPM_FILTER0_0, FWPM_LAYER_ALE_AUTH_CONNECT_V4, FWPM_LAYER_ALE_AUTH_CONNECT_V6,
    FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V4, FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V6,
    FWPM_PROVIDER_FLAG_PERSISTENT, FWPM_PROVIDER0, FWPM_SESSION0, FWPM_SUBLAYER_FLAG_PERSISTENT,
    FWPM_SUBLAYER0, FwpmEngineClose0, FwpmEngineOpen0, FwpmFilterAdd0, FwpmFilterDeleteByKey0,
    FwpmFilterGetByKey0, FwpmFreeMemory0, FwpmProviderAdd0, FwpmProviderDeleteByKey0,
    FwpmProviderGetByKey0, FwpmSubLayerAdd0, FwpmSubLayerDeleteByKey0, FwpmSubLayerGetByKey0,
    FwpmTransactionAbort0, FwpmTransactionBegin0, FwpmTransactionCommit0,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW,
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;
use windows_sys::Win32::System::Rpc::RPC_C_AUTHN_DEFAULT;
use windows_sys::Win32::System::Threading::INFINITE;
use windows_sys::core::GUID;

use crate::error::{InstallationError, InstallationResult};

const SESSION_NAME: &str = "LobsterAI Sandbox WFP";
const PROVIDER_NAME: &str = "LobsterAI Sandbox WFP";
const PROVIDER_DESCRIPTION: &str =
    "Persistent WFP provider for LobsterAI's managed Sandbox identity";
const SUBLAYER_NAME: &str = "LobsterAI Sandbox WFP";
const SUBLAYER_DESCRIPTION: &str =
    "Persistent WFP sublayer for LobsterAI's managed Sandbox identity";

// Stable LobsterAI-owned identities. Changing these values would orphan an installed policy.
const PROVIDER_KEY: GUID = GUID::from_u128(0x58b1d07f_4296_4fff_ac30_6048eb2cc3b2);
const SUBLAYER_KEY: GUID = GUID::from_u128(0x098b27e0_a7c7_45d5_a77a_7249ba5a5e7b);

const IP_PROTOCOL_ICMP: u8 = 1;
const IP_PROTOCOL_ICMPV6: u8 = 58;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ConditionSpec {
    User,
    Protocol(u8),
}

#[derive(Clone, Copy)]
struct FilterSpec {
    key: GUID,
    name: &'static str,
    description: &'static str,
    layer_key: GUID,
    conditions: &'static [ConditionSpec],
}

const FILTER_SPECS: [FilterSpec; 4] = [
    FilterSpec {
        key: GUID::from_u128(0x57b2a286_7dfc_4b04_af38_a3b85b75d6ec),
        name: "lobster_sandbox_wfp_connect_v4",
        description: "Block all IPv4 connects from the LobsterAI Sandbox identity",
        layer_key: FWPM_LAYER_ALE_AUTH_CONNECT_V4,
        conditions: &[ConditionSpec::User],
    },
    FilterSpec {
        key: GUID::from_u128(0xde81945d_2ad0_4541_aee3_757679b674eb),
        name: "lobster_sandbox_wfp_connect_v6",
        description: "Block all IPv6 connects from the LobsterAI Sandbox identity",
        layer_key: FWPM_LAYER_ALE_AUTH_CONNECT_V6,
        conditions: &[ConditionSpec::User],
    },
    FilterSpec {
        key: GUID::from_u128(0x39480992_421b_4ed0_86ed_8430c00dd552),
        name: "lobster_sandbox_wfp_icmp_assign_v4",
        description: "Block IPv4 ICMP assignment from the LobsterAI Sandbox identity",
        layer_key: FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V4,
        conditions: &[
            ConditionSpec::User,
            ConditionSpec::Protocol(IP_PROTOCOL_ICMP),
        ],
    },
    FilterSpec {
        key: GUID::from_u128(0x99b90a22_ff78_4aa2_ad4b_c7d54631da31),
        name: "lobster_sandbox_wfp_icmp_assign_v6",
        description: "Block IPv6 ICMP assignment from the LobsterAI Sandbox identity",
        layer_key: FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V6,
        conditions: &[
            ConditionSpec::User,
            ConditionSpec::Protocol(IP_PROTOCOL_ICMPV6),
        ],
    },
];

pub fn ensure_offline_wfp(account_sid: &str, owner_sid: &str) -> InstallationResult<()> {
    let engine = Engine::open()?;
    let mut transaction = engine.begin_transaction()?;
    for spec in &FILTER_SPECS {
        delete_filter_if_present(engine.handle, &spec.key)?;
    }
    delete_sublayer_if_present(engine.handle)?;
    delete_provider_if_present(engine.handle)?;
    let object_security = SecurityDescriptor::for_wfp_objects(owner_sid, account_sid)?;
    ensure_provider(engine.handle, object_security.raw())?;
    ensure_sublayer(engine.handle, object_security.raw())?;
    let user_condition = UserMatchCondition::for_sid(account_sid)?;
    for spec in &FILTER_SPECS {
        add_filter(engine.handle, spec, &user_condition, object_security.raw())?;
    }
    transaction.commit()?;
    verify_offline_wfp_with_engine(&engine, account_sid)
}

pub fn verify_offline_wfp(account_sid: &str) -> InstallationResult<bool> {
    let engine = Engine::open()?;
    verify_offline_wfp_with_engine(&engine, account_sid)?;
    Ok(true)
}

pub fn remove_offline_wfp() -> InstallationResult<()> {
    let engine = Engine::open()?;
    let mut transaction = engine.begin_transaction()?;
    for spec in &FILTER_SPECS {
        delete_filter_if_present(engine.handle, &spec.key)?;
    }
    delete_sublayer_if_present(engine.handle)?;
    delete_provider_if_present(engine.handle)?;
    transaction.commit()
}

fn verify_offline_wfp_with_engine(engine: &Engine, account_sid: &str) -> InstallationResult<()> {
    verify_provider(engine.handle)?;
    verify_sublayer(engine.handle)?;
    for spec in &FILTER_SPECS {
        verify_filter(engine.handle, spec, account_sid)?;
    }
    Ok(())
}

struct Engine {
    handle: HANDLE,
}

impl Engine {
    fn open() -> InstallationResult<Self> {
        let mut session_name = to_wide(SESSION_NAME);
        let session = FWPM_SESSION0 {
            sessionKey: zero_guid(),
            displayData: FWPM_DISPLAY_DATA0 {
                name: session_name.as_mut_ptr(),
                description: null_mut(),
            },
            flags: 0,
            txnWaitTimeoutInMSec: INFINITE,
            processId: 0,
            sid: null_mut(),
            username: null_mut(),
            kernelMode: 0,
        };
        let mut handle = 0;
        let result = unsafe {
            FwpmEngineOpen0(
                null(),
                RPC_C_AUTHN_DEFAULT as u32,
                null(),
                &session,
                &mut handle,
            )
        };
        ensure_success(
            result,
            "network-wfp-unavailable",
            "open-wfp",
            "FwpmEngineOpen0",
        )?;
        Ok(Self { handle })
    }

    fn begin_transaction(&self) -> InstallationResult<Transaction<'_>> {
        let result = unsafe { FwpmTransactionBegin0(self.handle, 0) };
        ensure_success(
            result,
            "network-wfp-transaction-failed",
            "configure-network",
            "FwpmTransactionBegin0",
        )?;
        Ok(Transaction {
            engine: self,
            committed: false,
        })
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        if self.handle != 0 {
            unsafe {
                FwpmEngineClose0(self.handle);
            }
        }
    }
}

struct Transaction<'a> {
    engine: &'a Engine,
    committed: bool,
}

impl Transaction<'_> {
    fn commit(&mut self) -> InstallationResult<()> {
        let result = unsafe { FwpmTransactionCommit0(self.engine.handle) };
        ensure_success(
            result,
            "network-wfp-transaction-failed",
            "configure-network",
            "FwpmTransactionCommit0",
        )?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for Transaction<'_> {
    fn drop(&mut self) {
        if !self.committed {
            unsafe {
                FwpmTransactionAbort0(self.engine.handle);
            }
        }
    }
}

struct SecurityDescriptor {
    descriptor: *mut c_void,
}

impl SecurityDescriptor {
    fn for_wfp_objects(owner_sid: &str, account_sid: &str) -> InstallationResult<Self> {
        // 0x80 is FWPM_ACTRL_READ. Ordinary users may inspect Lobster-owned policy objects but
        // cannot add, mutate, link, or delete them. SYSTEM and Administrators retain full control.
        let sddl =
            format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x80;;;{owner_sid})(A;;0x80;;;{account_sid})");
        Self::from_sddl(
            &sddl,
            "network-wfp-object-security-invalid",
            "could not create the WFP object security descriptor",
        )
    }

    fn from_sddl(
        sddl: &str,
        code: &'static str,
        context: &'static str,
    ) -> InstallationResult<Self> {
        let sddl = to_wide(sddl);
        let mut descriptor = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err(InstallationError::windows(
                code,
                "configure-network",
                context,
                unsafe { GetLastError() },
            ));
        }
        Ok(Self { descriptor })
    }

    fn raw(&self) -> *mut c_void {
        self.descriptor
    }
}

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        if !self.descriptor.is_null() {
            unsafe {
                LocalFree(self.descriptor as HLOCAL);
            }
        }
    }
}

struct UserMatchCondition {
    descriptor: *mut c_void,
    blob: FWP_BYTE_BLOB,
}

impl UserMatchCondition {
    fn for_sid(account_sid: &str) -> InstallationResult<Self> {
        let sddl = format!("D:(A;;CC;;;{account_sid})");
        let sddl = to_wide(&sddl);
        let mut descriptor = null_mut();
        let mut descriptor_size = 0;
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                &mut descriptor_size,
            )
        } == 0
        {
            return Err(InstallationError::windows(
                "network-wfp-user-condition-invalid",
                "configure-network",
                "could not create the WFP account match descriptor",
                unsafe { GetLastError() },
            ));
        }
        Ok(Self {
            descriptor,
            blob: FWP_BYTE_BLOB {
                size: descriptor_size,
                data: descriptor as *mut u8,
            },
        })
    }
}

impl Drop for UserMatchCondition {
    fn drop(&mut self) {
        if !self.descriptor.is_null() {
            unsafe {
                LocalFree(self.descriptor as HLOCAL);
            }
        }
    }
}

fn ensure_provider(engine: HANDLE, object_security: *mut c_void) -> InstallationResult<()> {
    let mut name = to_wide(PROVIDER_NAME);
    let mut description = to_wide(PROVIDER_DESCRIPTION);
    let provider = FWPM_PROVIDER0 {
        providerKey: PROVIDER_KEY,
        displayData: FWPM_DISPLAY_DATA0 {
            name: name.as_mut_ptr(),
            description: description.as_mut_ptr(),
        },
        flags: FWPM_PROVIDER_FLAG_PERSISTENT,
        providerData: empty_blob(),
        serviceName: null_mut(),
    };
    let result = unsafe { FwpmProviderAdd0(engine, &provider, object_security) };
    ensure_success_or(
        result,
        "network-wfp-provider-invalid",
        "configure-network",
        "FwpmProviderAdd0",
        &[FWP_E_ALREADY_EXISTS as u32],
    )
}

fn ensure_sublayer(engine: HANDLE, object_security: *mut c_void) -> InstallationResult<()> {
    let mut name = to_wide(SUBLAYER_NAME);
    let mut description = to_wide(SUBLAYER_DESCRIPTION);
    let mut provider_key = PROVIDER_KEY;
    let sublayer = FWPM_SUBLAYER0 {
        subLayerKey: SUBLAYER_KEY,
        displayData: FWPM_DISPLAY_DATA0 {
            name: name.as_mut_ptr(),
            description: description.as_mut_ptr(),
        },
        flags: FWPM_SUBLAYER_FLAG_PERSISTENT,
        providerKey: &mut provider_key,
        providerData: empty_blob(),
        weight: 0x8000,
    };
    let result = unsafe { FwpmSubLayerAdd0(engine, &sublayer, object_security) };
    ensure_success_or(
        result,
        "network-wfp-sublayer-invalid",
        "configure-network",
        "FwpmSubLayerAdd0",
        &[FWP_E_ALREADY_EXISTS as u32],
    )
}

fn add_filter(
    engine: HANDLE,
    spec: &FilterSpec,
    user_condition: &UserMatchCondition,
    object_security: *mut c_void,
) -> InstallationResult<()> {
    let mut name = to_wide(spec.name);
    let mut description = to_wide(spec.description);
    let mut provider_key = PROVIDER_KEY;
    let mut conditions = build_conditions(spec.conditions, user_condition);
    let filter = FWPM_FILTER0 {
        filterKey: spec.key,
        displayData: FWPM_DISPLAY_DATA0 {
            name: name.as_mut_ptr(),
            description: description.as_mut_ptr(),
        },
        flags: FWPM_FILTER_FLAG_PERSISTENT,
        providerKey: &mut provider_key,
        providerData: empty_blob(),
        layerKey: spec.layer_key,
        subLayerKey: SUBLAYER_KEY,
        weight: empty_value(),
        numFilterConditions: conditions.len() as u32,
        filterCondition: conditions.as_mut_ptr(),
        action: FWPM_ACTION0 {
            r#type: FWP_ACTION_BLOCK,
            Anonymous: FWPM_ACTION0_0 {
                filterType: zero_guid(),
            },
        },
        Anonymous: FWPM_FILTER0_0 { rawContext: 0 },
        reserved: null_mut(),
        filterId: 0,
        effectiveWeight: empty_value(),
    };
    let mut filter_id = 0;
    let result = unsafe { FwpmFilterAdd0(engine, &filter, object_security, &mut filter_id) };
    ensure_success(
        result,
        "network-wfp-filter-invalid",
        "configure-network",
        &format!("FwpmFilterAdd0({})", spec.name),
    )
}

fn build_conditions(
    specs: &[ConditionSpec],
    user_condition: &UserMatchCondition,
) -> Vec<FWPM_FILTER_CONDITION0> {
    specs
        .iter()
        .map(|spec| match spec {
            ConditionSpec::User => FWPM_FILTER_CONDITION0 {
                fieldKey: FWPM_CONDITION_ALE_USER_ID,
                matchType: FWP_MATCH_EQUAL,
                conditionValue: FWP_CONDITION_VALUE0 {
                    r#type: FWP_SECURITY_DESCRIPTOR_TYPE,
                    Anonymous: FWP_CONDITION_VALUE0_0 {
                        sd: &user_condition.blob as *const _ as *mut _,
                    },
                },
            },
            ConditionSpec::Protocol(protocol) => FWPM_FILTER_CONDITION0 {
                fieldKey: FWPM_CONDITION_IP_PROTOCOL,
                matchType: FWP_MATCH_EQUAL,
                conditionValue: FWP_CONDITION_VALUE0 {
                    r#type: FWP_UINT8,
                    Anonymous: FWP_CONDITION_VALUE0_0 { uint8: *protocol },
                },
            },
        })
        .collect()
}

fn verify_provider(engine: HANDLE) -> InstallationResult<()> {
    let mut raw = null_mut();
    let result = unsafe { FwpmProviderGetByKey0(engine, &PROVIDER_KEY, &mut raw) };
    ensure_success(
        result,
        "network-wfp-provider-invalid",
        "verify-network",
        "FwpmProviderGetByKey0",
    )?;
    let allocation = FwpmAllocation(raw);
    let provider = allocation.get("network-wfp-provider-invalid", "WFP provider")?;
    if provider.flags & FWPM_PROVIDER_FLAG_PERSISTENT == 0 {
        return Err(InstallationError::new(
            "network-wfp-provider-invalid",
            "verify-network",
            "the LobsterAI WFP provider is not persistent",
        ));
    }
    Ok(())
}

fn verify_sublayer(engine: HANDLE) -> InstallationResult<()> {
    let mut raw = null_mut();
    let result = unsafe { FwpmSubLayerGetByKey0(engine, &SUBLAYER_KEY, &mut raw) };
    ensure_success(
        result,
        "network-wfp-sublayer-invalid",
        "verify-network",
        "FwpmSubLayerGetByKey0",
    )?;
    let allocation = FwpmAllocation(raw);
    let sublayer = allocation.get("network-wfp-sublayer-invalid", "WFP sublayer")?;
    let provider_matches = !sublayer.providerKey.is_null()
        && guid_eq(unsafe { &*sublayer.providerKey }, &PROVIDER_KEY);
    if sublayer.flags & FWPM_SUBLAYER_FLAG_PERSISTENT == 0
        || !provider_matches
        || sublayer.weight < 0x8000
    {
        return Err(InstallationError::new(
            "network-wfp-sublayer-invalid",
            "verify-network",
            format!(
                "the LobsterAI WFP sublayer does not match the fail-closed policy: flags=0x{:08x}, providerMatches={provider_matches}, weight=0x{:04x}",
                sublayer.flags, sublayer.weight
            ),
        ));
    }
    Ok(())
}

fn verify_filter(engine: HANDLE, spec: &FilterSpec, account_sid: &str) -> InstallationResult<()> {
    let mut raw = null_mut();
    let result = unsafe { FwpmFilterGetByKey0(engine, &spec.key, &mut raw) };
    ensure_success(
        result,
        "network-wfp-filter-invalid",
        "verify-network",
        &format!("FwpmFilterGetByKey0({})", spec.name),
    )?;
    let allocation = FwpmAllocation(raw);
    let filter = allocation.get("network-wfp-filter-invalid", "WFP filter")?;
    let provider_matches =
        !filter.providerKey.is_null() && guid_eq(unsafe { &*filter.providerKey }, &PROVIDER_KEY);
    let shape_matches = filter.flags & FWPM_FILTER_FLAG_PERSISTENT != 0
        && provider_matches
        && guid_eq(&filter.layerKey, &spec.layer_key)
        && guid_eq(&filter.subLayerKey, &SUBLAYER_KEY)
        && filter.action.r#type == FWP_ACTION_BLOCK
        && filter.numFilterConditions as usize == spec.conditions.len()
        && (!filter.filterCondition.is_null() || spec.conditions.is_empty());
    if !shape_matches {
        return Err(InstallationError::new(
            "network-wfp-filter-invalid",
            "verify-network",
            format!(
                "WFP filter {} does not match the fail-closed shape",
                spec.name
            ),
        ));
    }
    let conditions = unsafe {
        std::slice::from_raw_parts(filter.filterCondition, filter.numFilterConditions as usize)
    };
    for expected in spec.conditions {
        let matched = match expected {
            ConditionSpec::User => conditions.iter().any(|condition| {
                guid_eq(&condition.fieldKey, &FWPM_CONDITION_ALE_USER_ID)
                    && condition.matchType == FWP_MATCH_EQUAL
                    && condition.conditionValue.r#type == FWP_SECURITY_DESCRIPTOR_TYPE
                    && user_condition_matches_sid(condition, account_sid).unwrap_or(false)
            }),
            ConditionSpec::Protocol(protocol) => conditions.iter().any(|condition| {
                guid_eq(&condition.fieldKey, &FWPM_CONDITION_IP_PROTOCOL)
                    && condition.matchType == FWP_MATCH_EQUAL
                    && condition.conditionValue.r#type == FWP_UINT8
                    && unsafe { condition.conditionValue.Anonymous.uint8 } == *protocol
            }),
        };
        if !matched {
            return Err(InstallationError::new(
                "network-wfp-filter-invalid",
                "verify-network",
                format!(
                    "WFP filter {} has an invalid account or protocol condition",
                    spec.name
                ),
            ));
        }
    }
    Ok(())
}

fn user_condition_matches_sid(
    condition: &FWPM_FILTER_CONDITION0,
    account_sid: &str,
) -> InstallationResult<bool> {
    let blob = unsafe { condition.conditionValue.Anonymous.sd };
    if blob.is_null() {
        return Ok(false);
    }
    let blob = unsafe { &*blob };
    if blob.data.is_null() || blob.size == 0 {
        return Ok(false);
    }
    let mut sddl = null_mut();
    let mut sddl_length = 0;
    if unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            blob.data as *mut c_void,
            SDDL_REVISION_1,
            DACL_SECURITY_INFORMATION,
            &mut sddl,
            &mut sddl_length,
        )
    } == 0
    {
        return Err(InstallationError::windows(
            "network-wfp-filter-invalid",
            "verify-network",
            "could not inspect the WFP account match descriptor",
            unsafe { GetLastError() },
        ));
    }
    let allocation = LocalWideString(sddl);
    let value = allocation.to_string(sddl_length as usize);
    Ok(sddl_authorizes_sid(&value, account_sid))
}

fn sddl_authorizes_sid(value: &str, account_sid: &str) -> bool {
    value.split(['(', ')']).any(|component| {
        let fields = component.split(';').collect::<Vec<_>>();
        fields.len() >= 6
            && fields[0].eq_ignore_ascii_case("A")
            && (fields[2].eq_ignore_ascii_case("CC") || fields[2].eq_ignore_ascii_case("0x1"))
            && fields[5].eq_ignore_ascii_case(account_sid)
    })
}

fn delete_filter_if_present(engine: HANDLE, key: &GUID) -> InstallationResult<()> {
    let result = unsafe { FwpmFilterDeleteByKey0(engine, key) };
    ensure_success_or(
        result,
        "network-wfp-filter-remove-failed",
        "uninstall-network",
        "FwpmFilterDeleteByKey0",
        &[FWP_E_FILTER_NOT_FOUND as u32, FWP_E_NOT_FOUND as u32],
    )
}

fn delete_sublayer_if_present(engine: HANDLE) -> InstallationResult<()> {
    let result = unsafe { FwpmSubLayerDeleteByKey0(engine, &SUBLAYER_KEY) };
    ensure_success_or(
        result,
        "network-wfp-sublayer-remove-failed",
        "uninstall-network",
        "FwpmSubLayerDeleteByKey0",
        &[FWP_E_SUBLAYER_NOT_FOUND as u32, FWP_E_NOT_FOUND as u32],
    )
}

fn delete_provider_if_present(engine: HANDLE) -> InstallationResult<()> {
    let result = unsafe { FwpmProviderDeleteByKey0(engine, &PROVIDER_KEY) };
    ensure_success_or(
        result,
        "network-wfp-provider-remove-failed",
        "uninstall-network",
        "FwpmProviderDeleteByKey0",
        &[FWP_E_PROVIDER_NOT_FOUND as u32, FWP_E_NOT_FOUND as u32],
    )
}

struct FwpmAllocation<T>(*mut T);

impl<T> FwpmAllocation<T> {
    fn get(&self, code: &'static str, name: &str) -> InstallationResult<&T> {
        unsafe { self.0.as_ref() }.ok_or_else(|| {
            InstallationError::new(
                code,
                "verify-network",
                format!("Windows returned an empty {name}"),
            )
        })
    }
}

impl<T> Drop for FwpmAllocation<T> {
    fn drop(&mut self) {
        if !self.0.is_null() {
            let mut allocation = self.0 as *mut c_void;
            unsafe {
                FwpmFreeMemory0(&mut allocation);
            }
        }
    }
}

struct LocalWideString(*mut u16);

impl LocalWideString {
    fn to_string(&self, length: usize) -> String {
        if self.0.is_null() || length == 0 {
            return String::new();
        }
        let units = unsafe { std::slice::from_raw_parts(self.0, length) };
        let units = units.strip_suffix(&[0]).unwrap_or(units);
        String::from_utf16_lossy(units)
    }
}

impl Drop for LocalWideString {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0 as HLOCAL);
            }
        }
    }
}

fn ensure_success(
    result: u32,
    code: &'static str,
    stage: &'static str,
    operation: &str,
) -> InstallationResult<()> {
    ensure_success_or(result, code, stage, operation, &[])
}

fn ensure_success_or(
    result: u32,
    code: &'static str,
    stage: &'static str,
    operation: &str,
    allowed: &[u32],
) -> InstallationResult<()> {
    if result == 0 || allowed.contains(&result) {
        return Ok(());
    }
    Err(InstallationError::new(
        code,
        stage,
        format!("{operation} failed (WFP error 0x{result:08x})"),
    ))
}

fn empty_blob() -> FWP_BYTE_BLOB {
    FWP_BYTE_BLOB {
        size: 0,
        data: null_mut(),
    }
}

fn empty_value() -> FWP_VALUE0 {
    FWP_VALUE0 {
        r#type: FWP_EMPTY,
        Anonymous: FWP_VALUE0_0 { uint64: null_mut() },
    }
}

fn zero_guid() -> GUID {
    GUID::from_u128(0)
}

fn guid_eq(left: &GUID, right: &GUID) -> bool {
    left.data1 == right.data1
        && left.data2 == right.data2
        && left.data3 == right.data3
        && left.data4 == right.data4
}

fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn filter_keys_and_names_are_unique() {
        let keys = FILTER_SPECS
            .iter()
            .map(|spec| {
                (
                    spec.key.data1,
                    spec.key.data2,
                    spec.key.data3,
                    spec.key.data4,
                )
            })
            .collect::<BTreeSet<_>>();
        let names = FILTER_SPECS
            .iter()
            .map(|spec| spec.name)
            .collect::<BTreeSet<_>>();
        assert_eq!(keys.len(), FILTER_SPECS.len());
        assert_eq!(names.len(), FILTER_SPECS.len());
    }

    #[test]
    fn account_condition_requires_exact_allow_match_ace() {
        let sid = "S-1-5-21-1-2-3-1001";
        assert!(sddl_authorizes_sid(&format!("D:(A;;CC;;;{sid})"), sid));
        assert!(sddl_authorizes_sid(&format!("D:(A;;0x1;;;{sid})"), sid));
        assert!(!sddl_authorizes_sid(&format!("D:(D;;CC;;;{sid})"), sid));
        assert!(!sddl_authorizes_sid(&format!("D:(A;;CC;;;{sid}0)"), sid));
    }

    #[test]
    fn connect_filters_cover_both_address_families() {
        let user_only_layers = FILTER_SPECS
            .iter()
            .filter(|spec| spec.conditions == [ConditionSpec::User])
            .map(|spec| spec.layer_key)
            .collect::<Vec<_>>();
        assert!(
            user_only_layers
                .iter()
                .any(|layer| guid_eq(layer, &FWPM_LAYER_ALE_AUTH_CONNECT_V4))
        );
        assert!(
            user_only_layers
                .iter()
                .any(|layer| guid_eq(layer, &FWPM_LAYER_ALE_AUTH_CONNECT_V6))
        );
    }
}
