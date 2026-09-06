// Sliding-window rate limiter protecting our Gemini API calls. Instead of
// firing every request immediately and letting Gemini reject the ones over
// the limit with a 429, requests over the limit wait in a queue and get
// released as soon as a slot frees up — so a burst of uploads (e.g. a
// class testing it around the same time) turns into "a few extra seconds
// of wait" instead of "some people see an error."
//
// Switched underlying model to gemini-3.5-flash-lite (see services/claude.js)
// after gemini-2.5-flash's free tier (5 RPM / 20 RPD) got fully used up by
// launch-day testing alone, with no billing available as an option.
// Flash-Lite's free tier is 15 RPM / 500 RPD (confirmed in AI Studio) --
// capping ourselves at 10, not 15, leaves real margin: this in-memory
// counter resets on every server restart and can't see requests from any
// other process sharing the same API key, so sitting exactly at the real
// ceiling still lets 429s through (confirmed live, 6 Sep 2026). There's no
// equivalent in-app guard for the 500 RPD ceiling yet -- at a small beta's
// volume that's unlikely to matter, but if it ever does, the fix is the
// same idea (track a rolling 24h window here too), not a bigger RPM
// number. Bump GEMINI_RPM_LIMIT in .env after a billing-tier upgrade.
const RPM_LIMIT = Number(process.env.GEMINI_RPM_LIMIT) || 10;
const WINDOW_MS = 60 * 1000;

const requestTimestamps = []; // when each in-window request was released
const queue = []; // FIFO of pending { resolve }
let drainScheduled = false;

function pruneOld() {
  const cutoff = Date.now() - WINDOW_MS;
  while (requestTimestamps.length && requestTimestamps[0] <= cutoff) {
    requestTimestamps.shift();
  }
}

function drainQueue() {
  drainScheduled = false;
  pruneOld();

  while (queue.length && requestTimestamps.length < RPM_LIMIT) {
    const next = queue.shift();
    requestTimestamps.push(Date.now());
    next.resolve();
  }

  if (queue.length && !drainScheduled) {
    // Nothing more can go out until the oldest in-window request ages out.
    const oldest = requestTimestamps[0];
    const delay = Math.max(50, oldest + WINDOW_MS - Date.now());
    drainScheduled = true;
    setTimeout(drainQueue, delay);
  }
}

// Resolves once it's safe to make a request without exceeding the rate
// limit — immediately if there's headroom, otherwise after waiting in line.
function acquireSlot() {
  return new Promise(resolve => {
    queue.push({ resolve });
    drainQueue();
  });
}

// How many requests are currently waiting their turn — useful for
// surfacing "you're #N in line" type feedback if we want it later.
function queueLength() {
  pruneOld();
  return queue.length;
}

module.exports = { acquireSlot, queueLength, RPM_LIMIT };
