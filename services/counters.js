// Small helper for generating simple sequential integer IDs (1, 2, 3...) in
// MongoDB, the same way the old JSON-file storage used to via
// Math.max(...ids) + 1. Keeps IDs short and human-readable in URLs/logs
// instead of switching every record to a Mongo ObjectId string.
//
// findOneAndUpdate's $inc + upsert is atomic at the document level, so this
// is concurrency-safe without needing our own mutex the way the old
// JSON-file version did.
async function nextSequence(db, name) {
  const doc = await db.collection('counters').findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return doc.seq;
}

module.exports = { nextSequence };
