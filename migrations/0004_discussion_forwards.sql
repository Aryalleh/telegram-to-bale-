-- Store the discussion-group auto-forward message id of each channel post, so
-- mirrored comments can be threaded under the corresponding post on the other
-- platform (Telegram/Bale comments are replies to the auto-forwarded post).
ALTER TABLE message_mappings ADD COLUMN telegram_discussion_message_id TEXT;
ALTER TABLE message_mappings ADD COLUMN bale_discussion_message_id TEXT;

CREATE INDEX IF NOT EXISTS idx_mappings_tg_disc_msg
  ON message_mappings (telegram_discussion_message_id);
CREATE INDEX IF NOT EXISTS idx_mappings_bale_disc_msg
  ON message_mappings (bale_discussion_message_id);
