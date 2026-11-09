# Delegation Receipt — V1 Light Build

UI + Node/SQLite backend (built-in `node:sqlite`, zero dependencies) proving the receipt gate logic with a mock Gmail.
No TrueForge, Gateway, Cedar, real Gmail/Stripe — those are V2.

    npm start    # http://localhost:3000
    npm test

Gate order: no_receipt → unknown → parent_revoked → expired → replay (op_id = sha256(receipt_id+tool+canonical(args))) → tool/recipient/invoice scope → max_sends → ALLOW (mock Gmail, ledger row).
Revoked/expired are checked before replay so a dead receipt never replays. The "direct Gmail key" toggle bypasses the gate and leaves no ledger row: enforcement is advisory in V1.
Note: the posted spec was cut off after check 4; checks 5+ (limit, expiry, revoke, ledger) are inferred from the "What V1 proves" list.

License: MIT (see LICENSE).
