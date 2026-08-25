/**
 * Repair settled picks whose stored payout is missing or not a number.
 *
 * The symptom is "$NaN" in the tracker where a dollar figure belongs, and it
 * is permanent once written: grading only ever visits picks that are still
 * pending, so a pick settled with a bad payout keeps that payout forever, and
 * fixing the grader only stops NEW ones. Confirmed live on a real record —
 * Gregory Rodrigues at +180 on 2026-08-22 graded WIN and displayed $NaN.
 *
 * How a settled pick ends up with no payout:
 *   - gradeMmaStraight returned a bare { won, detail } with no payout field
 *     at all (the bug fixed in worker/src/ufc-events.js). JSON.stringify then
 *     drops the undefined key entirely, so the stored record has no `payout`
 *     at all and roiPercent serialises to null.
 *   - a record missing `decimal` or `suggested_stake`, which makes the
 *     grader's own arithmetic evaluate to NaN.
 *
 * What this does NOT do is re-decide anything. It never looks at a scoreboard,
 * never calls a grader, and never changes a pick's status: won stays won, lost
 * stays lost. It only recomputes the dollar figure that should already have
 * followed from the pick's own stored price and stake, using the same formula
 * gradePick uses. That is what makes it safe to run over settled history,
 * where regradeMmaTotals (which CAN flip an outcome) is deliberately narrow.
 *
 * Dry run by default — the caller must pass apply:true to write.
 */

import { americanToDecimal, UNIT_DOLLARS } from '../../docs/engine.js';

const KV_TTL_SECONDS = 86400 * 120;

/** ET calendar day, matching every other date key in this worker. */
function etDate(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Whether this settled pick's stored money is unusable and needs rebuilding. */
export function needsPayoutRepair(pick) {
  if (!pick || pick.status === 'pending' || !pick.status) return false;
  // A void is legitimately 0, but only if it actually says 0 — a void with a
  // missing payout renders exactly as broken as a win with one.
  return !isNum(pick.result?.payout);
}

/**
 * The stake and decimal price this pick should have settled at, rebuilt from
 * whatever the record does carry. Returns null when the record genuinely
 * cannot support the arithmetic, so an unfixable pick is reported rather than
 * being written with a guessed number.
 */
export function settlementBasis(pick) {
  // suggested_stake is the tracked record's accounting basis; stakeUnits x
  // the unit dollar value reconstructs it for a record written before
  // suggested_stake existed.
  const stake = isNum(pick?.suggested_stake) && pick.suggested_stake > 0
    ? pick.suggested_stake
    : (isNum(pick?.stakeUnits) && pick.stakeUnits > 0 ? pick.stakeUnits * UNIT_DOLLARS : null);
  if (stake == null) return null;

  // A stored decimal is authoritative; american is the fallback, since the
  // two are the same price in different notation and every record carries at
  // least one. Guard decimal > 1: a 1.0 or 0 would silently make every win
  // pay nothing, which is its own wrong answer rather than a missing one.
  const decimal = isNum(pick?.decimal) && pick.decimal > 1
    ? pick.decimal
    : (isNum(pick?.american) && pick.american !== 0 ? americanToDecimal(pick.american) : null);
  if (decimal == null || !(decimal > 1)) return null;

  return { stake, decimal };
}

/**
 * The {payout, roiPercent} this pick should already have had — the identical
 * formula gradePick applies at settlement (a win pays (decimal - 1) x stake,
 * a loss forfeits the stake, a void returns it). Null when unfixable.
 */
export function repairedResult(pick) {
  const basis = settlementBasis(pick);
  if (!basis) return null;
  if (pick.status === 'void') return { payout: 0, roiPercent: 0 };
  if (pick.status !== 'won' && pick.status !== 'lost') return null;
  const payout = pick.status === 'won'
    ? (basis.decimal - 1) * basis.stake
    : -basis.stake;
  return { payout, roiPercent: (payout / basis.stake) * 100 };
}

/** The date keys to sweep, newest first. */
function recentDateKeys(now, days) {
  return Array.from({ length: days }, (_, i) => etDate(now - i * 86400000));
}

/**
 * Both tracked stores are swept: `track:` holds Pixel's Picks and Play of the
 * Day (what the Tracking Dashboard renders, and where the reported $NaN was),
 * `slate:` holds Full Slate. The same grader writes both, so the same bad
 * payout can land in either.
 */
const STORES = [
  { prefix: 'track', manifestKey: (d) => `track:${d}:top5`, pickKey: (d, id) => `track:${d}:pick:${id}` },
  { prefix: 'slate', manifestKey: (d) => `slate:${d}:manifest`, pickKey: (d, id) => `slate:${d}:pick:${id}` },
];

/** Pick ids in one store's manifest for one day — both manifests carry a `pickIds` array. */
async function manifestIds(env, store, dateKey) {
  const raw = await env.POTD_KV.get(store.manifestKey(dateKey));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.pickIds) ? parsed.pickIds : [];
  } catch {
    return [];
  }
}

const REPAIR_REASON = "payout was missing or NaN; recomputed from the pick's own stored price and stake";

/** Stamp a repaired result onto a pick, preserving everything else already on it. */
function applyRepair(pick, fixed, now) {
  pick.result = {
    ...(pick.result ?? {}),
    payout: fixed.payout,
    roiPercent: fixed.roiPercent,
    // Provenance, same convention as regradeMmaTotals: a settled record that
    // changed after the fact must always say why.
    repairedAt: now,
    repairedReason: REPAIR_REASON,
  };
}

export async function repairMissingPayouts(env, ctx, now = Date.now(), { days = 30, apply = false } = {}) {
  const repaired = [];
  const unfixable = [];
  let checked = 0;

  const consider = async (pick, label, write) => {
    checked += 1;
    if (!needsPayoutRepair(pick)) return;
    const fixed = repairedResult(pick);
    if (!fixed) {
      // No stake or no price on the record: there is no honest number to
      // write, so report it rather than inventing one.
      unfixable.push({ ...label, reason: 'record carries no usable stake or price' });
      return;
    }
    if (apply) {
      applyRepair(pick, fixed, now);
      await write();
    }
    repaired.push({ ...label, payout: fixed.payout, roiPercent: fixed.roiPercent });
  };

  const labelFor = (pick, store, dateKey, id) => ({
    store,
    dateKey,
    pickId: pick.pickId ?? id ?? null,
    matchup: [pick.away, pick.home].filter(Boolean).join(' @ '),
    selection: pick.selection ?? pick.outcomeName ?? null,
    american: pick.american ?? null,
    status: pick.status,
  });

  for (const dateKey of recentDateKeys(now, days)) {
    // Manifest-indexed stores: Pixel's Picks and Full Slate.
    for (const store of STORES) {
      for (const id of await manifestIds(env, store, dateKey)) {
        const key = store.pickKey(dateKey, id);
        const raw = await env.POTD_KV.get(key);
        if (!raw) continue;
        let pick;
        try {
          pick = JSON.parse(raw);
        } catch {
          continue;
        }
        await consider(
          pick,
          labelFor(pick, store.prefix, dateKey, id),
          () => env.POTD_KV.put(key, JSON.stringify(pick), { expirationTtl: KV_TTL_SECONDS }),
        );
      }
    }

    // Play of the Day is stored differently: one record per day at
    // `potd:<date>` with the pick nested inside it, rather than a manifest
    // and one key per pick. It runs through the identical grader, so it can
    // carry the identical bad payout and must be swept too.
    const potdRaw = await env.POTD_KV.get(`potd:${dateKey}`);
    if (!potdRaw) continue;
    let record;
    try {
      record = JSON.parse(potdRaw);
    } catch {
      continue;
    }
    if (!record?.pick) continue;
    await consider(
      record.pick,
      labelFor(record.pick, 'potd', dateKey, record.pick.pickId),
      () => env.POTD_KV.put(`potd:${dateKey}`, JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS }),
    );
  }

  return { apply, days, checked, repairedCount: repaired.length, repaired, unfixable };
}
