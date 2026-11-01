import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, normalizePhone } from './db.js';
import { Relay } from './relay.js';
import { simProvider, twilioProvider, validateTwilioSignature } from './providers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader so the app has zero dependencies.
if (existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export function buildApp(env = process.env) {
  const config = {
    port: Number(env.PORT || 3000),
    publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
    adminPassword: env.ADMIN_PASSWORD || 'change-me',
    providerName: env.SMS_PROVIDER || 'sim',
    dbPath: env.DATABASE_PATH || join(ROOT, 'data', 'textchain.db'),
  };
  const provider = config.providerName === 'twilio'
    ? twilioProvider({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, statusCallbackUrl: `${config.publicUrl}/sms/status` })
    : simProvider();
  const db = openDb(config.dbPath);
  const relay = new Relay(db, provider);
  const authToken = createHmac('sha256', config.adminPassword).update('textchain-admin').digest('hex');

  const routes = [];
  const route = (method, pattern, handler, { open = false } = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, handler, open });
  };

  // ---------- static pages ----------
  const page = (file, type) => async (req, res) => send(res, 200, await readFile(join(ROOT, 'public', file)), type);
  route('GET', '/', page('index.html', 'text/html; charset=utf-8'), { open: true });
  route('GET', '/sim', page('sim.html', 'text/html; charset=utf-8'), { open: true });
  route('GET', '/app.css', page('app.css', 'text/css'), { open: true });
  route('GET', '/health', (req, res) => json(res, 200, { ok: true }), { open: true });

  // ---------- auth ----------
  route('POST', '/api/login', async (req, res, { body }) => {
    const a = Buffer.from(String(body.password || ''));
    const b = Buffer.from(config.adminPassword);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return json(res, 401, { error: 'Wrong password' });
    res.setHeader('Set-Cookie', `tc_auth=${authToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
    json(res, 200, { ok: true });
  }, { open: true });
  route('POST', '/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'tc_auth=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    json(res, 200, { ok: true });
  }, { open: true });
  route('GET', '/api/config', (req, res) => json(res, 200, { provider: provider.name, webhookUrl: `${config.publicUrl}/sms/inbound` }));

  // ---------- groups ----------
  route('GET', '/api/groups', (req, res) => json(res, 200, relay.listGroups()));
  route('POST', '/api/groups', (req, res, { body }) => json(res, 201, relay.createGroup(body)));
  route('PATCH', '/api/groups/:id', (req, res, { params, body }) => json(res, 200, relay.updateGroup(+params.id, body)));
  route('DELETE', '/api/groups/:id', (req, res, { params }) => (relay.deleteGroup(+params.id), json(res, 200, { ok: true })));
  route('GET', '/api/groups/:id/members', (req, res, { params }) => json(res, 200, relay.listMembers(+params.id)));
  route('POST', '/api/groups/:id/members', (req, res, { params, body }) => json(res, 201, relay.addMember(+params.id, body)));
  route('POST', '/api/groups/:id/members/bulk', (req, res, { params, body }) => json(res, 200, relay.addMembersFromText(+params.id, body.text)));
  route('GET', '/api/groups/:id/messages', (req, res, { params }) => json(res, 200, relay.listMessages(+params.id)));
  route('POST', '/api/groups/:id/broadcast', (req, res, { params, body }) => json(res, 200, relay.broadcast(+params.id, body)));
  route('PATCH', '/api/members/:id', (req, res, { params, body }) => json(res, 200, relay.updateMember(+params.id, body)));
  route('DELETE', '/api/members/:id', (req, res, { params }) => (relay.removeMember(+params.id), json(res, 200, { ok: true })));
  route('POST', '/api/members/:id/invite', (req, res, { params }) => (relay.resendInvite(+params.id), json(res, 200, { ok: true })));

  // ---------- phone simulator (sim mode only) ----------
  const simOnly = (fn) => (req, res, ctx) => (provider.name === 'sim' ? fn(req, res, ctx) : json(res, 404, { error: 'Simulator is off' }));
  route('GET', '/api/sim/thread', simOnly((req, res, { query }) => {
    const group = relay.getGroup(+query.group);
    const phone = normalizePhone(query.phone);
    if (!group || !phone) return json(res, 400, { error: 'group and phone required' });
    const incoming = db.prepare("SELECT id, body, created_at, 'in' AS dir FROM deliveries WHERE to_phone = ? AND from_phone = ?").all(phone, group.phone_number);
    const outgoing = db.prepare(`SELECT x.id, x.body, x.created_at, x.kind, x.note, 'out' AS dir FROM messages x JOIN members m ON m.id = x.member_id
      WHERE m.phone = ? AND x.group_id = ? AND x.direction = 'in'`).all(phone, group.id);
    // messages are logged before the replies they trigger, so ties put the sender's own text first
    const thread = [...incoming, ...outgoing].sort((a, b) => a.created_at.localeCompare(b.created_at) || (a.dir === b.dir ? a.id - b.id : a.dir === 'out' ? -1 : 1));
    json(res, 200, thread);
  }));
  route('POST', '/api/sim/send', simOnly(async (req, res, { body }) => {
    const group = relay.getGroup(+body.group);
    if (!group) return json(res, 400, { error: 'Unknown group' });
    const result = relay.handleInbound({ from: body.phone, to: group.phone_number, body: body.body || '' });
    await relay.drain();
    json(res, 200, result);
  }));

  // ---------- Twilio webhooks ----------
  const twilioGuard = (req, params, path) => {
    if (provider.name !== 'twilio') return true;
    return validateTwilioSignature({ authToken: env.TWILIO_AUTH_TOKEN, signature: req.headers['x-twilio-signature'], url: config.publicUrl + path, params });
  };
  route('POST', '/sms/inbound', (req, res, { body }) => {
    if (!twilioGuard(req, body, '/sms/inbound')) return send(res, 403, 'Invalid signature', 'text/plain');
    const mediaUrls = Array.from({ length: Number(body.NumMedia || 0) }, (_, i) => body[`MediaUrl${i}`]).filter(Boolean);
    const result = relay.handleInbound({ from: body.From, to: body.To, body: body.Body || '', mediaUrls });
    console.log(`[inbound] ${body.From} -> ${body.To}: ${result.action}${result.reason ? ` (${result.reason})` : ''}`);
    send(res, 200, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>', 'text/xml');
  }, { open: true });
  route('POST', '/sms/status', (req, res, { body }) => {
    if (!twilioGuard(req, body, '/sms/status')) return send(res, 403, 'Invalid signature', 'text/plain');
    relay.updateDeliveryStatus(body.MessageSid, body.MessageStatus, body.ErrorCode && `Twilio error ${body.ErrorCode}`);
    send(res, 204, '');
  }, { open: true });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const r = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!r) return json(res, 404, { error: 'Not found' });
    if (!r.open && !hasAuth(req)) return json(res, 401, { error: 'Log in first' });
    try {
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(url.pathname.match(r.re)[i + 1])]));
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
      await r.handler(req, res, { params, body, query: Object.fromEntries(url.searchParams) });
    } catch (e) {
      json(res, 400, { error: e.message });
    }
  });

  function hasAuth(req) {
    const cookie = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith('tc_auth='));
    return cookie?.slice(8) === authToken;
  }

  return { server, relay, db, config };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new Error('Body too large');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  if ((req.headers['content-type'] || '').includes('application/json')) return JSON.parse(raw);
  return Object.fromEntries(new URLSearchParams(raw));
}

function send(res, status, body, type = 'text/plain') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function json(res, status, data) {
  send(res, status, JSON.stringify(data), 'application/json');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server, config, relay } = buildApp();
  relay.drain(); // send anything left queued from before a restart
  server.listen(config.port, () => {
    console.log(`TextChain running at http://localhost:${config.port}  (provider: ${config.providerName})`);
    if (config.providerName === 'sim') console.log(`Phone simulator: http://localhost:${config.port}/sim`);
    else console.log(`Point each Twilio number's "A message comes in" webhook to ${config.publicUrl}/sms/inbound`);
  });
}
