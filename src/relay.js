import { classify, isEmojiOnly, parseTapback } from './filter.js';
import { normalizePhone, randomId } from './db.js';

const SEND_CONCURRENCY = 4;
const REACTION_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

// System texts avoid emoji on purpose: one emoji switches the whole text to
// UCS-2 encoding, which cuts a segment from 160 to 70 characters (and doubles cost).
const texts = {
  invite: (g, link) => `${g.name}: You've been added to the ${g.name} group. Join free, no app needed: ${link} Or reply YES to get organizer announcements by text. Reply STOP to opt out.`,
  welcome: (g) => `You're in ${g.name}! You'll get organizer announcements here by text. For every message and free notifications, open your link and tap Add to Home Screen. Reply STOP to leave.`,
  pending: (g) => `Reply YES to get ${g.name} announcements by text, or STOP to opt out.`,
  stop: (g) => `You won't get more texts from ${g.name}. Reply START to get them again.`,
  help: (g) => `${g.name} group. Reply MUTE to pause, UNMUTE to resume, NAME <your name> to change your name, STOP to stop texts. Msg & data rates may apply.`,
  mute: (g) => `Muted. You won't get ${g.name} messages until you reply UNMUTE.`,
  unmute: (g) => `Unmuted. You'll get ${g.name} messages again.`,
  renamed: (name) => `Got it, the group will see you as "${name}".`,
  unknown: (g, link) => `This number is the ${g.name} group.${link ? ` Join here: ${link}` : ' Ask an organizer to add you.'}`,
};

export class Relay {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {{ name: string, send: Function, handlesComplianceReplies: boolean }} sms   SMS provider
   * @param {{ baseUrl?: string, push?: ReturnType<import('./push.js').webPusher>, log?: Console }} opts
   */
  constructor(db, sms, { baseUrl = 'http://localhost:3000', push = null, log = console } = {}) {
    this.db = db;
    this.provider = sms;
    this.push = push;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.log = log;
    this.draining = null;
    this.pendingPushes = new Set();
  }

  memberLink(member) { return `${this.baseUrl}/m/${member.token}`; }
  joinLink(group) { return `${this.baseUrl}/join/${group.join_code}`; }

  // ---------- groups ----------

  createGroup({ name, phoneNumber, mode = 'chat', smsBackup = 'announcements' }) {
    if (!name?.trim()) throw new Error('Group name is required');
    let phone = null;
    if (phoneNumber?.trim()) {
      phone = normalizePhone(phoneNumber);
      if (!phone) throw new Error("That group phone number doesn't look right");
    }
    if (!['chat', 'announce'].includes(mode)) throw new Error('mode must be chat or announce');
    if (!['announcements', 'all', 'off'].includes(smsBackup)) throw new Error('smsBackup must be announcements, all or off');
    const r = this.db.prepare('INSERT INTO groups (name, phone_number, join_code, mode, sms_backup) VALUES (?, ?, ?, ?, ?)')
      .run(name.trim(), phone, randomId(6), mode, smsBackup);
    return this.getGroup(Number(r.lastInsertRowid));
  }

  updateGroup(id, { name, mode, suppressEmojiOnly, smsBackup, phoneNumber }) {
    const g = this.getGroup(id);
    if (!g) throw new Error('Group not found');
    let phone = g.phone_number;
    if (phoneNumber !== undefined) {
      phone = phoneNumber?.trim() ? normalizePhone(phoneNumber) : null;
      if (phoneNumber?.trim() && !phone) throw new Error("That group phone number doesn't look right");
    }
    this.db.prepare('UPDATE groups SET name = ?, mode = ?, suppress_emoji_only = ?, sms_backup = ?, phone_number = ? WHERE id = ?').run(
      name?.trim() || g.name,
      ['chat', 'announce'].includes(mode) ? mode : g.mode,
      suppressEmojiOnly === undefined ? g.suppress_emoji_only : suppressEmojiOnly ? 1 : 0,
      ['announcements', 'all', 'off'].includes(smsBackup) ? smsBackup : g.sms_backup,
      phone,
      id,
    );
    return this.getGroup(id);
  }

  getGroup(id) {
    return this.db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  }

  listGroups() {
    return this.db.prepare(`
      SELECT g.*,
        (SELECT COUNT(*) FROM members m WHERE m.group_id = g.id AND m.status = 'active') AS active_count,
        (SELECT COUNT(*) FROM members m WHERE m.group_id = g.id) AS member_count,
        (SELECT COUNT(*) FROM reactions r JOIN messages x ON x.id = r.message_id WHERE x.group_id = g.id)
          + (SELECT COUNT(*) FROM messages x WHERE x.group_id = g.id AND x.kind = 'reaction' AND x.note = 'unmatched')
          + (SELECT COUNT(*) FROM messages x WHERE x.group_id = g.id AND x.note = 'quiet') AS reactions_blocked,
        (SELECT COUNT(*) FROM deliveries d WHERE d.group_id = g.id AND d.created_at >= date('now', 'start of month')) AS texts_this_month
      FROM groups g ORDER BY g.id`).all().map((g) => ({ ...g, join_link: this.joinLink(g) }));
  }

  deleteGroup(id) {
    this.db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  }

  // ---------- members ----------

  getMember(id) { return this.db.prepare('SELECT * FROM members WHERE id = ?').get(id); }
  memberByToken(token) { return this.db.prepare('SELECT * FROM members WHERE token = ?').get(String(token || '')); }

  listMembers(groupId) {
    return this.db.prepare(`SELECT m.*, EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.member_id = m.id) AS has_push
      FROM members m WHERE m.group_id = ? ORDER BY m.role, m.name`).all(groupId)
      .map((m) => ({ ...m, link: this.memberLink(m) }));
  }

  /** Organizer adds someone. With a phone (and a group number) they get one invite text with their personal link. */
  addMember(groupId, { name, phone, role = 'member' }, { invite = true } = {}) {
    const g = this.getGroup(groupId);
    if (!g) throw new Error('Group not found');
    if (!name?.trim()) throw new Error('Name is required');
    let p = null;
    if (phone?.trim?.()) {
      p = normalizePhone(phone);
      if (!p) throw new Error(`Invalid phone number: ${phone}`);
      if (p === g.phone_number) throw new Error("That's the group's own number");
      if (this.db.prepare('SELECT 1 FROM members WHERE group_id = ? AND phone = ?').get(groupId, p)) throw new Error(`${p} is already in this group`);
    }
    if (!['admin', 'member'].includes(role)) throw new Error('role must be admin or member');
    const r = this.db.prepare('INSERT INTO members (group_id, name, phone, role, token) VALUES (?, ?, ?, ?, ?)')
      .run(groupId, name.trim(), p, role, randomId());
    const member = this.getMember(Number(r.lastInsertRowid));
    if (invite && p && g.phone_number) this.queue(g, null, [p], texts.invite(g, this.memberLink(member)));
    return member;
  }

  /** Someone joins through the group's shareable link. A phone is optional and only used for text backup. */
  joinByCode(code, { name, phone, smsConsent = false }) {
    const g = this.db.prepare('SELECT * FROM groups WHERE join_code = ?').get(String(code || ''));
    if (!g) throw new Error('This join link is no longer valid');
    if (!name?.trim()) throw new Error('Please enter your name');
    let p = null;
    if (phone?.trim()) {
      p = normalizePhone(phone);
      if (!p) throw new Error("That phone number doesn't look right");
      const existing = this.db.prepare('SELECT * FROM members WHERE group_id = ? AND phone = ?').get(g.id, p);
      // Already invited by an organizer: we can't prove they own the number, so don't hand out their link.
      if (existing) throw new Error('That number is already in this group. Use the link from your invite text, or ask an organizer.');
    }
    const r = this.db.prepare("INSERT INTO members (group_id, name, phone, role, token, status, sms_ok) VALUES (?, ?, ?, 'member', ?, 'active', ?)")
      .run(g.id, name.trim().slice(0, 40), p, randomId(), p && smsConsent ? 1 : 0);
    return this.getMember(Number(r.lastInsertRowid));
  }

  publicGroupByCode(code) {
    const g = this.db.prepare('SELECT * FROM groups WHERE join_code = ?').get(String(code || ''));
    return g && { name: g.name, textsAvailable: !!g.phone_number && g.sms_backup !== 'off' };
  }

  /** Bulk add from pasted lines like "Maya Ruiz, 555-201-3344" or "555-201-3344 Maya Ruiz" or just "Maya Ruiz". */
  addMembersFromText(groupId, text) {
    const added = [];
    const errors = [];
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const phone = line.match(/\+?\(?\d[\d\s().-]{6,}\d/)?.[0];
      const name = (phone ? line.replace(phone, '') : line).replace(/[,\t;]+/g, ' ').trim();
      try {
        added.push(this.addMember(groupId, { name: name || phone, phone }));
      } catch (e) {
        errors.push({ line: line.trim(), error: e.message });
      }
    }
    return { added, errors };
  }

  updateMember(memberId, { name, role, muted }) {
    const m = this.getMember(memberId);
    if (!m) throw new Error('Member not found');
    this.db.prepare('UPDATE members SET name = ?, role = ?, muted = ? WHERE id = ?').run(
      name?.trim()?.slice(0, 40) || m.name,
      ['admin', 'member'].includes(role) ? role : m.role,
      muted === undefined ? m.muted : muted ? 1 : 0,
      memberId,
    );
    return this.getMember(memberId);
  }

  removeMember(memberId) {
    this.db.prepare('DELETE FROM members WHERE id = ?').run(memberId);
  }

  resendInvite(memberId) {
    const m = this.getMember(memberId);
    if (!m) throw new Error('Member not found');
    const g = this.getGroup(m.group_id);
    if (!m.phone || !g.phone_number) throw new Error('No phone to text. Share their personal link instead.');
    if (m.status !== 'invited') throw new Error('Member has already joined');
    this.queue(g, null, [m.phone], texts.invite(g, this.memberLink(m)));
  }

  // ---------- reading ----------

  /** Organizer dashboard feed: everything, including reactions. */
  listMessages(groupId, { limit = 200 } = {}) {
    return this.db.prepare(`
      SELECT x.*, m.name AS member_name,
        (SELECT COUNT(*) FROM deliveries d WHERE d.message_id = x.id) AS texted_to,
        (SELECT json_group_array(json_object('emoji', r.emoji, 'name', rm.name)) FROM reactions r JOIN members rm ON rm.id = r.member_id WHERE r.message_id = x.id) AS reactions
      FROM messages x LEFT JOIN members m ON m.id = x.member_id
      WHERE x.group_id = ? ORDER BY x.id DESC LIMIT ?`).all(groupId, limit).reverse()
      .map((x) => ({ ...x, reactions: JSON.parse(x.reactions || '[]') }));
  }

  /** What one member sees in the web app. */
  memberFeed(member, { after = 0, limit = 150 } = {}) {
    const rows = this.db.prepare(`
      SELECT x.id, x.member_id, x.direction, x.via, x.audience, x.body, x.media_urls, x.note, x.created_at,
        COALESCE(m.name, x.note, 'Organizer') AS sender, m.role AS sender_role
      FROM messages x LEFT JOIN members m ON m.id = x.member_id
      WHERE x.group_id = ? AND x.kind = 'message' AND x.id > ?
        AND (x.audience = 'all' OR ? = 'admin' OR x.member_id = ?)
      ORDER BY x.id DESC LIMIT ?`).all(member.group_id, after, member.role, member.id, limit).reverse();
    const ids = rows.map((r) => r.id);
    const reactions = ids.length
      ? this.db.prepare(`SELECT r.message_id, r.emoji, r.member_id, m.name FROM reactions r JOIN members m ON m.id = r.member_id
          WHERE r.message_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      : [];
    return rows.map((r) => {
      const mine = reactions.filter((x) => x.message_id === r.id);
      const grouped = {};
      for (const x of mine) {
        const e = (grouped[x.emoji] ||= { emoji: x.emoji, count: 0, names: [], mine: false });
        e.count++;
        e.names.push(x.name);
        if (x.member_id === member.id) e.mine = true;
      }
      return {
        id: r.id,
        sender: r.direction === 'out' ? r.note || 'Organizer' : r.sender,
        organizer: r.direction === 'out' || r.sender_role === 'admin',
        fromMe: r.member_id === member.id,
        toOrganizers: r.audience === 'admins',
        quiet: r.note === 'quiet',
        body: r.body,
        mediaUrls: JSON.parse(r.media_urls || '[]'),
        createdAt: r.created_at,
        reactions: Object.values(grouped),
      };
    });
  }

  // ---------- web app actions ----------

  touch(member) {
    this.db.prepare("UPDATE members SET last_seen = strftime('%Y-%m-%d %H:%M:%f', 'now'), status = 'active' WHERE id = ?").run(member.id);
  }

  postFromWeb(member, body) {
    const text = String(body || '').trim().slice(0, 1600);
    if (!text) throw new Error('Message is empty');
    const group = this.getGroup(member.group_id);
    this.touch(member);
    return this.sendToGroup(group, { member, body: text, via: 'web' });
  }

  /** Toggle a reaction. Reactions are shown in the app but never notify anyone. */
  react(member, messageId, emoji) {
    if (!REACTION_EMOJI.includes(emoji) && !isEmojiOnly(emoji)) throw new Error('Not a reaction');
    const msg = this.db.prepare("SELECT * FROM messages WHERE id = ? AND group_id = ? AND kind = 'message'").get(messageId, member.group_id);
    if (!msg) throw new Error('Message not found');
    const existing = this.db.prepare('SELECT id FROM reactions WHERE message_id = ? AND member_id = ? AND emoji = ?').get(messageId, member.id, emoji);
    if (existing) this.db.prepare('DELETE FROM reactions WHERE id = ?').run(existing.id);
    else this.db.prepare('INSERT INTO reactions (message_id, member_id, emoji) VALUES (?, ?, ?)').run(messageId, member.id, emoji);
    return { reacted: !existing };
  }

  // ---------- inbound SMS ----------

  /**
   * Handle one text a member sent to a group number.
   * Returns { action, ... } for logging and tests. Replies and fan-out are queued, not awaited.
   */
  handleInbound({ from, to, body = '', mediaUrls = [] }) {
    const fromPhone = normalizePhone(from);
    const group = this.db.prepare('SELECT * FROM groups WHERE phone_number = ?').get(normalizePhone(to));
    if (!group) return { action: 'ignored', reason: 'unknown group number' };

    const member = this.db.prepare('SELECT * FROM members WHERE group_id = ? AND phone = ?').get(group.id, fromPhone);
    if (!member) return this.reply(group, fromPhone, texts.unknown(group, this.joinLink(group)), 'unknown sender');

    const result = classify(body, { hasMedia: mediaUrls.length > 0, suppressEmojiOnly: !!group.suppress_emoji_only });

    if (result.kind === 'command') {
      const handled = this.handleCommand(group, member, result, body);
      if (handled) return handled;
      // fall through: e.g. a joined member texting "Yes" is just a message
    }

    if (!member.sms_ok) {
      if (member.status === 'invited') return this.reply(group, fromPhone, texts.pending(group), 'awaiting YES');
      return { action: 'ignored', reason: 'member opted out of texts' };
    }
    if (result.kind === 'empty') return { action: 'ignored', reason: 'empty' };

    if (result.kind === 'reaction' && result.reason === 'tapback') return this.attachTapback(group, member, body);

    // emoji-only replies are kept (and shown in the app) but notify nobody
    return this.sendToGroup(group, { member, body, mediaUrls, via: 'sms', quiet: result.kind === 'reaction' });
  }

  /** A phone sent "Loved “...”": attach it to that message as a reaction instead of texting anyone. */
  attachTapback(group, member, body) {
    const tap = parseTapback(body);
    let target = null;
    if (tap) {
      const recent = this.db.prepare(`SELECT x.*, COALESCE(m.name, x.note, 'Organizer') AS sender FROM messages x LEFT JOIN members m ON m.id = x.member_id
        WHERE x.group_id = ? AND x.kind = 'message' ORDER BY x.id DESC LIMIT 100`).all(group.id);
      const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
      if (tap.quoted) {
        const q = norm(tap.quoted);
        target = recent.find((x) => [x.body, `${x.sender}: ${x.body}`].some((c) => norm(c).startsWith(q) || (q.length > 3 && q.endsWith(norm(x.body)))));
      } else {
        target = recent.find((x) => x.member_id !== member.id);
      }
      if (target) {
        if (tap.remove) this.db.prepare('DELETE FROM reactions WHERE message_id = ? AND member_id = ? AND emoji = ?').run(target.id, member.id, tap.emoji);
        else this.db.prepare('INSERT OR IGNORE INTO reactions (message_id, member_id, emoji) VALUES (?, ?, ?)').run(target.id, member.id, tap.emoji);
      }
    }
    this.logMessage(group, member, { kind: 'reaction', body, via: 'sms', note: target ? 'attached' : 'unmatched' });
    return { action: 'suppressed', reason: 'tapback', attachedTo: target?.id ?? null };
  }

  handleCommand(group, member, { command, arg }, body) {
    const g = group;
    const compliance = ['stop', 'start', 'help'].includes(command);
    const say = (text, action) => {
      this.logMessage(g, member, { kind: 'command', body, via: 'sms', note: command });
      if (compliance && this.provider.handlesComplianceReplies) return { action };
      return this.reply(g, member.phone, text, action);
    };
    const set = (sql, ...args) => this.db.prepare(`UPDATE members SET ${sql} WHERE id = ?`).run(...args, member.id);

    switch (command) {
      case 'stop':
        set('sms_ok = 0');
        return say(texts.stop(g), 'opted out');
      case 'start':
        set("sms_ok = 1, status = 'active'");
        this.logMessage(g, member, { kind: 'command', body, via: 'sms', note: command });
        return this.reply(g, member.phone, texts.welcome(g), 'opted in');
      case 'confirm':
        if (member.sms_ok && member.status === 'active') return null; // "Yes" from a joined member is a normal message
        set("sms_ok = 1, status = 'active'");
        this.logMessage(g, member, { kind: 'command', body, via: 'sms', note: command });
        return this.reply(g, member.phone, texts.welcome(g), 'joined');
      case 'help':
        return say(texts.help(g), 'help');
      case 'mute':
      case 'unmute':
        if (!member.sms_ok) return null;
        set('muted = ?', command === 'mute' ? 1 : 0);
        return say(texts[command](g), command + 'd');
      case 'name':
        if (!member.sms_ok) return null;
        set('name = ?', arg);
        return say(texts.renamed(arg), 'renamed');
      default:
        return null;
    }
  }

  // ---------- delivery ----------

  /** An organizer posts from the dashboard. */
  broadcast(groupId, { body, fromName = 'Organizer', mediaUrls = [] }) {
    const group = this.getGroup(groupId);
    if (!group) throw new Error('Group not found');
    if (!body?.trim()) throw new Error('Message is empty');
    return this.sendToGroup(group, { member: null, fromName: fromName.trim() || 'Organizer', body: body.trim(), mediaUrls, via: 'dashboard' });
  }

  /**
   * The one place messages go out. Each recipient gets:
   *  - a free push notification on every device where they added the app, or
   *  - a text, only if they have no app, agreed to texts, the group has a number,
   *    and the group's text-backup rule covers this sender.
   * Quiet messages (emoji-only) are stored and shown in the app but notify nobody.
   */
  sendToGroup(group, { member, fromName, body, mediaUrls = [], via, quiet = false }) {
    const fromOrganizer = !member || member.role === 'admin';
    const audience = group.mode === 'announce' && !fromOrganizer ? 'admins' : 'all';
    if (via === 'web' && !mediaUrls.length && group.suppress_emoji_only && isEmojiOnly(body)) quiet = true;

    const msgId = member
      ? this.logMessage(group, member, { kind: 'message', body, mediaUrls, via, audience, note: quiet ? 'quiet' : null })
      : Number(this.db.prepare("INSERT INTO messages (group_id, direction, via, kind, audience, body, media_urls, note) VALUES (?, 'out', 'dashboard', 'message', 'all', ?, ?, ?)")
        .run(group.id, body, JSON.stringify(mediaUrls), fromName).lastInsertRowid);

    if (quiet) return { action: 'suppressed', reason: 'emoji-only', messageId: msgId, pushed: 0, texted: 0 };

    const senderName = member ? member.name : fromName;
    const prefix = audience === 'admins' ? `${senderName} (to organizers): ` : `${senderName}: `;
    let recipients = this.db.prepare("SELECT * FROM members WHERE group_id = ? AND status = 'active' AND muted = 0 AND id != ?")
      .all(group.id, member?.id ?? -1);
    if (audience === 'admins') recipients = recipients.filter((m) => m.role === 'admin');

    const smsAllowed = group.phone_number && (group.sms_backup === 'all' || (group.sms_backup === 'announcements' && fromOrganizer));
    const smsTo = [];
    let pushed = 0;
    for (const r of recipients) {
      if (this.push?.hasSubscription(r.id)) {
        pushed++;
        this.track(this.push.notify(r.id, {
          title: group.name,
          body: prefix + (body || (mediaUrls.length ? 'sent a photo' : '')),
          url: `/m/${r.token}`,
          tag: `group-${group.id}`,
        }));
      } else if (smsAllowed && r.phone && r.sms_ok) {
        smsTo.push(r.phone);
      }
    }
    if (smsTo.length) this.queue(group, msgId, smsTo, prefix + body, mediaUrls);
    return { action: 'relayed', messageId: msgId, recipients: recipients.length, pushed, texted: smsTo.length };
  }

  track(promise) {
    const p = Promise.resolve(promise).catch((e) => this.log.error?.(`push failed: ${e.message}`)).finally(() => this.pendingPushes.delete(p));
    this.pendingPushes.add(p);
  }

  logMessage(group, member, { kind, body, mediaUrls = [], via = 'sms', audience = 'all', note = null }) {
    const r = this.db.prepare("INSERT INTO messages (group_id, member_id, direction, via, kind, audience, body, media_urls, note) VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?)")
      .run(group.id, member?.id ?? null, via, kind, audience, body, JSON.stringify(mediaUrls), note);
    return Number(r.lastInsertRowid);
  }

  reply(group, toPhone, text, action) {
    this.queue(group, null, [toPhone], text);
    return { action, reply: text };
  }

  queue(group, messageId, phones, body, mediaUrls = []) {
    if (!group.phone_number) return;
    const insert = this.db.prepare('INSERT INTO deliveries (group_id, message_id, to_phone, from_phone, body, media_urls) VALUES (?, ?, ?, ?, ?, ?)');
    for (const p of phones) insert.run(group.id, messageId, p, group.phone_number, body, JSON.stringify(mediaUrls));
    this.drainTexts();
  }

  /** Resolves when every queued text and pending push has been sent. */
  async drain() {
    await this.drainTexts();
    while (this.pendingPushes.size) await Promise.all([...this.pendingPushes]);
  }

  drainTexts() {
    if (this.draining) {
      this.pendingDrain = true;
      return this.draining;
    }
    this.draining = (async () => {
      do {
        this.pendingDrain = false;
        const rows = this.db.prepare("SELECT * FROM deliveries WHERE status = 'queued' ORDER BY id").all();
        let i = 0;
        const worker = async () => {
          while (i < rows.length) {
            const d = rows[i++];
            try {
              const { id } = await this.provider.send({ to: d.to_phone, from: d.from_phone, body: d.body, mediaUrls: JSON.parse(d.media_urls) });
              this.db.prepare("UPDATE deliveries SET status = 'sent', provider_id = ? WHERE id = ?").run(id ?? null, d.id);
            } catch (e) {
              this.db.prepare("UPDATE deliveries SET status = 'failed', error = ? WHERE id = ?").run(String(e.message).slice(0, 500), d.id);
              this.log.error?.(`send to ${d.to_phone} failed: ${e.message}`);
            }
          }
        };
        await Promise.all(Array.from({ length: SEND_CONCURRENCY }, worker));
      } while (this.pendingDrain);
    })().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  /** Twilio status callback: a delivery failed or was undelivered after sending. */
  updateDeliveryStatus(providerId, status, error) {
    if (!['failed', 'undelivered'].includes(status)) return;
    this.db.prepare("UPDATE deliveries SET status = 'failed', error = ? WHERE provider_id = ?").run(error || status, providerId);
  }
}

export { REACTION_EMOJI };
