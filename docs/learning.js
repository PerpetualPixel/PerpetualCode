/**
 * Client-side learning dashboard and pick tracking.
 * Records every pick generated, simulates bankroll betting,
 * matches results, and provides performance analytics.
 */

const BANKROLL_INITIAL = 1000;
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
 * Record a pick when it's generated on the Pixel Picks board.
 */
export async function logPick(pick, stake) {
  if (!db) await initializePickDatabase();

  const pickId = `${pick.eventId}:${pick.id}:${Date.now()}`;
  const pickRecord = {
    pickId,
    eventId: pick.eventId,
    sport: pick.sportKey,
    team: pick.away && pick.home ? `${pick.away} vs ${pick.home}` : 'Unknown',
    side: pick.away, // The predicted winner
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

/**
 * Analyze performance for a date range.
 */
export async function analyzePerformance(startDate = new Date(), endDate = new Date()) {
  const startOfDay = new Date(startDate);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(endDate);
  endOfDay.setHours(23, 59, 59, 999);

  const picks = await getPicksInRange(startOfDay, endOfDay);
  const results = await getResultsInRange(startOfDay, endOfDay);

  if (results.length === 0) {
    return {
      totalPicks: picks.length,
      gradedPicks: 0,
      pendingPicks: picks.filter((p) => p.status === 'pending').length,
      wins: 0,
      losses: 0,
      winRate: 0,
      roi: 0,
      totalRoi: 0,
      averageConfidence: 0,
      confidenceCalibration: 0,
    };
  }

  const wins = results.filter((r) => r.actualOutcome === 'WIN').length;
  const losses = results.filter((r) => r.actualOutcome === 'LOSS').length;
  const totalRoi = results.reduce((sum, r) => sum + r.roiPercent, 0);
  const avgConfidence = picks.reduce((sum, p) => sum + p.confidence, 0) / picks.length;
  const calibrationError = results.reduce((sum, r) => sum + r.calibrationDelta, 0) / results.length;

  return {
    totalPicks: picks.length,
    gradedPicks: results.length,
    pendingPicks: picks.filter((p) => p.status === 'pending').length,
    wins,
    losses,
    winRate: (wins / results.length) * 100,
    roi: totalRoi / results.length,
    totalRoi,
    averageConfidence: avgConfidence,
    confidenceCalibration: calibrationError,
    dateRange: {
      start: startOfDay.toISOString().split('T')[0],
      end: endOfDay.toISOString().split('T')[0],
    },
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
 * Calculate bankroll after a set of picks/results.
 */
export function calculateBankroll(results) {
  let bankroll = BANKROLL_INITIAL;
  for (const result of results) {
    bankroll += result.payout;
  }
  return bankroll;
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
