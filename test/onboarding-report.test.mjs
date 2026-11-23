import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountHealth, sendDailyOnboardingReport } from '../worker/src/onboarding-report.js';

/** A stand-in for the database: each query is answered by the first rule whose text it contains. */
const db = (rules, seen = []) => ({ prepare: (sql) => ({ bind: (...args) => ({
  first: async () => { seen.push({ sql, args }); const hit = rules.find(([needle]) => sql.includes(needle)); if (hit?.[1] instanceof Error) throw hit[1]; return hit ? hit[1] : {}; },
  all: async () => ({ results: [] }),
}) }) });
const quiet = [
  ['FROM users)) GROUP BY k', { mailboxes: 0, accounts: 0, most: 0 }],
  ['strftime', { most: 2 }],
  ['SUM(email_verified = 1)', { total: 120, verified: 100, stale: 8 }],
  ['GROUP BY message', { texts: 0 }],
  ['GROUP BY user_id)', { most: 1 }],
  ['FROM bug_reports', { total: 3, links: 0 }],
];

test('accountHealth counts the accounts and flags nothing on a quiet week', async () => {
  const seen = [];
  const h = await accountHealth({ DB: db(quiet, seen) }, Date.parse('2026-11-23T20:00:00Z'));
  assert.deepEqual(h.flags, []);
  assert.deepEqual([h.counts.accounts, h.counts.verified, h.counts.unverifiedOverAWeek, h.counts.busiestSignupHour, h.counts.reportsThisWeek], [120, 100, 8, 2, 3]);
  // Counts only: no query selects a name, an address or an id as a column of its own.
  for (const q of seen) assert.ok(!/SELECT\s+(username|email|id|user_id)\b/i.test(q.sql), q.sql.slice(0, 80));
  // The week is the last seven days.
  assert.equal(seen.find((q) => q.sql.includes('FROM bug_reports WHERE created_at >= ?')).args[0], Date.parse('2026-11-16T20:00:00Z'));
});

test('accountHealth says what stands out: one mailbox behind several accounts, a signup burst, the limit got round, report spam', async () => {
  const loud = [
    ['FROM users)) GROUP BY k', { mailboxes: 2, accounts: 7, most: 5 }],
    ['strftime', { most: 9 }],
    ['SUM(email_verified = 1)', { total: 100, verified: 60, stale: 30 }],
    ['GROUP BY message', { texts: 1 }],
    ['GROUP BY user_id)', { most: 12 }],
    ['FROM bug_reports', { total: 20, links: 3 }],
  ];
  const h = await accountHealth({ DB: db(loud) });
  assert.equal(h.flags.length, 6);
  assert.match(h.flags[0], /2 mailboxes are behind 7 accounts \(the most on one: 5\)/);
  assert.ok(h.flags.some((f) => /9 signups landed in one hour/.test(f)));
  assert.ok(h.flags.some((f) => /30 of 100 accounts are over a week old and never verified/.test(f)));
  assert.ok(h.flags.some((f) => /One account sent 12 reports/.test(f)));
  assert.ok(h.flags.some((f) => /3 reports this week carried a link/.test(f)));
  assert.ok(h.flags.every((f) => !f.includes('@')), 'no address in any flag');
});

test('the owner digest carries account health, says so in its subject when something stands out, and still sends when the tables cannot be read', async () => {
  const send = async (rules) => { const sent = []; await sendDailyOnboardingReport({ DB: db(rules), EMAIL: { send: async (m) => { sent.push(m); } } }, Date.parse('2026-11-23T20:00:00Z')); return sent[0]; };
  const calm = await send(quiet);
  assert.match(calm.text, /Account health\nAccounts: 120 \(100 verified\)\nNever verified, over a week old: 8\nMost signups in one hour this week: 2\nReports this week: 3\nNothing stands out\./);
  assert.match(calm.html, /Nothing stands out: no shared mailboxes/);
  assert.ok(!/to look at/.test(calm.subject));
  const flagged = await send([['FROM users)) GROUP BY k', { mailboxes: 1, accounts: 3, most: 3 }], ...quiet]);
  assert.match(flagged.subject, /· 1 to look at$/);
  assert.match(flagged.text, /! 1 mailbox is behind 3 accounts/);
  const broken = await send([['SUM(email_verified = 1)', new Error('no such table')]]);
  assert.ok(broken && !/Account health/.test(broken.text), 'the digest goes without the block');
});
