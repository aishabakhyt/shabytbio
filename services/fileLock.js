// Serializes async read-modify-write operations per key so two concurrent
// requests can never race on the same file (e.g. two students saving
// history at the same instant, which could otherwise silently lose one of
// their updates). This is an in-process mutex — correct as long as
// ShabytBio runs as a single Node process, which is the actual deployment
// model here. If this ever scales to multiple processes/machines, this
// would need to become a real distributed lock or a proper database.

const chains = new Map();

function withLock(key, fn) {
  const previous = chains.get(key) || Promise.resolve();

  // Wait for whatever's currently running on this key to settle — regardless
  // of whether it succeeded or failed — then run fn.
  const settled = previous.catch(() => {});
  const run = settled.then(fn);

  // Store a version that never rejects, so one operation's failure can't
  // permanently jam the queue for operations after it. The caller of THIS
  // withLock still gets the real result/error via the returned `run` promise.
  chains.set(key, run.catch(() => {}));

  return run;
}

module.exports = { withLock };
