// Classifies an inbound text so the relay knows whether to fan it out.
//
// The point of this file: phones turn "tapback" reactions into ordinary SMS
// when the other side isn't on iMessage/RCS. Without filtering, every heart
// on a message buzzes every phone in the group. We recognise those and drop
// them, along with emoji-only replies.

const OPT_OUT = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT']);
const OPT_IN = new Set(['START', 'UNSTOP']);
// Only treated as a command while the member hasn't joined yet (the relay decides).
const CONFIRM = new Set(['YES', 'Y', 'JOIN']);
const HELP = new Set(['HELP', 'INFO']);
const MUTE = new Set(['MUTE', 'PAUSE']);
const UNMUTE = new Set(['UNMUTE', 'RESUME']);

const QUOTED = String.raw`["“”'‘’].*["“”'‘’…]`;
const MEDIA = String.raw`an?\s+(?:image|photo|picture|video|movie|attachment|audio message|gif|sticker|link|message|contact|location)`;
const TARGET = `(?:${QUOTED}|${MEDIA})`;

// English formats sent by iOS Messages, Google Messages and Samsung Messages.
const REACTION_PATTERNS = [
  // iOS classic tapbacks: Liked “...”, Laughed at an image, Emphasized “...”
  new RegExp(String.raw`^(?:liked|loved|disliked|laughed at|emphasi[sz]ed|questioned)\s+${TARGET}$`, 'isu'),
  // iOS 18+ / Google Messages emoji reactions: Reacted 🎉 to “...”
  new RegExp(String.raw`^reacted\s+.{1,16}?\s+to\s+${TARGET}$`, 'isu'),
  // Google Messages short form: 👍 to “...”
  new RegExp(String.raw`^[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}‍️]+\s+to\s+${TARGET}$`, 'isu'),
  // Removing a reaction: Removed a heart from “...”, Removed 😂 from “...”
  new RegExp(String.raw`^removed\s+.{1,30}?\s+from\s+${TARGET}$`, 'isu'),
];

// Characters allowed in an "emoji-only" message.
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️⃣\s!?.]+$/u;

export function isReaction(body) {
  const text = (body || '').trim();
  if (!text) return false;
  return REACTION_PATTERNS.some((re) => re.test(text));
}

export function isEmojiOnly(body) {
  const text = (body || '').trim();
  if (!text) return false;
  // must contain at least one pictograph (so "!!!" or "?" still go through)
  return EMOJI_ONLY.test(text) && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text);
}

/**
 * @param {string} body
 * @param {{ hasMedia?: boolean, suppressEmojiOnly?: boolean }} opts
 * @returns {{ kind: 'command', command: string, arg?: string } | { kind: 'reaction', reason: string } | { kind: 'message' } | { kind: 'empty' }}
 */
export function classify(body, { hasMedia = false, suppressEmojiOnly = true } = {}) {
  const text = (body || '').trim();
  const word = text.toUpperCase().replace(/[.!]+$/, '');

  if (OPT_OUT.has(word)) return { kind: 'command', command: 'stop' };
  if (OPT_IN.has(word)) return { kind: 'command', command: 'start' };
  if (CONFIRM.has(word)) return { kind: 'command', command: 'confirm' };
  if (HELP.has(word)) return { kind: 'command', command: 'help' };
  if (MUTE.has(word)) return { kind: 'command', command: 'mute' };
  if (UNMUTE.has(word)) return { kind: 'command', command: 'unmute' };
  const name = text.match(/^NAME\s+(.{1,30})$/i);
  if (name) return { kind: 'command', command: 'name', arg: name[1].trim() };

  if (!text && !hasMedia) return { kind: 'empty' };
  if (isReaction(text)) return { kind: 'reaction', reason: 'tapback' };
  if (!hasMedia && suppressEmojiOnly && isEmojiOnly(text)) return { kind: 'reaction', reason: 'emoji-only' };
  return { kind: 'message' };
}
