# TextChain

Group texting for schools, clubs, and teams (25 to 100+ people). Members don't install anything: each group has its own phone number, and texts sent to it go out to everyone as normal SMS. **Reactions (tapbacks like "Loved ...") and emoji-only replies never notify anyone.**

## How it works

1. An organizer creates a group in the dashboard and gives it a phone number (one Twilio number per group).
2. They add members by name and mobile number (one at a time or by pasting a list).
3. Each member gets one text: *"Reply YES to join."* Nobody gets group texts until they say YES.
4. When a member texts the group number, the server re-sends it to every other joined member as `Name: message`, from the group number. On each phone it's one conversation, saved as the group's name.
5. Every inbound text is classified first:
   - **Reaction** (`Loved “…”`, `Laughed at an image`, `Reacted 🎉 to “…”`, `👍 to “…”`, `Removed a heart from “…”`) or **emoji-only** (`👍`, `😂😂`): logged in the dashboard, sent to nobody.
   - **Command**: `STOP` / `START` / `HELP` (carrier-required), `MUTE` / `UNMUTE`, `NAME <new name>`.
   - Everything else is relayed.

Two group modes:
- **Group chat**: everyone's texts go to everyone.
- **Announcements**: only organizers reach the whole group; members' replies go only to organizers.

## Run it locally (no Twilio needed)

Requires Node.js 22.13 or newer. There are no npm dependencies.

```sh
cp .env.example .env      # set ADMIN_PASSWORD
npm start                 # http://localhost:3000
npm test                  # 48 tests
```

With `SMS_PROVIDER=sim` (the default) nothing is really sent. Open **http://localhost:3000/sim** to see every member's phone side by side, send texts, tap "Love last" or 👍, and watch who buzzes.

## Go live with Twilio

1. Create a Twilio account and buy one local number per group (Phone Numbers > Buy a number, SMS + MMS capable).
2. Register for **A2P 10DLC** (Messaging > Regulatory Compliance). You need a Brand (your school/club or company) and one Campaign. US carriers block unregistered traffic. Describe the use case plainly: *"Opt-in group messaging for schools, clubs and teams. Members are added by an organizer and must reply YES before receiving messages."* Include the opt-in text and sample messages. Add every group number to the campaign (a Messaging Service makes this easy).
3. Deploy this app somewhere with a public HTTPS URL and a persistent disk for `data/` (Render, Railway, Fly.io, a small VPS).
4. Set environment variables: `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `PUBLIC_URL`, `ADMIN_PASSWORD`.
5. On each number (or the Messaging Service), set **A message comes in** to `POST {PUBLIC_URL}/sms/inbound`.

Inbound webhooks are verified with Twilio's `X-Twilio-Signature`, so `PUBLIC_URL` must match the URL Twilio calls exactly.

Twilio answers STOP / START / HELP itself on long codes, so in Twilio mode the app updates the member's status but doesn't send a second reply.

## Costs (approximate; check Twilio's pricing page)

Every message is sent once per recipient. In a 60-person group, one message = 59 texts. At about $0.012 per text including carrier fees, 15 messages a day is about $330/month; announcement mode with 3 posts a day is about $65/month. Photos (MMS) cost 2 to 3 times more. Numbers are about $1.15/month each, plus 10DLC fees (about $4 to $45 one-time, $15 campaign vetting, $2 to $10/month).

## Layout

```
src/filter.js     reaction / emoji / command detection  (the important bit)
src/relay.js      groups, members, fan-out, commands, send queue
src/providers.js  Twilio sender + signature check, and the simulator
src/server.js     HTTP server: dashboard API, Twilio webhooks, simulator API
src/db.js         SQLite schema (built-in node:sqlite)
public/           dashboard (index.html) and phone simulator (sim.html)
test/             node:test suites
```

## Known limits of this MVP

- One organizer password for the whole dashboard (no per-organizer accounts yet).
- Sends go out from a simple in-process queue; restarts resume anything still queued, but there's no retry for failed sends.
- Reaction detection covers English-language phone formats. Other languages would need their own patterns.
- A real text that happens to look exactly like a tapback (e.g. `Loved "Hamilton"`) is treated as a reaction.
