# Delegation Receipt — V1 Light Build

UI + Node/SQLite backend (built-in `node:sqlite`, zero dependencies) proving the receipt gate logic with a mock Gmail.
No TrueForge, Gateway, Cedar, real Gmail/Stripe — those are V2.

    npm start    # http://localhost:3000
    npm test

Endpoints: POST /receipts, POST /calls, POST /revoke, GET /ledger, GET /verify (hash-chain replay), GET /stripe/list_overdue_invoices (Globex first), POST /demo/run (scripted villain), POST /bypass/gmail (advisory-bypass demo).
Tests: 11 in test/gate.test.js (N_out=8 out-of-scope incl. wide-mint, N_in=3 in-scope; spec §8 says 10, the case-insensitivity test is kept in addition; "refused before execution" = REFUSED and Gmail send count unchanged) plus evidence checks. Pass/fail checklist, not a rate claim.
Limits: receipt_id is a bearer token (not bound to subagent identity); bypass is advisory.

Gate order: no_receipt → unknown_receipt → parent_revoked → expired → redelegation_forbidden → in_flight (PENDING op) / replay (EXECUTED op, op_id = sha256(receipt_id+tool+canonical(args))) → tool/recipient/invoice scope → limit_exceeded (reserved sends ≥ max_sends) → write PENDING (unique on op_id) → ALLOW (mock Gmail) → EXECUTED, or FAILED on upstream error (reservation released, retry allowed).
Revoked/expired are checked before replay so a dead receipt never replays. The "direct Gmail key" toggle bypasses the gate and leaves no ledger row: enforcement is advisory in V1.

## Hardening (V1-D-04 / V1-D-05)
- `policy_rev` (`v1.1`) is written on every ledger row and covered by the hash chain.
- Mint requires `parent_grant_ref` (fixture `G-ACME-1`); a receipt wider than its grant (tool, recipient, invoice, max_sends) is refused with a `REFUSED_MINT` ledger row.
- `sends_so_far` is derived from `ops` rows with status EXECUTED, never stored. Step 5: a `PENDING` row (unique on `op_id`) is written before the Gmail call; EXECUTED on success, FAILED (reservation released, retry allowed) if the send throws. A concurrent identical op is refused `in_flight`.
- Receipt states (derived): MINTED (no call yet) → ACTIVE (a call presented) → EXECUTED (sends_so_far >= max_sends) | EXPIRED | REVOKED (revoked wins).
- `POST /reset` is DEMO ONLY: it drops the append-only triggers to wipe the ledger, and returns 403 when `NODE_ENV=production`. Do not expose it on a shared deployment.
