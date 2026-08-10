import {
  handleRegister,
  handleVerifyEmail,
  handleLogin,
  handleMe,
  handleForgotPassword,
  handleResetPassword,
  authenticateRequest,
} from './auth-handlers.js';
import {
  handleUpdateUsername,
  handleUpdatePassword,
  handleRequestEmailChange,
  handleConfirmEmailChange,
  handleUpdateNotifications,
  handleDeleteAccount,
  handleLogoutAll,
} from './account-handlers.js';
import {
  sendPotdNotifications,
  sendPicksNotifications,
  getNotifiedTop5PickIds,
  markTop5PickIdsNotified,
} from './notifications.js';
import { sendWeeklyTrackingReport } from './weekly-report.js';
import { sendDailyOnboardingReport } from './onboarding-report.js';
import { handleReportBug } from './bug-reports.js';
import { QuotaManager } from './quota.js';
import { fetchContext, hasContext } from './context.js';
import { fetchWeather, hasVenue } from './weather.js';
import { fetchMmaContext } from './mma.js';
import {
  fetchTeamStats,
  fetchRecentSchedule,
  fetchLeagueStats,
  refreshMlbLeagueStats,
  fetchSituationalSplits,
  rankTeamStats,
  fetchHeadToHead,
  fetchStartingPitchers,
  fetchPitcherOutings,
} from './mlb-stats.js';
import { runMlbPropsScan, runMlbPropsGrading, getAllMlbPropsTracked } from './mlb-props.js';
import { runNflPropsScan, runNflPropsGrading, getAllNflPropsTracked } from './nfl-props.js';
import { runWnbaPropsScan, runWnbaPropsGrading, getAllWnbaPropsTracked } from './wnba-props.js';
import { runNhlPropsScan, runNhlPropsGrading, getAllNhlPropsTracked } from './nhl-props.js';
import { runPotdDaily, runPotdClvSnapshot, runPotdGrading, backfillPotdAnalysis, getPotd, getPotdLeaning, getPotdHistory } from './potd.js';
import { getOrGenerateAnalysis } from './analysis.js';
import {
  UPSTREAM,
  REGIONS,
  DEFAULT_CACHE_SECONDS,
  isAllowedSport,
  ALLOWED_SPORTS,
  fetchSport,
  fetchScores,
  fetchCatalogue,
} from './odds.js';
import {
  runTop5Batch,
  runClvSnapshot,
  runGrading,
  getTop5,
  getTop5Leaning,
  getAllTrackedPicks,
  fetchFullSlateEvents,
  TOP5_COUNT,
} from './tracking.js';
import { authorize as authorizeSettings, getSettings, putSettings } from './settings.js';
import {
  runAlgoHealthReview,
  getAlgoConfig,
  getPausedSegments,
  getHealthLog,
  resumeSegmentNow,
  resetAlgoConfigToDefaults,
  defaultAlgoConfig,
  TUNABLE_BOUNDS,
  HEALTH_WINDOW_DAYS,
} from './algo-health.js';
import {
  runFullSlateBatch,
  runFullSlateClvSnapshot,
  runFullSlateGrading,
  getAllFullSlateTracked,
} from './full-slate-tracking.js';
import {
  runDailyLearning,
  getLearningProfile,
  getLearningLog,
  LEARN_WINDOW_DAYS,
} from './daily-learning.js';

// Each sport is a separate billed call: 3 markets x 1 region = 3 credits apiece.
// Three is the ceiling the app's league picker enforces, repeated here because
// the browser is not where a spend limit belongs.
const MAX_SPORTS_PER_REQUEST = 3;
const FREE_TIER_DAILY_LIMIT = 3;

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get('Origin') ?? '';
  const allow = allowed.includes(origin) ? origin : allowed[0] ?? '';

  return {
    'Access-Control-Allow-Origin': allow,
    // PUT and X-Owner-Key are for /settings (worker/src/settings.js) — a
    // browser preflights both, so omitting either blocks the request before
    // it ever reaches the route.
    // DELETE is for /api/account (self-service account deletion) — a
    // browser preflights it, so omitting it here blocks the request before
    // it ever reaches the route, same reasoning as PUT below.
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Owner-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function handleScores(request, env, ctx, cors) {
  const { searchParams } = new URL(request.url);
  const requested = (searchParams.get('sports') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(isAllowedSport);

  if (!requested.length) {
    return json({ error: 'No valid sports requested.' }, { status: 400, headers: cors });
  }

  const sports = [...new Set(requested)];
  const results = await Promise.all(sports.map((s) => fetchScores(s, env, ctx)));

  const events = [];
  const errors = [];
  for (const result of results) {
    if (result.error) {
      errors.push(result.error);
      continue;
    }
    events.push(...result.events);
  }

  if (!events.length && errors.length) {
    return json({ error: 'Upstream scores request failed', errors }, { status: 502, headers: cors });
  }

  return json(
    { events, sports, errors },
    { headers: { ...cors, 'Cache-Control': 'public, max-age=300' } },
  );
}

/**
 * A tennis event's alternate_spreads market — a wider ladder of game-margin
 * handicaps than the featured 'spreads' market carries, not a sets-won
 * market. (There isn't one: The Odds API's own docs describe
 * alternate_spreads as "all available point spread outcomes" — the same
 * game-margin axis, just denser — and a live match's ladder ran to ±9.5,
 * which is impossible as a sets margin in any tennis format, best-of-3 or
 * best-of-5.)
 *
 * The Odds API doesn't carry this on the featured board endpoint at all
 * (confirmed by direct probe: /odds only ever returns h2h, spreads, totals
 * for tennis). It only shows up on the per-event endpoint, which is billed
 * per event (1 credit/market/region here) rather than per league — which is
 * why this is its own route, called lazily and only for a bounded few
 * matches already on the board, not folded into fetchSport's per-league pull.
 */
async function fetchTennisAltSpread(sportKey, eventId, env, ctx) {
  const ttl = 3600; // an alternate-spread price doesn't need per-tap freshness
  const cacheKey = new Request(
    `https://pixel-pick.cache/altspread/${sportKey}/${eventId}`,
  );
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) return { event: await cached.json(), cached: true };

  const url = new URL(`${UPSTREAM}/sports/${sportKey}/events/${eventId}/odds`);
  url.searchParams.set('apiKey', (env.ODDS_API_KEY ?? '').trim());
  url.searchParams.set('regions', REGIONS);
  url.searchParams.set('markets', 'alternate_spreads');
  url.searchParams.set('oddsFormat', 'american');
  url.searchParams.set('dateFormat', 'iso');

  const upstream = await fetch(url.toString());
  if (!upstream.ok) return { event: null, cached: false };

  const event = await upstream.json();
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(event), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
      }),
    ),
  );
  return { event, cached: false };
}


/** Sign-in is only enforced once REQUIRE_AUTH is switched on in wrangler.toml. */
const authRequired = (env) => String(env.REQUIRE_AUTH ?? '') === 'true';

async function handleOdds(request, env, ctx) {
  const cors = corsHeaders(request, env);

  if (!authRequired(env)) {
    return respondWithOdds(request, env, ctx, cors, null);
  }

  const payload = await authenticateRequest(request, env);

  if (!payload) {
    return json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  // Check quota via Durable Object
  const quotaId = env.QUOTA_MANAGER.idFromName(payload.userId);
  const quotaObj = env.QUOTA_MANAGER.get(quotaId);

  const checkRes = await quotaObj.fetch(
    new Request('http://quota/check', {
      method: 'POST',
      body: JSON.stringify({ userId: payload.userId, limit: FREE_TIER_DAILY_LIMIT }),
    }),
  );
  const quotaStatus = await checkRes.json();

  if (!quotaStatus.allowed) {
    return json(
      { error: 'Daily quota exceeded', remaining: 0, used: quotaStatus.used },
      { status: 429, headers: cors },
    );
  }

  // Increment usage
  await quotaObj.fetch(
    new Request('http://quota/increment', {
      method: 'POST',
      body: JSON.stringify({ userId: payload.userId }),
    }),
  );

  return respondWithOdds(request, env, ctx, cors, quotaStatus);
}

/** The actual odds fan-out, shared by the authed and open paths. */
async function respondWithOdds(request, env, ctx, cors, quotaStatus) {
  const { searchParams } = new URL(request.url);
  const requested = (searchParams.get('sports') ?? 'upcoming')
    .split(',')
    .map((s) => s.trim())
    .filter(isAllowedSport);

  if (!requested.length) {
    return json(
      { error: 'No valid sports requested.', allowed: [...ALLOWED_SPORTS] },
      { status: 400, headers: cors },
    );
  }

  const sports = [...new Set(requested)].slice(0, MAX_SPORTS_PER_REQUEST);
  const results = await Promise.all(sports.map((s) => fetchSport(s, env, ctx)));

  const events = [];
  const errors = [];
  let quota = null;
  let allCached = true;

  for (const result of results) {
    if (result.error) {
      errors.push(result.error);
      continue;
    }
    events.push(...result.events);
    if (!result.cached) allCached = false;
    if (result.quota?.remaining != null) quota = result.quota;
  }

  if (!events.length && errors.length) {
    return json({ error: 'Upstream odds request failed', errors }, { status: 502, headers: cors });
  }

  return json(
    {
      events,
      sports,
      cached: allCached,
      quota,
      errors,
      fetchedAt: new Date().toISOString(),
      ...(quotaStatus
        ? { remaining: quotaStatus.remaining - 1, used: quotaStatus.used + 1 }
        : {}),
    },
    {
      headers: {
        ...cors,
        'Cache-Control': `public, max-age=${env.CACHE_SECONDS ?? DEFAULT_CACHE_SECONDS}`,
      },
    },
  );
}

/**
 * The catalogue of leagues the app may request. The Odds API bills nothing for
 * this endpoint, so the picker can be populated on page load without touching
 * the credit budget — and it stays correct as tournaments come and go.
 */
async function handleSports(env, ctx, cors) {
  const { sports, cached, error } = await fetchCatalogue(env, ctx);
  if (error) {
    return json(
      { error: 'Could not load the sports catalogue', status: error.status },
      { status: 502, headers: cors },
    );
  }
  return json({ sports, cached: Boolean(cached) }, { headers: cors });
}

export { QuotaManager };

const MORNING_PREWARM_HOUR = 4; // 4am ET
const MLB_LEAGUE_STATS_HOUR = 3; // 3am ET
const ALGO_HEALTH_HOUR = 7; // Monday 7am ET
const ALGO_HEALTH_WEEKDAY = 1; // Monday (0=Sunday per Intl's 'short' weekday index below)
const ADMIN_REPORT_HOUR = 20; // 8pm ET daily — owner-only onboarding digest
// How close to its own commence time an already-locked, not-yet-emailed
// Pixel's Picks slot can get before waiting any longer for the rest of the
// board risks missing the 1-hour notice floor — see the scheduled()
// notification block's own comment and tracking.js's PICK_LEAD_HOURS for
// why this specific value pairs with those lead times.
const NOTIFY_URGENCY_HOURS = 2;

/** ET wall-clock hour for a given instant — same self-correcting-across-DST
 * approach as potd.js's own etParts, kept local since this is the only other
 * place in the worker that needs an ET hour rather than a UTC one. */
function etHour(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
  return Number(fmt.format(ms)) % 24;
}

/** ET calendar weekday for a given instant, 0=Sunday..6=Saturday — same
 * DST-safe Intl approach as etHour, just for the weekly algorithm health
 * review's Monday gate rather than an hourly one. */
function etWeekday(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days.indexOf(fmt.format(ms));
}

/**
 * True only on the first of the three ticks now landing within any given
 * hour (the cron fires every 20 minutes — see wrangler.toml). ET's offset
 * from UTC is always a whole number of hours (never a fractional-hour
 * shift), so the UTC minute of "top of the ET hour" is always :00 regardless
 * of DST — no ET-specific minute lookup needed, just the UTC minute.
 *
 * Every once-per-day/week gated block below (2am/3am/4am ET, Monday 7am ET)
 * needs this in addition to its own etHour/etWeekday check: those blocks'
 * own idempotency (a manifest/KV key already written today) only guards the
 * WORK each batch does, not the fetch that feeds it — runTop5Batch and
 * friends all share one fetchFullSlateEvents() call made unconditionally
 * before any of them run, and that fetch alone reaches every sport at real
 * Odds-API cost. Without this gate, three ticks in the target hour would
 * mean three full-slate fetches a day instead of one, even though the
 * batches themselves would still only ever generate picks once.
 */
function isTopOfHour(ms) {
  return new Date(ms).getUTCMinutes() === 0;
}

export default {
  /**
   * Fires every 20 minutes (see wrangler.toml's [triggers]) — most ticks are
   * a no-op for the once-daily/once-weekly gated tasks below. etHour/
   * etWeekday check the actual ET wall-clock, so every gated task self-
   * corrects across DST without a UTC cron needing hand-maintenance twice a
   * year, and still only fires once per matching hour even though the cron
   * itself ticks 3x within that hour.
   */
  async scheduled(event, env, ctx) {
    const now = event.scheduledTime ?? Date.now();

    // 4am ET: pre-warm the 'upcoming' board (the same "next games across
    // every sport" pull the Full Slate/Pixel Picks tabs make on their own
    // first tap) so it's already cached before anyone's awake, rather than
    // the very first user of the day paying for a cold fetch. This is a
    // cache warm, not a bigger pull than normal — it fetches exactly what
    // 'upcoming' already means, once, and normal on-demand 15-minute
    // caching carries the rest of the day exactly as it does today.
    if (etHour(now) === MORNING_PREWARM_HOUR && isTopOfHour(now)) {
      ctx.waitUntil(fetchSport('upcoming', env, ctx));
    }

    // Every tick: MLB starting-pitcher props (Outs Recorded, Strikeouts).
    // Not gated to one fixed hour — see worker/src/mlb-props.js's own header
    // for why: sportsbooks don't reliably post pitcher-prop boards long
    // before game time, so each game is scanned once it falls within a few
    // hours of its own first pitch, whichever tick first notices. Cheap on
    // every other tick — one cached KV read for the day's game list, no
    // fetch, when nothing is currently in-window.
    ctx.waitUntil(runMlbPropsScan(env, ctx, now, { fetchFullSlate: () => fetchFullSlateEvents(env, ctx) }));
    ctx.waitUntil(runMlbPropsGrading(env, ctx, now));

    // Every tick: NFL starting-QB props (Pass Completions, Pass Attempts) —
    // same per-game dynamic window as MLB props, see worker/src/nfl-props.js.
    ctx.waitUntil(runNflPropsScan(env, ctx, now, { fetchFullSlate: () => fetchFullSlateEvents(env, ctx) }));
    ctx.waitUntil(runNflPropsGrading(env, ctx, now));

    // Every tick: WNBA player props (PRA, Rebounds+Assists) — same per-game
    // dynamic window, see worker/src/wnba-props.js.
    ctx.waitUntil(runWnbaPropsScan(env, ctx, now, { fetchFullSlate: () => fetchFullSlateEvents(env, ctx) }));
    ctx.waitUntil(runWnbaPropsGrading(env, ctx, now));

    // Every tick: NHL player props (Shots on Goal) — same per-game dynamic
    // window, see worker/src/nhl-props.js.
    ctx.waitUntil(runNhlPropsScan(env, ctx, now, { fetchFullSlate: () => fetchFullSlateEvents(env, ctx) }));
    ctx.waitUntil(runNhlPropsGrading(env, ctx, now));

    // 3am ET: refresh the league-wide MLB batting/pitching snapshot "View
    // Stats" ranks every team against. Has to run standalone, with nothing
    // else in the same invocation — fetching all 30 teams alongside a live
    // request's own schedule/situational calls blew Cloudflare's per-
    // invocation subrequest cap (confirmed live). The result is one KV blob;
    // a live /mlb-stats request only ever reads it, never re-fetches it.
    if (etHour(now) === MLB_LEAGUE_STATS_HOUR && isTopOfHour(now)) {
      ctx.waitUntil(refreshMlbLeagueStats(env, ctx));
    }

    // Hourly, all day — not a single 2am batch anymore. Pixel's Picks, Full
    // Slate tracking, and Play of the Day each lock games in on their own
    // per-game timeline now (see tracking.js's isPickWindowOpen/
    // PICK_LEAD_HOURS): a game's pick locks once IT is close enough to its
    // own start, not the whole day's board at once. Checking hourly (rather
    // than every 20-minute tick) is a deliberate cost tradeoff — the real
    // full-slate fetch below is genuine Odds-API spend, and lead times are
    // measured in hours, so hourly precision loses nothing that matters
    // (a lock lands within an hour of its ideal moment either way).
    //
    // All three still share one full-slate fetch per tick (fetched once,
    // handed to each batch's own injectable fetchFullSlate parameter) for
    // the same reason as before: three independent fetch cycles would be
    // three real Odds-API charges and the same race-prone subrequest-
    // stampede risk the MMA schedule bug once had, for the same data. Each
    // batch is itself idempotent/self-healing (checks its own manifest/pool
    // state), so a retried or overlapping tick can't double-generate or
    // double-lock anything.
    if (isTopOfHour(now)) {
      const sharedSlate = fetchFullSlateEvents(env, ctx);
      const fetchFullSlate = () => sharedSlate;
      // Learn first, then pick: the daily learning review (worker/src/
      // daily-learning.js) digests yesterday's graded results into today's
      // reliability weights, and MUST finish before the selection batches
      // read the profile — otherwise today's picks would be chosen under
      // yesterday's lessons. The Full Slate batch is deliberately inside
      // the same chain but never reads the profile: it records the raw,
      // unadjusted engine so tomorrow's learning stays unbiased. Learning
      // failures fall through to the batches (catch → null) rather than
      // costing the day's picks; runDailyLearning is idempotent per ET
      // date, so calling it every hourly tick (not just the first one)
      // can't double-learn — it's cheap to no-op once today's review exists.
      ctx.waitUntil(
        (async () => {
          await runDailyLearning(env, ctx, now, {
            getPicks: async () => {
              // Props are a real selection surface (graded by genuine edges,
              // like Pixel's Picks/Play of the Day), not a raw-evidence
              // tracker like Full Slate — so, like those two, they both feed
              // this review AND have their own runXPropsScan read its
              // weights back.
              const [top5, slate, mlbProps, nflProps, wnbaProps, nhlProps] = await Promise.all([
                getAllTrackedPicks(env, { now, days: LEARN_WINDOW_DAYS }),
                getAllFullSlateTracked(env, { now, days: LEARN_WINDOW_DAYS }),
                getAllMlbPropsTracked(env, { now, days: LEARN_WINDOW_DAYS }),
                getAllNflPropsTracked(env, { now, days: LEARN_WINDOW_DAYS }),
                getAllWnbaPropsTracked(env, { now, days: LEARN_WINDOW_DAYS }),
                getAllNhlPropsTracked(env, { now, days: LEARN_WINDOW_DAYS }),
              ]);
              return [...top5, ...slate, ...mlbProps, ...nflProps, ...wnbaProps, ...nhlProps];
            },
          }).catch(() => null);

          // Top5's own "did it just become complete this tick" is the
          // clean first-time signal for the ideal, single "board's
          // complete" email — compare the count before and after this
          // tick's batch call, since runTop5Batch's "skipped" isn't that
          // signal (it validly no-ops on every tick once full, not just
          // the first).
          const top5Before = await getTop5(env, { now });
          const wasComplete = top5Before.length >= TOP5_COUNT;

          const [, , potdResult] = await Promise.all([
            runTop5Batch(env, ctx, now, { fetchFullSlate }),
            runFullSlateBatch(env, ctx, now, { fetchFullSlate }),
            runPotdDaily(env, ctx, now, { fetchFullSlate }),
          ]);

          // Notify whoever opted in (see worker/src/account-handlers.js's
          // handleUpdateNotifications). Best-effort: notifications.js
          // swallows individual send failures itself, and this whole step
          // is wrapped so a D1 hiccup here can never cost the day's picks.
          //
          // Ideally this is exactly two emails a day total: one Play of
          // the Day, one Pixel's Picks once all 5 lock together. But since
          // each of the 5 slots now locks on its own per-game timeline
          // (tracking.js's PICK_LEAD_HOURS) rather than all at once, an
          // early slot's game can start well before a later slot's window
          // even opens — waiting for the full board in that case would
          // mean whoever opted in never hears about a pick before it's too
          // late to act on. NOTIFY_URGENCY_HOURS is the release valve: any
          // already-locked, not-yet-emailed pick within that window of its
          // own commence time goes out immediately in its own smaller
          // email instead of waiting on the rest of the board — sized
          // (2h) together with PICK_LEAD_HOURS so that in the worst case
          // (a lock landing as late as the hourly check cadence allows)
          // there's still at least an hour of notice, and in the common
          // case (most locks land promptly after their window opens)
          // there's enough runway left to bundle into the one ideal email
          // instead.
          const top5Picks = await getTop5(env, { now });
          const isNowComplete = top5Picks.length >= TOP5_COUNT;
          try {
            const sends = [];
            if (potdResult?.skipped === false) sends.push(sendPotdNotifications(env, await getPotd(env, now)));

            if (!wasComplete && isNowComplete) {
              sends.push(sendPicksNotifications(env, top5Picks, { isFinal: true }));
              ctx.waitUntil(markTop5PickIdsNotified(env, now, top5Picks.map((p) => p.pickId)));
            } else if (!isNowComplete) {
              const notified = await getNotifiedTop5PickIds(env, now);
              const urgent = top5Picks.filter(
                (p) => !notified.has(p.pickId) && p.commenceMs - now <= NOTIFY_URGENCY_HOURS * 3600000,
              );
              if (urgent.length) {
                sends.push(sendPicksNotifications(env, urgent, { isFinal: false }));
                ctx.waitUntil(markTop5PickIdsNotified(env, now, urgent.map((p) => p.pickId)));
              }
            }

            await Promise.all(sends);
          } catch (e) {
            console.error('Notification send failed:', e);
          }

          // Warm each currently-locked Pixel's Picks write-up, so a newly-
          // locked slot's analysis is ready the moment anyone opens the
          // board rather than the first visitor paying a model call's
          // latency. Already-warmed picks are a cheap cache-hit KV read
          // (getOrGenerateAnalysis's own cache), so calling this for all 5
          // every hourly tick — not just newly-locked ones — costs almost
          // nothing once the board's been stable for a while. Play of the
          // Day already generates its own inside runPotdDaily.
          //
          // Sequential rather than parallel — this invocation has already
          // spent a full-slate fetch, and a burst of model calls alongside
          // it is exactly the per-invocation subrequest pressure that has
          // bitten this cron before. Failures are swallowed per pick: an
          // unwarmed analysis just falls back to the existing on-demand
          // /analysis path, so this is strictly a latency optimization and
          // can never cost the day's picks.
          try {
            for (const pick of top5Picks) {
              await getOrGenerateAnalysis(
                {
                  eventId: pick.eventId,
                  sportKey: pick.sportKey,
                  sportTitle: '',
                  home: pick.home,
                  away: pick.away,
                  // Must match the /analysis route's own candidate exactly —
                  // eventId + outcomeName are the analysis cache key, so a
                  // mismatch here would warm a key no client ever reads.
                  outcomeName: pick.outcomeName,
                },
                env,
                ctx,
                now,
              ).catch(() => null);
            }
          } catch {
            /* prewarm is best-effort; the on-demand path still covers it */
          }
        })(),
      );
    }

    // Every tick (now every 20 min, not gated to the top of the hour): refresh
    // the closing-line snapshot for whatever's still pending and not yet
    // underway, and grade whatever now has a completed score. This is the
    // one block that's meant to benefit from the faster cron — a pick gets
    // graded within 20 minutes of its game ending instead of sitting
    // "pending" for up to an hour. Safe to run every tick for all three
    // trackers — CLV only touches games that haven't started, grading only
    // touches picks still pending — so there's no "already ran today" gate
    // needed the way the 2am batch has.
    ctx.waitUntil(runClvSnapshot(env, ctx, now));
    ctx.waitUntil(runGrading(env, ctx, now));
    ctx.waitUntil(runPotdClvSnapshot(env, ctx, now));
    ctx.waitUntil(runPotdGrading(env, ctx, now));
    ctx.waitUntil(runFullSlateClvSnapshot(env, ctx, now));
    ctx.waitUntil(runFullSlateGrading(env, ctx, now));
    // Retries today's Play of the Day write-up if the 2am generation attempt
    // came back empty — see backfillPotdAnalysis's own comment for why that
    // one-shot attempt needs a way to recover. No-ops (one KV get) once a
    // write-up exists, so running it every tick costs nothing once it's done
    // its job for the day.
    ctx.waitUntil(backfillPotdAnalysis(env, ctx, now));

    // Monday 7am ET: the weekly algorithm health review (worker/src/
    // algo-health.js) — looks at the last HEALTH_WINDOW_DAYS of graded
    // Pixel's Picks history, auto-pauses a sport+bet-type segment that's
    // significantly underperforming its own no-vig expectation, auto-
    // resumes one that's recovered, and can tighten (never loosen below the
    // shipped default) one global EV/Kelly/score floor if overall
    // performance is weak. runAlgoHealthReview is itself idempotent per ISO
    // week, so a retried or overlapping tick can't double-act.
    if (etWeekday(now) === ALGO_HEALTH_WEEKDAY && etHour(now) === ALGO_HEALTH_HOUR && isTopOfHour(now)) {
      ctx.waitUntil(
        runAlgoHealthReview(env, ctx, now, {
          getPicks: () => getAllTrackedPicks(env, { now, days: HEALTH_WINDOW_DAYS }),
        }),
      );

      // Same Monday-morning slot for the optional weekly tracking-dashboard
      // email digest (off by default — see account-handlers.js's
      // notify_tracking_report_email toggle). Independent ctx.waitUntil, not
      // folded into runAlgoHealthReview above: a report-send failure
      // shouldn't affect the health review, and vice versa.
      ctx.waitUntil(
        sendWeeklyTrackingReport(env, now).catch((e) =>
          console.error('Weekly tracking report failed:', e),
        ),
      );
    }

    // 8pm ET daily: the owner-only new-signups digest (worker/src/
    // onboarding-report.js) — who onboarded today, plus running totals for
    // the week and month. Independent ctx.waitUntil, same as the weekly
    // report above, so a send failure here can never affect anything else.
    if (etHour(now) === ADMIN_REPORT_HOUR && isTopOfHour(now)) {
      ctx.waitUntil(
        sendDailyOnboardingReport(env, now).catch((e) =>
          console.error('Daily onboarding report failed:', e),
        ),
      );
    }
  },

  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const { pathname } = new URL(request.url);

    // Per-IP throttle (10/min) on every credential-adjacent endpoint:
    // login brute-forcing, reset-email spam toward a victim's inbox, and
    // scripted account creation all get cut off at the same gate.
    // Report-bug shares the mechanism under its own key prefix, so its
    // budget is independent. Backed by the QuotaManager Durable Object
    // (one instance per key via idFromName) rather than the platform's
    // [[ratelimits]] binding — see quota.js's handleRateLimit for why the
    // binding didn't actually work for this. Fails open if the DO call
    // errors — a rate-limiter outage should degrade to "no throttle,"
    // never to "nobody can log in."
    const rateLimited = async (key) => {
      try {
        const id = env.QUOTA_MANAGER.idFromName(`ratelimit:${key}`);
        const obj = env.QUOTA_MANAGER.get(id);
        const res = await obj.fetch(
          new Request('http://quota/ratelimit', {
            method: 'POST',
            body: JSON.stringify({ key, limit: 10 }),
          }),
        );
        const { allowed } = await res.json();
        return !allowed;
      } catch (e) {
        console.error('Rate limiter error (failing open):', e);
        return false;
      }
    };
    const AUTH_LIMITED_PATHS = new Set([
      '/api/auth/register',
      '/api/auth/login',
      '/api/auth/forgot-password',
      '/api/auth/reset-password',
      '/api/auth/verify-email',
    ]);
    if (request.method === 'POST' && (AUTH_LIMITED_PATHS.has(pathname) || pathname === '/api/report-bug')) {
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      const prefix = pathname === '/api/report-bug' ? 'bug' : 'auth';
      if (await rateLimited(`${prefix}:${ip}`)) {
        return json({ error: 'Too many attempts — try again in a minute.' }, { status: 429, headers: cors });
      }
    }

    if (pathname === '/api/auth/register' && request.method === 'POST') {
      const res = await handleRegister(request, env);
      return new Response(res.body, { status: res.status, headers: { ...cors, ...Object.fromEntries(res.headers) } });
    }

    if (pathname === '/api/auth/verify-email' && request.method === 'POST') {
      const res = await handleVerifyEmail(request, env);
      return new Response(res.body, { status: res.status, headers: { ...cors, ...Object.fromEntries(res.headers) } });
    }

    if (pathname === '/api/auth/login' && request.method === 'POST') {
      const res = await handleLogin(request, env);
      return new Response(res.body, { status: res.status, headers: { ...cors, ...Object.fromEntries(res.headers) } });
    }

    if (pathname === '/api/auth/forgot-password' && request.method === 'POST') {
      const res = await handleForgotPassword(request, env);
      return new Response(res.body, { status: res.status, headers: { ...cors, ...Object.fromEntries(res.headers) } });
    }

    if (pathname === '/api/auth/reset-password' && request.method === 'POST') {
      const res = await handleResetPassword(request, env);
      return new Response(res.body, { status: res.status, headers: { ...cors, ...Object.fromEntries(res.headers) } });
    }

    if (pathname === '/api/auth/me' && request.method === 'GET') {
      const res = await handleMe(request, env);
      return new Response(res.body, { status: res.status, headers: { ...cors, ...Object.fromEntries(res.headers) } });
    }

    if (pathname === '/api/account/username' && request.method === 'PUT') {
      const res = await handleUpdateUsername(request, env);
      return new Response(res.body, { status: res.status, headers: { ...cors, ...Object.fromEntries(res.headers) } });
    }

    if (pathname === '/api/account/password' && request.method === 'PUT') {
      const res = await handleUpdatePassword(request, env);
      return new Response(res.body, { status: res.status, headers: { ...cors, ...Object.fromEntries(res.headers) } });
    }

    if (pathname === '/api/account/email' && request.method === 'POST') {
      const res = await handleRequestEmailChange(request, env);
      return new Response(res.body, { status: res.status, headers: { ...cors, ...Object.fromEntries(res.headers) } });
    }

    if (pathname === '/api/account/email/confirm' && request.method === 'POST') {
      const res = await handleConfirmEmailChange(request, env);
      return new Response(res.body, { status: res.status, headers: { ...cors, ...Object.fromEntries(res.headers) } });
    }

    if (pathname === '/api/account/notifications' && request.method === 'PUT') {
      const res = await handleUpdateNotifications(request, env);
      return new Response(res.body, { status: res.status, headers: { ...cors, ...Object.fromEntries(res.headers) } });
    }

    if (pathname === '/api/report-bug' && request.method === 'POST') {
      const res = await handleReportBug(request, env);
      return new Response(res.body, { status: res.status, headers: { ...cors, ...Object.fromEntries(res.headers) } });
    }

    if (pathname === '/api/account' && request.method === 'DELETE') {
      const res = await handleDeleteAccount(request, env);
      return new Response(res.body, { status: res.status, headers: { ...cors, ...Object.fromEntries(res.headers) } });
    }

    if (pathname === '/api/account/logout-all' && request.method === 'POST') {
      const res = await handleLogoutAll(request, env);
      return new Response(res.body, { status: res.status, headers: { ...cors, ...Object.fromEntries(res.headers) } });
    }

    if (pathname === '/context') {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, { status: 405, headers: cors });
      }
      const { searchParams } = new URL(request.url);
      const sportKey = searchParams.get('sport') ?? '';

      if (!hasContext(sportKey)) {
        return json({ context: null, reason: 'unsupported sport' }, { headers: cors });
      }

      try {
        const context = await fetchContext(
          {
            sportKey,
            home: searchParams.get('home') ?? '',
            away: searchParams.get('away') ?? '',
          },
          ctx,
        );
        return json(
          { context },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=900' } },
        );
      } catch (error) {
        // Context is a bonus, never a blocker: a card without it is still a card.
        return json({ context: null, reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    // Live venue weather for one NFL/MLB fixture, from the National Weather
    // Service — free, no key, no odds credit. Only ever asked for the two
    // outdoor US sports this app has a venue table for; every other sport
    // (and a game further out than NWS forecasts reach) gets null, not a
    // guess.
    if (pathname === '/weather') {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, { status: 405, headers: cors });
      }
      const { searchParams } = new URL(request.url);
      const sportKey = searchParams.get('sport') ?? '';
      const homeTeam = searchParams.get('home') ?? '';
      const commenceMs = Number(searchParams.get('commenceMs') ?? '');

      if (!hasVenue(sportKey) || !homeTeam || !Number.isFinite(commenceMs)) {
        return json({ weather: null, reason: 'unsupported sport or missing params' }, { headers: cors });
      }

      try {
        const weather = await fetchWeather({ sportKey, homeTeam, commenceMs }, ctx);
        return json(
          { weather },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=1800' } },
        );
      } catch (error) {
        return json({ weather: null, reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    // MMA fighter research (UFC/PFL/DWCS — the Odds API bundles all of them
    // under one key, with no way to tell them apart at that layer). Free —
    // it reads Sherdog, not the odds feed.
    // AI-written matchup analysis, one per game per ET calendar day — see
    // analysis.js for the full design. Free to the client (reads/writes KV,
    // never touches the odds feed); the real cost is the model call itself,
    // which only happens on that game's first request of the day.
    if (pathname === '/analysis') {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, { status: 405, headers: cors });
      }
      const { searchParams } = new URL(request.url);
      const candidate = {
        eventId: searchParams.get('eventId') ?? '',
        sportKey: searchParams.get('sportKey') ?? '',
        sportTitle: searchParams.get('sportTitle') ?? '',
        home: searchParams.get('home') ?? '',
        away: searchParams.get('away') ?? '',
        // The side this app's own pricing already picked — the model builds
        // its case around this rather than independently guessing (see
        // worker/src/analysis.js), so the write-up can never disagree with
        // the pick shown next to it.
        outcomeName: searchParams.get('outcomeName') ?? '',
      };
      if (!candidate.eventId || !candidate.sportKey || !candidate.home || !candidate.away || !candidate.outcomeName) {
        return json({ analysis: null, reason: 'missing eventId/sportKey/home/away/outcomeName' }, { headers: cors });
      }
      try {
        // &isPotd=true exercises getOrGenerateAnalysis's POTD variant
        // (longer prompt, higher maxTokens, separate cache namespace)
        // directly rather than the regular per-game one — useful for
        // reproducing a POTD-specific write-up failure without waiting for
        // the 2am batch.
        const isPotd = searchParams.get('isPotd') === 'true';
        const analysis = await getOrGenerateAnalysis(candidate, env, ctx, Date.now(), { isPotd });
        return json(
          { analysis },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=3600' } },
        );
      } catch (error) {
        return json({ analysis: null, reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    if (pathname === '/mma-context') {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, { status: 405, headers: cors });
      }
      const { searchParams } = new URL(request.url);
      try {
        const context = await fetchMmaContext(
          {
            fighterA: searchParams.get('a') ?? '',
            fighterB: searchParams.get('b') ?? '',
          },
          ctx,
        );
        return json(
          { context },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=3600' } },
        );
      } catch (error) {
        return json({ context: null, reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    // Today's Play of the Day — written by the scheduled() cron, read-only
    // here. Free: reads KV, never touches the odds feed on this path.
    // `leaning` is the current pool leader when today's pick hasn't locked
    // yet (see potd.js's getPotdLeaning) — null once `potd` itself is set,
    // since there's nothing left to lean on at that point.
    if (pathname === '/potd') {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, { status: 405, headers: cors });
      }
      try {
        const potd = await getPotd(env);
        const leaning = potd ? null : await getPotdLeaning(env);
        return json(
          { potd, leaning },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=300' } },
        );
      } catch (error) {
        return json({ potd: null, leaning: null, reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    // Every Play of the Day pick still in KV (up to 90 days) — the raw
    // material for the Tracking Dashboard's Play of the Day section.
    // Read-only, KV only, no odds credit.
    if (pathname === '/potd-history') {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, { status: 405, headers: cors });
      }
      try {
        const picks = await getPotdHistory(env);
        return json(
          { picks },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=300' } },
        );
      } catch (error) {
        return json({ picks: [], reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    // Today's server-side tracked Top 5 — written by the scheduled() cron,
    // updated by its hourly CLV/grading passes, read-only here. Independent
    // of the client's own browser-local IndexedDB tracking (see
    // docs/learning.js) — this is the one shared history that exists
    // whether or not anyone has the app open. `leaning` fills in whichever
    // of the 5 slots aren't locked yet with the current pool leaders (see
    // tracking.js's getTop5Leaning) — [] once all 5 are locked.
    if (pathname === '/top5' && request.method === 'GET') {
      try {
        const picks = await getTop5(env);
        const leaning = picks.length < TOP5_COUNT ? await getTop5Leaning(env) : [];
        return json(
          { picks, leaning },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=300' } },
        );
      } catch (error) {
        return json({ picks: [], leaning: [], reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    // Every tracked pick still in KV (up to 90 days) — the raw material for
    // the client's calibration/audit reporting view (Brier score, CLV
    // correlation, segmented accuracy). Read-only, KV only, no odds credit.
    if (pathname === '/top5-history' && request.method === 'GET') {
      try {
        const picks = await getAllTrackedPicks(env);
        return json(
          { picks },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=300' } },
        );
      } catch (error) {
        return json({ picks: [], reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    // Every Full Slate pick still in KV (up to 90 days, or fewer via
    // ?days=N) — one pick per game, every sport, no filtering. Used by both
    // the Tracking Dashboard's Full Slate tab (full 90-day window) and the
    // Full Slate board itself (?days=2, just enough to label a just-finished
    // game whose odds have already dropped off the feed). Read-only, KV
    // only, no odds credit.
    if (pathname === '/full-slate-history' && request.method === 'GET') {
      try {
        const { searchParams } = new URL(request.url);
        const daysParam = Number(searchParams.get('days'));
        const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 90) : 90;
        const picks = await getAllFullSlateTracked(env, { days });
        return json(
          { picks },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=300' } },
        );
      } catch (error) {
        return json({ picks: [], reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    if (pathname === '/mlb-props-history' && request.method === 'GET') {
      try {
        const { searchParams } = new URL(request.url);
        const daysParam = Number(searchParams.get('days'));
        const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 90) : 90;
        const picks = await getAllMlbPropsTracked(env, { days });
        return json(
          { picks },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=300' } },
        );
      } catch (error) {
        return json({ picks: [], reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    if (pathname === '/nfl-props-history' && request.method === 'GET') {
      try {
        const { searchParams } = new URL(request.url);
        const daysParam = Number(searchParams.get('days'));
        const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 90) : 90;
        const picks = await getAllNflPropsTracked(env, { days });
        return json(
          { picks },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=300' } },
        );
      } catch (error) {
        return json({ picks: [], reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    if (pathname === '/wnba-props-history' && request.method === 'GET') {
      try {
        const { searchParams } = new URL(request.url);
        const daysParam = Number(searchParams.get('days'));
        const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 90) : 90;
        const picks = await getAllWnbaPropsTracked(env, { days });
        return json(
          { picks },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=300' } },
        );
      } catch (error) {
        return json({ picks: [], reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    if (pathname === '/nhl-props-history' && request.method === 'GET') {
      try {
        const { searchParams } = new URL(request.url);
        const daysParam = Number(searchParams.get('days'));
        const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 90) : 90;
        const picks = await getAllNhlPropsTracked(env, { days });
        return json(
          { picks },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=300' } },
        );
      } catch (error) {
        return json({ picks: [], reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    // DISABLED. This used to wipe every server-side tracker (Pixel's Picks
    // and Full Slate) on an unauthenticated POST — meaning anyone who found
    // the URL could destroy the entire performance record, and the "Reset
    // All Tracking" button that called it was the only thing keeping it out
    // of reach. The tracked record is the whole point of the app right now,
    // so the endpoint is closed rather than merely unlinked from the UI.
    //
    // To genuinely reset: delete this block and redeploy. That friction is
    // deliberate for an irreversible, once-in-a-blue-moon operation. When
    // per-user accounts land, this should come back scoped to the calling
    // user's own history instead of being global.
    if (pathname === '/top5-reset' && request.method === 'POST') {
      return json(
        { error: 'Tracking reset is disabled on this deployment' },
        { status: 403, headers: cors },
      );
    }

    // Durable bankroll/unit settings (see worker/src/settings.js) — one
    // record per authenticated account now, keyed by the JWT's userId
    // rather than the old single hardcoded "owner" identity. settings.js's
    // own header comment anticipated exactly this migration: settingsKey()
    // is the only place the identity->KV-key mapping lives, so passing a
    // real per-user identity here is the entire change on that side. The
    // bankroll is personal, and this site is publicly reachable, so an
    // unauthenticated GET would publish it to every visitor.
    if (pathname === '/settings' && (request.method === 'GET' || request.method === 'PUT')) {
      const payload = await authenticateRequest(request, env);
      if (!payload) return json({ error: 'unauthorized' }, { status: 401, headers: cors });

      try {
        if (request.method === 'GET') {
          return json({ settings: await getSettings(env, payload.userId) }, { headers: { ...cors, 'Cache-Control': 'no-store' } });
        }
        const body = await request.json().catch(() => null);
        if (!body) return json({ error: 'Expected a JSON body' }, { status: 400, headers: cors });
        return json({ settings: await putSettings(env, body, payload.userId) }, { headers: { ...cors, 'Cache-Control': 'no-store' } });
      } catch (error) {
        return json({ error: String(error).slice(0, 120) }, { status: 500, headers: cors });
      }
    }

    // Current state of the weekly algorithm health review (worker/src/
    // algo-health.js) — tuned config vs. shipped defaults, currently paused
    // segments, and the recent action/proposal log — for the Tracking
    // Dashboard's Algorithm Health panel. Read-only, KV only.
    // The daily learning review's current weight profile and day-by-day
    // report log (worker/src/daily-learning.js) — read by the Tracking
    // panel's "Daily Learning" section. Read-only; the review itself only
    // ever runs from the 2am scheduled gate.
    if (pathname === '/learning' && request.method === 'GET') {
      try {
        const [profile, log] = await Promise.all([getLearningProfile(env), getLearningLog(env)]);
        return json(
          { profile, log, windowDays: LEARN_WINDOW_DAYS },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=300' } },
        );
      } catch (error) {
        return json({ error: String(error).slice(0, 120) }, { status: 500, headers: cors });
      }
    }

    if (pathname === '/algo-health' && request.method === 'GET') {
      try {
        const [config, paused, log] = await Promise.all([
          getAlgoConfig(env),
          getPausedSegments(env),
          getHealthLog(env),
        ]);
        return json(
          { config, defaults: defaultAlgoConfig(), bounds: TUNABLE_BOUNDS, paused, log },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=300' } },
        );
      } catch (error) {
        return json({ error: String(error).slice(0, 120) }, { status: 500, headers: cors });
      }
    }

    // Manual early resume of one paused segment — the human-override
    // counterpart to the automatic, evidence-based resume the weekly review
    // does on its own. Body: {"key": "sportKey|marketKey"}.
    // Both mutating algo-health routes are owner-only (same X-Owner-Key
    // gate as /settings) — the Tracking Dashboard's UI no longer exposes
    // either (removed: "Resume now" per paused segment, and "Reset Tuning
    // to Defaults"), since the dashboard is meant to be view-only for every
    // visitor. Left reachable by the owner directly (curl/a future admin
    // tool) rather than removed outright — closing the UI button but
    // leaving the route wide open would still let anyone who found the URL
    // mutate the live algorithm tuning, which defeats the point.
    if (pathname === '/algo-health/resume' && request.method === 'POST') {
      const auth = authorizeSettings(request, env);
      if (!auth.ok) return json({ error: auth.error }, { status: auth.status, headers: cors });
      try {
        const body = await request.json().catch(() => ({}));
        if (!body.key) return json({ error: 'Missing "key"' }, { status: 400, headers: cors });
        const resumed = await resumeSegmentNow(env, body.key);
        return json({ resumed }, { headers: cors });
      } catch (error) {
        return json({ error: String(error).slice(0, 120) }, { status: 500, headers: cors });
      }
    }

    // Manual full reset of the tuned config back to shipped defaults — does
    // not touch paused segments (those resume individually via the route
    // above). Never run on a schedule; only ever hit by the owner directly.
    if (pathname === '/algo-health/reset' && request.method === 'POST') {
      const auth = authorizeSettings(request, env);
      if (!auth.ok) return json({ error: auth.error }, { status: auth.status, headers: cors });
      try {
        const config = await resetAlgoConfigToDefaults(env);
        return json({ config }, { headers: cors });
      } catch (error) {
        return json({ error: String(error).slice(0, 120) }, { status: 500, headers: cors });
      }
    }

    // Manual send of the daily onboarding digest (worker/src/
    // onboarding-report.js) — lets the owner trigger/test it on demand
    // instead of waiting for the 8pm ET cron gate. Same owner-only
    // X-Owner-Key gate as /settings and the algo-health admin routes above.
    if (pathname === '/admin/onboarding-report' && request.method === 'POST') {
      const auth = authorizeSettings(request, env);
      if (!auth.ok) return json({ error: auth.error }, { status: auth.status, headers: cors });
      try {
        await sendDailyOnboardingReport(env, Date.now());
        return json({ sent: true }, { headers: cors });
      } catch (error) {
        return json({ error: String(error).slice(0, 120) }, { status: 500, headers: cors });
      }
    }

    // Tennis alternate-spread ladder for one match already on the board.
    // Costs a real odds credit (unlike /context and /mma-context) — app.js
    // calls this for only a small, score-ranked slice of the tennis matches
    // it already has, never the whole tour.
    if (pathname === '/tennis-alt-spread') {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, { status: 405, headers: cors });
      }
      const { searchParams } = new URL(request.url);
      const sportKey = searchParams.get('sport') ?? '';
      const eventId = searchParams.get('eventId') ?? '';

      if (!isAllowedSport(sportKey) || !/^tennis_/.test(sportKey) || !eventId) {
        return json({ event: null, reason: 'invalid sport or eventId' }, { headers: cors });
      }

      try {
        const { event } = await fetchTennisAltSpread(sportKey, eventId, env, ctx);
        return json(
          { event },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=3600' } },
        );
      } catch (error) {
        return json({ event: null, reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    // MLB team stats endpoint
    if (pathname === '/mlb-stats' && request.method === 'GET') {
      const { searchParams } = new URL(request.url);
      const teamAbbr = searchParams.get('team') ?? '';
      // The opponent, for the Starting Pitchers section (both teams' probable
      // starter for this specific matchup) and, once the client opens the
      // Head-to-Head tab, for scanning the requesting team's whole-season
      // schedule for their meetings — sent on every call since it's cheap
      // (same schedule fetch either way), but headToHead itself only
      // computed when explicitly asked for.
      const opponentAbbr = searchParams.get('opponent') ?? '';
      const wantHeadToHead = searchParams.get('h2h') === '1';

      if (!teamAbbr) {
        return json({ error: 'team parameter required' }, { status: 400, headers: cors });
      }

      try {
        const [teamStats, leagueStats, recentSchedule, situational, headToHead, startingPitchers] = await Promise.all([
          fetchTeamStats(teamAbbr, ctx),
          fetchLeagueStats(env),
          fetchRecentSchedule(teamAbbr, ctx),
          fetchSituationalSplits(teamAbbr, ctx),
          wantHeadToHead && opponentAbbr ? fetchHeadToHead(teamAbbr, opponentAbbr, ctx) : Promise.resolve(null),
          opponentAbbr ? fetchStartingPitchers(teamAbbr, opponentAbbr, ctx) : Promise.resolve(null),
        ]);

        // Ranked server-side against all 30 teams so the client only ever
        // gets {value, rank} pairs, not the full league's raw numbers.
        const rankedStats = teamStats ? rankTeamStats(teamStats, leagueStats) : null;

        return json(
          { teamStats: rankedStats, recentSchedule, situational, headToHead, startingPitchers },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=3600' } },
        );
      } catch (error) {
        return json(
          { error: String(error).slice(0, 120) },
          { status: 500, headers: cors },
        );
      }
    }

    // A single pitcher's last 5 real outings — lazy-loaded only once the
    // client opens that drilldown, same reasoning as head-to-head above.
    if (pathname === '/mlb-pitcher-outings' && request.method === 'GET') {
      const { searchParams } = new URL(request.url);
      const playerId = searchParams.get('player') ?? '';
      if (!playerId) {
        return json({ error: 'player parameter required' }, { status: 400, headers: cors });
      }
      try {
        const outings = await fetchPitcherOutings(playerId, ctx);
        return json(
          { outings },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=3600' } },
        );
      } catch (error) {
        return json({ outings: [], reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }


    if (pathname === '/odds' || pathname === '/sports' || pathname === '/scores') {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, { status: 405, headers: cors });
      }
      if (!env.ODDS_API_KEY) {
        return json(
          { error: 'Proxy is missing ODDS_API_KEY. Set it with: wrangler secret put ODDS_API_KEY' },
          { status: 500, headers: cors },
        );
      }
      if (pathname === '/sports') return handleSports(env, ctx, cors);
      if (pathname === '/scores') return handleScores(request, env, ctx, cors);
      return handleOdds(request, env, ctx);
    }

    return json(
      { error: 'Not found. Try GET /sports or GET /odds?sports=upcoming' },
      { status: 404, headers: cors },
    );
  },
};
