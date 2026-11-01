import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Relay } from '../src/relay.js';

const GROUP = '+15550001000';
let relay, sent, group;

function provider(opts = {}) {
  return { name: 'fake', handlesComplianceReplies: false, ...opts, async send(m) { sent.push(m); return { id: 'X' + sent.length }; } };
}

async function text(from, body, mediaUrls = []) {
  const r = relay.handleInbound({ from, to: GROUP, body, mediaUrls });
  await relay.drain();
  return r;
}
const to = (phone) => sent.filter((m) => m.to === phone).map((m) => m.body);

beforeEach(async () => {
  sent = [];
  relay = new Relay(openDb(), provider(), { log: { error() {} } });
  group = relay.createGroup({ name: 'Lincoln Robotics', phoneNumber: '(555) 000-1000' });
  relay.addMember(group.id, { name: 'Coach Dan', phone: '555-111-0001', role: 'admin' });
  relay.addMember(group.id, { name: 'Maya', phone: '555-111-0002' });
  relay.addMember(group.id, { name: 'Jordan', phone: '555-111-0003' });
  await relay.drain();
});

test('members get an invite and must reply YES before receiving group texts', async () => {
  assert.equal(sent.length, 3);
  assert.match(to('+15551110002')[0], /Reply YES to join/);
  await text('+15551110001', 'YES');
  sent = [];
  const r = await text('+15551110001', 'Practice at 6');
  assert.equal(r.recipients, 0, 'nobody else has joined yet');
  const pending = await text('+15551110002', 'hi');
  assert.equal(pending.action, 'awaiting YES');
});

async function joinAll() {
  for (const p of ['+15551110001', '+15551110002', '+15551110003']) await text(p, 'yes');
  sent = [];
}

test('messages fan out to everyone except the sender, with the sender name', async () => {
  await joinAll();
  const r = await text('+15551110001', 'Practice moved to 6pm');
  assert.equal(r.recipients, 2);
  assert.deepEqual(to('+15551110002'), ['Coach Dan: Practice moved to 6pm']);
  assert.deepEqual(to('+15551110001'), []);
  assert.equal(sent[0].from, GROUP);
});

test('tapback reactions and emoji-only replies notify nobody', async () => {
  await joinAll();
  assert.equal((await text('+15551110002', 'Loved “Practice moved to 6pm”')).action, 'suppressed');
  assert.equal((await text('+15551110003', '👍')).action, 'suppressed');
  assert.equal(sent.length, 0);
  const log = relay.listMessages(group.id).filter((m) => m.kind === 'reaction');
  assert.equal(log.length, 2, 'reactions are still logged for the dashboard');
});

test('"Yes" from an active member is a normal message', async () => {
  await joinAll();
  const r = await text('+15551110002', 'Yes');
  assert.equal(r.action, 'relayed');
  assert.deepEqual(to('+15551110003'), ['Maya: Yes']);
});

test('STOP opts out and stops delivery; START rejoins', async () => {
  await joinAll();
  await text('+15551110003', 'STOP');
  assert.match(to('+15551110003')[0], /You've left/);
  sent = [];
  await text('+15551110001', 'hello');
  assert.deepEqual(to('+15551110003'), []);
  assert.equal((await text('+15551110003', 'still here?')).action, 'ignored');
  await text('+15551110003', 'START');
  sent = [];
  await text('+15551110001', 'welcome back');
  assert.deepEqual(to('+15551110003'), ['Coach Dan: welcome back']);
});

test('compliance replies are left to the provider when it handles them', async () => {
  sent = [];
  relay = new Relay(relay.db, provider({ handlesComplianceReplies: true }));
  await joinAll();
  await text('+15551110003', 'STOP');
  assert.deepEqual(to('+15551110003'), []);
  assert.equal(relay.listMembers(group.id).find((m) => m.name === 'Jordan').status, 'opted_out');
});

test('MUTE pauses delivery to one member', async () => {
  await joinAll();
  await text('+15551110002', 'mute');
  sent = [];
  await text('+15551110001', 'quiet test');
  assert.deepEqual(to('+15551110002'), []);
  assert.equal(to('+15551110003').length, 1);
});

test('announcement mode: member replies go only to admins', async () => {
  await joinAll();
  relay.updateGroup(group.id, { mode: 'announce' });
  await text('+15551110002', 'Can I bring my sister?');
  assert.deepEqual(to('+15551110001'), ['Maya (to organizers): Can I bring my sister?']);
  assert.deepEqual(to('+15551110003'), []);
  sent = [];
  await text('+15551110001', 'Yes, everyone can bring a guest');
  assert.equal(sent.length, 2);
});

test('unknown senders are told to ask an organizer', async () => {
  const r = await text('+15559999999', 'hi');
  assert.match(r.reply, /Ask an organizer/);
});

test('NAME changes how a member appears', async () => {
  await joinAll();
  await text('+15551110002', 'NAME Maya R');
  sent = [];
  await text('+15551110002', 'hi all');
  assert.deepEqual(to('+15551110001'), ['Maya R: hi all']);
});

test('dashboard broadcast reaches all active members', async () => {
  await joinAll();
  const r = relay.broadcast(group.id, { body: 'Game cancelled', fromName: 'Lincoln Robotics' });
  await relay.drain();
  assert.equal(r.recipients, 3);
  assert.deepEqual(to('+15551110003'), ['Lincoln Robotics: Game cancelled']);
});

test('bulk add parses pasted lists and reports bad lines', () => {
  const { added, errors } = relay.addMembersFromText(group.id, 'Ava Chen, 555-222-0001\n(555) 222-0002 Ben Ito\nno number here\nMaya dup, 555-111-0002');
  assert.deepEqual(added.map((m) => m.name), ['Ava Chen', 'Ben Ito']);
  assert.equal(errors.length, 2);
});

test('photos are forwarded', async () => {
  await joinAll();
  await text('+15551110002', '', ['https://example.com/a.jpg']);
  assert.deepEqual(sent.find((m) => m.to === '+15551110001').mediaUrls, ['https://example.com/a.jpg']);
});

test('a 100-person group fans out to 99 phones', async () => {
  for (let i = 0; i < 97; i++) relay.addMember(group.id, { name: `P${i}`, phone: `555-300-${String(i).padStart(4, '0')}` });
  relay.db.prepare("UPDATE members SET status = 'active'").run();
  await relay.drain();
  sent = [];
  const r = await text('+15551110001', 'big group');
  assert.equal(r.recipients, 99);
  assert.equal(sent.length, 99);
});
