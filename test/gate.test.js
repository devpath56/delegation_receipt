const { test } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server.js');

async function boot() {
  const { server } = createApp();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', body: JSON.stringify(b || {}) }); return { s: r.status, b: await r.json() }; };
  const state = async () => (await fetch(base + '/state')).json();
  return { server, post, state };
}
const mk = (post, o = {}) => post('/receipts', { recipient: 'Acme', invoice_id: 'INV-123', max_sends: 1, ...o }).then((r) => r.b.id);
const call = (post, id, to = 'Acme', inv = 'INV-123') => post('/calls', { receipt_id: id, tool: 'send_email', args: { to, invoice_id: inv } });

test('full demo', async () => {
  const { server, post, state } = await boot();
  try {
    const id = await mk(post);
    assert.equal((await call(post, id)).b.decision, 'ALLOWED');
    assert.equal((await call(post, id, 'Globex')).b.reason, 'recipient_out_of_scope');
    assert.equal((await call(post, id, 'Acme', 'INV-124')).b.reason, 'invoice_out_of_scope');
    assert.equal((await post('/calls', { tool: 'send_email', args: {} })).b.reason, 'no_receipt');
    assert.equal((await call(post, id)).b.decision, 'REPLAYED');
    assert.equal((await state()).gmail.length, 1);
    // limit: widen receipt to two invoices not possible; use second receipt scoped same recipient but max 1 via different args
    const id2 = await mk(post, { max_sends: 1 });
    await call(post, id2);
    assert.equal((await post('/calls', { receipt_id: id2, tool: 'send_email', args: { to: 'Acme', invoice_id: 'INV-123', note: 'x' } })).b.reason, 'limit_exceeded');
    const exp = await mk(post, { ttl_seconds: 0 });
    assert.equal((await call(post, exp)).b.reason, 'expired');
    const rv = await mk(post);
    await post(`/receipts/${rv}/revoke`);
    assert.equal((await call(post, rv)).b.reason, 'parent_revoked');
    const before = (await state()).ledger.length;
    await post('/bypass/gmail', { to: 'Globex', invoice_id: 'X' });
    const s = await state();
    assert.equal(s.ledger.length, before);
    assert.equal(s.gmail.length, 3);
    const row = s.ledger.find((l) => l.decision === 'ALLOWED');
    assert.deepEqual([row.principal, row.parent, row.subagent], ['priya', 'parent-agent', 'subagent-1']);
  } finally { server.close(); }
});
