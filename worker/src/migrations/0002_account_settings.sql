-- Username, notification preferences, and pending-email-change support.
-- username is nullable at the DB level (SQLite's UNIQUE allows multiple
-- NULLs) so existing accounts created before this migration aren't broken;
-- new registrations require one at the API layer, and an existing account
-- without one is prompted to set it from Settings.
ALTER TABLE users ADD COLUMN username TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- Two signup checkboxes collapse into these four columns: "email me" sets
-- both notify_potd_email and notify_picks_email together at signup, then
-- Settings lets a user split them apart. The _sms columns are stored now so
-- a later migration isn't needed once real SMS sending ships, but are never
-- set to 1 today — the signup checkbox for SMS is disabled/"coming soon".
ALTER TABLE users ADD COLUMN notify_potd_email INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN notify_picks_email INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN notify_potd_sms INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN notify_picks_sms INTEGER DEFAULT 0;

-- Off by default, per the Settings page's tracking-report toggle.
ALTER TABLE users ADD COLUMN notify_tracking_report_email INTEGER DEFAULT 0;

-- Changing email requires re-verifying the NEW address before it takes
-- effect (same token/expiry shape as the original signup verification) —
-- the live `email` column is untouched until pending_email_token is
-- confirmed, so a typo or a stolen session can't silently redirect the
-- account to an address the real owner doesn't control.
ALTER TABLE users ADD COLUMN pending_email TEXT;
ALTER TABLE users ADD COLUMN pending_email_token TEXT;
ALTER TABLE users ADD COLUMN pending_email_token_expires INTEGER;
