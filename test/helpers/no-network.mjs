/**
 * Loaded before every test file (NODE_OPTIONS=--import=./test/helpers/no-network.mjs):
 * the tests never reach the network.
 *
 * Some of them count on that without saying so ("no events list reachable",
 * "the only write is the hold record"): written where outbound calls fail,
 * they pass there and fail on a machine that can reach the odds feed, where
 * a refused call is recorded as a refusal instead of thrown. That is a
 * runner in CI. So the suite brings its own weather: a call to the real
 * network fails the way an unreachable host does, on every machine, and a
 * test that needs a response stubs globalThis.fetch itself, as they do.
 */
globalThis.fetch = async (input) => {
  throw new TypeError(`fetch failed: no network in tests (${String(input?.url ?? input).slice(0, 120)})`);
};
