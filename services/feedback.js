const { connectMongo } = require('./mongo');
const { nextSequence } = require('./counters');

// Student-submitted feedback/bug reports -- separate from quality_warnings
// (which is Gemini's OWN output being auto-checked) and from grade_history
// (which is grading accuracy over time). This is the one Aisha asked for
// specifically: "a place where they can report it to me and i see it."
async function submitFeedback({ userId, userEmail, message, page }) {
  const trimmed = (message || '').trim();
  if (!trimmed) {
    throw new Error('Feedback message is required.');
  }
  if (trimmed.length > 2000) {
    throw new Error('Feedback is too long (max 2000 characters).');
  }
  const db = await connectMongo();
  const id = await nextSequence(db, 'feedback');
  const doc = {
    id,
    userId,
    userEmail: userEmail || null,
    message: trimmed,
    page: page || null, // which tab/screen they were on when they submitted, for context
    createdAt: new Date().toISOString(),
  };
  await db.collection('feedback').insertOne(doc);
  return doc;
}

// Newest first -- Aisha wants to see what just came in, not scroll to the bottom.
async function listFeedback(limit = 200) {
  const db = await connectMongo();
  return db.collection('feedback')
    .find({}, { projection: { _id: 0 } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

module.exports = { submitFeedback, listFeedback };
