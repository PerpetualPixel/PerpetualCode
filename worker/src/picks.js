/**
 * Pick recording, outcome tracking, and performance analytics.
 * Self-learning framework: every pick is recorded with full context (odds, confidence, EV),
 * matched against actual results, and analyzed to improve future predictions.
 */

const PICKS_KV_PREFIX = 'picks:';
const RESULTS_KV_PREFIX = 'results:';

/**
 * Record a pick when it's generated (before placing the simulated bet).
 * Stores: pick details, odds, confidence, EV, timestamp, bankroll state.
 */
export async function recordPick(pick, env, ctx) {
  const pickId = `${pick.eventId}:${pick.marketKey}:${pick.side}:${Date.now()}`;
  const timestamp = Date.now();

  const pickRecord = {
    pickId,
    eventId: pick.eventId,
    sport: pick.sport,
    team: pick.team,
    side: pick.side,
    marketKey: pick.marketKey,
    marketType: pick.marketType,
    american: pick.american,
    decimal: pick.decimal,
    book: pick.book,
    confidence: pick.score, // 0-100 scale
    consensusProb: pick.consensusProb,
    ev: pick.ev, // Expected value as decimal (0.05 = +5%)
    kelly: pick.kelly, // Kelly fraction
    suggested_stake: pick.stake,
    commenceTime: pick.commenceTime,
    recordedAt: timestamp,
    status: 'pending', // pending, won, lost, cancelled, graded
    result: null,
  };

  const key = `${PICKS_KV_PREFIX}${pickId}`;
  await env.POTD_KV.put(key, JSON.stringify(pickRecord), {
    expirationTtl: 86400 * 30, // Keep for 30 days
  });

  // Also log to a daily picks list for easy retrieval
  const dateKey = new Date(timestamp).toISOString().split('T')[0];
  const dailyKey = `${PICKS_KV_PREFIX}daily:${dateKey}`;
  const dailyList = JSON.parse(await env.POTD_KV.get(dailyKey) || '[]');
  dailyList.push(pickId);
  await env.POTD_KV.put(dailyKey, JSON.stringify(dailyList));

  return pickRecord;
}

/**
 * Record the outcome of a pick after the match concludes.
 * Matches pick to actual result and analyzes performance.
 */
export async function recordOutcome(pickId, result, env, ctx) {
  const key = `${PICKS_KV_PREFIX}${pickId}`;
  const pickJson = await env.POTD_KV.get(key);
  if (!pickJson) return null;

  const pick = JSON.parse(pickJson);
  const timestamp = Date.now();

  // Calculate actual outcome
  const won = result.pickOutcome === 'win';
  const payout = won ? (pick.decimal - 1) * pick.suggested_stake : -pick.suggested_stake;

  const outcome = {
    pickId,
    status: won ? 'won' : 'lost',
    result: result,
    actualOutcome: won ? 'WIN' : 'LOSS',
    payout,
    roiPercent: (payout / pick.suggested_stake) * 100,
    confidence: pick.confidence,
    ev: pick.ev,
    scoredAt: timestamp,
    calibrationDelta: null, // Confidence vs actual outcome
  };

  // Calculate confidence calibration error
  // If confidence was 70% and pick lost, delta is -70
  // If confidence was 70% and pick won, delta is +30
  const confidenceDecimal = pick.confidence / 100;
  outcome.calibrationDelta = won
    ? (1 - confidenceDecimal) * 100
    : -confidenceDecimal * 100;

  // Update pick record
  pick.status = outcome.status;
  pick.result = outcome;
  await env.POTD_KV.put(key, JSON.stringify(pick));

  // Log to results index
  const dateKey = new Date(timestamp).toISOString().split('T')[0];
  const resultsKey = `${RESULTS_KV_PREFIX}daily:${dateKey}`;
  const resultsList = JSON.parse(await env.POTD_KV.get(resultsKey) || '[]');
  resultsList.push(outcome);
  await env.POTD_KV.put(resultsKey, JSON.stringify(resultsList));

  return outcome;
}

/**
 * Analyze pick performance to understand algorithm accuracy.
 * Returns: win rate, ROI, confidence calibration, EV accuracy.
 */
export async function analyzePickPerformance(env, ctx, dateRange = { start: null, end: null }) {
  const today = new Date().toISOString().split('T')[0];
  const startDate = dateRange.start || today;
  const endDate = dateRange.end || today;

  let picks = [];
  let outcomes = [];

  // Fetch all picks for date range
  for (let d = new Date(startDate); d <= new Date(endDate); d.setDate(d.getDate() + 1)) {
    const dateKey = d.toISOString().split('T')[0];
    const dailyKey = `${PICKS_KV_PREFIX}daily:${dateKey}`;
    const dailyList = JSON.parse(await env.POTD_KV.get(dailyKey) || '[]');

    for (const pickId of dailyList) {
      const key = `${PICKS_KV_PREFIX}${pickId}`;
      const pickJson = await env.POTD_KV.get(key);
      if (pickJson) {
        const pick = JSON.parse(pickJson);
        picks.push(pick);
        if (pick.result) {
          outcomes.push(pick.result);
        }
      }
    }
  }

  if (!outcomes.length) return null;

  // Calculate metrics
  const wins = outcomes.filter((o) => o.actualOutcome === 'WIN').length;
  const losses = outcomes.filter((o) => o.actualOutcome === 'LOSS').length;
  const totalRoi = outcomes.reduce((sum, o) => sum + o.roiPercent, 0);
  const avgConfidence = picks.reduce((sum, p) => sum + p.confidence, 0) / picks.length;

  // Confidence calibration: average delta across all picks
  const calibrationError = outcomes.reduce((sum, o) => sum + o.calibrationDelta, 0) / outcomes.length;

  // EV accuracy: do picks with predicted +5% EV actually return +5%?
  const evBuckets = {};
  for (const outcome of outcomes) {
    const evKey = Math.round(outcome.ev * 100) / 100; // Round to 2 decimals
    if (!evBuckets[evKey]) {
      evBuckets[evKey] = { picks: [], avgRoi: 0 };
    }
    evBuckets[evKey].picks.push(outcome);
  }

  for (const evKey in evBuckets) {
    const bucket = evBuckets[evKey];
    bucket.avgRoi = bucket.picks.reduce((sum, p) => sum + p.roiPercent, 0) / bucket.picks.length;
  }

  return {
    totalPicks: picks.length,
    gradedPicks: outcomes.length,
    pendingPicks: picks.filter((p) => p.status === 'pending').length,
    wins,
    losses,
    winRate: (wins / outcomes.length) * 100,
    roi: totalRoi / outcomes.length,
    totalRoi,
    averageConfidence: avgConfidence,
    confidenceCalibration: calibrationError, // How far off confidence predictions were
    evAccuracy: evBuckets, // Predicted EV vs actual ROI by bucket
    dateRange: { start: startDate, end: endDate },
  };
}

/**
 * Identify learning patterns: which types of picks win/lose?
 * Groups by: confidence level, sport, market type, EV range.
 */
export async function identifyPatterns(env, ctx, dateRange = { start: null, end: null }) {
  const analysis = await analyzePickPerformance(env, ctx, dateRange);
  if (!analysis) return null;

  const today = new Date().toISOString().split('T')[0];
  const startDate = dateRange.start || today;
  const endDate = dateRange.end || today;

  let picks = [];
  for (let d = new Date(startDate); d <= new Date(endDate); d.setDate(d.getDate() + 1)) {
    const dateKey = d.toISOString().split('T')[0];
    const dailyKey = `${PICKS_KV_PREFIX}daily:${dateKey}`;
    const dailyList = JSON.parse(await env.POTD_KV.get(dailyKey) || '[]');

    for (const pickId of dailyList) {
      const key = `${PICKS_KV_PREFIX}${pickId}`;
      const pickJson = await env.POTD_KV.get(key);
      if (pickJson) {
        const pick = JSON.parse(pickJson);
        if (pick.result) picks.push(pick);
      }
    }
  }

  // Group by confidence level
  const confidenceBuckets = {
    veryHigh: { min: 80, picks: [] },
    high: { min: 70, max: 79, picks: [] },
    medium: { min: 60, max: 69, picks: [] },
    low: { min: 50, max: 59, picks: [] },
  };

  for (const pick of picks) {
    const conf = pick.confidence;
    if (conf >= 80) confidenceBuckets.veryHigh.picks.push(pick);
    else if (conf >= 70) confidenceBuckets.high.picks.push(pick);
    else if (conf >= 60) confidenceBuckets.medium.picks.push(pick);
    else confidenceBuckets.low.picks.push(pick);
  }

  // Calculate win rate by confidence
  const confidenceAnalysis = {};
  for (const bucket in confidenceBuckets) {
    const picks = confidenceBuckets[bucket].picks;
    if (picks.length > 0) {
      const wins = picks.filter((p) => p.result.actualOutcome === 'WIN').length;
      confidenceAnalysis[bucket] = {
        count: picks.length,
        wins,
        winRate: (wins / picks.length) * 100,
        avgRoi: picks.reduce((sum, p) => sum + p.result.roiPercent, 0) / picks.length,
      };
    }
  }

  // Group by sport
  const sportAnalysis = {};
  for (const pick of picks) {
    if (!sportAnalysis[pick.sport]) {
      sportAnalysis[pick.sport] = { picks: [] };
    }
    sportAnalysis[pick.sport].picks.push(pick);
  }

  for (const sport in sportAnalysis) {
    const picks = sportAnalysis[sport].picks;
    const wins = picks.filter((p) => p.result.actualOutcome === 'WIN').length;
    sportAnalysis[sport] = {
      count: picks.length,
      wins,
      winRate: (wins / picks.length) * 100,
      avgRoi: picks.reduce((sum, p) => sum + p.result.roiPercent, 0) / picks.length,
    };
  }

  // Group by market type
  const marketAnalysis = {};
  for (const pick of picks) {
    const market = pick.marketType || pick.marketKey;
    if (!marketAnalysis[market]) {
      marketAnalysis[market] = { picks: [] };
    }
    marketAnalysis[market].picks.push(pick);
  }

  for (const market in marketAnalysis) {
    const picks = marketAnalysis[market].picks;
    const wins = picks.filter((p) => p.result.actualOutcome === 'WIN').length;
    marketAnalysis[market] = {
      count: picks.length,
      wins,
      winRate: (wins / picks.length) * 100,
      avgRoi: picks.reduce((sum, p) => sum + p.result.roiPercent, 0) / picks.length,
    };
  }

  return {
    dateRange: { start: startDate, end: endDate },
    byConfidence: confidenceAnalysis,
    bySport: sportAnalysis,
    byMarket: marketAnalysis,
    recommendations: generateRecommendations(confidenceAnalysis, sportAnalysis, marketAnalysis),
  };
}

/**
 * Generate learning recommendations based on performance patterns.
 */
function generateRecommendations(confidence, sports, markets) {
  const recs = [];

  // Confidence calibration
  for (const level in confidence) {
    const data = confidence[level];
    if (data.winRate < 45) {
      recs.push({
        type: 'confidence_adjustment',
        message: `${level} confidence picks underperforming (${data.winRate.toFixed(1)}% win rate). Consider lowering confidence scores or adding stricter filters.`,
        metric: level,
        severity: 'high',
      });
    }
  }

  // Sport-specific insights
  for (const sport in sports) {
    const data = sports[sport];
    if (data.winRate > 55 && data.count > 5) {
      recs.push({
        type: 'sports_strength',
        message: `${sport} is a strength (${data.winRate.toFixed(1)}% win rate). Consider increasing allocation here.`,
        metric: sport,
        severity: 'low',
      });
    } else if (data.winRate < 45 && data.count > 5) {
      recs.push({
        type: 'sports_weakness',
        message: `${sport} is underperforming (${data.winRate.toFixed(1)}% win rate). Reduce picks or investigate models.`,
        metric: sport,
        severity: 'high',
      });
    }
  }

  // Market-specific insights
  for (const market in markets) {
    const data = markets[market];
    if (data.winRate > 55 && data.count > 5) {
      recs.push({
        type: 'market_strength',
        message: `${market} outperforming (${data.winRate.toFixed(1)}% win rate). Strong edge here.`,
        metric: market,
        severity: 'low',
      });
    }
  }

  return recs;
}

/**
 * Get all picks from a specific date.
 */
export async function getPicksByDate(date, env) {
  const dateKey = new Date(date).toISOString().split('T')[0];
  const dailyKey = `${PICKS_KV_PREFIX}daily:${dateKey}`;
  const dailyList = JSON.parse(await env.POTD_KV.get(dailyKey) || '[]');

  const picks = [];
  for (const pickId of dailyList) {
    const key = `${PICKS_KV_PREFIX}${pickId}`;
    const pickJson = await env.POTD_KV.get(key);
    if (pickJson) {
      picks.push(JSON.parse(pickJson));
    }
  }
  return picks;
}

/**
 * Get results from a specific date.
 */
export async function getResultsByDate(date, env) {
  const dateKey = new Date(date).toISOString().split('T')[0];
  const resultsKey = `${RESULTS_KV_PREFIX}daily:${dateKey}`;
  return JSON.parse(await env.POTD_KV.get(resultsKey) || '[]');
}
