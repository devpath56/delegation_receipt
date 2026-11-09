# Delegation Receipt — V1 Light Build

UI + Node/SQLite backend (built-in `node:sqlite`, zero dependencies) proving the receipt gate logic with a mock Gmail.
No TrueForge, Gateway, Cedar, real Gmail/Stripe — those are V2.

    npm start    # http://localhost:3000
    npm test

Endpoints: POST /receipts, POST /calls, POST /revoke, GET /ledger, GET /verify (hash-chain replay), GET /stripe/list_overdue_invoices (Globex first), POST /demo/run (scripted villain), POST /bypass/gmail (advisory-bypass demo).
Tests: 10 in test/gate.test.js (N_out=7 out-of-scope, N_in=3 in-scope; "refused before execution" = REFUSED and Gmail send count unchanged) plus evidence checks. Pass/fail checklist, not a rate claim.
Limits: receipt_id is a bearer token (not bound to subagent identity); bypass is advisory.

Gate order: no_receipt → unknown → parent_revoked → expired → replay (op_id = sha256(receipt_id+tool+canonical(args))) → tool/recipient/invoice scope → max_sends → ALLOW (mock Gmail, ledger row).
Revoked/expired are checked before replay so a dead receipt never replays. The "direct Gmail key" toggle bypasses the gate and leaves no ledger row: enforcement is advisory in V1.
