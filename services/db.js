const { connectMongo } = require('./mongo');
const { nextSequence } = require('./counters');

// Upload history, now backed by MongoDB Atlas (free tier) instead of a local
// JSON file. Local files don't survive on Render's free tier — no
// persistent disk, and the container filesystem resets on every restart —
// so anything meant to outlive a single request has to live somewhere else.

async function saveUpload({ userId, filename, charCount, focusInstructions, result, qualityWarnings }) {
  const db = await connectMongo();
  const id = await nextSequence(db, 'history');
  const record = {
    id,
    userId,
    filename,
    uploaded_at: new Date().toISOString(),
    char_count: charCount,
    focus_instructions: focusInstructions || '',
    result,
    // Structural rule violations validateStudyPack() found in this exact
    // response (empty array = clean) — kept on the record itself so a
    // pattern of quality drift is visible per-upload, not just in logs
    // that scroll away.
    quality_warnings: Array.isArray(qualityWarnings) ? qualityWarnings : [],
  };
  await db.collection('history').insertOne(record);
  return id;
}

// All reads/deletes are scoped to userId so one student never sees another's history.
async function listUploads(userId) {
  const db = await connectMongo();
  return db.collection('history')
    .find({ userId }, { projection: { _id: 0, result: 0 } }) // omit heavy result payload from the list view
    .sort({ uploaded_at: -1 })
    .toArray();
}

async function getUpload(id, userId) {
  const db = await connectMongo();
  return db.collection('history').findOne({ id, userId }, { projection: { _id: 0 } });
}

async function deleteUpload(id, userId) {
  const db = await connectMongo();
  const res = await db.collection('history').deleteOne({ id, userId });
  return res.deletedCount > 0;
}

module.exports = { saveUpload, listUploads, getUpload, deleteUpload };
