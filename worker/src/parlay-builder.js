/**
 * The Parlay Builder's worker half (2026-10-28 direction, the way
 * breakingballssports.io does it): the legs are built in the app from
 * the Trends rows it already holds (docs/trends.js's legScore scores
 * them), and this module writes the breakdown of one leg on demand: the
 * model reads the line's record, the matchup and the injury report and
 * says why it is a good leg or not. Cached in KV for the day so a leg
 * is read once, not once per viewer.
 */
import { callModel, parseVerdict } from './trend-picks.js';
import { getTrends } from './trends.js';
import { attachSeries, legScore } from '../../docs/trends.js';
import { loadInjuries, injuryFor, loadRoles, roleFor } from './espn-bundle.js';
import { fetchContext, hasContext } from './context.js';
import { etParts } from './potd.js';

const CACHE_SECONDS = 6 * 3600;
const key = (dateKey, rowId) => `parlay:leg:${dateKey}:${rowId}`;

/** The stored Trends row by id, with its series and the injury report, or null. */
export async function findTrendRow(env, sportKey, rowId) {
  const t = await getTrends(env, sportKey);
  const row = (t?.rows ?? []).find((r) => r.id === rowId);
  if (!row) return null;
  const [hydrated] = attachSeries([row], t.logs);
  return { ...hydrated, injury: injuryFor(await loadInjuries(env, sportKey), hydrated.athleteId), role: roleFor(await loadRoles(env, sportKey), hydrated.athleteId) };
}

/** The model's read of one leg: { verdict: 'good' | 'risky', score, summary, reasons: [] }, cached for the day. */
/**
 * The model reads a free service can afford in a day: a line's read is
 * cached for the day, so these count distinct lines, not taps. The site
 * cap holds the bill; the per-person cap keeps one visitor from spending
 * everyone's. Past either, the leg still answers from the record alone.
 */
export const DAILY_MODEL_READS = 400;
export const DAILY_MODEL_READS_PER_PERSON = 30;
const readsKey = (dateKey, who = null) => `parlay:reads:${dateKey}${who ? `:${who}` : ''}`;
const readCount = async (env, k) => Number((await env.POTD_KV.get(k).catch(() => null)) ?? 0) || 0;

/** How many model reads today has used, site-wide and for one visitor. */
export async function modelReadsToday(env, now = Date.now(), who = null) {
  const dateKey = etParts(now).date;
  return { site: await readCount(env, readsKey(dateKey)), person: who ? await readCount(env, readsKey(dateKey, who)) : 0, caps: { site: DAILY_MODEL_READS, person: DAILY_MODEL_READS_PER_PERSON } };
}

export async function legBreakdown(env, sportKey, rowId, ctx, { now = Date.now(), deps = {}, who = null, caps = {} } = {}) {
  const dateKey = etParts(now).date;
  const cached = await env.POTD_KV.get(key(dateKey, rowId)).catch(() => null);
  if (cached) return JSON.parse(cached);
  // The day's budget: past it the leg answers from the record alone, and that answer is kept only briefly so a read follows once the day turns.
  const siteCap = caps.site ?? DAILY_MODEL_READS; const personCap = caps.person ?? DAILY_MODEL_READS_PER_PERSON;
  const used = await modelReadsToday(env, now, who);
  const capped = used.site >= siteCap || (who && used.person >= personCap);
  const row = deps.row ?? await findTrendRow(env, sportKey, rowId);
  if (!row) return null;
  const score = legScore(row);
  // A chance row (first basket): no record to read, the market's own chance and the player's place in the field, no model call.
  if (row.yesNo && Number.isFinite(row.prob)) {
    const field = row.statKey === 'firstTeamBasket' ? 'on the team' : 'in the game';
    const chance = `${Math.round(row.prob * 100)}%`;
    const result = {
      rowId, score, at: now, verdict: score >= 3.5 ? 'good' : 'risky',
      summary: `The market makes ${row.playerName} a ${chance} shot at the ${String(row.marketLabel ?? '').toLowerCase()}, number ${row.fieldRank} of ${row.fieldSize} ${field}; every first-basket price is a long shot, so this leg is for the payout, not the floor.`,
      reasons: [`${chance} chance by the market, the vig taken out across the field`, `Number ${row.fieldRank} of ${row.fieldSize} ${field}`, row.role ? (row.role.starter ? `${row.role.today ? 'Starting today' : 'Started his team\'s last game'}: the first basket goes to the first five` : 'Not a starter: the first basket goes to the first five') : 'Starter status unknown', row.injury ? `Injury report: ${row.injury.status}${row.injury.detail ? `, ${row.injury.detail}` : ''}` : 'Not on the injury report'],
      model: false, capped: false,
    };
    await env.POTD_KV.put(key(dateKey, rowId), JSON.stringify(result), { expirationTtl: CACHE_SECONDS }).catch(() => {});
    return result;
  }
  const p = row.periods ?? {};
  const pct = (x) => (x && Number.isFinite(x.rate) ? `${Math.round(x.rate * 100)}% (${x.hits} of ${x.games})` : 'no games');
  const context = deps.context ? await deps.context(row) : (hasContext(sportKey) ? await fetchContext({ sportKey, home: row.home, away: row.away }, ctx).catch(() => null) : null);
  const facts = [
    `Line: ${row.selection} at ${row.american} (${row.book}). ${row.away} @ ${row.home}.`,
    `Last 5: ${pct(p.l5)}. Last 10: ${pct(p.l10)}. Last 20: ${pct(p.l20)}.${row.seasons?.[0] ? ` This season: ${pct(p[`s${row.seasons[0]}`])}.` : ''}`,
    p.h2h?.games ? `Against ${row.opponent}: ${pct(p.h2h)}.` : `No games against ${row.opponent} in the log.`,
    `Average ${p.l20?.avg ?? '?'}, median ${p.l20?.median ?? '?'} over the last 20; last five values ${(row.series ?? []).slice(0, 5).map((g) => g.value).join(', ')}.`,
    row.injury ? `Injury report: ${row.injury.status}${row.injury.detail ? `, ${row.injury.detail}` : ''}.` : 'Not on the injury report.',
    context?.projection ? `ESPN projects home ${Math.round(context.projection.home)}%, away ${Math.round(context.projection.away)}%.` : null,
    `Pixel score ${score} of 5.`,
  ].filter(Boolean).join('\n');
  const prompt = `You explain one player prop as a parlay leg to a bettor. Use only the facts below and what you know of these teams' rotations and matchups in general; do not invent news.

${facts}

Say whether it is a good leg or a risky one, in plain words, no dashes. Reply with JSON only: {"verdict":"good"|"risky","summary":"<one sentence>","reasons":["<short point>","<short point>","<short point>"]}`;
  const text = capped ? null : deps.model ? await deps.model(prompt) : await callModel(prompt, env);
  if (!capped) {
    // One read spent, site-wide and for this visitor; a soft count (KV is not atomic), which is all a budget needs.
    await env.POTD_KV.put(readsKey(dateKey), String(used.site + 1), { expirationTtl: 2 * 86400 }).catch(() => {});
    if (who) await env.POTD_KV.put(readsKey(dateKey, who), String(used.person + 1), { expirationTtl: 2 * 86400 }).catch(() => {});
  }
  const parsed = parseBreakdown(text);
  const result = {
    rowId, score, at: now,
    verdict: parsed?.verdict ?? (score >= 3.5 ? 'good' : 'risky'),
    summary: parsed?.summary ?? (capped
      ? (score >= 3.5 ? 'The record says the number is safe.' : 'The record is mixed.')
      : (score >= 3.5 ? 'The record says the number is safe; the read was not available.' : 'The record is mixed; the read was not available.')),
    reasons: parsed?.reasons ?? [`Last 10: ${pct(p.l10)}`, `Last 20: ${pct(p.l20)}`, p.h2h?.games ? `Head to head: ${pct(p.h2h)}` : 'No head to head yet'],
    model: Boolean(parsed),
    capped,
  };
  await env.POTD_KV.put(key(dateKey, rowId), JSON.stringify(result), { expirationTtl: capped ? 600 : CACHE_SECONDS }).catch(() => {});
  return result;
}

/** The model's JSON, or null when it sent anything else. */
export function parseBreakdown(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (o.verdict !== 'good' && o.verdict !== 'risky') return null;
    return { verdict: o.verdict, summary: typeof o.summary === 'string' ? o.summary.trim().slice(0, 300) : '', reasons: Array.isArray(o.reasons) ? o.reasons.filter((r) => typeof r === 'string').map((r) => r.trim().slice(0, 160)).slice(0, 4) : [] };
  } catch {
    return null;
  }
}
void parseVerdict;
