# Telegram ↔ Bale Channel Synchronization

A **bidirectional** synchronization system that bridges a Telegram channel +
its discussion group with a Bale channel + its discussion group, running
entirely on **Cloudflare Workers + D1**.

- **Channel posts** — sync **both directions**. A post made in *either* channel
  is mirrored to the other (text, media, albums, captions, formatting, URL
  buttons), and edits are mirrored too.
- **Comments & replies** — synchronized **both directions** between the two
  discussion groups, with the original author's name, a "from Telegram / from
  Bale" label, and a link back to the source.
- **Admin dashboard** — a web UI to configure connections (channel/group IDs),
  behavior settings, view live status/stats, register webhooks, and check
  which secrets are set. Persian (RTL) interface.
- **Reliability** — idempotent webhook processing, loop prevention, duplicate
  prevention, and a durable retry queue drained by a cron trigger.

> **Note on sync direction.** The original design document specified one-way
> channel publishing (Telegram → Bale). Per the project request, channel posts
> are synchronized in **both directions** here. Each direction can be toggled
> independently from the dashboard (`sync_telegram_to_bale`,
> `sync_bale_to_telegram`). Automatic deletion is intentionally **not**
> included — deletions are handled manually on both platforms.

---

## Architecture

```
Telegram Channel ─┐                                   ┌─ Bale Channel
Telegram Group   ─┤──▶  Cloudflare Worker  ◀──────────┤─ Bale Group
                  │      (webhooks, sync,   │          │
                  │       formatting,       ▼          │
                  │       retries)     Cloudflare D1   │
                  └────────────────── (mappings,  ─────┘
                                       jobs, logs)
```

Both Telegram and Bale expose a Telegram-compatible Bot API, so a single
`BotApiClient` serves both platforms (`src/services/bot-api.ts`).

### Project layout

```
src/
  index.ts                 Router + scheduled (cron) job runner
  routes/
    telegram-webhook.ts     POST /webhooks/telegram/{secret}
    bale-webhook.ts         POST /webhooks/bale/{secret}
    admin.ts                /admin/* JSON API (Bearer auth)
    health.ts               GET /health
  services/
    bot-api.ts              Shared Telegram/Bale Bot API client
    telegram-api.ts         Telegram client factory
    bale-api.ts             Bale client factory
    dispatch.ts             Update -> handler routing + idempotency
    post-sync.ts            Bidirectional channel-post sync + edits
    comment-sync.ts         Bidirectional comment/reply sync + edits
    reply-sync.ts           Reply / standalone-message policy
    media-transfer.ts       Media extraction + URL resolution + fallbacks
    formatter.ts            Entity -> Markdown, identity headers, sanitization
    links.ts                Message/comment deep links
    retry.ts                Backoff + retryability rules
    job-runner.ts           Durable delivery jobs + queue draining
    commands.ts             Admin bot commands (/status, /pause, ...)
    status.ts               Status/stats snapshots
    context.ts              Per-request bundle of repos + clients (async factory)
    secrets.ts              Resolve secrets from D1 (encrypted) or env
    hash.ts                 Content fingerprint (edit/duplicate detection)
  repositories/             D1 data-access layer (incl. secure-config)
  security/                 Webhook validation, allowlists, AES-GCM crypto
  types/                    Telegram/Bale/env type definitions
migrations/                 D1 schema (0001_initial.sql, 0002_indexes.sql)
public/dashboard.html       Admin dashboard (served via ASSETS binding)
wrangler.jsonc              Worker config
```

---

## Setup

### 1. Prerequisites

- A Cloudflare account with Workers + D1.
- A Telegram bot (via [@BotFather](https://t.me/BotFather)) that is an
  **administrator** of the Telegram channel **and** discussion group.
- A Bale bot that is an **administrator** of the Bale channel **and**
  discussion group.

### 2. Install & create the database

```bash
npm install
wrangler d1 create telegram_bale_sync
# Copy the returned database_id into wrangler.jsonc (d1_databases[0].database_id)
npm run db:init:remote     # apply migrations to the remote D1
```

### 3. Configure secrets

Only **one** secret must be set via the CLI — the dashboard login password,
which also derives the encryption key for everything else:

```bash
wrangler secret put ADMIN_API_SECRET          # dashboard login token
```

The **bot tokens and webhook secrets are entered from the dashboard** (see
step 6). They are stored **encrypted at rest (AES-GCM)** in D1 — never in
plaintext and never in source. If you prefer, you can still provide them as
Cloudflare env secrets instead (the resolver falls back to env when a value is
not set from the dashboard):

```bash
# Optional — env fallback instead of entering them in the dashboard:
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put BALE_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put BALE_WEBHOOK_SECRET
```

For local development, copy `.dev.vars.example` to `.dev.vars` and fill it in.

> Rotating `ADMIN_API_SECRET` changes the encryption key, so re-enter the
> dashboard-stored tokens afterwards.

### 4. Deploy

```bash
npm run deploy
```

### 5. Register webhooks

Open `https://<your-worker>.workers.dev/dashboard`, log in with your
`ADMIN_API_SECRET`, enter the **bot tokens and webhook secrets** in the
«توکن‌ها و رمزها» section (stored encrypted in D1), then click
**«ثبت خودکار وب‌هوک‌ها»** (Register webhooks). This calls `setWebhook` on both
platforms pointing at:

```
POST /webhooks/telegram/{TELEGRAM_WEBHOOK_SECRET}
POST /webhooks/bale/{BALE_WEBHOOK_SECRET}
```

(You can also register manually via each Bot API's `setWebhook`.)

### 6. Add a connection

In the dashboard, add a **connection** with the numeric IDs of your Telegram
channel, Telegram discussion group, Bale channel, and Bale discussion group.
Only configured chats are synchronized — everything else is rejected by the
allowlist.

---

## Admin dashboard

`GET /dashboard` serves a single-page admin UI. It authenticates every request
with the `ADMIN_API_SECRET` bearer token (stored in the browser's
localStorage). From there you can:

- See live status (Telegram / Bale / D1 connectivity, pending jobs, errors).
- **Enter / rotate the bot tokens and webhook secrets** (encrypted at rest in
  D1; values are never shown again — only their source: dashboard / env).
- Register webhooks with one click.
- Create / delete channel↔channel + group↔group connections.
- Toggle every behavior setting and edit text settings / allowlists.
- Review recent message mappings and errors.

### Admin API (Bearer `ADMIN_API_SECRET`)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/admin/status` | Full overview (snapshot, secrets, connections, settings, recent activity) |
| GET | `/admin/stats` | Today's counters |
| GET/POST | `/admin/settings` | Read / update settings |
| GET/POST | `/admin/connections` | List / upsert connections |
| DELETE | `/admin/connections/{id}` | Delete a connection |
| POST | `/admin/retry` | Requeue failed jobs |
| POST | `/admin/pause` \| `/admin/resume` | Pause / resume sync |
| GET | `/admin/secrets` | Which secrets are set and their source (no values) |
| POST | `/admin/secrets` | Store bot tokens / webhook secrets (encrypted) |
| DELETE | `/admin/secrets/{key}` | Clear a dashboard-stored secret |
| POST | `/admin/register-webhooks` | Register both webhooks |

### Bot commands (admins only)

`/status`, `/stats`, `/pause`, `/resume`, `/pause_posts`, `/pause_comments`,
`/pause_telegram_to_bale`, `/pause_bale_to_telegram`, `/retry`,
`/retry_failed`, `/retry_message <id>`, `/find_mapping <message_id>`,
`/mark_deleted <mapping_id>`, `/test_connection`.

Admin user IDs are configured via the `admin_telegram_user_ids` /
`admin_bale_user_ids` settings.

---

## How synchronization works

- **Idempotency** — each webhook `update_id` is claimed once in
  `processed_updates` (unique index). Duplicate deliveries are ignored.
- **Loop prevention** — every synchronized message is recorded in
  `message_mappings` with its source (`telegram_user`, `bale_user`, etc.). A
  message that is already the mirror side of a mapping, or is authored by our
  own bot, is never re-mirrored.
- **Editing** — `edited_channel_post` / `edited_message` look up the twin and
  call `editMessageText` / `editMessageCaption`. Replacing the underlying media
  is not editable in place; the system notifies the admin to repost.
- **Media** — files are resolved to a source-platform download URL and handed
  to the destination `sendX` method. Oversized or unsupported media falls back
  per `media_fallback_mode` (document / source link / notify), always keeping
  the caption + a link to the original.
- **Retries** — transient failures enqueue a self-contained `deliver` job in
  `sync_jobs`, drained every minute by the cron `scheduled` handler with
  exponential backoff up to `max_retry_count`, then marked dead + admin
  notified.

## Security

- Bot tokens and webhook secrets are stored **encrypted (AES-GCM)** in D1 when
  entered from the dashboard, with the key derived from `ADMIN_API_SECRET`
  (the only value that must be a Cloudflare secret). They can alternatively be
  provided as env secrets. Values are never returned by the API or shown in the
  UI after entry.
- Telegram webhooks are validated by both the path secret and the
  `X-Telegram-Bot-Api-Secret-Token` header; Bale by a long unpredictable path +
  POST-only.
- Chat allowlist rejects any unconfigured chat.
- Admin API/commands require the admin bearer token / allowlisted user IDs.
- User text is escaped before being embedded in Markdown to prevent formatting
  injection, broken links, or unintended mentions.

## Known limitations

- **Media albums** are transferred item-by-item (each linked by media-group ID)
  rather than aggregated into a single `sendMediaGroup` call — true
  cross-request album buffering would require a Durable Object or queue.
- Cross-platform media compatibility, codecs, and size limits vary; fallbacks
  ensure text + source link are always delivered.
- Messages are sent by the bots, so they display the original user's name and
  platform but cannot post as that user's real account.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run dev         # wrangler dev (needs .dev.vars)
npm run tail        # stream production logs
```

## License

MIT
