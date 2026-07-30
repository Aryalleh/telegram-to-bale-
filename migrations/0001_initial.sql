-- Telegram <-> Bale synchronization schema (SQLite / Cloudflare D1).

-- Configured platform connections (channel + linked discussion group pairs).
CREATE TABLE IF NOT EXISTS channel_connections (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_channel_id       TEXT,
  telegram_channel_username TEXT,
  telegram_discussion_id    TEXT,
  bale_channel_id           TEXT,
  bale_channel_username     TEXT,
  bale_discussion_id        TEXT,
  is_enabled                INTEGER NOT NULL DEFAULT 1,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The permanent relationship between a Telegram message and its Bale twin.
CREATE TABLE IF NOT EXISTS message_mappings (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id         INTEGER,
  message_type          TEXT NOT NULL,          -- channel_post | channel_album_item | comment | reply | media_fallback | system_notice
  source_platform       TEXT NOT NULL,          -- telegram_user | telegram_bot_mirror | bale_user | bale_bot_mirror

  telegram_chat_id      TEXT,
  telegram_message_id   TEXT,
  telegram_thread_id    TEXT,
  telegram_media_group_id TEXT,

  bale_chat_id          TEXT,
  bale_message_id       TEXT,
  bale_media_group_id   TEXT,

  parent_mapping_id     INTEGER,
  content_hash          TEXT,
  status                TEXT NOT NULL DEFAULT 'active', -- active | manually_deleted | missing_telegram | missing_bale | outdated
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (connection_id) REFERENCES channel_connections(id),
  FOREIGN KEY (parent_mapping_id) REFERENCES message_mappings(id)
);

-- Idempotency guard: every processed webhook update is recorded once.
CREATE TABLE IF NOT EXISTS processed_updates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  platform      TEXT NOT NULL,      -- telegram | bale
  update_id     TEXT NOT NULL,
  received_at   TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at  TEXT,
  status        TEXT NOT NULL DEFAULT 'received' -- received | processed | failed | skipped
);

-- Retryable operations (send/edit calls that failed transiently).
CREATE TABLE IF NOT EXISTS sync_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  operation       TEXT NOT NULL,
  payload         TEXT NOT NULL,          -- JSON
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error      TEXT,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | in_progress | done | failed | dead
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Operational error log.
CREATE TABLE IF NOT EXISTS sync_errors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  platform        TEXT,
  operation       TEXT,
  chat_id         TEXT,
  message_id      TEXT,
  error_code      TEXT,
  error_message   TEXT,
  payload_summary TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT
);

-- Configurable behavior (key/value).
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
