/**
 * Build the tennis history dataset the pick insights read from.
 *
 * Why this exists as a build step rather than a live fetch: ESPN — which covers
 * NFL, MLB and soccer well — carries nothing usable for tennis. Its tennis
 * athletes have no ids at all, and the summary endpoint 400s. The one free
 * source with real depth is tennis-data.co.uk, which publishes a season per
 * spreadsheet. Spreadsheets are the wrong thing to parse on every request, so
 * we flatten them here and ship the result as a static asset.
 *
 * Usage:
 *   node scripts/build-tennis-data.mjs          # current + previous season
 *   node scripts/build-tennis-data.mjs 2024 2025 2026
 *
 * Source: http://www.tennis-data.co.uk/alldata.php (free, robots-permitted).
 * Re-run it every week or so; matches only accumulate.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const OUT_DIR = path.join(process.cwd(), 'docs', 'data');
const TOURS = { atp: (y) => `${y}`, wta: (y) => `${y}w` };
const EPOCH = Date.UTC(2000, 0, 1); // day numbers are relative to this

/* ------------------------------------------------------------------ */
/* Minimal xlsx reader                                                 */
/* ------------------------------------------------------------------ */

/** Unzip via the platform's own tooling so this script needs no dependencies. */
function unzip(buffer) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tennis-'));
  // Must end in .zip: PowerShell's Expand-Archive refuses an .xlsx by extension
  // even though the bytes are a perfectly ordinary zip.
  const zipPath = path.join(tmp, 'book.zip');
  const outDir = path.join(tmp, 'out');
  fs.writeFileSync(zipPath, buffer);

  const attempts = [
    ['unzip', ['-o', '-q', zipPath, '-d', outDir]],
    ['powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`]],
  ];

  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, { stdio: 'ignore' });
      if (fs.existsSync(path.join(outDir, 'xl'))) return outDir;
    } catch {
      /* try the next tool */
    }
  }
  throw new Error('Could not unzip the workbook — need either `unzip` or PowerShell.');
}

const decode = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

/** Read one sheet into rows of plain strings, keyed by header name. */
function readSheet(dir) {
  const sharedXml = fs.readFileSync(path.join(dir, 'xl', 'sharedStrings.xml'), 'utf8');
  // <si> can hold several <t> runs when a cell has mixed formatting.
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) =>
    decode([...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')),
  );

  const sheetXml = fs.readFileSync(
    path.join(dir, 'xl', 'worksheets', 'sheet1.xml'), 'utf8',
  );

  const rows = [];
  for (const [, attrs, body] of sheetXml.matchAll(/<row([^>]*)>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const [, ref, type, inner] of body.matchAll(
      /<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g,
    )) {
      const raw = (inner.match(/<v>([\s\S]*?)<\/v>/) ?? [])[1];
      if (raw == null) continue;
      cells[ref] = / t="s"/.test(type) ? shared[+raw] : decode(raw);
    }
    if (Object.keys(cells).length) rows.push(cells);
  }
  if (!rows.length) return [];

  const header = rows[0];
  return rows.slice(1).map((cells) => {
    const out = {};
    for (const [col, name] of Object.entries(header)) out[name] = cells[col];
    return out;
  });
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

/** Excel stores dates as days since 1899-12-30. */
const excelDateToDayNum = (serial) =>
  Math.round((Date.UTC(1899, 11, 30) + Number(serial) * 86400000 - EPOCH) / 86400000);

async function buildTour(tour, years) {
  const players = [];
  const playerIndex = new Map();
  const surfaces = [];
  const surfaceIndex = new Map();
  const courts = [];
  const courtIndex = new Map();
  const rounds = [];
  const roundIndex = new Map();

  const intern = (list, index, value) => {
    const key = String(value ?? '').trim();
    if (!key) return -1;
    if (!index.has(key)) { index.set(key, list.length); list.push(key); }
    return index.get(key);
  };

  const matches = [];

  for (const year of years) {
    const url = `http://www.tennis-data.co.uk/${TOURS[tour](year)}/${year}.xlsx`;
    process.stdout.write(`  ${tour} ${year} … `);

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      redirect: 'follow',
    });
    if (!response.ok) { console.log(`skipped (HTTP ${response.status})`); continue; }

    const dir = unzip(Buffer.from(await response.arrayBuffer()));
    let kept = 0;

    for (const row of readSheet(dir)) {
      const winner = row.Winner;
      const loser = row.Loser;
      if (!winner || !loser || !row.Date) continue;

      const day = excelDateToDayNum(row.Date);
      if (!Number.isFinite(day)) continue;

      // W1..W5/L1..L5 are per-set games for the match winner/loser — the
      // feed's own set-by-set scoreline. Used to derive two things this
      // dataset otherwise has no way to know: how many sets a match actually
      // took (a fatigue/grind proxy — a player closing matches in straight
      // sets recently is carrying a different physical load than one needing
      // five), and which sets went to a tiebreak, and who won it (7-6 for
      // that set means the winner's-column player took the breaker; 6-7
      // means the match's overall LOSER won that particular set's breaker).
      // Previously discarded entirely — the only thing kept from these rows
      // was the retirement flag below.
      let sets = 0;
      let tbWinnerSets = 0;
      let tbLoserSets = 0;
      for (let i = 1; i <= 5; i++) {
        const w = Number(row[`W${i}`]);
        const l = Number(row[`L${i}`]);
        if (!Number.isFinite(w) || !Number.isFinite(l) || (row[`W${i}`] ?? '') === '' || (row[`L${i}`] ?? '') === '') continue;
        sets++;
        if (w === 7 && l === 6) tbWinnerSets++;
        else if (w === 6 && l === 7) tbLoserSets++;
      }

      matches.push([
        day,
        intern(surfaces, surfaceIndex, row.Surface),
        // "Indoor" | "Outdoor" — only meaningfully varies for Hard; Clay and
        // Grass are effectively always Outdoor in this feed, but read
        // directly from the row rather than assumed, same as everything else.
        intern(courts, courtIndex, row.Court),
        intern(rounds, roundIndex, row.Round),
        intern(players, playerIndex, winner),
        intern(players, playerIndex, loser),
        Number(row.WRank) || 0,
        Number(row.LRank) || 0,
        // "Completed" | "Retired" | "Walkover" — a retirement is the closest
        // thing to an injury signal this feed carries.
        /retired|walkover/i.test(row.Comment ?? '') ? 1 : 0,
        sets,
        tbWinnerSets,
        tbLoserSets,
      ]);
      kept++;
    }

    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`${kept} matches`);
  }

  matches.sort((a, b) => a[0] - b[0]);

  return {
    tour,
    updated: new Date().toISOString().slice(0, 10),
    epoch: '2000-01-01',
    seasons: years,
    // Columns of each match tuple, so the reader never guesses at positions.
    fields: ['day', 'surface', 'court', 'round', 'winner', 'loser', 'wRank', 'lRank', 'retired'],
    players,
    surfaces,
    courts,
    rounds,
    matches,
  };
}

const argYears = process.argv.slice(2).filter((a) => /^\d{4}$/.test(a)).map(Number);
const thisYear = new Date().getUTCFullYear();
const years = argYears.length ? argYears : [thisYear - 1, thisYear];

fs.mkdirSync(OUT_DIR, { recursive: true });

let failed = false;

for (const tour of Object.keys(TOURS)) {
  console.log(`${tour.toUpperCase()}:`);
  const data = await buildTour(tour, years);
  const file = path.join(OUT_DIR, `tennis-${tour}.json`);

  // Never overwrite a good archive with an empty one. Every download failing
  // (tennis-data.co.uk 403s datacenter IPs, and any site can be down) used to
  // still write a 0-match file straight over the real one — and because the
  // tennis form gate treats a missing archive as "no evidence", the silent
  // result was every straight-moneyline underdog blocked on both tours until
  // someone noticed the picks had gone strange. A build that fetched nothing
  // is a failed build, not an empty dataset.
  if (!data.matches.length) {
    failed = true;
    const kept = fs.existsSync(file);
    console.log(
      `  -> NOT WRITTEN — every download failed, so there is nothing to build.\n` +
      `     ${kept ? `Left ${path.relative(process.cwd(), file)} as it was.` : `No existing ${path.relative(process.cwd(), file)} to fall back on.`}\n`,
    );
    continue;
  }

  fs.writeFileSync(file, JSON.stringify(data));
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  console.log(
    `  -> ${path.relative(process.cwd(), file)} · ${data.matches.length} matches · ` +
    `${data.players.length} players · ${kb}kb\n`,
  );
}

// Non-zero exit so this can't pass silently in a script or scheduled job.
if (failed) {
  console.error('Build incomplete: at least one tour fetched no data. Existing archives were left untouched.');
  process.exit(1);
}
