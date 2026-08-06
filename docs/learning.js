/**
 * Client-side learning dashboard and pick tracking.
 * Records every pick generated, simulates bankroll betting,
 * matches results, and provides performance analytics.
 */

export const BANKROLL_INITIAL = 1000;
// Flat 1-unit stake on every tracked pick, regardless of odds — the
// simulation is measuring the algorithm's picking, not a staking strategy,
// so every bet risks the same $20 (2% of the $1000 bankroll).
export const FLAT_UNIT_STAKE = 20;
const PICKS_DB_NAME = 'PixelPickLearning';
const PICKS_STORE_NAME = 'picks';
const RESULTS_STORE_NAME = 'results';

let db = null;

/**
 * Initialize IndexedDB for local pick storage.
 */
export async function initializePickDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PICKS_DB_NAME, 1);

    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      db = req.result;
      resolve(db);
    };

    req.onupgradeneeded = (event) => {
      const database = event.target.result;

      // Picks store
      if (!database.objectStoreNames.contains(PICKS_STORE_NAME)) {
        const pickStore = database.createObjectStore(PICKS_STORE_NAME, { keyPath: 'pickId' });
        pickStore.createIndex('dateIndex', 'recordedAt', { unique: false });
        pickStore.createIndex('statusIndex', 'status', { unique: false });
        pickStore.createIndex('sportIndex', 'sport', { unique: false });
      }

      // Results store
      if (!database.objectStoreNames.contains(RESULTS_STORE_NAME)) {
        const resultStore = database.createObjectStore(RESULTS_STORE_NAME, { keyPath: 'pickId' });
        resultStore.createIndex('dateIndex', 'scoredAt', { unique: false });
        resultStore.createIndex('outcomeIndex', 'actualOutcome', { unique: false });
      }
    };
  });
}

/**
 * A pick's identity for tracking purposes: same game, same market, same
 * side, same calendar day. Stable across regenerations — tapping Generate
 * twice in one day on a board that includes the same lock both times must
 * not double-log it, which is what a timestamp-based id would do.
 *
 * The date component is the user's own local calendar day, not UTC —
 * toISOString() would roll evening picks in negative-UTC-offset timezones
 * (all of the US) into tomorrow's date, which is wrong both for the "don't
 * double-log today's board" check and for a day-by-day calendar view.
 */
function stablePickId(pick) {
  const now = new Date();
  const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `${dateKey}:${pick.eventId}:${pick.marketKey}:${pick.side}`;
}

export async function pickExists(pickId) {
  if (!db) await initializePickDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([PICKS_STORE_NAME], 'readonly');
    const req = tx.objectStore(PICKS_STORE_NAME).get(pickId);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(Boolean(req.result));
  });
}

/**
 * Record a pick when it's generated on the Pixel Picks board. Stake defaults
 * to the flat 1-unit ($20) stake every tracked pick uses — pass an override
 * only for tests. Silently a no-op if this exact pick (same game/market/side/
 * day) is already tracked, so re-generating the board never double-counts.
 */
export async function logPick(pick, stake = FLAT_UNIT_STAKE) {
  if (!db) await initializePickDatabase();

  const pickId = stablePickId(pick);
  if (await pickExists(pickId)) return null;

  const pickRecord = {
    pickId,
    eventId: pick.eventId,
    sport: pick.sportKey,
    home: pick.home,
    away: pick.away,
    team: pick.away && pick.home ? `${pick.away} vs ${pick.home}` : 'Unknown',
    side: pick.side ?? pick.away, // Display string, e.g. "Chiefs +150"
    outcomeName: pick.outcomeName, // Raw team name ('Over'/'Under' for totals) — what grading matches against
    point: pick.point ?? null, // Spread/total line, null for moneyline
    marketKey: pick.marketKey,
    american: pick.american,
    decimal: pick.decimal,
    book: pick.book || 'Unknown',
    confidence: pick.score, // 0-100
    consensusProb: pick.consensusProb,
    ev: pick.ev,
    kelly: pick.kelly,
    suggested_stake: stake,
    commenceTime: pick.commenceMs,
    recordedAt: Date.now(),
    status: 'pending',
    result: null,
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction([PICKS_STORE_NAME], 'readwrite');
    const store = tx.objectStore(PICKS_STORE_NAME);
    const req = store.add(pickRecord);

    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(pickRecord);
  });
}

/**
 * Record the outcome of a pick after the match concludes.
 */
export async function logResult(pickId, won, actualPayout) {
  if (!db) await initializePickDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([PICKS_STORE_NAME, RESULTS_STORE_NAME], 'readwrite');
    const pickStore = tx.objectStore(PICKS_STORE_NAME);
    const resultStore = tx.objectStore(RESULTS_STORE_NAME);

    // Get the pick
    const pickReq = pickStore.get(pickId);
    pickReq.onerror = () => reject(pickReq.error);
    pickReq.onsuccess = () => {
      const pick = pickReq.result;
      if (!pick) return reject(new Error('Pick not found'));

      const outcome = {
        pickId,
        actualOutcome: won ? 'WIN' : 'LOSS',
        payout: actualPayout,
        roiPercent: (actualPayout / pick.suggested_stake) * 100,
        confidence: pick.confidence,
        ev: pick.ev,
        scoredAt: Date.now(),
        calibrationDelta: won ? (1 - pick.consensusProb) * 100 : -pick.consensusProb * 100,
      };

      // Update pick status
      pick.status = won ? 'won' : 'lost';
      pick.result = outcome;

      const updateReq = pickStore.put(pick);
      updateReq.onerror = () => reject(updateReq.error);
      updateReq.onsuccess = () => {
        // Record result
        const resultReq = resultStore.add(outcome);
        resultReq.onerror = () => reject(resultReq.error);
        resultReq.onsuccess = () => resolve(outcome);
      };
    };
  });
}

/**
 * Get all picks from a date range.
 */
export async function getPicksInRange(startDate, endDate) {
  if (!db) await initializePickDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([PICKS_STORE_NAME], 'readonly');
    const store = tx.objectStore(PICKS_STORE_NAME);
    const index = store.index('dateIndex');
    const range = IDBKeyRange.bound(startDate.getTime(), endDate.getTime());

    const req = index.getAll(range);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

/**
 * Get all results from a date range.
 */
export async function getResultsInRange(startDate, endDate) {
  if (!db) await initializePickDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([RESULTS_STORE_NAME], 'readonly');
    const store = tx.objectStore(RESULTS_STORE_NAME);
    const index = store.index('dateIndex');
    const range = IDBKeyRange.bound(startDate.getTime(), endDate.getTime());

    const req = index.getAll(range);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

/** Every tracked pick ever, regardless of day or status. */
export async function getAllPicks() {
  if (!db) await initializePickDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([PICKS_STORE_NAME], 'readonly');
    const req = tx.objectStore(PICKS_STORE_NAME).getAll();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

/** Every tracked pick still awaiting a graded outcome. */
export async function getPendingPicks() {
  if (!db) await initializePickDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([PICKS_STORE_NAME], 'readonly');
    const req = tx.objectStore(PICKS_STORE_NAME).index('statusIndex').getAll('pending');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

/**
 * Decide win/loss for a tracked pick against the matching /scores event, and
 * the resulting payout. Returns null if the game isn't completed yet, its
 * score is missing/unparseable, or the result is a push — a push isn't a
 * win or a loss, so it's left pending rather than graded either way.
 */
export function gradePick(pick, scoreEvent) {
  if (!scoreEvent?.completed || !Array.isArray(scoreEvent.scores)) return null;

  const scoreFor = (teamName) => {
    const entry = scoreEvent.scores.find((s) => s.name === teamName);
    const value = entry ? Number(entry.score) : NaN;
    return Number.isFinite(value) ? value : null;
  };

  const homeScore = scoreFor(pick.home);
  const awayScore = scoreFor(pick.away);
  if (homeScore == null || awayScore == null) return null;

  const pickedIsHome = pick.outcomeName === pick.home;
  const pickedScore = pickedIsHome ? homeScore : awayScore;
  const otherScore = pickedIsHome ? awayScore : homeScore;
  const point = pick.point ?? 0;

  let won;
  if (pick.marketKey === 'h2h') {
    if (pickedScore === otherScore) return null; // push (extra-innings/OT ties settle it elsewhere)
    won = pickedScore > otherScore;
  } else if (pick.marketKey === 'spreads') {
    const margin = pickedScore + point - otherScore;
    if (margin === 0) return null; // push
    won = margin > 0;
  } else if (pick.marketKey === 'totals') {
    const total = homeScore + awayScore;
    if (total === point) return null; // push
    won = pick.outcomeName === 'Over' ? total > point : total < point;
  } else {
    return null; // unrecognized market — leave pending rather than guess
  }

  const payout = won ? (pick.decimal - 1) * pick.suggested_stake : -pick.suggested_stake;
  return { won, payout };
}

/**
 * W-L/ROI/net summary over any picks array — the pure building block behind
 * getOverallSummary and each day's entry in getPicksByDay. Exported directly
 * so a caller that needs a summary over a *filtered* subset (the tracker's
 * per-sport filter, say) can reuse the exact same math without going back
 * through IndexedDB.
 */
export function summarizePicks(picks) {
  const graded = picks.filter((p) => p.status !== 'pending');
  const wins = graded.filter((p) => p.status === 'won').length;
  const losses = graded.filter((p) => p.status === 'lost').length;
  const staked = graded.reduce((sum, p) => sum + p.suggested_stake, 0);
  const net = graded.reduce((sum, p) => sum + (p.result?.payout ?? 0), 0);
  return {
    picks,
    total: picks.length,
    graded: graded.length,
    pending: picks.length - graded.length,
    wins,
    losses,
    staked,
    net,
    roi: staked ? (net / staked) * 100 : 0,
  };
}

/**
 * Groups any picks array by the calendar day it was generated on (the
 * stable pickId's own date prefix — see stablePickId — not recordedAt, so a
 * pick logged a few minutes after midnight still lands in the right day),
 * most recent day first, each with its own summarizePicks() result. Exported
 * so a filtered subset can be grouped the same way getPicksByDay groups
 * everything.
 */
export function groupPicksByDay(picks) {
  const byDay = new Map();
  for (const pick of picks) {
    const day = pick.pickId.split(':')[0];
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(pick);
  }

  return [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, dayPicks]) => ({
      date,
      ...summarizePicks(dayPicks.sort((a, b) => b.recordedAt - a.recordedAt)),
    }));
}

/** Every tracked pick grouped by day — see groupPicksByDay. */
export async function getPicksByDay() {
  return groupPicksByDay(await getAllPicks());
}

/** All-time W-L/ROI/net summary plus the running simulated bankroll. */
export async function getOverallSummary() {
  const summary = summarizePicks(await getAllPicks());
  return {
    ...summary,
    winRate: summary.graded ? (summary.wins / summary.graded) * 100 : 0,
    bankroll: BANKROLL_INITIAL + summary.net,
  };
}

/**
 * Identify patterns: group picks by confidence, sport, market.
 */
export async function identifyPatterns(startDate = new Date(), endDate = new Date()) {
  const startOfDay = new Date(startDate);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(endDate);
  endOfDay.setHours(23, 59, 59, 999);

  const picks = await getPicksInRange(startOfDay, endOfDay);
  const results = await getResultsInRange(startOfDay, endOfDay);

  if (results.length === 0) return null;

  // Map results back to picks
  const pickMap = new Map(picks.map((p) => [p.pickId, p]));
  const picksWithResults = results
    .map((r) => ({ pick: pickMap.get(r.pickId), result: r }))
    .filter((x) => x.pick);

  // Group by confidence level
  const confidenceBuckets = {
    veryHigh: { range: '80+', picks: [] },
    high: { range: '70-79', picks: [] },
    medium: { range: '60-69', picks: [] },
    low: { range: '50-59', picks: [] },
  };

  for (const { pick, result } of picksWithResults) {
    const conf = pick.confidence;
    if (conf >= 80) confidenceBuckets.veryHigh.picks.push({ pick, result });
    else if (conf >= 70) confidenceBuckets.high.picks.push({ pick, result });
    else if (conf >= 60) confidenceBuckets.medium.picks.push({ pick, result });
    else confidenceBuckets.low.picks.push({ pick, result });
  }

  const confidenceAnalysis = {};
  for (const bucket in confidenceBuckets) {
    const data = confidenceBuckets[bucket];
    if (data.picks.length > 0) {
      const wins = data.picks.filter((x) => x.result.actualOutcome === 'WIN').length;
      confidenceAnalysis[bucket] = {
        range: data.range,
        count: data.picks.length,
        wins,
        winRate: (wins / data.picks.length) * 100,
        avgRoi: data.picks.reduce((sum, x) => sum + x.result.roiPercent, 0) / data.picks.length,
      };
    }
  }

  // Group by sport
  const sportMap = {};
  for (const { pick, result } of picksWithResults) {
    if (!sportMap[pick.sport]) sportMap[pick.sport] = [];
    sportMap[pick.sport].push({ pick, result });
  }

  const sportAnalysis = {};
  for (const sport in sportMap) {
    const data = sportMap[sport];
    const wins = data.filter((x) => x.result.actualOutcome === 'WIN').length;
    sportAnalysis[sport] = {
      count: data.length,
      wins,
      winRate: (wins / data.length) * 100,
      avgRoi: data.reduce((sum, x) => sum + x.result.roiPercent, 0) / data.length,
    };
  }

  return {
    dateRange: {
      start: startOfDay.toISOString().split('T')[0],
      end: endOfDay.toISOString().split('T')[0],
    },
    byConfidence: confidenceAnalysis,
    bySport: sportAnalysis,
  };
}

/**
 * Export picks and results as CSV for external analysis.
 */
export async function exportData(startDate, endDate) {
  const picks = await getPicksInRange(startDate, endDate);
  const results = await getResultsInRange(startDate, endDate);

  let csv = 'pickId,sport,confidence,american,decimal,ev,suggested_stake,status,outcome,payout,roiPercent,recordedAt\n';

  const resultMap = new Map(results.map((r) => [r.pickId, r]));

  for (const pick of picks) {
    const result = resultMap.get(pick.pickId);
    csv += `${pick.pickId},${pick.sport},${pick.confidence},${pick.american},${pick.decimal},${pick.ev},${pick.suggested_stake},${pick.status},${result?.actualOutcome || 'pending'},${result?.payout || ''},${result?.roiPercent || ''},${pick.recordedAt}\n`;
  }

  return csv;
}
