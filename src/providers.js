import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A provider sends one SMS/MMS. Every provider exposes:
 *   name, send({ to, from, body, mediaUrls }) -> { id }
 *   handlesComplianceReplies: true if the carrier/provider already answers STOP/START/HELP itself
 */

/** Simulator: nothing leaves the server. Deliveries show up in the /sim phone view. */
export function simProvider() {
  let n = 0;
  return {
    name: 'sim',
    handlesComplianceReplies: false,
    async send() {
      return { id: `SIM${++n}` };
    },
  };
}

export function twilioProvider({ accountSid, authToken, statusCallbackUrl } = {}) {
  if (!accountSid || !authToken) throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required for SMS_PROVIDER=twilio');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  return {
    name: 'twilio',
    // Twilio's default opt-out handling replies to STOP / START / HELP on long codes.
    handlesComplianceReplies: true,
    async send({ to, from, body, mediaUrls = [] }) {
      const form = new URLSearchParams({ To: to, From: from, Body: body });
      for (const m of mediaUrls) form.append('MediaUrl', m);
      if (statusCallbackUrl) form.set('StatusCallback', statusCallbackUrl);
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Twilio ${res.status}: ${json.message || 'send failed'}`);
      return { id: json.sid };
    },
  };
}

/** Verify the X-Twilio-Signature header on an inbound webhook. */
export function validateTwilioSignature({ authToken, signature, url, params }) {
  if (!signature) return false;
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  const expected = createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
