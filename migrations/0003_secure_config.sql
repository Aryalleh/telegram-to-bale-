-- Encrypted secrets entered from the admin dashboard (AES-GCM at rest).
-- Values are ciphertext; the key is derived from ADMIN_API_SECRET.
CREATE TABLE IF NOT EXISTS secure_config (
  key             TEXT PRIMARY KEY,   -- e.g. TELEGRAM_BOT_TOKEN
  value_encrypted TEXT NOT NULL,      -- base64(iv || ciphertext)
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
