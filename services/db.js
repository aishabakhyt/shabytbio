const { connectMongo } = require('./mongo');
const { nextSequence } = require('./counters');

// Upload history, now backed by MongoDB Atlas (free tier) instead of a local
// JSON file. Local files don't survive on Render's free tier — no
// persistent disk, and the container filesystem resets on every restart —
// so anything meant to outlive a single request has to live somewhere else.

async function saveUpload({
  userId, filename, charCount, focusInstructions, result, qualityWarnings,
  extractedText, language, school, grade,
}) {
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
    // Persisted so a later "regenerate in my language" call (see
    // updateUploadResult) can re-run analysis without needing the original
    // file again — a student who switches their profile language after
    // uploading previously had no way to get old content translated short
    // of re-uploading the exact same file. language/school/grade record
    // what the CURRENT result was actually generated with, so the frontend
    // can tell when a saved result no longer matches the student's current
    // profile language and offer to regenerate it.
    extracted_text: extractedText || '',
    language: language || 'en',
    school: school || null,
    grade: grade || null,
  };
  await db.collection('history').insertOne(record);
  return id;
}

// All reads/deletes are scoped to userId so one student never sees another's history.
// extracted_text is omitted from the list view (same reasoning as result: it's
// the heaviest field and the list view never needs it) but language ships
// with every list entry — cheap, and lets the history list itself flag a
// stale-language item without a per-item fetch.
async function listUploads(userId) {
  const db = await connectMongo();
  return db.collection('history')
    .find({ userId }, { projection: { _id: 0, result: 0, extracted_text: 0 } })
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

// Overwrites a record's result (and the language/school/grade it was
// generated with) after a "regenerate in my language" call — same record,
// same id, so it stays in place in the student's history instead of
// spawning a duplicate entry. Returns the updated record, or null if it
// doesn't exist / doesn't belong to this user.
async function updateUploadResult(id, userId, { result, qualityWarnings, language, school, grade }) {
  const db = await connectMongo();
  const res = await db.collection('history').findOneAndUpdate(
    { id, userId },
    {
      $set: {
        result,
        quality_warnings: Array.isArray(qualityWarnings) ? qualityWarnings : [],
        language: language || 'en',
        school: school || null,
        grade: grade || null,
        regenerated_at: new Date().toISOString(),
      },
    },
    { returnDocument: 'after', projection: { _id: 0 } },
  );
  return res && res.value ? res.value : res; // driver-version-safe (some return the doc directly)
}

module.exports = { saveUpload, listUploads, getUpload, deleteUpload, updateUploadResult };
