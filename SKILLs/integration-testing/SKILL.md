---
name: integration-testing
description: Test how modules, services, and external dependencies work together. Use when asked to verify component interactions, API contracts, or database/queue/service integration.
official: true
metadata:
  short-description: Cross-module integration tests
---

# Integration Testing

## Goal

Verify that modules, services, and external systems **work correctly together** — contracts, data flow, and failure modes.

## Workflow

1. **Identify the seams under test**
   - Choose the integration boundary: two modules, an HTTP API + client, DB layer + service, message queue consumer/producer.
   - Decide what is real vs. substituted (real DB in a test container, real HTTP for contract tests, mocks for third-party paid APIs).

2. **Write contract-and-flow tests**
   - Verify **contracts**: request/response shapes, status codes, schemas, error responses.
   - Verify **data flow**: a record written by A is read correctly by B; transactions commit/roll back.
   - Verify **failure modes**: downstream timeout/error surfaces correctly to the caller.
   - Use the project's existing test setup; prefer test containers / seeded DBs over production data.

3. **Isolate side effects**
   - Use unique test data, transactional rollback, or per-test clean-up.
   - Keep tests independent and order-independent.

4. **Run and verify**
   - Run the integration suite; fix flakiness caused by shared state or timing.
   - Report which boundaries were covered and any that need manual/CI verification.

## Rules

- **Favour a few high-value integration tests** over many shallow ones; the pyramid says most coverage is unit-level.
- Make **timeouts and retries** explicit and short in tests.
- Tag tests that need external services (e.g. `@integration`) so they can be skipped in fast local runs.
- Assert on **outcomes** (what the consumer receives), not internal calls.
