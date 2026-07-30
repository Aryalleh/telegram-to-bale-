-- Indexes and uniqueness constraints for fast lookups and duplicate prevention.

-- A given platform update is processed at most once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_processed_updates_unique
  ON processed_updates (platform, update_id);

-- Fast reverse lookups when editing/replying: find the twin by either side.
CREATE INDEX IF NOT EXISTS idx_mappings_telegram
  ON message_mappings (telegram_chat_id, telegram_message_id);
CREATE INDEX IF NOT EXISTS idx_mappings_bale
  ON message_mappings (bale_chat_id, bale_message_id);

-- Prevent two mappings from claiming the same Telegram message.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mappings_telegram_unique
  ON message_mappings (telegram_chat_id, telegram_message_id)
  WHERE telegram_message_id IS NOT NULL;

-- Prevent two mappings from claiming the same Bale message.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mappings_bale_unique
  ON message_mappings (bale_chat_id, bale_message_id)
  WHERE bale_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mappings_media_group
  ON message_mappings (telegram_media_group_id, bale_media_group_id);

CREATE INDEX IF NOT EXISTS idx_mappings_parent
  ON message_mappings (parent_mapping_id);

-- Job queue scan order.
CREATE INDEX IF NOT EXISTS idx_jobs_due
  ON sync_jobs (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_errors_created
  ON sync_errors (created_at);
