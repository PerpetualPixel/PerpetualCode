-- Forgot-password support — same token/expiry shape as the existing
-- email-verification and pending-email-change flows.
ALTER TABLE users ADD COLUMN password_reset_token TEXT;
ALTER TABLE users ADD COLUMN password_reset_token_expires INTEGER;

CREATE INDEX IF NOT EXISTS idx_users_password_reset_token ON users(password_reset_token);
