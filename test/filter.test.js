import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, isReaction, isEmojiOnly } from '../src/filter.js';

const reactions = [
  'Loved “Practice moved to 6pm”',
  'Liked "See you there"',
  'Disliked “Game is cancelled”',
  'Laughed at “lol coach”',
  'Emphasized “Bring water bottles”',
  'Questioned “Bus leaves at 7”',
  'Loved an image',
  'Laughed at a video',
  'Liked “Practice moved to 6pm…”',
  'Reacted 🎉 to “We won!”',
  'Reacted 👍🏽 to “Bus leaves at 7”',
  '👍 to “Bus leaves at 7”',
  '😂 to "lol"',
  'Removed a heart from “Practice moved”',
  'Removed a like from “See you there”',
  'Removed 😂 from “lol coach”',
  '  Loved “trailing whitespace”  ',
];

for (const r of reactions) {
  test(`reaction: ${r}`, () => {
    assert.equal(isReaction(r), true);
    assert.equal(classify(r).kind, 'reaction');
  });
}

const realMessages = [
  'Loved the game today, great job everyone',
  'I liked "Hamilton" a lot, we should go as a team',
  'Reacted badly to the news honestly',
  'Practice moved to 6pm',
  'Can someone drive me? 🙏',
  'lol 😂',
  '?',
  '!!!',
  '7',
  'Yes',
  'Liked',
];
for (const m of realMessages) {
  test(`message: ${m}`, () => {
    const kind = classify(m).kind;
    assert.ok(kind === 'message' || kind === 'command', `${m} -> ${kind}`);
    assert.notEqual(kind, 'reaction');
  });
}

test('emoji-only messages are suppressed by default', () => {
  for (const e of ['👍', '😂😂😂', '❤️', '👍🏾', '🇺🇸', '🔥 🔥', '🙏!', '👨‍👩‍👧']) {
    assert.equal(isEmojiOnly(e), true, e);
    assert.equal(classify(e).kind, 'reaction', e);
  }
});

test('emoji-only can be allowed per group', () => {
  assert.equal(classify('👍', { suppressEmojiOnly: false }).kind, 'message');
});

test('emoji with a photo still goes through', () => {
  assert.equal(classify('🔥', { hasMedia: true }).kind, 'message');
});

test('commands', () => {
  assert.deepEqual(classify('STOP'), { kind: 'command', command: 'stop' });
  assert.deepEqual(classify('stop.'), { kind: 'command', command: 'stop' });
  assert.deepEqual(classify('Unsubscribe'), { kind: 'command', command: 'stop' });
  assert.deepEqual(classify('start'), { kind: 'command', command: 'start' });
  assert.deepEqual(classify('yes'), { kind: 'command', command: 'confirm' });
  assert.deepEqual(classify('HELP'), { kind: 'command', command: 'help' });
  assert.deepEqual(classify('mute'), { kind: 'command', command: 'mute' });
  assert.deepEqual(classify('name Coach Dan'), { kind: 'command', command: 'name', arg: 'Coach Dan' });
  assert.equal(classify('please stop texting me so early').kind, 'message');
});

import { parseTapback } from '../src/filter.js';
test('parseTapback maps tapbacks to emoji and the quoted text', () => {
  assert.deepEqual(parseTapback('Loved “Coach Dan: Practice moved…”'), { emoji: '❤️', quoted: 'Coach Dan: Practice moved', remove: false });
  assert.deepEqual(parseTapback('Reacted 🎉 to “We won”'), { emoji: '🎉', quoted: 'We won', remove: false });
  assert.deepEqual(parseTapback('Removed a heart from “abc”'), { emoji: '❤️', quoted: 'abc', remove: true });
  assert.deepEqual(parseTapback('Laughed at an image'), { emoji: '😂', quoted: null, remove: false });
  assert.equal(parseTapback('hello'), null);
});
