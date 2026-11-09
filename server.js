// Delegation Receipt V1 — receipt gate logic only. No TrueForge, Gateway, Cedar, real Gmail/Stripe.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function createApp(dbPath = ':memory:') {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, principal TEXT, parent TEXT, subagent TEXT,
      tool TEXT, recipient TEXT, invoice_id TEXT, max_sends INTEGER, sends INTEGER DEFAULT 0,
      expires_at INTEGER, revoked INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS ops (op_id TEXT PRIMARY KEY, receipt_id TEXT, result TEXT);
    CREATE TABLE IF NOT EXISTS ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, decision TEXT, reason TEXT,
      principal TEXT, parent TEXT, subagent TEXT, receipt_id TEXT, tool TEXT, args TEXT, op_id TEXT);
    CREATE TABLE IF NOT EXISTS gmail (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, to_addr TEXT, invoice_id TEXT, via TEXT);
  `);
  let counter = 41;

  // canonical JSON: sorted keys, so arg order never changes the op_id
  const canon = (v) => Array.isArray(v) ? `[${v.map(canon)}]` : v && typeof v === 'object'
    ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k]))}}` : JSON.stringify(v);
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

  // ---- mock Gmail (the only side effect) ----
  function gmailSend(to, invoice_id, via) {
    const r = db.prepare('INSERT INTO gmail (ts,to_addr,invoice_id,via) VALUES (?,?,?,?)').run(Date.now(), to, invoice_id, via);
    return { message_id: 'msg_' + r.lastInsertRowid, to, invoice_id };
  }

  function log(decision, reason, rc, receipt_id, tool, args, op_id) {
    db.prepare(`INSERT INTO ledger (ts,decision,reason,principal,parent,subagent,receipt_id,tool,args,op_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(Date.now(), decision, reason, rc?.principal ?? null, rc?.parent ?? null,
      rc?.subagent ?? null, receipt_id ?? null, tool ?? null, JSON.stringify(args ?? null), op_id ?? null);
  }

  function mint(b) {
    const id = 'R-' + (++counter);
    const ttl = Number.isFinite(b.ttl_seconds) ? b.ttl_seconds : 300;
    const r = { id, principal: b.principal || 'priya', parent: b.parent || 'parent-agent', subagent: b.subagent || 'subagent-1',
      tool: b.tool || 'send_email', recipient: b.recipient, invoice_id: b.invoice_id,
      max_sends: Number.isInteger(b.max_sends) ? b.max_sends : 1, expires_at: Date.now() + ttl * 1000 };
    if (!r.recipient || !r.invoice_id) throw Object.assign(new Error('recipient and invoice_id required'), { status: 400 });
    db.prepare(`INSERT INTO receipts (id,principal,parent,subagent,tool,recipient,invoice_id,max_sends,expires_at)
      VALUES (:id,:principal,:parent,:subagent,:tool,:recipient,:invoice_id,:max_sends,:expires_at)`).run(r);
    return getReceipt(id);
  }
  const getReceipt = (id) => db.prepare('SELECT * FROM receipts WHERE id=?').get(id);

  // ---- RECEIPT GATE: plain code, no Cedar ----
  function gate({ receipt_id, tool, args }) {
    args = args || {};
    if (!receipt_id) { log('REFUSED', 'no_receipt', null, null, tool, args); return { status: 403, body: { decision: 'REFUSED', reason: 'no_receipt' } }; }
    const rc = getReceipt(receipt_id);
    const refuse = (reason, op_id) => { log('REFUSED', reason, rc, receipt_id, tool, args, op_id); return { status: 403, body: { decision: 'REFUSED', reason } }; };
    if (!rc) return refuse('unknown_receipt');
    if (rc.revoked) return refuse('parent_revoked');
    if (Date.now() >= rc.expires_at) return refuse('expired');
    const op_id = sha(receipt_id + tool + canon(args));
    const prior = db.prepare('SELECT result FROM ops WHERE op_id=?').get(op_id);
    if (prior) { log('REPLAYED', 'identical_retry', rc, receipt_id, tool, args, op_id);
      return { status: 200, body: { decision: 'REPLAYED', result: JSON.parse(prior.result) } }; }
    if (tool !== rc.tool) return refuse('tool_out_of_scope', op_id);
    if (args.to !== rc.recipient) return refuse('recipient_out_of_scope', op_id);
    if (args.invoice_id !== rc.invoice_id) return refuse('invoice_out_of_scope', op_id);
    if (rc.sends >= rc.max_sends) return refuse('limit_exceeded', op_id);
    // all checks passed: reserve the send, then call Gmail
    db.prepare('UPDATE receipts SET sends=sends+1 WHERE id=?').run(receipt_id);
    const result = gmailSend(args.to, args.invoice_id, 'gate');
    db.prepare('INSERT INTO ops (op_id,receipt_id,result) VALUES (?,?,?)').run(op_id, receipt_id, JSON.stringify(result));
    log('ALLOWED', 'in_scope', rc, receipt_id, tool, args, op_id);
    return { status: 200, body: { decision: 'ALLOWED', result } };
  }

  const state = () => ({
    receipts: db.prepare('SELECT * FROM receipts ORDER BY rowid').all(),
    ledger: db.prepare('SELECT * FROM ledger ORDER BY seq').all().map((r) => ({ ...r, args: JSON.parse(r.args) })),
    gmail: db.prepare('SELECT * FROM gmail ORDER BY id').all(),
  });

  const readBody = (req) => new Promise((res, rej) => { let d = ''; req.on('data', (c) => (d += c));
    req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch { rej(Object.assign(new Error('bad json'), { status: 400 })); } }); });

  const server = http.createServer(async (req, res) => {
    const send = (s, b, type = 'application/json') => { res.writeHead(s, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(b) : b); };
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'POST' && url.pathname === '/receipts') return send(201, mint(await readBody(req)));
      if (req.method === 'POST' && url.pathname === '/calls') { const o = gate(await readBody(req)); return send(o.status, o.body); }
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
      if (req.method === 'POST' && url.pathname === '/reset') { db.exec('DELETE FROM receipts; DELETE FROM ops; DELETE FROM ledger; DELETE FROM gmail;'); counter = 41; return send(200, state()); }
      if (req.method === 'GET') {
        const f = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
        if (f.startsWith(path.join(__dirname, 'public')) && fs.existsSync(f) && fs.statSync(f).isFile())
          return send(200, fs.readFileSync(f), f.endsWith('.html') ? 'text/html' : 'application/octet-stream');
      }
      send(404, { error: 'not_found' });
    } catch (e) { send(e.status || 500, { error: e.message }); }
  });
  return { server, db };
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  createApp(process.env.DB || ':memory:').server.listen(port, () => console.log(`Delegation Receipt V1 on http://localhost:${port}`));
}
module.exports = { createApp };
