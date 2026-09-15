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
