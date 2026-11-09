// 11 deterministic tests: N_out = 8 out-of-scope (7 gate calls + 1 wide mint), N_in = 3 in-scope.
// (Spec §8 says 10; the case-insensitivity test is kept in addition to the wide-mint test, so the population is 11.)
// "Refused before execution" = decision REFUSED and the mock Gmail send count is unchanged.
const { test, after } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server.js');

const ACME = 'billing@acme.example';
const tally = { out: 0, outRefused: 0, in: 0, inWronglyRefused: 0 };

async function boot() {
  const { server } = createApp();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', body: JSON.stringify(b || {}) }); return { s: r.status, b: await r.json() }; };
  const sends = async () => (await (await fetch(base + '/state')).json()).gmail.length;
  const mk = (o = {}) => post('/receipts', { recipient: ACME, invoice_id: 'INV-123', max_sends: 1, parent_grant_ref: 'G-ACME-1', ...o }).then((r) => r.b.id);
  const call = (id, args = { to: ACME, invoice_id: 'INV-123' }, tool = 'send_email') => post('/calls', { receipt_id: id, tool, args });
  return { server, post, sends, mk, call };
}
// out-of-scope: must be REFUSED with the expected reason and zero new sends
async function outOfScope(name, reason, fn) {
  test(`OUT: ${name}`, async () => {
    const t = await boot(); tally.out++;
    try {
      const r = await fn(t); // fn runs setup, then returns the single out-of-scope call
      const before = r.before ?? 0; // only the over-limit test sets up a prior send
      if (/^REFUSED/.test(r.b.decision) && (await t.sends()) === before) tally.outRefused++;
      assert.match(r.b.decision, /^REFUSED/); assert.equal(r.b.reason, reason);
      assert.equal(await t.sends(), before, 'Gmail send count must be unchanged');
    } finally { t.server.close(); }
  });
}
async function inScope(name, decision, fn) {
  test(`IN: ${name}`, async () => {
    const t = await boot(); tally.in++;
    try {
      const { r, expectSends } = await fn(t);
      if (/^REFUSED/.test(r.b.decision)) tally.inWronglyRefused++;
      assert.equal(r.b.decision, decision);
      assert.equal(await t.sends(), expectSends);
    } finally { t.server.close(); }
  });
}

outOfScope('wrong recipient only (Globex address, correct invoice INV-123)', 'recipient_out_of_scope', async (t) => t.call(await t.mk(), { to: 'billing@globex.example', invoice_id: 'INV-123' }));
outOfScope('wrong invoice, right recipient', 'invoice_out_of_scope', async (t) => t.call(await t.mk(), { to: ACME, invoice_id: 'INV-124' }));
outOfScope('over limit: 2nd distinct send under max_sends=1', 'limit_exceeded', async (t) => {
  const id = await t.mk(); await t.call(id); const before = await t.sends();
  return { ...(await t.call(id, { to: ACME, invoice_id: 'INV-123', note: 'second' })), before }; });
outOfScope('wide mint: receipt wider than parent grant is refused at mint', 'exceeds_parent_grant', async (t) => {
  const r = await t.mk({ recipient: 'billing@globex.example', invoice_id: 'INV-456', max_sends: 5 });
  assert.equal(r, undefined); // no receipt id was issued
  const rr = await t.post('/receipts', { recipient: ACME, invoice_id: 'INV-123', max_sends: 5, parent_grant_ref: 'G-ACME-1' });
  assert.equal(rr.s, 403); assert.equal(rr.b.decision, 'REFUSED_MINT'); return rr; });
outOfScope('expired receipt', 'expired', async (t) => t.call(await t.mk({ ttl_seconds: 0 })));
outOfScope('parent revoked', 'parent_revoked', async (t) => { const id = await t.mk(); await t.post('/revoke', { receipt_id: id }); return t.call(id); });
outOfScope('no receipt', 'no_receipt', async (t) => t.call(undefined));
outOfScope('re-delegation attempt', 'redelegation_forbidden', async (t) => t.call(await t.mk(), { max_sends: 99 }, 'delegate'));

inScope('first send runs once', 'ALLOWED', async (t) => ({ r: await t.call(await t.mk()), expectSends: 1 }));
inScope('identical retry with different arg key order is replayed (still 1 send)', 'REPLAYED', async (t) => {
  const id = await t.mk(); await t.call(id); return { r: await t.call(id, { invoice_id: 'INV-123', to: ACME }), expectSends: 1 }; });
inScope('recipient in different case is still in scope', 'ALLOWED', async (t) => ({ r: await t.call(await t.mk(), { to: 'Billing@ACME.example', invoice_id: 'INV-123' }), expectSends: 1 }));

after(() => {
  console.log(`\nNSM: ${tally.outRefused}/${tally.out} out-of-scope calls refused before execution (N_out=${tally.out})`);
  console.log(`Counter: ${tally.inWronglyRefused}/${tally.in} in-scope calls wrongly refused (N_in=${tally.in})`);
  console.log('Pass/fail checklist over 11 self-written tests, not a rate claim.');
});
