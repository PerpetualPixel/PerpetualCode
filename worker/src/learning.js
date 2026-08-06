/**
 * Self-learning pick algorithm — tracks which picks win/lose and adjusts
 * confidence scoring based on historical accuracy.
 *
 * Every pick is archived with full context (pitcher stats, team splits, odds, analysis).
 * After games resolve, we store outcomes and calculate:
 * - Calibration: Do 54/100 confident picks actually hit 54%?
 * - Feature importance: Which factors (pitcher ERA, day/night, travel) actually matter?
 * - Confidence drift: Is the model becoming overconfident or underconfident?
 *
 * This informs future prompt adjustments and confidence weighting.
 */

/**
 * Log a pick when it's generated, with full context for later analysis.
 * Called immediately after buildPrompt (before Claude processes it).
 */
export async function archivePick(candidate, context, confidence, env, ctx) {
  if (!env.POTD_KV || !candidate.eventId) return;

  const pickId = `pick:${candidate.eventId}:${candidate.sportKey}`;
  const archive = {
    eventId: candidate.eventId,
    sportKey: candidate.sportKey,
    away: candidate.away,
    home: candidate.home,
    commence_time: candidate.commence_time,
    confidence,
    moneyline: candidate.h2h?.home?.odd || null,
    timestamp: Date.now(),
    context: {
      // Store the factors that influenced this pick
      pitcher: context.pitcher || null,
      teamStats: context.teamStats || null,
      isDayGame: context.isDayGame || null,
      weather: context.weather || null,
    },
    analysis: context.analysis || null, // The AI-generated reasoning
  };

  ctx.waitUntil(env.POTD_KV.put(pickId, JSON.stringify(archive), { expirationTtl: 86400 * 365 }));
}

/**
 * Record a pick's outcome after the game resolves.
 * Called from dashboard or scheduled job after game time.
 */
export async function recordOutcome(eventId, sportKey, result, env, ctx) {
  if (!env.POTD_KV) return;

  const pickId = `pick:${eventId}:${sportKey}`;
  const archived = await env.POTD_KV.get(pickId);
  if (!archived) return;

  const pick = JSON.parse(archived);
  pick.result = result; // 'win', 'loss', 'push', or 'pending'
  pick.resolvedAt = Date.now();

  ctx.waitUntil(env.POTD_KV.put(pickId, JSON.stringify(pick), { expirationTtl: 86400 * 365 }));
}

/**
 * Analyze pick accuracy and calibration.
 * Returns stats on whether confidence levels align with actual accuracy.
 */
export async function analyzeAccuracy(env, limit = 500) {
  if (!env.POTD_KV) return null;

  // This would require listing picks from KV — not directly supported.
  // For now, return a placeholder. In production, you'd need a separate
  // analytics DB or paginated KV scan.
  return {
    totalPicks: 0,
    resolvedPicks: 0,
    winRate: null,
    calibration: null, // Should be: actual win% by confidence bucket
    note: 'Requires picks DB integration',
  };
}

/**
 * Calculate feature importance from historical picks.
 * Which factors (pitcher ERA, day/night, etc.) actually drive winners?
 */
export async function analyzeFeatureImportance(env) {
  if (!env.POTD_KV) return null;

  // Placeholder: in production, analyze picks where:
  // - High pitcher ERA diff → did it predict losses?
  // - Day game + away team → did it predict losses?
  // - New pitcher on team → how much adjustment period?
  //
  // Use simple correlation: picks with factor X present, what's the hit rate?
  // vs. picks without factor X, what's the hit rate?

  return {
    pitcherERADiff: { importance: 0, correlation: 0, samples: 0 },
    dayGameAway: { importance: 0, correlation: 0, samples: 0 },
    newTeamAdjustment: { importance: 0, correlation: 0, samples: 0 },
    note: 'Requires picks DB integration',
  };
}

/**
 * Suggest prompt adjustments based on what's working.
 * E.g., if day/night splits are underweighted in Claude's analysis, boost the instruction.
 */
export async function suggestPromptAdjustment(env) {
  const importance = await analyzeFeatureImportance(env);
  if (!importance) return null;

  const suggestions = [];

  // If pitcher ERA matters a lot but Claude isn't emphasizing it, suggest adjustment
  if (importance.pitcherERADiff?.importance > 0.6) {
    suggestions.push({
      factor: 'pitcher_era',
      current: 'emphasized in CRITICAL section',
      suggestion: 'increase weight in Claude prompt',
    });
  }

  // If day/night splits are high-impact, make sure they're prioritized
  if (importance.dayGameAway?.importance > 0.5) {
    suggestions.push({
      factor: 'day_night_splits',
      current: 'included in team stats',
      suggestion: 'add explicit instruction to prioritize away + day game penalty',
    });
  }

  // If new team adjustment isn't mattering, remove the feature
  if (importance.newTeamAdjustment?.importance < 0.2) {
    suggestions.push({
      factor: 'new_team_adjustment',
      current: 'flagged in pitcher info',
      suggestion: 'consider removing or reducing weight',
    });
  }

  return suggestions;
}

/**
 * Generate calibration report: confidence levels vs. actual accuracy.
 * E.g., "Your 54/100 picks hit 52% — well calibrated. Your 51/100 picks only hit 48%."
 */
export function generateCalibrationReport(picks) {
  if (!Array.isArray(picks) || !picks.length) return null;

  // Bucket picks by confidence level (50-51, 52-53, 54-55, etc.)
  const buckets = {};
  for (const pick of picks) {
    if (!pick.result || pick.result === 'pending') continue; // Skip unresolved
    const bucket = Math.floor(pick.confidence / 2) * 2; // Round down to nearest 2%
    if (!buckets[bucket]) buckets[bucket] = { total: 0, wins: 0 };
    buckets[bucket].total++;
    if (pick.result === 'win') buckets[bucket].wins++;
  }

  const report = Object.entries(buckets).map(([confidence, stats]) => ({
    confidenceLevel: Number(confidence),
    sampleSize: stats.total,
    winRate: stats.total > 0 ? (stats.wins / stats.total) * 100 : 0,
    expectedRate: Number(confidence),
    calibrationError: Math.abs((stats.wins / stats.total) * 100 - Number(confidence)),
  }));

  return {
    overallAccuracy: picks.filter((p) => p.result === 'win').length / picks.filter((p) => p.result).length * 100,
    calibration: report,
    wellCalibrated: report.every((r) => r.calibrationError < 5), // Within 5% is good
  };
}

/**
 * Adjust confidence scoring based on historical overfit/underfit.
 * E.g., if 54/100 picks only hit 48%, reduce future 54/100 scores to ~50/100.
 */
export function adjustConfidenceWeight(picks, confidenceLevel) {
  const calibration = generateCalibrationReport(picks);
  if (!calibration) return confidenceLevel;

  const bucket = calibration.calibration.find(
    (b) => b.confidenceLevel === Math.floor(confidenceLevel / 2) * 2,
  );
  if (!bucket || bucket.sampleSize < 10) return confidenceLevel; // Not enough data

  // Scale: if 54% confident picks only hit 48%, reduce this pick's confidence proportionally
  const scaleFactor = bucket.winRate / bucket.expectedRate;
  return Math.round(confidenceLevel * scaleFactor);
}
