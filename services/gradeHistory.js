const { connectMongo } = require('./mongo');
const { nextSequence } = require('./counters');

// Records the outcome of every AI-graded review answer (correct/partial/
// incorrect) over time -- separate from the spaced-repetition scheduling
// data in mastery.js (interval/easeFactor/repetitions), which only tracks
// WHEN to show a question again, not how the student actually did on it.
// Before this existed, a grade-answer verdict was used once to render
// feedback and then thrown away -- there was no way to ever compute a real
// "quiz accuracy improved over time" number, and that history can't be
// created retroactively, so the sooner this starts logging the more
// baseline data exists later. Best-effort and fire-and-forget by design
// (see the .catch() at the call site in routes/mastery.js) -- a logging
// failure should never affect the student-facing grading response.
async function logGradeResult({ userId, masteryItemId, uploadId, sourceFilename, verdict }) {
  if (!['correct', 'partial', 'incorrect'].includes(verdict)) return null; // ignore malformed/unexpected verdicts rather than polluting the history
  const db = await connectMongo();
  const id = await nextSequence(db, 'grade_history');
  const doc = {
    id,
    userId,
    masteryItemId: masteryItemId || null,
    uploadId: uploadId || null,
    sourceFilename: sourceFilename || '',
    verdict,
    gradedAt: new Date().toISOString(),
  };
  await db.collection('grade_history').insertOne(doc);
  return doc;
}

module.exports = { logGradeResult };
