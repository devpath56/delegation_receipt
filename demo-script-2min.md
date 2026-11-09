# Delegation Receipt — 2-minute demo script

**Total: 2:00 · One workflow, one error, one fix**

Follow the README's demo walkthrough beats in order. All numbers below were verified live against main: after beats 0–10, ledger = 8 rows, Gmail = 4 sends.

## 0:00–0:20 — Stakes (Screen 1: Stakes)

> "Priya, a finance lead, asks her agent to email the overdue invoice to Acme. The agent delegates to a subagent. The admin's standing policy allows that subagent to call `send_email` — to anyone.
>
> Mock Stripe returns two overdue invoices. Globex first, Acme second. The subagent is going to make the obvious mistake."

*[On screen: invoice table, Globex INV-456 on top.]*

## 0:20–0:55 — Run 1, no receipt (Screen 2)

> "Run 1, no receipt. The subagent sends to Globex first, then Acme. Two emails. Globex got an invoice that isn't theirs — and there is no per-task record of who authorised what. The log just says the agent did it."

*[On screen: click "Run scripted subagent". Banner: SENT UNDER STANDING POLICY. Gmail: 2 sends, ledger: 0 rows.]*

## 0:55–1:35 — Run 2, with receipt (Screen 3)

> "Run 2, same mistake, with a receipt. R-42 says: this subagent, this tool, Acme only, invoice INV-123 only, one send, ten minutes. And it was minted under a parent grant — the parent can't hand out more than it holds.
>
> Same Globex call — refused before Gmail is ever called. `recipient_out_of_scope`. The correct Acme call goes through, exactly once. An identical retry is replayed, not re-sent. A second distinct email is refused — max sends is one. Try to re-delegate, and the gate refuses that too. Revoke the parent's receipt, and the next call is refused — a dead receipt never replays."

*[On screen: "Mint receipt", then "Run scripted subagent" — REFUSED banner, then ALLOWED. Then "Identical retry" — REPLAYED. "2nd distinct email" — REFUSED. "Try to re-delegate" — REFUSED. "Revoke parent" — REVOKED.]*

## 1:35–2:00 — Evidence + tradeoffs (Screen 4)

> "Evidence: eight ledger rows, hash-chained, every one tracing to Priya — and `GET /verify` passes. And the honest limit: with a raw Gmail key, the receipt can't stop the call. It shows as UNGOVERNED, with no ledger row. The guarantee depends on credentials living in the gateway.
>
> Your policies set the ceiling. Receipts set each task's limit."

*[On screen: ledger table, "verified (8 rows)", Gmail sends: 4 including the bypass.]*

## Wording notes — what the script deliberately does not claim

- **Re-delegation is gate-enforced, not a stored receipt field.** V1 stores no `re_delegate` field on the receipt. The gate refuses `delegate` / `mint_receipt` tool calls as `redelegation_forbidden`, with a UI button and a test. The script says "try to re-delegate, and the gate refuses that too" — never "as a receipt field".
- **Revoke kills the parent's receipt, not a multi-child cascade.** V1 has one parent, one receipt, one child — there is no parent→children chain to cascade through. The script says "revoke the parent's receipt, and the next call is refused", which matches the mechanism on screen.

## Tradeoffs (ad-lib 15 seconds after the close, or for Q&A)

1. **Depth over breadth.** One hop, one operation, one receipt. A second hop would make the demo unprovable in 3 minutes. The one-hop receipt is the thesis, not the whole product.
2. **Logic first, integration second.** V1 is a plain-code gate with mock Gmail — no TrueForge fork, no Cedar, no Gateway. Prove the *semantics* (refuse before execution, replay not re-send, cascade revocation) before paying the integration cost. Cedar is the V2 enforcement point, not the thing being proven.
3. **Exactly-once by reservation, not by counting.** A PENDING row is written before the upstream call; EXECUTED after, FAILED releases it. `sends_so_far` is derived from those rows, never stored — so a failed send can't leave the counter and the ledger disagreeing. A stored counter was the simpler design, and the wrong one.
4. **Honest bypass over a clean story.** The direct-key bypass could have been cut from the demo. Keeping it is the point: the receipt is enforcement *only if* credentials live in the gateway. A demo that hides its own failure mode isn't evidence, it's a pitch.
