# Tracked record snapshots

Written by `.github/workflows/tracking-export.yml`, once a day and on demand:
one JSON file per public history route of the worker (`top5-history`,
`potd-history`, `full-slate-history`, `ladder-history`, `prop-play-history`,
the four prop pools, `learning`, `algo-health`, `stale-picks`) plus today's
live boards, and the football engine's own ledgers from its live site.

These are read-only copies of what the dashboard shows — the worker's KV is
the source of truth, and the app never reads these files. They exist so the
record can be studied, diffed and audited from anywhere that can reach
GitHub. Each file is the route's response verbatim.

## Eras

The dashboard splits the record at a reset date (`TRACKING_EPOCH` in
`docs/app.js`): the live record runs from that date, and everything before
it is the archive behind the dashboard's Archive toggle. The current reset is
**2026-10-20** — the day the boards narrowed to NFL, NHL, NBA and MMA, moved
to two-leg tickets of low-level lines ranked locks first, a Play of the Day
every day, and NBA and NHL props from opening week. Earlier resets:
2026-09-25, 2026-09-01, 2026-08-21. The snapshots here carry every era; the
`dateKey` on each record says which side of the line it falls on.
