import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { buildApp } from '../src/server.js';

const TOKEN = 'test-auth-token';
const PUBLIC = 'https://textchain.example.com';

function sign(url, params) {
  const data = Object.keys(params).sort().reduce((a, k) => a + k + params[k], url);
  return createHmac('sha1', TOKEN).update(data).digest('base64');
}

test('Twilio webhook: rejects bad signatures, relays signed messages through the Twilio API', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  const { server, relay } = buildApp({
    SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: TOKEN,
    PUBLIC_URL: PUBLIC, DATABASE_PATH: ':memory:', ADMIN_PASSWORD: 'pw',
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.twilio.com')) {
      calls.push({ url: String(url), form: Object.fromEntries(new URLSearchParams(opts.body)) });
      return new Response(JSON.stringify({ sid: 'SM' + calls.length }), { status: 201 });
    }
    return realFetch(url, opts);
  };
  try {
    const g = relay.createGroup({ name: 'Team', phoneNumber: '+15550001000', smsBackup: 'all' });
    relay.addMember(g.id, { name: 'A', phone: '+15551110001' }, { invite: false });
    relay.addMember(g.id, { name: 'B', phone: '+15551110002' }, { invite: false });
    relay.db.prepare("UPDATE members SET status = 'active', sms_ok = 1").run();

    const params = { From: '+15551110001', To: '+15550001000', Body: 'hello team', NumMedia: '0' };
    const post = (sig, p = params) => realFetch(`${base}/sms/inbound`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig }, body: new URLSearchParams(p),
    });

    assert.equal((await post('bogus')).status, 403);
    const ok = await post(sign(`${PUBLIC}/sms/inbound`, params));
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /<Response><\/Response>/);
    await relay.drain();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    assert.deepEqual([calls[0].form.To, calls[0].form.From, calls[0].form.Body], ['+15551110002', '+15550001000', 'A: hello team']);
    assert.equal(calls[0].form.StatusCallback, `${PUBLIC}/sms/status`);

    const tap = { ...params, Body: 'Loved “hello team”' };
    await post(sign(`${PUBLIC}/sms/inbound`, tap));
    await relay.drain();
    assert.equal(calls.length, 1, 'reaction was not sent to anyone');
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});

test('dashboard API requires login', async () => {
  const { server } = buildApp({ DATABASE_PATH: ':memory:', ADMIN_PASSWORD: 'pw' });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/groups`)).status, 401);
    assert.equal((await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"nope"}' })).status, 401);
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"pw"}' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const res = await fetch(`${base}/api/groups`, { headers: { cookie } });
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test('members web app: join by link, post, react, manifest, push subscribe', async () => {
  const { server, relay } = buildApp({ DATABASE_PATH: ':memory:', ADMIN_PASSWORD: 'pw', PUBLIC_URL: 'https://tc.example' });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = (path, method = 'GET', body) => fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  try {
    const g = relay.createGroup({ name: 'Chess Club' });
    assert.deepEqual((await j(`/api/join/${g.join_code}`)).data, { name: 'Chess Club', textsAvailable: false });
    assert.equal((await j('/api/join/bogus')).status, 404);

    const ava = (await j(`/api/join/${g.join_code}`, 'POST', { name: 'Ava' })).data.token;
    const ben = (await j(`/api/join/${g.join_code}`, 'POST', { name: 'Ben' })).data.token;

    const page = await fetch(`${base}/m/${ava}`);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes(`/m/${ava}/manifest.webmanifest`));
    assert.equal((await fetch(`${base}/m/nope`)).status, 404);
    const manifest = await (await fetch(`${base}/m/${ava}/manifest.webmanifest`)).json();
    assert.equal(manifest.start_url, `/m/${ava}`);
    assert.equal(manifest.name, 'Chess Club');

    const me = (await j(`/api/m/${ava}`)).data;
    assert.equal(me.group.name, 'Chess Club');
    assert.ok(me.vapidPublicKey.length > 40);

    const posted = (await j(`/api/m/${ava}/messages`, 'POST', { body: 'Tournament Saturday' })).data;
    assert.equal(posted.action, 'relayed');
    const feed = (await j(`/api/m/${ben}/messages`)).data;
    assert.equal(feed[0].body, 'Tournament Saturday');
    assert.equal(feed[0].sender, 'Ava');

    assert.deepEqual((await j(`/api/m/${ben}/reactions`, 'POST', { messageId: posted.messageId, emoji: '❤️' })).data, { reacted: true });
    assert.equal((await j(`/api/m/${ava}/messages`)).data[0].reactions[0].emoji, '❤️');

    assert.equal((await j(`/api/m/${ben}/push`, 'POST', { endpoint: 'http://evil', keys: { p256dh: 'x', auth: 'y' } })).status, 400);
    assert.equal((await j(`/api/m/${ben}/push`, 'POST', { endpoint: 'https://push.example/abc', keys: { p256dh: 'x', auth: 'y' } })).status, 201);
    assert.equal((await j(`/api/m/${ben}`, 'PATCH', { name: 'Benny', muted: true })).data.name, 'Benny');
    assert.equal((await j('/api/m/nope')).status, 404);
  } finally {
    server.close();
  }
});
