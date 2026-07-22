# Third-party references

The Windows security design was reviewed against:

- Portions of the Windows account, DPAPI, firewall, restricted-token, and
  setup lifecycle design were adapted from OpenAI Codex
  `codex-rs/windows-sandbox-rs`, commit
  `4f3852107e5eedeb4cb89b57a6d4a35b49f8a59a`, Copyright OpenAI, licensed
  under the Apache License 2.0.
- Microsoft Windows API documentation for restricted tokens, access checks,
  Job Objects, process creation, and security descriptors.

The Lobster implementation uses its own protocol, module layout, policy
validation, runner lifecycle, and tests. The reference is recorded so future
security reviews can compare assumptions and API usage.

The Apache License 2.0 text is available at
<https://www.apache.org/licenses/LICENSE-2.0>.
