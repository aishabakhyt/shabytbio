// Sliding-window rate limiter protecting our Gemini API calls. Instead of
// firing every request immediately and letting Gemini reject the ones over
// the limit with a 429, requests over the limit wait in a queue and get
// released as soon as a slot frees up — so a burst of uploads (e.g. a
// class testing it around the same time) turns into "a few extra seconds
// of wait" instead of "some people see an error."
//
// 6 Sep 2026: this used to be a single global limiter for one model. Now
// that services/claude.js tries gemini-2.5-flash first and falls back to
// gemini-3.5-flash-lite only once 2.5 Flash's own daily quota is actually
// exhausted (see the comment there for why), each model needs its OWN
// independent window -- they have different real ceilings (2.5 Flash: 5
// RPM / 20 RPD; 3.5 Flash Lite: 15 RPM / 500 RPD, confirmed in AI Studio),
// and Google tracks them as completely separate quotas. createRateLimiter
// builds one such window; callers cap themselves below the real ceiling,
// not exactly at it, because this in-memory counter resets on every server
// restart and can't see requests from any other process sharing the same
// API key -- sitting exactly at the real ceiling still lets 429s through
// (confirmed live, 6 Sep 2026, "getting it constantly" during active
// testing even with a limiter in place).
const WINDOW_MS = 60 * 1000;

function createRateLimiter(rpmLimit) {
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

    while (queue.length && requestTimestamps.length < rpmLimit) {
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
  // surfacing "you're #N in line" type feedback.
  function queueLength() {
    pruneOld();
    return queue.length;
  }

  return { acquireSlot, queueLength, RPM_LIMIT: rpmLimit };
}

// Default/primary instance: matches gemini-2.5-flash's real 5 RPM ceiling,
// capped at 3 for margin. This is the instance routes/upload.js's
// /queue-status endpoint surfaces to students (that's the queue a real
// upload actually waits on first) -- see services/claude.js for where the
// fallback model's own separate limiter is created.
const PRIMARY_RPM_LIMIT = Number(process.env.GEMINI_RPM_LIMIT) || 3;
const primary = createRateLimiter(PRIMARY_RPM_LIMIT);

module.exports = {
  createRateLimiter,
  acquireSlot: primary.acquireSlot,
  queueLength: primary.queueLength,
  RPM_LIMIT: PRIMARY_RPM_LIMIT,
};
