---
name: e2e-testing
description: Drive end-to-end tests through the real application (browser/UI). Use when asked to test a user flow, verify UI behaviour, or run browser-based scenarios.
official: true
metadata:
  short-description: Browser end-to-end testing
---

# End-to-End Testing

## Goal

Verify **real user flows** through the running application (browser UI), not isolated units.

## Workflow

1. **Scope the flow**
   - Identify the user journey to cover (login → action → result), the starting URL, and the expected end state.
   - Check the project's E2E setup (Playwright, Cypress, etc.) and how the app is launched for tests.

2. **Drive the real app**
   - Use the project's browser-automation tooling (e.g. the bundled `playwright` skill) to:
     - navigate to the page, wait for readiness,
     - interact (click, fill, submit) following the real flow,
     - assert on visible state (text, elements, navigation, network calls if relevant).
   - Prefer **stable selectors** (roles, test ids, data attributes) over fragile CSS/XPath.

3. **Make it deterministic**
   - Control state before the test: seed data, mock external APIs at the network layer, pin time.
   - Use explicit waits on expected conditions rather than fixed sleeps.
   - Keep each test independent (clean state between runs).

4. **Report**
   - Capture evidence on failure: screenshot / DOM snapshot / trace (Playwright trace or equivalent).
   - Distinguish product bugs from test bugs (flaky selector, missing wait).

## Rules

- E2E is the **tip of the pyramid**: cover the few critical user journeys, not every edge case.
- If the project has no E2E harness, set up a minimal Playwright setup first (see the `playwright` skill) and note it.
- Do not depend on production data or live third-party services without a controllable mock.
- If a flow can't be driven reliably, report that and suggest a lower-level test.
