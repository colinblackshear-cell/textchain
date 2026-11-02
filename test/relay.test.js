import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Relay } from '../src/relay.js';

const GROUP = '+15550001000';
const DAN = '+15551110001', MAYA = '+15551110002', JORDAN = '+15551110003';
let relay, sent, pushes, appUsers, group, members;

function sms(opts = {}) {
  return { name: 'fake', handlesComplianceReplies: false, ...opts, async send(m) { sent.push(m); return { id: 'X' + sent.length }; } };
}
const fakePush = {
  hasSubscription: (id) => appUsers.has(id),
  async notify(id, payload) { pushes.push({ id, ...payload }); return 1; },
};

async function text(from, body, mediaUrls = []) {
  const r = relay.handleInbound({ from, to: GROUP, body, mediaUrls });
  await relay.drain();
  return r;
}
const textsTo = (phone) => sent.filter((m) => m.to === phone).map((m) => m.body);
const pushesTo = (m) => pushes.filter((p) => p.id === m.id).map((p) => p.body);
const reset = () => { sent = []; pushes = []; };

beforeEach(async () => {
  sent = []; pushes = []; appUsers = new Set();
  relay = new Relay(openDb(), sms(), { baseUrl: 'https://tc.example', push: fakePush, log: { error() {} } });
  group = relay.createGroup({ name: 'Lincoln Robotics', phoneNumber: '(555) 000-1000', smsBackup: 'all' });
  members = {
    dan: relay.addMember(group.id, { name: 'Coach Dan', phone: '555-111-0001', role: 'admin' }),
    maya: relay.addMember(group.id, { name: 'Maya', phone: '555-111-0002' }),
    jordan: relay.addMember(group.id, { name: 'Jordan', phone: '555-111-0003' }),
  };
  await relay.drain();
});

async function joinAllByText() {
  for (const p of [DAN, MAYA, JORDAN]) await text(p, 'yes');
  reset();
}

// ---------- invites ----------

test('invite text includes a personal link and asks for YES', () => {
  const invite = textsTo(MAYA)[0];
  assert.match(invite, /reply YES/i);
  assert.ok(invite.includes(`https://tc.example/m/${members.maya.token}`));
});

test('members must accept before getting group messages', async () => {
  await text(DAN, 'YES');
  reset();
  const r = await text(DAN, 'Practice at 6');
  assert.equal(r.recipients, 0, 'nobody else has joined yet');
  assert.equal((await text(MAYA, 'hi')).action, 'awaiting YES');
});

test('opening the personal link joins a member without any text', async () => {
  relay.touch(members.maya);
  await text(DAN, 'yes');
  reset();
  const r = relay.broadcast(group.id, { body: 'hello', fromName: 'Coach' });
  assert.equal(r.recipients, 2);
});

// ---------- SMS relay (all-texts mode) ----------

test('texts fan out to everyone except the sender, with the sender name', async () => {
  await joinAllByText();
  const r = await text(DAN, 'Practice moved to 6pm');
  assert.equal(r.texted, 2);
  assert.deepEqual(textsTo(MAYA), ['Coach Dan: Practice moved to 6pm']);
  assert.deepEqual(textsTo(DAN), []);
  assert.equal(sent[0].from, GROUP);
});

test('a texted tapback is attached to the right message and notifies nobody', async () => {
  await joinAllByText();
  const { messageId } = await text(DAN, 'Practice moved to 6pm, gym B');
  reset();
  const r = await text(MAYA, 'Loved “Coach Dan: Practice moved to 6pm, gym B”');
  assert.equal(r.action, 'suppressed');
  assert.equal(r.attachedTo, messageId);
  await text(JORDAN, 'Laughed at “Coach Dan: Practice moved…”');
  assert.equal(sent.length + pushes.length, 0);
  const msg = relay.listMessages(group.id).find((m) => m.id === messageId);
  assert.deepEqual(msg.reactions.map((x) => x.emoji).sort(), ['❤️', '😂'].sort());
  await text(MAYA, 'Removed a heart from “Coach Dan: Practice moved to 6pm, gym B”');
  assert.equal(relay.listMessages(group.id).find((m) => m.id === messageId).reactions.length, 1);
});

test('emoji-only texts are kept but notify nobody', async () => {
  await joinAllByText();
  const r = await text(JORDAN, '👍');
  assert.equal(r.action, 'suppressed');
  assert.equal(sent.length, 0);
  const feed = relay.memberFeed(members.maya);
  assert.equal(feed.at(-1).body, '👍');
  assert.equal(feed.at(-1).quiet, true);
});

test('"Yes" from a joined member is a normal message', async () => {
  await joinAllByText();
  assert.equal((await text(MAYA, 'Yes')).action, 'relayed');
  assert.deepEqual(textsTo(JORDAN), ['Maya: Yes']);
});

test('STOP stops texts; START brings them back', async () => {
  await joinAllByText();
  await text(JORDAN, 'STOP');
  assert.match(textsTo(JORDAN)[0], /won't get more texts/);
  reset();
  await text(DAN, 'hello');
  assert.deepEqual(textsTo(JORDAN), []);
  assert.equal((await text(JORDAN, 'still here?')).action, 'ignored');
  await text(JORDAN, 'START');
  reset();
  await text(DAN, 'welcome back');
  assert.deepEqual(textsTo(JORDAN), ['Coach Dan: welcome back']);
});

test('compliance replies are left to the provider when it handles them', async () => {
  relay = new Relay(relay.db, sms({ handlesComplianceReplies: true }), { push: fakePush });
  await joinAllByText();
  await text(JORDAN, 'STOP');
  assert.deepEqual(textsTo(JORDAN), []);
  assert.equal(relay.getMember(members.jordan.id).sms_ok, 0);
});

test('MUTE pauses delivery to one member', async () => {
  await joinAllByText();
  await text(MAYA, 'mute');
  reset();
  await text(DAN, 'quiet test');
  assert.deepEqual(textsTo(MAYA), []);
  assert.equal(textsTo(JORDAN).length, 1);
});

test('NAME changes how a member appears', async () => {
  await joinAllByText();
  await text(MAYA, 'NAME Maya R');
  reset();
  await text(MAYA, 'hi all');
  assert.deepEqual(textsTo(DAN), ['Maya R: hi all']);
});

test('unknown senders get the join link', async () => {
  const r = await text('+15559999999', 'hi');
  assert.ok(r.reply.includes(`/join/${group.join_code}`));
});

test('photos are forwarded', async () => {
  await joinAllByText();
  await text(MAYA, '', ['https://example.com/a.jpg']);
  assert.deepEqual(sent.find((m) => m.to === DAN).mediaUrls, ['https://example.com/a.jpg']);
});

// ---------- the free app ----------

test('app users get a free push instead of a text', async () => {
  await joinAllByText();
  appUsers.add(members.maya.id);
  const r = await text(DAN, 'Bus leaves at 7');
  assert.deepEqual([r.pushed, r.texted], [1, 1]);
  assert.deepEqual(pushesTo(members.maya), ['Coach Dan: Bus leaves at 7']);
  assert.deepEqual(textsTo(MAYA), []);
  assert.equal(pushes[0].title, 'Lincoln Robotics');
  assert.equal(pushes[0].url, `/m/${members.maya.token}`);
});

test('text backup "announcements": only organizer messages are texted, everything is pushed', async () => {
  relay.updateGroup(group.id, { smsBackup: 'announcements' });
  await joinAllByText();
  appUsers.add(members.dan.id);
  const fromMember = await text(MAYA, 'Can I bring my sister?');
  assert.deepEqual([fromMember.pushed, fromMember.texted], [1, 0]);
  assert.deepEqual(textsTo(JORDAN), []);
  const fromDashboard = relay.broadcast(group.id, { body: 'Game cancelled', fromName: 'Lincoln Robotics' });
  await relay.drain();
  assert.equal(fromDashboard.texted, 2);
  assert.deepEqual(textsTo(JORDAN), ['Lincoln Robotics: Game cancelled']);
});

test('app-only groups never text anyone', async () => {
  const free = relay.createGroup({ name: 'Chess Club' });
  assert.equal(free.phone_number, null);
  const a = relay.joinByCode(free.join_code, { name: 'Ava' });
  const b = relay.joinByCode(free.join_code, { name: 'Ben' });
  appUsers.add(b.id);
  reset();
  const r = relay.postFromWeb(a, 'Meeting moved to Thursday');
  await relay.drain();
  assert.deepEqual([r.pushed, r.texted], [1, 0]);
  assert.equal(sent.length, 0);
  assert.deepEqual(pushesTo(b), ['Ava: Meeting moved to Thursday']);
});

test('web reactions toggle, show in the feed, and never notify', async () => {
  const a = relay.joinByCode(group.join_code, { name: 'Ava' });
  const b = relay.joinByCode(group.join_code, { name: 'Ben' });
  appUsers.add(a.id).add(b.id);
  const { messageId } = relay.postFromWeb(a, 'Who needs a ride?');
  await relay.drain();
  reset();
  assert.deepEqual(relay.react(b, messageId, '👍'), { reacted: true });
  await relay.drain();
  assert.equal(pushes.length + sent.length, 0);
  const seenByA = relay.memberFeed(a).find((m) => m.id === messageId);
  assert.deepEqual(seenByA.reactions, [{ emoji: '👍', count: 1, names: ['Ben'], mine: false }]);
  assert.equal(relay.memberFeed(b).find((m) => m.id === messageId).reactions[0].mine, true);
  assert.deepEqual(relay.react(b, messageId, '👍'), { reacted: false });
  assert.equal(relay.memberFeed(a).find((m) => m.id === messageId).reactions.length, 0);
  assert.throws(() => relay.react(b, messageId, 'hello'), /Not a reaction/);
});

test('emoji-only posts from the app show up but notify nobody', async () => {
  const a = relay.joinByCode(group.join_code, { name: 'Ava' });
  const b = relay.joinByCode(group.join_code, { name: 'Ben' });
  appUsers.add(b.id);
  const r = relay.postFromWeb(a, '😂😂');
  await relay.drain();
  assert.equal(r.action, 'suppressed');
  assert.equal(pushes.length, 0);
  assert.equal(relay.memberFeed(b).at(-1).quiet, true);
});

test('announcement mode: member posts reach organizers only and are hidden from other members', async () => {
  relay.updateGroup(group.id, { mode: 'announce' });
  await joinAllByText();
  await text(MAYA, 'Can I bring my sister?');
  assert.deepEqual(textsTo(DAN), ['Maya (to organizers): Can I bring my sister?']);
  assert.deepEqual(textsTo(JORDAN), []);
  const jordanFeed = relay.memberFeed(relay.getMember(members.jordan.id));
  assert.equal(jordanFeed.length, 0);
  assert.equal(relay.memberFeed(relay.getMember(members.dan.id)).length, 1);
  assert.equal(relay.memberFeed(relay.getMember(members.maya.id)).length, 1, 'Maya sees her own message');
});

test('join by link: phone is optional, and texts need explicit consent', () => {
  const noPhone = relay.joinByCode(group.join_code, { name: 'Ava' });
  assert.equal(noPhone.phone, null);
  assert.equal(noPhone.status, 'active');
  const noConsent = relay.joinByCode(group.join_code, { name: 'Ben', phone: '555-222-0002' });
  assert.equal(noConsent.sms_ok, 0);
  const yes = relay.joinByCode(group.join_code, { name: 'Cy', phone: '555-222-0003', smsConsent: true });
  assert.equal(yes.sms_ok, 1);
  assert.throws(() => relay.joinByCode(group.join_code, { name: 'Imposter', phone: MAYA }), /already in this group/);
  assert.throws(() => relay.joinByCode('nope', { name: 'X' }), /no longer valid/);
});

test('bulk add accepts names with or without numbers', () => {
  const { added, errors } = relay.addMembersFromText(group.id, 'Ava Chen, 555-222-0001\n(555) 222-0002 Ben Ito\nCy Park\nMaya dup, 555-111-0002');
  assert.deepEqual(added.map((m) => m.name), ['Ava Chen', 'Ben Ito', 'Cy Park']);
  assert.equal(added[2].phone, null);
  assert.equal(errors.length, 1);
});

test('a 100-person group fans out to 99 people', async () => {
  for (let i = 0; i < 97; i++) {
    const m = relay.addMember(group.id, { name: `P${i}`, phone: `555-300-${String(i).padStart(4, '0')}` }, { invite: false });
    if (i % 2) appUsers.add(m.id);
  }
  relay.db.prepare("UPDATE members SET status = 'active', sms_ok = 1").run();
  reset();
  const r = await text(DAN, 'big group');
  assert.equal(r.recipients, 99);
  assert.equal(r.pushed + r.texted, 99);
  assert.equal(sent.length, r.texted);
  assert.equal(pushes.length, r.pushed);
});
