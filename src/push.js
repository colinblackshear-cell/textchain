import webpush from 'web-push';

/**
 * Free notifications through the browser's own push service (Apple, Google, Mozilla).
 * Members add the group page to their home screen once; after that, messages arrive
 * as normal phone notifications without an app store app or a text plan.
 *
 * VAPID keys identify this server to the push services. They're generated on first
 * run and stored in the database so existing subscriptions keep working.
 */
export function webPusher(db, { subject = 'mailto:admin@example.com', send } = {}) {
  let keys = db.prepare("SELECT value FROM settings WHERE key = 'vapid'").get();
  if (keys) keys = JSON.parse(keys.value);
  else {
    keys = webpush.generateVAPIDKeys();
    db.prepare("INSERT INTO settings (key, value) VALUES ('vapid', ?)").run(JSON.stringify(keys));
  }
  const deliver = send || ((sub, payload) => webpush.sendNotification(sub, payload, {
    vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
    TTL: 60 * 60 * 24,
    urgency: 'high',
  }));

  return {
    publicKey: keys.publicKey,

    subscribe(memberId, sub) {
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('Invalid push subscription');
      if (!/^https:\/\//.test(sub.endpoint)) throw new Error('Invalid push endpoint');
      db.prepare(`INSERT INTO push_subscriptions (member_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET member_id = excluded.member_id, p256dh = excluded.p256dh, auth = excluded.auth`)
        .run(memberId, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
    },

    unsubscribe(memberId, endpoint) {
      db.prepare('DELETE FROM push_subscriptions WHERE member_id = ? AND endpoint = ?').run(memberId, endpoint);
    },

    hasSubscription(memberId) {
      return !!db.prepare('SELECT 1 FROM push_subscriptions WHERE member_id = ? LIMIT 1').get(memberId);
    },

    /** Sends to every device of a member. Expired subscriptions are removed. */
    async notify(memberId, payload) {
      const subs = db.prepare('SELECT * FROM push_subscriptions WHERE member_id = ?').all(memberId);
      const body = JSON.stringify(payload);
      let delivered = 0;
      await Promise.all(subs.map(async (s) => {
        try {
          await deliver({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body);
          delivered++;
        } catch (e) {
          if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
          else console.error(`push to member ${memberId} failed: ${e.statusCode || ''} ${e.message}`);
        }
      }));
      return delivered;
    },
  };
}
