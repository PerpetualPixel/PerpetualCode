import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSlipFromImage,
  sanitizeLeg,
  sanitizeExtraction,
  MAX_IMAGE_BASE64_BYTES,
} from '../worker/src/slip-vision.js';

const ENV = { ANTHROPIC_API_KEY: 'test-key' };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A stub Anthropic endpoint returning `text` as the model's reply. */
function replyWith(text, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return {
      ok,
      status,
      json: async () => ({ content: [{ type: 'text', text }] }),
    };
  };
  return { fetchFn, calls };
}

/* ---------------------------------------------------------------- */
/* The request it actually sends                                     */
/* ---------------------------------------------------------------- */

test('sends the image as a vision block alongside the extraction prompt', async () => {
  const { fetchFn, calls } = replyWith(JSON.stringify({ legs: [] }));
  await extractSlipFromImage(PNG, 'image/png', ENV, { fetchFn });

  assert.equal(calls.length, 1);
  const content = calls[0].body.messages[0].content;
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].source.media_type, 'image/png');
  assert.equal(content[0].source.data, PNG, 'the uploaded bytes are what gets read');
  assert.equal(content[1].type, 'text');
  assert.match(content[1].text, /bet slip/i);
});

test('the API key travels in the header and never in the body', async () => {
  const { fetchFn, calls } = replyWith(JSON.stringify({ legs: [] }));
  await extractSlipFromImage(PNG, 'image/png', ENV, { fetchFn });
  assert.equal(calls[0].headers['x-api-key'], 'test-key');
  assert.ok(!JSON.stringify(calls[0].body).includes('test-key'));
});

/* ---------------------------------------------------------------- */
/* Caller errors, with messages meant for the user                   */
/* ---------------------------------------------------------------- */

test('an unconfigured deployment says so rather than failing obscurely', async () => {
  await assert.rejects(
    () => extractSlipFromImage(PNG, 'image/png', {}, { fetchFn: async () => { throw new Error('should not be called'); } }),
    /not configured/i,
  );
});

test('a non-image media type is refused before any spend', async () => {
  let called = false;
  await assert.rejects(
    () => extractSlipFromImage(PNG, 'application/pdf', ENV, { fetchFn: async () => { called = true; } }),
    /Unsupported image type/i,
  );
  assert.equal(called, false, 'a bad type must not reach the paid endpoint');
});

test('an oversized payload is refused before any spend', async () => {
  let called = false;
  await assert.rejects(
    () => extractSlipFromImage('a'.repeat(MAX_IMAGE_BASE64_BYTES + 1), 'image/png', ENV,
      { fetchFn: async () => { called = true; } }),
    /too large/i,
  );
  assert.equal(called, false);
});

test('an upstream failure surfaces the status rather than pretending to have read the slip', async () => {
  const { fetchFn } = replyWith('', { ok: false, status: 529 });
  await assert.rejects(() => extractSlipFromImage(PNG, 'image/png', ENV, { fetchFn }), /529/);
});

/* ---------------------------------------------------------------- */
/* Reading a real reply                                              */
/* ---------------------------------------------------------------- */

const SLIP = {
  legs: [
    { selection: "A'ja Wilson Over 24.5 Points", american: -118, market: 'PROP', confidence: 0.95 },
    { selection: 'Aces ML', american: -240, market: 'MONEYLINE', confidence: 0.9 },
  ],
  slipType: 'PARLAY',
  combinedAmerican: 165,
  stake: 25,
  note: '',
};

test('extracts the legs the reader actually returned', async () => {
  const { fetchFn } = replyWith(JSON.stringify(SLIP));
  const out = await extractSlipFromImage(PNG, 'image/png', ENV, { fetchFn });
  assert.equal(out.legs.length, 2);
  assert.equal(out.legs[0].selection, "A'ja Wilson Over 24.5 Points");
  assert.equal(out.legs[0].american, -118);
  assert.equal(out.slipType, 'PARLAY');
  assert.equal(out.combinedAmerican, 165);
  assert.equal(out.stake, 25);
  assert.equal(out.mocked, false);
});

test('every extracted leg is tagged as coming from an image', async () => {
  const { fetchFn } = replyWith(JSON.stringify(SLIP));
  const out = await extractSlipFromImage(PNG, 'image/png', ENV, { fetchFn });
  assert.ok(out.legs.every((l) => l.source === 'image'));
});

test('a reply wrapped in a markdown fence still parses', async () => {
  const { fetchFn } = replyWith('```json\n' + JSON.stringify(SLIP) + '\n```');
  const out = await extractSlipFromImage(PNG, 'image/png', ENV, { fetchFn });
  assert.equal(out.legs.length, 2);
});

test('a reply with prose around the JSON still parses', async () => {
  const { fetchFn } = replyWith(`Here is the slip:\n${JSON.stringify(SLIP)}\nHope that helps.`);
  const out = await extractSlipFromImage(PNG, 'image/png', ENV, { fetchFn });
  assert.equal(out.legs.length, 2);
});

test('an unparseable reply returns no legs and says why, rather than throwing', async () => {
  const { fetchFn } = replyWith('I could not see anything useful here.');
  const out = await extractSlipFromImage(PNG, 'image/png', ENV, { fetchFn });
  assert.deepEqual(out.legs, []);
  assert.match(out.note, /unreadable|clearer/i);
});

test('an image with no slip in it returns zero legs plus the reader\'s reason', async () => {
  const { fetchFn } = replyWith(JSON.stringify({
    legs: [], slipType: 'UNKNOWN', note: 'This is a photograph of a dog.',
  }));
  const out = await extractSlipFromImage(PNG, 'image/png', ENV, { fetchFn });
  assert.deepEqual(out.legs, []);
  assert.equal(out.note, 'This is a photograph of a dog.');
});

test('zero legs with no reason still gets one, so the UI never shows a blank failure', async () => {
  const { fetchFn } = replyWith(JSON.stringify({ legs: [] }));
  const out = await extractSlipFromImage(PNG, 'image/png', ENV, { fetchFn });
  assert.ok(out.note.length > 0);
});

/* ---------------------------------------------------------------- */
/* Never guess                                                       */
/* ---------------------------------------------------------------- */

test('a leg with no readable selection is dropped, not invented', () => {
  assert.equal(sanitizeLeg({ american: -110, confidence: 0.9 }), null);
  assert.equal(sanitizeLeg({ selection: '   ', american: -110 }), null);
  assert.equal(sanitizeLeg(null), null);
});

test('an illegible price becomes null rather than an estimate', () => {
  assert.equal(sanitizeLeg({ selection: 'X', american: null }).american, null);
  assert.equal(sanitizeLeg({ selection: 'X', american: 'about -110' }).american, null);
});

test('a value inside the impossible -99..+99 band is treated as a misread', () => {
  // Real American odds never sit there, so a 25 is a stake or a line the
  // reader mistook for a price — filling it in would be a fabricated number
  // on a bet the user is holding.
  for (const bogus of [0, 25, -50, 99, -99]) {
    assert.equal(sanitizeLeg({ selection: 'X', american: bogus }).american, null, `accepted ${bogus}`);
  }
  assert.equal(sanitizeLeg({ selection: 'X', american: 100 }).american, 100);
  assert.equal(sanitizeLeg({ selection: 'X', american: -100 }).american, -100);
});

test('a missing confidence becomes a middling 0.5, never an implied certainty', () => {
  assert.equal(sanitizeLeg({ selection: 'X', american: -110 }).confidence, 0.5);
  assert.equal(sanitizeLeg({ selection: 'X', american: -110, confidence: 5 }).confidence, 1);
  assert.equal(sanitizeLeg({ selection: 'X', american: -110, confidence: -2 }).confidence, 0);
});

test('the leg count is capped so a runaway reply cannot flood the drawer', () => {
  const many = { legs: Array.from({ length: 200 }, (_, i) => ({ selection: `Leg ${i}`, american: -110 })) };
  assert.equal(sanitizeExtraction(many).legs.length, 25);
});

test('a malformed legs field yields an empty list rather than throwing', () => {
  assert.deepEqual(sanitizeExtraction({ legs: 'nope' }).legs, []);
  assert.deepEqual(sanitizeExtraction({}).legs, []);
  assert.deepEqual(sanitizeExtraction(null).legs, []);
});

test('a nonsense combined price or stake is dropped rather than carried through', () => {
  const out = sanitizeExtraction({ legs: [], combinedAmerican: 12, stake: -5 });
  assert.equal(out.combinedAmerican, null);
  assert.equal(out.stake, null);
});
