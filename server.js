// Delegation Receipt V1 — receipt gate logic only. No TrueForge, Gateway, Cedar, real Gmail/Stripe.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const POLICY_REV = 'v1.1'; // stamped on every ledger row (V1-D-04)

function createApp(dbPath = ':memory:', opts = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, principal TEXT, parent TEXT, subagent TEXT,
      tool TEXT, recipient TEXT, invoice_id TEXT, max_sends INTEGER, parent_grant_ref TEXT,
      expires_at INTEGER, revoked INTEGER DEFAULT 0);
    -- PENDING is written (unique on op_id) BEFORE the upstream call; EXECUTED/FAILED after. sends_so_far is derived from these rows.
    CREATE TABLE IF NOT EXISTS ops (op_id TEXT PRIMARY KEY, receipt_id TEXT, status TEXT, result TEXT);
    CREATE TABLE IF NOT EXISTS ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, decision TEXT, reason TEXT,
      principal TEXT, parent TEXT, subagent TEXT, receipt_id TEXT, tool TEXT, args TEXT, op_id TEXT, policy_rev TEXT, prev_hash TEXT, hash TEXT);
    CREATE TABLE IF NOT EXISTS gmail (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, to_addr TEXT, invoice_id TEXT, via TEXT);
  `);
  const TRIGGERS = `
    CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'ledger is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'ledger is append-only'); END;`;
  db.exec(TRIGGERS);
  let counter = 41;
  // parent grants: the ceiling a receipt may be minted under (spec §8: a receipt can never be wider than its grant)
  const GRANTS = {
    'G-ACME-1': { principal: 'priya', parent: 'parent-agent', tool: 'send_email', recipients: ['billing@acme.example'], invoice_ids: ['INV-123'], max_sends: 1 },
  };
  const GENESIS = '0'.repeat(64);
  // mock Stripe fixture: the villain fixture lists Globex FIRST
  const INVOICES = [
    { invoice_id: 'INV-456', customer: 'Globex', email: 'billing@globex.example', overdue_days: 41 },
    { invoice_id: 'INV-123', customer: 'Acme', email: 'billing@acme.example', overdue_days: 12 },
  ];

  // canonical JSON: sorted keys, so arg order never changes the op_id
  const canon = (v) => Array.isArray(v) ? `[${v.map(canon)}]` : v && typeof v === 'object'
    ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k]))}}` : JSON.stringify(v);
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

  // ---- mock Gmail (the only side effect) ----
  function gmailSend(to, invoice_id, via) {
    const r = db.prepare('INSERT INTO gmail (ts,to_addr,invoice_id,via) VALUES (?,?,?,?)').run(Date.now(), to, invoice_id, via);
    return { message_id: 'msg_' + r.lastInsertRowid, to, invoice_id };
  }

  const rowHash = (prev, r) => sha(prev + JSON.stringify([r.ts, r.decision, r.reason, r.principal, r.parent, r.subagent, r.receipt_id, r.tool, r.args, r.op_id, r.policy_rev]));
  function log(decision, reason, rc, receipt_id, tool, args, op_id) {
    const r = { ts: Date.now(), decision, reason, principal: rc?.principal ?? null, parent: rc?.parent ?? null,
      subagent: rc?.subagent ?? null, receipt_id: receipt_id ?? null, tool: tool ?? null, args: JSON.stringify(args ?? null), op_id: op_id ?? null, policy_rev: POLICY_REV };
    const prev = db.prepare('SELECT hash FROM ledger ORDER BY seq DESC LIMIT 1').get()?.hash ?? GENESIS;
    db.prepare(`INSERT INTO ledger (ts,decision,reason,principal,parent,subagent,receipt_id,tool,args,op_id,policy_rev,prev_hash,hash)
      VALUES (:ts,:decision,:reason,:principal,:parent,:subagent,:receipt_id,:tool,:args,:op_id,:policy_rev,:prev_hash,:hash)`)
      .run({ ...r, prev_hash: prev, hash: rowHash(prev, r) });
  }
  // replay the chain from genesis; report the first row that does not match
  function verify() {
    let prev = GENESIS;
    const rows = db.prepare('SELECT * FROM ledger ORDER BY seq').all();
    for (const r of rows) {
      if (r.prev_hash !== prev || r.hash !== rowHash(prev, r)) return { ok: false, rows: rows.length, broken_at: r.seq };
      prev = r.hash;
    }
    return { ok: true, rows: rows.length, head: prev, broken_at: null };
  }

  function mint(b) {
    const ttl = Number.isFinite(b.ttl_seconds) ? b.ttl_seconds : 600;
    const r = { principal: b.principal || 'priya', parent: b.parent || 'parent-agent', subagent: b.subagent || 'subagent-1',
      tool: b.tool || 'send_email', recipient: typeof b.recipient === 'string' ? b.recipient.toLowerCase() : b.recipient, invoice_id: b.invoice_id,
      max_sends: Number.isInteger(b.max_sends) ? b.max_sends : 1, parent_grant_ref: b.parent_grant_ref ?? null, expires_at: Date.now() + ttl * 1000 };
    if (!r.recipient || !r.invoice_id) throw Object.assign(new Error('recipient and invoice_id required'), { status: 400 });
    // wide-mint guard: the receipt must be present in, and no wider than, its parent grant
    const g = GRANTS[r.parent_grant_ref];
    const why = !r.parent_grant_ref ? 'no_parent_grant' : !g ? 'unknown_parent_grant'
      : r.tool !== g.tool || !g.recipients.includes(r.recipient) || !g.invoice_ids.includes(r.invoice_id) || r.max_sends > g.max_sends || r.max_sends < 1
        ? 'exceeds_parent_grant' : null;
    if (why) { log('REFUSED_MINT', why, r, null, 'mint_receipt', { recipient: r.recipient, invoice_id: r.invoice_id, max_sends: r.max_sends, parent_grant_ref: r.parent_grant_ref });
      throw Object.assign(new Error(why), { status: 403, body: { decision: 'REFUSED_MINT', reason: why } }); }
    r.id = 'R-' + (++counter);
    db.prepare(`INSERT INTO receipts (id,principal,parent,subagent,tool,recipient,invoice_id,max_sends,parent_grant_ref,expires_at)
      VALUES (:id,:principal,:parent,:subagent,:tool,:recipient,:invoice_id,:max_sends,:parent_grant_ref,:expires_at)`).run(r);
    return getReceipt(r.id);
  }
  // sends_so_far is DERIVED from ops rows, never stored. EXECUTED = completed; PENDING = reserved, upstream call in flight.
  const sendsSoFar = (id) => db.prepare("SELECT COUNT(*) n FROM ops WHERE receipt_id=? AND status='EXECUTED'").get(id).n;
  const reservedSends = (id) => db.prepare("SELECT COUNT(*) n FROM ops WHERE receipt_id=? AND status IN ('PENDING','EXECUTED')").get(id).n;
  // Receipt lifecycle (V1-D-05): MINTED -> ACTIVE -> EXECUTED | EXPIRED | REVOKED. Derived, not stored.
  //   MINTED  no call presented yet      ACTIVE   a call was presented, still usable
  //   EXECUTED sends_so_far >= max_sends EXPIRED  past expires_at     REVOKED  parent revoked (wins over all)
  function receiptState(rc, sends) {
    if (rc.revoked) return 'REVOKED';
    if (sends >= rc.max_sends) return 'EXECUTED';
    if (Date.now() >= rc.expires_at) return 'EXPIRED';
    const seen = db.prepare('SELECT 1 FROM ledger WHERE receipt_id=? LIMIT 1').get(rc.id);
    return seen ? 'ACTIVE' : 'MINTED';
  }
  const getReceipt = (id) => { const rc = db.prepare('SELECT * FROM receipts WHERE id=?').get(id);
    if (!rc) return rc; const n = sendsSoFar(id); return { ...rc, sends_so_far: n, state: receiptState(rc, n) }; };

  // ---- RECEIPT GATE: plain code, no Cedar ----
  function gate({ receipt_id, tool, args }) {
    args = { ...(args || {}) };
    if (typeof args.to === 'string') args.to = args.to.toLowerCase(); // recipient case never changes the decision
    if (!receipt_id) { log('REFUSED', 'no_receipt', null, null, tool, args); return { status: 403, body: { decision: 'REFUSED', reason: 'no_receipt' } }; }
    const rc = getReceipt(receipt_id);
    const refuse = (reason, op_id) => { log('REFUSED', reason, rc, receipt_id, tool, args, op_id); return { status: 403, body: { decision: 'REFUSED', reason } }; };
    if (!rc) return refuse('unknown_receipt');
    if (rc.revoked) return refuse('parent_revoked');
    if (Date.now() >= rc.expires_at) return refuse('expired');
    if (tool === 'delegate' || tool === 'mint_receipt') return refuse('redelegation_forbidden');
    const op_id = sha(receipt_id + tool + canon(args));
    const prior = db.prepare('SELECT status, result FROM ops WHERE op_id=?').get(op_id);
    if (prior?.status === 'PENDING') return refuse('in_flight', op_id); // same op already reserved: never a second upstream call
    if (prior?.status === 'EXECUTED') { log('REPLAYED', 'identical_retry', rc, receipt_id, tool, args, op_id);
      return { status: 200, body: { decision: 'REPLAYED', result: JSON.parse(prior.result) } }; }
    if (tool !== rc.tool) return refuse('tool_out_of_scope', op_id);
    if (args.to !== rc.recipient) return refuse('recipient_out_of_scope', op_id);
    if (args.invoice_id !== rc.invoice_id) return refuse('invoice_out_of_scope', op_id);
    if (reservedSends(receipt_id) >= rc.max_sends) return refuse('limit_exceeded', op_id);
    // all checks passed: write PENDING (unique on op_id) BEFORE forwarding upstream; a FAILED op may be retried
    try { db.prepare("INSERT INTO ops (op_id,receipt_id,status) VALUES (?,?,'PENDING')").run(op_id, receipt_id); }
    catch { if (prior?.status === 'FAILED') db.prepare("UPDATE ops SET status='PENDING' WHERE op_id=?").run(op_id); else return refuse('in_flight', op_id); }
    let result;
    try { opts.beforeSend?.(); result = gmailSend(args.to, args.invoice_id, 'gate'); }
    catch (e) { db.prepare("UPDATE ops SET status='FAILED' WHERE op_id=?").run(op_id); // reservation released; sends_so_far unchanged
      log('FAILED', 'upstream_error', rc, receipt_id, tool, args, op_id); return { status: 502, body: { decision: 'FAILED', reason: 'upstream_error' } }; }
    db.prepare("UPDATE ops SET status='EXECUTED', result=? WHERE op_id=?").run(JSON.stringify(result), op_id);
    log('ALLOWED', 'in_scope', rc, receipt_id, tool, args, op_id);
    return { status: 200, body: { decision: 'ALLOWED', result } };
  }

  // scripted demo: no model runs. The parent picks the first overdue invoice (Globex), then the right one.
  function demo(mode, rid) {
    const out = { steps: [] };
    const villain = INVOICES[0], right = INVOICES.find((i) => i.customer === 'Acme');
    for (const inv of [villain, right]) {
      const args = { to: inv.email, invoice_id: inv.invoice_id };
      if (mode === 'no_receipt') { // standing admin policy: any send_email is allowed, no per-task record
        out.steps.push({ args, decision: 'ALLOWED_BY_STANDING_POLICY', result: gmailSend(args.to, args.invoice_id, 'admin_policy') });
      } else { const o = gate({ receipt_id: rid, tool: 'send_email', args }); out.steps.push({ args, decision: o.body.decision, reason: o.body.reason, result: o.body.result }); }
    }
    return out;
  }

  const state = () => ({
    receipts: db.prepare('SELECT id FROM receipts ORDER BY rowid').all().map((r) => getReceipt(r.id)),
    ledger: db.prepare('SELECT * FROM ledger ORDER BY seq').all().map((r) => ({ ...r, args: JSON.parse(r.args) })),
    gmail: db.prepare('SELECT * FROM gmail ORDER BY id').all(),
    verify: verify(),
  });

  const readBody = (req) => new Promise((res, rej) => { let d = ''; req.on('data', (c) => (d += c));
    req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch { rej(Object.assign(new Error('bad json'), { status: 400 })); } }); });

  const server = http.createServer(async (req, res) => {
    const send = (s, b, type = 'application/json') => { res.writeHead(s, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(b) : b); };
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'POST' && url.pathname === '/receipts') return send(201, mint(await readBody(req)));
      if (req.method === 'POST' && url.pathname === '/calls') { const o = gate(await readBody(req)); return send(o.status, o.body); }
      if (req.method === 'GET' && url.pathname === '/ledger') return send(200, state().ledger);
      if (req.method === 'GET' && url.pathname === '/verify') return send(200, verify());
      if (req.method === 'GET' && url.pathname === '/stripe/list_overdue_invoices') return send(200, INVOICES);
      if (req.method === 'POST' && url.pathname === '/demo/run') { const b = await readBody(req); return send(200, demo(b.mode, b.receipt_id)); }
      if (req.method === 'POST' && url.pathname === '/revoke') {
        const b = await readBody(req); const rc = getReceipt(b.receipt_id);
        if (!rc) return send(404, { error: 'unknown_receipt' });
        db.prepare('UPDATE receipts SET revoked=1 WHERE id=?').run(rc.id);
        log('REVOKED', 'parent_revoked_by_principal', rc, rc.id, null, null);
        return send(200, getReceipt(rc.id));
      }
      const rv = url.pathname.match(/^\/receipts\/([^/]+)\/revoke$/);
      if (req.method === 'POST' && rv) {
        if (!getReceipt(rv[1])) return send(404, { error: 'unknown_receipt' });
        db.prepare('UPDATE receipts SET revoked=1 WHERE id=?').run(rv[1]);
        log('REVOKED', 'parent_revoked_by_principal', getReceipt(rv[1]), rv[1], null, null);
        return send(200, getReceipt(rv[1]));
      }
      // Advisory-only bypass: a holder of the raw key skips the gate and leaves no ledger row.
      if (req.method === 'POST' && url.pathname === '/bypass/gmail') {
        const b = await readBody(req); return send(200, { decision: 'UNGOVERNED', result: gmailSend(b.to, b.invoice_id, 'direct_key') });
      }
      if (req.method === 'GET' && url.pathname === '/state') return send(200, state());
      // DEMO ONLY: drops the append-only triggers to wipe the ledger. Disabled when NODE_ENV=production.
      if (req.method === 'POST' && url.pathname === '/reset') {
        if (process.env.NODE_ENV === 'production') return send(403, { error: 'reset_disabled_in_production' });
        db.exec('DROP TRIGGER ledger_no_update; DROP TRIGGER ledger_no_delete; DELETE FROM receipts; DELETE FROM ops; DELETE FROM ledger; DELETE FROM gmail;'); db.exec(TRIGGERS); counter = 41; return send(200, { ...state(), demo_only: true }); }
      if (req.method === 'GET') {
        const f = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
        if (f.startsWith(path.join(__dirname, 'public')) && fs.existsSync(f) && fs.statSync(f).isFile())
          return send(200, fs.readFileSync(f), f.endsWith('.html') ? 'text/html' : 'application/octet-stream');
      }
      send(404, { error: 'not_found' });
    } catch (e) { send(e.status || 500, e.body || { error: e.message }); }
  });
  return { server, db, TRIGGERS, gate };
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  createApp(process.env.DB || ':memory:').server.listen(port, () => console.log(`Delegation Receipt V1 on http://localhost:${port}`));
}
module.exports = { createApp };
