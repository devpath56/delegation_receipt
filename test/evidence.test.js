// Evidence-layer checks (not part of the 11-test NSM population).
const { test } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server.js');

async function boot() {
  const app = createApp(); await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const post = async (p, b) => (await fetch(base + p, { method: 'POST', body: JSON.stringify(b || {}) })).json();
  const get = async (p) => (await fetch(base + p)).json();
  return { ...app, post, get, base };
}

test('villain: no receipt sends to Globex; with receipt it is refused', async () => {
  const t = await boot();
  try {
    assert.equal((await t.get('/stripe/list_overdue_invoices'))[0].customer, 'Globex');
    const r1 = await t.post('/demo/run', { mode: 'no_receipt' });
    assert.equal(r1.steps[0].args.to, 'billing@globex.example');
    assert.equal((await t.get('/state')).gmail.length, 2);
    await t.post('/reset');
    const rc = await t.post('/receipts', { recipient: 'billing@acme.example', invoice_id: 'INV-123', parent_grant_ref: 'G-ACME-1' });
    const r2 = await t.post('/demo/run', { mode: 'receipt', receipt_id: rc.id });
    assert.deepEqual(r2.steps.map((s) => s.decision), ['REFUSED', 'ALLOWED']);
    assert.equal((await t.get('/state')).gmail.length, 1);
    assert.equal(rc.expires_at - Date.now() > 590000, true); // ~10 min default
  } finally { t.server.close(); }
});

test('ledger: rows trace to the human, /verify passes, tampering and edits are caught', async () => {
  const t = await boot();
  try {
    const rc = await t.post('/receipts', { recipient: 'billing@acme.example', invoice_id: 'INV-123', parent_grant_ref: 'G-ACME-1' });
    await t.post('/calls', { receipt_id: rc.id, tool: 'send_email', args: { to: 'billing@acme.example', invoice_id: 'INV-123' } });
    await t.post('/calls', { receipt_id: rc.id, tool: 'send_email', args: { to: 'x@y.example', invoice_id: 'INV-123' } });
    const led = await t.get('/ledger');
    assert.deepEqual([led[0].principal, led[0].parent, led[0].subagent, led[0].receipt_id], ['priya', 'parent-agent', 'subagent-1', rc.id]);
    assert.equal((await t.get('/verify')).ok, true);
    assert.throws(() => t.db.prepare("UPDATE ledger SET decision='ALLOWED' WHERE seq=2").run(), /append-only/);
    t.db.exec('DROP TRIGGER ledger_no_update'); // simulate an attacker with raw DB access
    t.db.prepare("UPDATE ledger SET reason='in_scope' WHERE seq=2").run();
    const v = await t.get('/verify');
    assert.deepEqual([v.ok, v.broken_at], [false, 2]);
  } finally { t.server.close(); }
});

test('bypass: direct Gmail key sends with no ledger row', async () => {
  const t = await boot();
  try {
    await t.post('/bypass/gmail', { to: 'billing@globex.example', invoice_id: 'INV-456' });
    const s = await t.get('/state');
    assert.equal(s.gmail.length, 1); assert.equal(s.ledger.length, 0);
  } finally { t.server.close(); }
});

test('policy_rev on every ledger row, covered by the hash chain', async () => {
  const t = await boot();
  try {
    const rc = await t.post('/receipts', { recipient: 'billing@acme.example', invoice_id: 'INV-123', parent_grant_ref: 'G-ACME-1' });
    await t.post('/receipts', { recipient: 'x@y.example', invoice_id: 'INV-9', parent_grant_ref: 'G-ACME-1' }); // REFUSED_MINT row
    await t.post('/calls', { receipt_id: rc.id, tool: 'send_email', args: { to: 'billing@acme.example', invoice_id: 'INV-123' } });
    await t.post('/revoke', { receipt_id: rc.id });
    const led = await t.get('/ledger');
    assert.deepEqual(led.map((l) => l.decision), ['REFUSED_MINT', 'ALLOWED', 'REVOKED']);
    assert.equal(led.every((l) => l.policy_rev === 'v1.1'), true);
    t.db.exec('DROP TRIGGER ledger_no_update');
    t.db.prepare("UPDATE ledger SET policy_rev='v0' WHERE seq=2").run();
    assert.equal((await t.get('/verify')).broken_at, 2);
  } finally { t.server.close(); }
});

test('mint refuses missing/unknown grant', async () => {
  const t = await boot();
  try {
    const a = await fetch(t.base + '/receipts', { method: 'POST', body: JSON.stringify({ recipient: 'billing@acme.example', invoice_id: 'INV-123' }) });
    assert.equal(a.status, 403); assert.equal((await a.json()).reason, 'no_parent_grant');
    const b = await t.post('/receipts', { recipient: 'billing@acme.example', invoice_id: 'INV-123', parent_grant_ref: 'G-NOPE' });
    assert.equal(b.reason, 'unknown_parent_grant');
  } finally { t.server.close(); }
});

test('sends_so_far is derived: a throwing send leaves count 0, ledger FAILED, and the retry succeeds', async () => {
  let fail = true;
  const app = createApp(':memory:', { beforeSend: () => { if (fail) throw new Error('gmail down'); } });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', body: JSON.stringify(b) }); return { s: r.status, b: await r.json() }; };
  try {
    const rc = (await post('/receipts', { recipient: 'billing@acme.example', invoice_id: 'INV-123', parent_grant_ref: 'G-ACME-1' })).b;
    const call = () => post('/calls', { receipt_id: rc.id, tool: 'send_email', args: { to: 'billing@acme.example', invoice_id: 'INV-123' } });
    assert.equal((await call()).b.decision, 'FAILED');
    let st = await (await fetch(base + '/state')).json();
    assert.equal(st.receipts[0].sends_so_far, 0); assert.equal(st.gmail.length, 0);
    assert.equal(st.receipts[0].state, 'ACTIVE');
    fail = false;
    assert.equal((await call()).b.decision, 'ALLOWED');
    st = await (await fetch(base + '/state')).json();
    assert.equal(st.receipts[0].sends_so_far, 1); assert.equal(st.receipts[0].state, 'EXECUTED'); assert.equal(st.gmail.length, 1);
  } finally { app.server.close(); }
});

test('PENDING reservation: a concurrent identical op during the upstream call is refused in_flight, one send only', async () => {
  let app, inner;
  app = createApp(':memory:', { beforeSend: () => { if (!inner) inner = app.gate({ receipt_id: 'R-42', tool: 'send_email', args: { to: 'billing@acme.example', invoice_id: 'INV-123' } }); } });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const post = async (p, b) => (await fetch(base + p, { method: 'POST', body: JSON.stringify(b) })).json();
  try {
    const rc = await post('/receipts', { recipient: 'billing@acme.example', invoice_id: 'INV-123', parent_grant_ref: 'G-ACME-1' });
    assert.equal(rc.id, 'R-42');
    const out = await post('/calls', { receipt_id: rc.id, tool: 'send_email', args: { to: 'billing@acme.example', invoice_id: 'INV-123' } });
    assert.equal(out.decision, 'ALLOWED');
    assert.equal(inner.body.reason, 'in_flight');
    assert.equal((await (await fetch(base + '/state')).json()).gmail.length, 1);
  } finally { app.server.close(); }
});

test('receipt states: MINTED -> ACTIVE -> EXECUTED | EXPIRED | REVOKED; /reset is labelled demo-only', async () => {
  const t = await boot();
  try {
    const mk = (o = {}) => t.post('/receipts', { recipient: 'billing@acme.example', invoice_id: 'INV-123', parent_grant_ref: 'G-ACME-1', ...o });
    const st = async (id) => (await t.get('/state')).receipts.find((r) => r.id === id).state;
    const a = await mk(); assert.equal(a.state, 'MINTED');
    await t.post('/calls', { receipt_id: a.id, tool: 'send_email', args: { to: 'nobody@x.example', invoice_id: 'INV-123' } });
    assert.equal(await st(a.id), 'ACTIVE');
    await t.post('/calls', { receipt_id: a.id, tool: 'send_email', args: { to: 'billing@acme.example', invoice_id: 'INV-123' } });
    assert.equal(await st(a.id), 'EXECUTED');
    const e = await mk({ ttl_seconds: 0 }); assert.equal(await st(e.id), 'EXPIRED');
    const r = await mk(); await t.post('/revoke', { receipt_id: r.id }); assert.equal(await st(r.id), 'REVOKED');
    assert.equal((await t.post('/reset')).demo_only, true);
  } finally { t.server.close(); }
});
