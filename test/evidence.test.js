// Evidence-layer checks (not part of the 10-test NSM population).
const { test } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server.js');

async function boot() {
  const app = createApp(); await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const post = async (p, b) => (await fetch(base + p, { method: 'POST', body: JSON.stringify(b || {}) })).json();
  const get = async (p) => (await fetch(base + p)).json();
  return { ...app, post, get };
}

test('villain: no receipt sends to Globex; with receipt it is refused', async () => {
  const t = await boot();
  try {
    assert.equal((await t.get('/stripe/list_overdue_invoices'))[0].customer, 'Globex');
    const r1 = await t.post('/demo/run', { mode: 'no_receipt' });
    assert.equal(r1.steps[0].args.to, 'billing@globex.example');
    assert.equal((await t.get('/state')).gmail.length, 2);
    await t.post('/reset');
    const rc = await t.post('/receipts', { recipient: 'billing@acme.example', invoice_id: 'INV-123' });
    const r2 = await t.post('/demo/run', { mode: 'receipt', receipt_id: rc.id });
    assert.deepEqual(r2.steps.map((s) => s.decision), ['REFUSED', 'ALLOWED']);
    assert.equal((await t.get('/state')).gmail.length, 1);
    assert.equal(rc.expires_at - Date.now() > 590000, true); // ~10 min default
  } finally { t.server.close(); }
});

test('ledger: rows trace to the human, /verify passes, tampering and edits are caught', async () => {
  const t = await boot();
  try {
    const rc = await t.post('/receipts', { recipient: 'billing@acme.example', invoice_id: 'INV-123' });
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
