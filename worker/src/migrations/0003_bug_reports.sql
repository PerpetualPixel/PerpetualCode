-- Bug reports / suggestions submitted via the app's "Report a Bug" panel.
-- id doubles as the ticket number shown to the reporter and used in the
-- notification email's subject line — SQLite's own AUTOINCREMENT rowid is
-- already a stable, sequential, unique number, no separate scheme needed.
CREATE TABLE IF NOT EXISTS bug_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  username TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'bug',
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bug_reports_user ON bug_reports(user_id);
