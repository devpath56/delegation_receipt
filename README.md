# Delegation Receipt — V1 Light Build

**Your policies set the ceiling. Receipts set each task's limit.**

A parent agent can delegate one irreversible operation to one subagent — and the subagent can run it only inside a signed, scoped, revocable receipt. Same mistake, twice: without a receipt it costs $75 to the wrong customer; with a receipt it costs $0 and leaves an exact record.

## TL;DR — 30 seconds

```bash
npm start    # http://localhost:3000 — Node >= 22.5, zero dependencies
npm test     # 19/19 pass: 8/8 out-of-scope calls refused, 0/3 in-scope calls wrongly refused
```

| What V1 proves | Result |
| --- | --- |
| Out-of-scope subagent calls refused **before** execution | **8/8** (counts, not a rate claim) |
| In-scope calls wrongly refused | **0/3** |
| Identical retry double-sends | **0** — replayed, one send total |
| Ledger replays to its accountable human | **Yes** — `GET /verify` passes, hash-chained |

## What it is

Priya (finance ops lead) approves `invoice-agent` to email overdue invoices. The parent agent delegates to a `reminder-worker` subagent. The receipt `R-42` says exactly what that subagent may do — and nothing else:

```json
{ "receipt_id": "R-42", "principal": "priya@example.com", "parent": "invoice-agent",
  "subagent": "reminder-worker", "tool": "gmail.send_email",
  "constraints": { "recipient": "billing@acme.example", "invoice_id": "INV-123", "max_sends": 1 },
  "expires_at": "+10 min", "re_delegate": false, "parent_grant_ref": "G-ACME-1" }
```

Every call is checked against that receipt **before** Gmail is called, and every decision — allowed, refused, replayed, revoked — is written to a hash-chained, append-only ledger that traces back to Priya.

## Why it matters

A standing admin policy says "this agent may call `send_email`". That is a ceiling, not a task limit. A prompt says "email Acme". That is not a limit at all — the model can misread it, and the log then blames the human who wrote the prompt.

The receipt fixes the gap between those two:

- **Identity is not authority.** The subagent is authenticated, but it may only do what its receipt allows, for one invoice, once, for 10 minutes.
- **A retry is not a replay.** The same call twice sends once. A *different* call under `max_sends=1` is refused.
- **Revocation cascades.** Revoke the parent and the child's receipt dies with it.
- **The log reconstructs the decision.** A stranger can run `./verify` (here: `GET /verify`) and trace every row to the human who authorised it.

This is V1: the receipt *logic*, in a UI + Node/SQLite backend with mock Stripe and mock Gmail. It does **not** prove TrueForge spawn hooks, Gateway passthrough, Cedar context, or hosted subagent identity — that is V2. See Limits below.

## Design Tradeoffs

| Tradeoff | Chose | Gave up | Why |
| --- | --- | --- | --- |
| Depth vs breadth | One hop, one operation, one receipt | Multi-agent / multi-hop delegation | A second hop would make the demo unprovable in 3 minutes. The one-hop receipt is the thesis, not the whole product. |
| Logic first, integration second | Plain-code gate + mock Gmail in V1 | TrueForge fork, Cedar, Gateway in V1 | Prove the *semantics* (refuse before execution, replay not re-send, cascade revocation) before paying the integration cost. Cedar is the V2 enforcement point, not the thing being proven. |
| Exactly-once by reservation, not by counting | PENDING row before the upstream call; `sends_so_far` derived from EXECUTED rows, never stored | A simpler stored counter | A stored counter can disagree with the ledger if the send fails. Reservation + derivation can't: a failed send leaves the count at 0 and the reservation released. |
| Honest bypass over a clean story | Keep the direct-key bypass in the demo (beat 9) | A demo with no visible failure mode | The receipt is enforcement *only if* credentials live in the gateway. A demo that hides its own failure mode isn't evidence, it's a pitch. |

## Demo walkthrough — reproduce in 3 minutes

Start fresh, then follow the beats **in order**. No other setup is needed; every button is labelled exactly as shown. Counts below are cumulative Gmail sends / ledger rows as shown on screen 4 (Evidence).

```bash
npm start    # open http://localhost:3000
```

| Beat | Screen / click | What you see (big banner) | What it proves | Gmail / ledger after |
| --- | --- | --- | --- | --- |
| 0. Stakes | **1. Stakes** — read the invoice table | Mock Stripe lists **Globex first** (INV-456), Acme second (INV-123) | The mistake is seeded: the first invoice the subagent sees is the wrong one | 0 / 0 |
| 1. No receipt | **2. Run 1** → **Run scripted subagent** | ⛔ SENT UNDER STANDING POLICY | Without a receipt, the standing policy allows everything — Globex gets the invoice email | **2** / 0 — no per-task record exists |
| 2. Mint | **3. Run 2** → **Mint receipt** | Receipt line: `R-42: priya → parent-agent → subagent-1; send_email to billing@acme.example for INV-123; max_sends=1; grant G-ACME-1; state MINTED (sends_so_far 0)` | The receipt is narrower than the admin policy, and narrower than the parent's grant | 2 / 0 |
| 3. With receipt | **3. Run 2** → **Run scripted subagent** | ⛔ REFUSED — no email was sent (`recipient_out_of_scope`, Globex), then ✓ ALLOWED — sent once (Acme) | The same mistake now costs $0; the correct send still works | **3** (1 new) / 2 |
| 4. Identical retry | **3. Run 2** → **Identical retry** | ↩ REPLAYED — same call, no second send | A retry is a replay, not a second charge | 3 / 3 |
| 5. Second distinct email | **3. Run 2** → **2nd distinct email** | ⛔ REFUSED (`limit_exceeded`) | `max_sends=1` means one *distinct* send, not one call shape | 3 / 4 |
| 6. No receipt | **3. Run 2** → **Call with no receipt** | ⛔ REFUSED (`no_receipt`) | A call with no receipt is refused, not allowed by default | 3 / 5 |
| 7. Re-delegate | **3. Run 2** → **Try to re-delegate** | ⛔ REFUSED (`redelegation_forbidden`) | The child cannot hand its authority on to anyone else | 3 / 6 |
| 8. Kill switch | **3. Run 2** → **Revoke parent**, then **Identical retry** | ⚠ REVOKED, then ⛔ REFUSED (`parent_revoked`) | Revoking the parent kills the child's receipt — a dead receipt never replays | 3 / 8 |
| 9. Bypass, honestly | **3. Run 2** → **Send via direct key (Globex)** | ⛔ UNGOVERNED — direct key, no ledger row | With a raw Gmail key the receipt cannot stop the call. The guarantee depends on credentials living in the gateway — shown, not hidden | **4** / 8 (unchanged) |
| 10. Evidence | **4. Evidence** — read the ledger and Gmail tables | `Ledger chain: verified (8 rows)` · Gmail sends: 4 | Every decision traces to Priya: REFUSED / ALLOWED / REPLAYED / REVOKED rows, each with a hash | 4 / 8, `GET /verify` → `{"ok": true}` |
| 11. Expired receipt | **4. Evidence** → **Reset (DEMO ONLY)**, then **3. Run 2** → **Mint expired**, then **Run scripted subagent** | ⛔ REFUSED (`expired`) on both steps | A receipt past its 10 minutes is dead, even for the right recipient | 0 / 2 after reset |
| 12. Wide mint (API) | In a terminal: `curl -s -X POST localhost:3000/receipts -H 'Content-Type: application/json' -d '{"recipient":"billing@globex.example","invoice_id":"INV-456","max_sends":5,"parent_grant_ref":"G-ACME-1"}'` | `403 {"decision":"REFUSED_MINT","reason":"exceeds_parent_grant"}` | A receipt wider than its parent grant is refused **at mint** — the parent cannot hand out more than it holds | No receipt issued; a `REFUSED_MINT` ledger row is written |

If any beat shows a different banner, count, or reason, the demo has diverged from the spec — that is a bug, not a different interpretation.

## How to run and verify

```bash
npm start    # http://localhost:3000
npm test     # 19/19 pass
```

Tests are a pass/fail checklist over self-written deterministic tests, not a rate claim: 11 in `test/gate.test.js` (N_out=8 out-of-scope, N_in=3 in-scope; the spec's §8 lists 10, the case-insensitivity test is kept in addition) plus 8 in `test/evidence.test.js` (villain demo, ledger tamper-evidence, bypass, `policy_rev`, wide mint, derived sends, PENDING reservation, receipt states). "Refused before execution" means decision `REFUSED` **and** the mock Gmail send count is unchanged.

## How it works

### The gate, in order

```
no_receipt → unknown_receipt → parent_revoked → expired → redelegation_forbidden
  → in_flight (PENDING op) / replay (EXECUTED op; op_id = sha256(receipt_id + tool + canonical(args)))
  → tool / recipient / invoice scope → limit_exceeded (reserved sends ≥ max_sends)
  → write PENDING (unique on op_id) → ALLOW (mock Gmail) → EXECUTED,
    or FAILED on upstream error (reservation released, retry allowed)
```

Revoked/expired are checked before replay, so a dead receipt never replays. `sends_so_far` is **derived** from `ops` rows with status `EXECUTED`, never stored; a failed send leaves the count at 0. A concurrent identical call while one is in flight is refused `in_flight` — never a second upstream call.

### The receipt

- **Minted under a grant.** `POST /receipts` requires `parent_grant_ref` (fixture `G-ACME-1`: Acme / INV-123 / max 1). A receipt wider than its grant in tool, recipient, invoice, or `max_sends` is refused with a `REFUSED_MINT` ledger row.
- **Carried in tool arguments.** `receipt_id` travels in the tool-call JSON body, not in a header (per-child headers fail by code inspection against TrueForge — see the V2 note below).
- **Lifecycle (derived, not stored):** `MINTED` (no call yet) → `ACTIVE` (a call presented) → `EXECUTED` (sends_so_far ≥ max_sends) | `EXPIRED` | `REVOKED` (revoked wins). Shown live on the receipt line in the UI.

### The ledger

SQLite, append-only (UPDATE/DELETE triggers), hash-chained (`prev_hash` / `hash`, genesis `0`×64). Every row carries `policy_rev` (`v1.1`), covered by the hash chain, and traces `principal → parent → subagent → call`. `GET /verify` replays the chain and reports the first broken row, if any. `GET /ledger` returns all rows; `GET /state` returns receipts, ledger, Gmail outbox, and the verify result.

## Endpoints

| Endpoint | What it does |
| --- | --- |
| `POST /receipts` | Mint a receipt under a parent grant (403 `REFUSED_MINT` if wider than the grant) |
| `POST /calls` | One gated tool call: `{receipt_id, tool, args}` → `ALLOWED` / `REFUSED` / `REPLAYED` / `FAILED` |
| `POST /revoke` | Revoke a receipt by id (`{"receipt_id": "R-42"}`); also `POST /receipts/:id/revoke` |
| `GET /ledger` | All ledger rows |
| `GET /verify` | Replay the hash chain: `{"ok": true, "rows": N}` or `{"ok": false, "broken_at": seq}` |
| `GET /stripe/list_overdue_invoices` | Mock Stripe fixture — Globex first, Acme second |
| `POST /demo/run` | Scripted villain: `{"mode": "no_receipt"}` or `{"mode": "receipt", "receipt_id": "R-42"}` |
| `POST /bypass/gmail` | Direct Gmail key — sends with no ledger row (advisory-bypass demo) |
| `GET /state` | Receipts (with `state` + `sends_so_far`), ledger, Gmail outbox, verify result |
| `POST /reset` | **DEMO ONLY** — wipes receipts/ops/ledger/Gmail; returns 403 when `NODE_ENV=production` |

## Limits — stated honestly

- `receipt_id` is a **bearer token**: any child holding it passes; it is not bound to subagent identity.
- **Bypass is advisory**: a holder of the raw Gmail key skips the gate and leaves no ledger row (beat 9 shows this on purpose).
- The ledger is hash-chained and append-only in SQLite; anyone with raw DB write access can still rewrite the whole chain. `POST /reset` drops the append-only triggers to wipe it — demo only, never expose it on a shared deployment.
- Parent/worker are scripted roles, not model agents; the mistake is seeded deterministically (Globex first in the fixture), not produced by a live model.
- Tests are self-written pass/fail checks, not a rate claim. The L3 simulated run set (20–50 runs) is not built yet.

## What is V2

V1 proves the receipt logic with no TrueFoundry access. V2 moves the same logic into the real system: a TrueForge spawn-hook fork (per-child limits, `receipt_id` in tool arguments), the receipt gate as an MCP proxy in front of the TrueFoundry Gateway, Cedar policy for the five checks, and hosted subagent identity via `x-tfy-agent-authorization`. Three Day-0 checks gate V2: hosted subagent identity, gateway header forwarding, and whether Cedar can receive receipt context natively. See `delegation-receipt-v2-access-note-2026-11-09.md` in the proposal set.
