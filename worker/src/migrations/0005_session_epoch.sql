-- Session revocation support: every JWT is issued carrying the account's
-- current session_epoch, and authenticateRequest() (auth-handlers.js)
-- rejects any token whose epoch no longer matches. Bumping the number
-- instantly invalidates every outstanding token for that account —
-- "sign out everywhere", plus automatic session kill on password
-- change/reset. Default 0 matches the implicit epoch of tokens issued
-- before this column existed, so nobody gets logged out by the migration
-- itself.
ALTER TABLE users ADD COLUMN session_epoch INTEGER DEFAULT 0;
