import { classify } from './filter.js';
import { normalizePhone } from './db.js';

const SEND_CONCURRENCY = 4;

// System texts avoid emoji on purpose: one emoji switches the whole text to
// UCS-2 encoding, which cuts a segment from 160 to 70 characters (and doubles cost).
const texts = {
  invite: (g) => `${g.name}: You've been added to the ${g.name} group text. Reply YES to join. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`,
  welcome: (g) => `You're in ${g.name}! Texts you send to this number go to the whole group${g.mode === 'announce' ? "'s organizers" : ''}. Save this contact as "${g.name}". Reactions stay silent. Reply MUTE to pause, STOP to leave.`,
  pending: (g) => `Reply YES to join the ${g.name} group text, or STOP to opt out.`,
  stop: (g) => `You've left ${g.name} and won't get more texts. Reply START to rejoin.`,
  help: (g) => `${g.name} group text. Reply MUTE to pause texts, UNMUTE to resume, NAME <your name> to change your name, STOP to leave. Msg & data rates may apply.`,
  mute: (g) => `Muted. You won't get ${g.name} texts until you reply UNMUTE.`,
  unmute: (g) => `Unmuted. You'll get ${g.name} texts again.`,
  renamed: (name) => `Got it, the group will see you as "${name}".`,
  unknown: (g) => `This number is the ${g.name} group text. Ask an organizer to add you.`,
};

export class Relay {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {{ name: string, send: Function, handlesComplianceReplies: boolean }} provider
   */
  constructor(db, provider, { log = console } = {}) {
    this.db = db;
    this.provider = provider;
    this.log = log;
    this.draining = null;
  }

  // ---------- groups & members ----------

  createGroup({ name, phoneNumber, mode = 'chat' }) {
    const phone = normalizePhone(phoneNumber);
    if (!name?.trim()) throw new Error('Group name is required');
    if (!phone) throw new Error('A valid group phone number is required');
    if (!['chat', 'announce'].includes(mode)) throw new Error('mode must be chat or announce');
    const r = this.db.prepare('INSERT INTO groups (name, phone_number, mode) VALUES (?, ?, ?)').run(name.trim(), phone, mode);
    return this.getGroup(Number(r.lastInsertRowid));
  }

  updateGroup(id, { name, mode, suppressEmojiOnly }) {
    const g = this.getGroup(id);
    if (!g) throw new Error('Group not found');
    this.db.prepare('UPDATE groups SET name = ?, mode = ?, suppress_emoji_only = ? WHERE id = ?').run(
      name?.trim() || g.name,
      ['chat', 'announce'].includes(mode) ? mode : g.mode,
      suppressEmojiOnly === undefined ? g.suppress_emoji_only : suppressEmojiOnly ? 1 : 0,
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
        (SELECT COUNT(*) FROM messages x WHERE x.group_id = g.id AND x.kind = 'reaction') AS reactions_blocked
      FROM groups g ORDER BY g.id`).all();
  }

  deleteGroup(id) {
    this.db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  }

  listMembers(groupId) {
    return this.db.prepare('SELECT * FROM members WHERE group_id = ? ORDER BY role, name').all(groupId);
  }

  /** Adds a member and texts them an invite they must answer YES to. */
  addMember(groupId, { name, phone, role = 'member' }, { invite = true } = {}) {
    const g = this.getGroup(groupId);
    if (!g) throw new Error('Group not found');
    const p = normalizePhone(phone);
    if (!p) throw new Error(`Invalid phone number: ${phone}`);
    if (!name?.trim()) throw new Error('Name is required');
    if (!['admin', 'member'].includes(role)) throw new Error('role must be admin or member');
    if (p === g.phone_number) throw new Error("That's the group's own number");
    const existing = this.db.prepare('SELECT * FROM members WHERE group_id = ? AND phone = ?').get(groupId, p);
    if (existing) throw new Error(`${p} is already in this group`);
    const r = this.db.prepare('INSERT INTO members (group_id, name, phone, role) VALUES (?, ?, ?, ?)').run(groupId, name.trim(), p, role);
    const member = this.db.prepare('SELECT * FROM members WHERE id = ?').get(Number(r.lastInsertRowid));
    if (invite) this.queue(g, null, [member.phone], texts.invite(g));
    return member;
  }

  /** Bulk add from pasted lines like "Maya Ruiz, 555-201-3344" or "555-201-3344 Maya Ruiz". */
  addMembersFromText(groupId, text) {
    const added = [];
    const errors = [];
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const phoneMatch = line.match(/\+?\(?\d[\d\s().-]{6,}\d/);
      const phone = phoneMatch?.[0];
      const name = phone ? line.replace(phone, '').replace(/[,\t;]+/g, ' ').trim() : '';
      try {
        if (!phone) throw new Error('no phone number found');
        added.push(this.addMember(groupId, { name: name || phone, phone }));
      } catch (e) {
        errors.push({ line: line.trim(), error: e.message });
      }
    }
    return { added, errors };
  }

  updateMember(memberId, { name, role, muted }) {
    const m = this.db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
    if (!m) throw new Error('Member not found');
    this.db.prepare('UPDATE members SET name = ?, role = ?, muted = ? WHERE id = ?').run(
      name?.trim() || m.name,
      ['admin', 'member'].includes(role) ? role : m.role,
      muted === undefined ? m.muted : muted ? 1 : 0,
      memberId,
    );
    return this.db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
  }

  removeMember(memberId) {
    this.db.prepare('DELETE FROM members WHERE id = ?').run(memberId);
  }

  resendInvite(memberId) {
    const m = this.db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
    if (!m) throw new Error('Member not found');
    if (m.status !== 'invited') throw new Error('Member has already answered the invite');
    this.queue(this.getGroup(m.group_id), null, [m.phone], texts.invite(this.getGroup(m.group_id)));
  }

  listMessages(groupId, { limit = 200 } = {}) {
    return this.db.prepare(`
      SELECT x.*, m.name AS member_name,
        (SELECT COUNT(*) FROM deliveries d WHERE d.message_id = x.id) AS delivered_to
      FROM messages x LEFT JOIN members m ON m.id = x.member_id
      WHERE x.group_id = ? ORDER BY x.id DESC LIMIT ?`).all(groupId, limit).reverse();
  }

  // ---------- inbound ----------

  /**
   * Handle one text a member sent to a group number.
   * Returns { action, reply? } for logging and tests. Replies and fan-out are queued, not awaited.
   */
  handleInbound({ from, to, body = '', mediaUrls = [] }) {
    const fromPhone = normalizePhone(from);
    const toPhone = normalizePhone(to);
    const group = this.db.prepare('SELECT * FROM groups WHERE phone_number = ?').get(toPhone);
    if (!group) return { action: 'ignored', reason: 'unknown group number' };

    const member = this.db.prepare('SELECT * FROM members WHERE group_id = ? AND phone = ?').get(group.id, fromPhone);
    if (!member) return this.reply(group, fromPhone, texts.unknown(group), 'unknown sender');

    const result = classify(body, { hasMedia: mediaUrls.length > 0, suppressEmojiOnly: !!group.suppress_emoji_only });

    if (result.kind === 'command') {
      const handled = this.handleCommand(group, member, result, body);
      if (handled) return handled;
      // fall through: e.g. an active member texting "Yes" is just a message
    }

    if (member.status === 'opted_out') return { action: 'ignored', reason: 'member opted out' };
    if (member.status === 'invited') return this.reply(group, fromPhone, texts.pending(group), 'awaiting YES');
    if (result.kind === 'empty') return { action: 'ignored', reason: 'empty' };

    if (result.kind === 'reaction') {
      this.logMessage(group, member, 'reaction', body, mediaUrls, result.reason);
      return { action: 'suppressed', reason: result.reason };
    }

    return this.fanOut(group, member, body, mediaUrls);
  }

  handleCommand(group, member, { command, arg }, body) {
    const g = group;
    const compliance = ['stop', 'start', 'help'].includes(command);
    const say = (text, action) => {
      this.logMessage(g, member, 'command', body, [], command);
      if (compliance && this.provider.handlesComplianceReplies) return { action };
      return this.reply(g, member.phone, text, action);
    };
    const setStatus = (status) => this.db.prepare('UPDATE members SET status = ? WHERE id = ?').run(status, member.id);

    switch (command) {
      case 'stop':
        setStatus('opted_out');
        return say(texts.stop(g), 'opted out');
      case 'start':
        setStatus('active');
        // START is a carrier keyword; the provider may answer it, but our welcome explains the group
        this.logMessage(g, member, 'command', body, [], command);
        return this.reply(g, member.phone, texts.welcome(g), 'opted in');
      case 'confirm':
        if (member.status !== 'invited') return null; // "Yes" from an active member is a normal message
        setStatus('active');
        this.logMessage(g, member, 'command', body, [], command);
        return this.reply(g, member.phone, texts.welcome(g), 'joined');
      case 'help':
        return say(texts.help(g), 'help');
      case 'mute':
      case 'unmute':
        if (member.status !== 'active') return null;
        this.db.prepare('UPDATE members SET muted = ? WHERE id = ?').run(command === 'mute' ? 1 : 0, member.id);
        return say(texts[command](g), command + 'd');
      case 'name':
        if (member.status !== 'active') return null;
        this.db.prepare('UPDATE members SET name = ? WHERE id = ?').run(arg, member.id);
        return say(texts.renamed(arg), 'renamed');
      default:
        return null;
    }
  }

  fanOut(group, sender, body, mediaUrls) {
    const active = this.db.prepare(
      "SELECT * FROM members WHERE group_id = ? AND status = 'active' AND muted = 0 AND id != ?",
    ).all(group.id, sender.id);

    let recipients = active;
    let prefix = `${sender.name}: `;
    if (group.mode === 'announce' && sender.role !== 'admin') {
      recipients = active.filter((m) => m.role === 'admin');
      prefix = `${sender.name} (to organizers): `;
    }

    const msgId = this.logMessage(group, sender, 'message', body, mediaUrls, group.mode === 'announce' && sender.role !== 'admin' ? 'to organizers' : null);
    this.queue(group, msgId, recipients.map((m) => m.phone), prefix + body, mediaUrls);
    return { action: 'relayed', recipients: recipients.length };
  }

  /** An organizer posts from the dashboard. */
  broadcast(groupId, { body, fromName = 'Organizer', mediaUrls = [] }) {
    const group = this.getGroup(groupId);
    if (!group) throw new Error('Group not found');
    if (!body?.trim()) throw new Error('Message is empty');
    const recipients = this.db.prepare("SELECT phone FROM members WHERE group_id = ? AND status = 'active' AND muted = 0").all(groupId);
    const r = this.db.prepare("INSERT INTO messages (group_id, direction, kind, body, media_urls, note) VALUES (?, 'out', 'message', ?, ?, ?)")
      .run(groupId, body.trim(), JSON.stringify(mediaUrls), fromName);
    this.queue(group, Number(r.lastInsertRowid), recipients.map((m) => m.phone), `${fromName}: ${body.trim()}`, mediaUrls);
    return { recipients: recipients.length };
  }

  // ---------- outbox ----------

  logMessage(group, member, kind, body, mediaUrls, note) {
    const r = this.db.prepare("INSERT INTO messages (group_id, member_id, direction, kind, body, media_urls, note) VALUES (?, ?, 'in', ?, ?, ?, ?)")
      .run(group.id, member?.id ?? null, kind, body, JSON.stringify(mediaUrls), note ?? null);
    return Number(r.lastInsertRowid);
  }

  reply(group, toPhone, text, action) {
    this.queue(group, null, [toPhone], text);
    return { action, reply: text };
  }

  queue(group, messageId, phones, body, mediaUrls = []) {
    const insert = this.db.prepare('INSERT INTO deliveries (group_id, message_id, to_phone, from_phone, body, media_urls) VALUES (?, ?, ?, ?, ?, ?)');
    for (const p of phones) insert.run(group.id, messageId, p, group.phone_number, body, JSON.stringify(mediaUrls));
    this.drain();
  }

  /** Sends everything queued. Safe to call repeatedly; resolves when the queue is empty. */
  drain() {
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

  /** Simulator: the inbox of a phone number. */
  inbox(phone, { limit = 100 } = {}) {
    return this.db.prepare('SELECT * FROM deliveries WHERE to_phone = ? ORDER BY id DESC LIMIT ?').all(normalizePhone(phone), limit).reverse();
  }
}
