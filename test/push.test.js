import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { webPusher } from '../src/push.js';

test('push keys persist, expired subscriptions are removed', async () => {
  const db = openDb();
  db.prepare("INSERT INTO groups (name, join_code) VALUES ('G', 'abc')").run();
  db.prepare("INSERT INTO members (group_id, name, token) VALUES (1, 'A', 't1')").run();
  const calls = [];
  const push = webPusher(db, {
    send: async (sub, payload) => {
      calls.push([sub.endpoint, JSON.parse(payload)]);
      if (sub.endpoint.includes('gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
    },
  });
  assert.equal(webPusher(db).publicKey, push.publicKey, 'same keys on restart');
  push.subscribe(1, { endpoint: 'https://push.example/ok', keys: { p256dh: 'p', auth: 'a' } });
  push.subscribe(1, { endpoint: 'https://push.example/gone', keys: { p256dh: 'p', auth: 'a' } });
  assert.equal(push.hasSubscription(1), true);
  assert.equal(await push.notify(1, { title: 'G', body: 'hi' }), 1);
  assert.equal(calls.length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 1);
});
