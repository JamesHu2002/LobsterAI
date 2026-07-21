# Third-party references

The Windows security design was reviewed against:

- OpenAI Codex `codex-rs/windows-sandbox-rs`, commit
  `2deed3fb9c00c74dac3d177ea700d6fb7a94539d`, Apache License 2.0.
- Microsoft Windows API documentation for restricted tokens, access checks,
  Job Objects, process creation, and security descriptors.

The Lobster implementation uses its own protocol, module layout, policy
validation, runner lifecycle, and tests. The reference is recorded so future
security reviews can compare assumptions and API usage.
