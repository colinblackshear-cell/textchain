# TextChain

Group messaging for schools, clubs, and teams (25 to 100+ people) that's **free for members**: no app store, no account, and **reactions never buzz anyone's phone**.

## How it works

1. An organizer creates a group in the dashboard and shares its **join link** (or adds people by name and number).
2. Members open the link, type their name, and they're in. They tap **Add to Home Screen** once, and new messages show up as normal phone notifications (web push). That's free: it goes over the internet, not the text plan.
3. Reactions (❤️ 👍 😂 ...) show under the message but **never send a notification**. Emoji-only replies are shown but silent too.
4. **Text backup (optional).** Give the group a Twilio number, and people who never add the app can get texts instead. By default only organizer messages are texted, which keeps the bill small. People can also text the group number; their message goes to everyone, and their tapbacks (`Loved “…”`) are matched to the right message as a silent reaction.

Each person gets each message one way: a free push notification if they've turned notifications on in the app, otherwise a text if they agreed to texts and the group's text-backup rule covers that message.

| Group setting | Options |
| --- | --- |
| Who can message the whole group | Everyone (group chat), or only organizers (member replies go to organizers) |
| Texts for people not using the app | Organizer messages only (default), every message, or nobody (app only, completely free) |
| Group phone number | Optional. Without one the group is app-only and costs nothing to run beyond hosting. |

Text commands for people on the text backup: `YES` (join), `STOP` / `START` / `HELP` (carrier-required), `MUTE` / `UNMUTE`, `NAME <new name>`.

## Run it locally (no Twilio needed)

Requires Node.js 22.13 or newer. There are no npm dependencies.

```sh
cp .env.example .env      # set ADMIN_PASSWORD
npm install               # one dependency: web-push
npm start                 # http://localhost:3000
npm test
```

With `SMS_PROVIDER=sim` (the default) no texts are really sent. Open **http://localhost:3000/sim** to see text-backup members' phones side by side, send texts, tap "Love last" or 👍, and watch who buzzes.

Push notifications need HTTPS in production (browsers allow them on `localhost` for testing). On iPhone they work once the page is added to the Home Screen (iOS 16.4+). Server keys for push (VAPID) are generated on first run and stored in the database; set `VAPID_SUBJECT=mailto:you@yourdomain` so push services can contact you.

## Deploy

Any host with a public HTTPS URL and a persistent disk for `data/` works (Render, Railway, Fly.io, a small VPS). Set `PUBLIC_URL`, `ADMIN_PASSWORD` and `VAPID_SUBJECT`. That's all an app-only group needs.

## Add text backup with Twilio (optional)

1. Create a Twilio account and buy one local number per group that needs texts (SMS + MMS capable).
2. Register for **A2P 10DLC** (Messaging > Regulatory Compliance): one Brand and one Campaign. US carriers block unregistered traffic. Describe it plainly: *"Opt-in group messaging for schools, clubs and teams. Members are added by an organizer or join via a web form with an explicit checkbox, and must reply YES or tick the box before receiving texts."*
3. Set `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`.
4. On each number, set **A message comes in** to `POST {PUBLIC_URL}/sms/inbound`, then enter the number in the group's Settings tab.

Inbound webhooks are verified with Twilio's `X-Twilio-Signature`, so `PUBLIC_URL` must match the URL Twilio calls exactly. Twilio answers STOP / START / HELP itself on long codes, so in Twilio mode the app updates the member but doesn't send a second reply.

## Costs (approximate)

- App-only groups: hosting only (about $5 to $10/month for many groups). Push notifications are free.
- Text backup: about $0.012 per text including carrier fees, once per person texted; about $1.15/month per number; 10DLC registration about $20 to $60 up front plus a few dollars a month. With the default "organizer messages only" rule, a 30-person group where 10 people use texts and organizers post twice a day is about $7/month. The dashboard shows texts sent this month per group.

## Layout

```
src/filter.js     reaction / emoji / command detection  (the important bit)
src/relay.js      groups, members, delivery rules (push vs text), reactions, commands, send queue
src/push.js       free web push notifications (VAPID keys, subscriptions)
src/providers.js  Twilio sender + signature check, and the SMS simulator
src/server.js     HTTP server: dashboard API, Twilio webhooks, simulator API
src/db.js         SQLite schema (built-in node:sqlite)
public/           dashboard (index.html), members' app (member.html, sw.js), join page, SMS simulator (sim.html)
test/             node:test suites
```

## Known limits of this MVP

- One organizer password for the whole dashboard (no per-organizer accounts yet). Organizers can also chat from their own member link.
- A member's personal link is their login. Anyone with the link can post as them; organizers can remove and re-add someone to issue a new link.
- The app checks for new messages every few seconds while open (no live socket yet). Photos can't be posted from the app yet.
- Sends go out from a simple in-process queue; restarts resume anything still queued, but there's no retry for failed sends.
- Reaction detection covers English-language phone formats. Other languages would need their own patterns.
- A real text that happens to look exactly like a tapback (e.g. `Loved "Hamilton"`) is treated as a reaction.
