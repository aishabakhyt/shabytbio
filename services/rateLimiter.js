// Sliding-window rate limiter protecting our Gemini API calls. Instead of
// firing every request immediately and letting Gemini reject the ones over
// the limit with a 429, requests over the limit wait in a queue and get
// released as soon as a slot frees up — so a burst of uploads (e.g. a
// class testing it around the same time) turns into "a few extra seconds
// of wait" instead of "some people see an error."
//
// Default of 5 matches Aisha's confirmed free-tier RPM for Gemini 2.5
// Flash (checked in AI Studio) — bump GEMINI_RPM_LIMIT in .env if that
// changes (e.g. after a billing-tier upgrade or switching models).
const RPM_LIMIT = Number(process.env.GEMINI_RPM_LIMIT) || 5;
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
