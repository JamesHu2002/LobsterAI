use windows::Win32::Foundation::{S_OK, VARIANT_TRUE};
use windows::Win32::NetworkManagement::WindowsFirewall::{
    INetFwPolicy2, INetFwRule3, INetFwRules, NET_FW_ACTION_BLOCK, NET_FW_IP_PROTOCOL_ANY,
    NET_FW_IP_PROTOCOL_TCP, NET_FW_IP_PROTOCOL_UDP, NET_FW_MODIFY_STATE, NET_FW_MODIFY_STATE_OK,
    NET_FW_PROFILE2_ALL, NET_FW_PROFILE2_DOMAIN, NET_FW_PROFILE2_PRIVATE, NET_FW_PROFILE2_PUBLIC,
    NET_FW_RULE_DIR_OUT, NetFwPolicy2, NetFwRule,
};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
    CoUninitialize,
};
use windows::core::{BSTR, Interface};

use crate::error::{InstallationError, InstallationResult};

pub const NETWORK_POLICY_VERSION: u32 = 1;

const RULE_NON_LOOPBACK: &str = "lobster_sandbox_offline_block_outbound";
const RULE_LOOPBACK_TCP: &str = "lobster_sandbox_offline_block_loopback_tcp";
const RULE_LOOPBACK_UDP: &str = "lobster_sandbox_offline_block_loopback_udp";
const LOOPBACK_ADDRESSES: &str = "127.0.0.0/8,::1";
const NON_LOOPBACK_ADDRESSES: &str = "0.0.0.0-126.255.255.255,128.0.0.0-255.255.255.255,::,::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff";

struct RuleSpec<'a> {
    name: &'a str,
    description: &'a str,
    protocol: i32,
    remote_addresses: &'a str,
}

const RULES: [RuleSpec<'static>; 3] = [
    RuleSpec {
        name: RULE_NON_LOOPBACK,
        description: "LobsterAI Sandbox - block non-loopback outbound traffic",
        protocol: NET_FW_IP_PROTOCOL_ANY.0,
        remote_addresses: NON_LOOPBACK_ADDRESSES,
    },
    RuleSpec {
        name: RULE_LOOPBACK_TCP,
        description: "LobsterAI Sandbox - block loopback TCP",
        protocol: NET_FW_IP_PROTOCOL_TCP.0,
        remote_addresses: LOOPBACK_ADDRESSES,
    },
    RuleSpec {
        name: RULE_LOOPBACK_UDP,
        description: "LobsterAI Sandbox - block loopback UDP",
        protocol: NET_FW_IP_PROTOCOL_UDP.0,
        remote_addresses: LOOPBACK_ADDRESSES,
    },
];

pub fn ensure_offline_firewall(account_sid: &str) -> InstallationResult<()> {
    with_rules(|policy, rules| {
        ensure_local_policy_effective(policy)?;
        ensure_active_firewall_enabled(policy)?;
        for spec in &RULES {
            ensure_rule(rules, spec, account_sid)?;
        }
        Ok(())
    })
}

pub fn verify_offline_firewall(account_sid: &str) -> InstallationResult<bool> {
    with_rules(|policy, rules| {
        ensure_local_policy_effective(policy)?;
        ensure_active_firewall_enabled(policy)?;
        for spec in &RULES {
            let name = BSTR::from(spec.name);
            let rule: INetFwRule3 = unsafe { rules.Item(&name) }
                .map_err(|_| {
                    InstallationError::new(
                        "network-rule-missing",
                        "verify-network",
                        format!("Windows Firewall rule {} is missing", spec.name),
                    )
                })?
                .cast()
                .map_err(|error| {
                    InstallationError::new(
                        "network-rule-invalid",
                        "verify-network",
                        format!("could not inspect firewall rule {}: {error:?}", spec.name),
                    )
                })?;
            verify_rule(&rule, spec, account_sid)?;
        }
        Ok(true)
    })
}

pub fn remove_offline_firewall() -> InstallationResult<()> {
    with_rules(|_policy, rules| {
        for spec in &RULES {
            let name = BSTR::from(spec.name);
            if unsafe { rules.Item(&name) }.is_ok() {
                unsafe { rules.Remove(&name) }.map_err(|error| {
                    InstallationError::new(
                        "network-rule-remove-failed",
                        "uninstall-network",
                        format!("could not remove firewall rule {}: {error:?}", spec.name),
                    )
                })?;
            }
        }
        Ok(())
    })
}

fn with_rules<T>(
    operation: impl FnOnce(&INetFwPolicy2, &INetFwRules) -> InstallationResult<T>,
) -> InstallationResult<T> {
    let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if initialized.is_err() {
        return Err(InstallationError::new(
            "network-firewall-unavailable",
            "configure-network",
            format!("CoInitializeEx failed: {initialized:?}"),
        ));
    }
    let result = unsafe {
        (|| {
            let policy: INetFwPolicy2 = CoCreateInstance(&NetFwPolicy2, None, CLSCTX_INPROC_SERVER)
                .map_err(|error| {
                    InstallationError::new(
                        "network-firewall-unavailable",
                        "configure-network",
                        format!("could not open Windows Firewall policy: {error:?}"),
                    )
                })?;
            let rules = policy.Rules().map_err(|error| {
                InstallationError::new(
                    "network-firewall-unavailable",
                    "configure-network",
                    format!("could not enumerate Windows Firewall rules: {error:?}"),
                )
            })?;
            operation(&policy, &rules)
        })()
    };
    unsafe {
        CoUninitialize();
    }
    result
}

fn ensure_local_policy_effective(policy: &INetFwPolicy2) -> InstallationResult<()> {
    let mut state = NET_FW_MODIFY_STATE::default();
    let result = unsafe {
        (Interface::vtable(policy).LocalPolicyModifyState)(Interface::as_raw(policy), &mut state)
    };
    if result != S_OK || state != NET_FW_MODIFY_STATE_OK {
        return Err(InstallationError::new(
            "network-policy-ineffective",
            "configure-network",
            format!("local firewall rules are not effective (result={result:?}, state={state:?})"),
        ));
    }
    Ok(())
}

fn ensure_active_firewall_enabled(policy: &INetFwPolicy2) -> InstallationResult<()> {
    let current_profiles = unsafe { policy.CurrentProfileTypes() }.map_err(|error| {
        InstallationError::new(
            "network-firewall-unavailable",
            "verify-network",
            format!("could not resolve active firewall profiles: {error:?}"),
        )
    })?;
    let profiles = [
        NET_FW_PROFILE2_DOMAIN,
        NET_FW_PROFILE2_PRIVATE,
        NET_FW_PROFILE2_PUBLIC,
    ];
    let mut active_profile_found = false;
    for profile in profiles {
        if current_profiles & profile.0 == 0 {
            continue;
        }
        active_profile_found = true;
        let enabled = unsafe { policy.get_FirewallEnabled(profile) }.map_err(|error| {
            InstallationError::new(
                "network-firewall-unavailable",
                "verify-network",
                format!("could not inspect active firewall profile: {error:?}"),
            )
        })?;
        if enabled != VARIANT_TRUE {
            return Err(InstallationError::new(
                "network-policy-ineffective",
                "verify-network",
                "an active Windows Firewall profile is disabled",
            ));
        }
    }
    if !active_profile_found {
        return Err(InstallationError::new(
            "network-policy-ineffective",
            "verify-network",
            "Windows did not report an active firewall profile",
        ));
    }
    Ok(())
}

fn ensure_rule(
    rules: &INetFwRules,
    spec: &RuleSpec<'_>,
    account_sid: &str,
) -> InstallationResult<()> {
    let name = BSTR::from(spec.name);
    let rule: INetFwRule3 = match unsafe { rules.Item(&name) } {
        Ok(existing) => existing.cast().map_err(|error| {
            InstallationError::new(
                "network-rule-invalid",
                "configure-network",
                format!("could not open firewall rule {}: {error:?}", spec.name),
            )
        })?,
        Err(_) => {
            let created: INetFwRule3 =
                unsafe { CoCreateInstance(&NetFwRule, None, CLSCTX_INPROC_SERVER) }.map_err(
                    |error| {
                        InstallationError::new(
                            "network-rule-create-failed",
                            "configure-network",
                            format!("could not create firewall rule {}: {error:?}", spec.name),
                        )
                    },
                )?;
            unsafe { created.SetName(&name) }.map_err(|error| {
                InstallationError::new(
                    "network-rule-create-failed",
                    "configure-network",
                    format!("could not name firewall rule {}: {error:?}", spec.name),
                )
            })?;
            configure_rule(&created, spec, account_sid)?;
            unsafe { rules.Add(&created) }.map_err(|error| {
                InstallationError::new(
                    "network-rule-create-failed",
                    "configure-network",
                    format!("could not add firewall rule {}: {error:?}", spec.name),
                )
            })?;
            created
        }
    };
    configure_rule(&rule, spec, account_sid)?;
    verify_rule(&rule, spec, account_sid)
}

fn configure_rule(
    rule: &INetFwRule3,
    spec: &RuleSpec<'_>,
    account_sid: &str,
) -> InstallationResult<()> {
    unsafe {
        rule.SetDescription(&BSTR::from(spec.description))
            .map_err(|error| rule_error(spec, "description", error))?;
        rule.SetDirection(NET_FW_RULE_DIR_OUT)
            .map_err(|error| rule_error(spec, "direction", error))?;
        rule.SetAction(NET_FW_ACTION_BLOCK)
            .map_err(|error| rule_error(spec, "action", error))?;
        rule.SetProfiles(NET_FW_PROFILE2_ALL.0)
            .map_err(|error| rule_error(spec, "profiles", error))?;
        rule.SetProtocol(spec.protocol)
            .map_err(|error| rule_error(spec, "protocol", error))?;
        rule.SetRemoteAddresses(&BSTR::from(spec.remote_addresses))
            .map_err(|error| rule_error(spec, "remote addresses", error))?;
        rule.SetLocalUserOwner(&BSTR::from(account_sid))
            .map_err(|error| rule_error(spec, "local user owner", error))?;
        rule.SetEnabled(VARIANT_TRUE)
            .map_err(|error| rule_error(spec, "enabled state", error))?;
    }
    Ok(())
}

fn verify_rule(
    rule: &INetFwRule3,
    spec: &RuleSpec<'_>,
    account_sid: &str,
) -> InstallationResult<()> {
    let local_user_owner = unsafe { rule.LocalUserOwner() }
        .map_err(|error| rule_error(spec, "local user owner", error))?
        .to_string();
    let enabled = unsafe { rule.Enabled() }.map_err(|error| rule_error(spec, "enabled", error))?;
    let action = unsafe { rule.Action() }.map_err(|error| rule_error(spec, "action", error))?;
    let direction =
        unsafe { rule.Direction() }.map_err(|error| rule_error(spec, "direction", error))?;
    let protocol =
        unsafe { rule.Protocol() }.map_err(|error| rule_error(spec, "protocol", error))?;
    let remote = unsafe { rule.RemoteAddresses() }
        .map_err(|error| rule_error(spec, "remote addresses", error))?
        .to_string();
    if !local_user_owner.eq_ignore_ascii_case(account_sid)
        || enabled != VARIANT_TRUE
        || action != NET_FW_ACTION_BLOCK
        || direction != NET_FW_RULE_DIR_OUT
        || protocol != spec.protocol
        || !remote.eq_ignore_ascii_case(spec.remote_addresses)
    {
        return Err(InstallationError::new(
            "network-rule-invalid",
            "verify-network",
            format!(
                "Windows Firewall rule {} does not match the fail-closed policy",
                spec.name
            ),
        ));
    }
    Ok(())
}

fn rule_error(spec: &RuleSpec<'_>, field: &str, error: windows::core::Error) -> InstallationError {
    InstallationError::new(
        "network-rule-invalid",
        "configure-network",
        format!("could not configure {field} for {}: {error:?}", spec.name),
    )
}
