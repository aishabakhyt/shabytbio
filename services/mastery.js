const { connectMongo } = require('./mongo');
const { nextSequence } = require('./counters');

// Spaced-repetition tracking for self_test questions, so a student's
// progress persists ACROSS uploads instead of resetting every time they
// study new material. Backed by MongoDB Atlas (free tier) — see
// services/db.js for why local JSON files don't work for a real deployment.

// A lightweight variant of the SM-2 spaced-repetition algorithm (the same
// family Anki is built on), simplified to 4 self-graded buttons. It's not
// meant to be a research-grade implementation — it's meant to give a
// genuinely useful "what should I review today" queue without needing a
// real backend or ML.
const MIN_EASE = 1.3;
const GRADE_DELTAS = { again: -0.3, hard: -0.15, good: 0, easy: 0.15 };
const MASTERED_REPETITIONS = 4; // consecutive "good"/"easy" reviews
const MASTERED_INTERVAL_DAYS = 21; // ...and a long enough gap between them
const VALID_GRADES = ['again', 'hard', 'good', 'easy'];

// Called right after a successful upload — turns that upload's self_test
// questions into trackable review items, due immediately so they show up
// in the next review session.
async function seedFromSelfTest({ userId, uploadId, filename, selfTest }) {
  if (!Array.isArray(selfTest) || selfTest.length === 0) return [];
  const db = await connectMongo();
  const now = new Date().toISOString();

  // Re-uploading the same material (re-testing a file, or a cache hit off
  // a classmate's identical upload) used to blindly insert a fresh copy of
  // every question every time — silently duplicating the review queue and
  // resetting progress on questions the student had already been tracking.
  // Dedup by (userId, question text): a repeat question keeps its existing
  // spaced-repetition progress instead of spawning a clone due immediately.
  const questions = selfTest.map(item => item.question || '').filter(Boolean);
  const existing = questions.length
    ? await db.collection('mastery')
        .find({ userId, question: { $in: questions } }, { projection: { question: 1 } })
        .toArray()
    : [];
  const alreadyTracked = new Set(existing.map(e => e.question));

  const docs = [];
  for (const item of selfTest) {
    const question = item.question || '';
    if (question && alreadyTracked.has(question)) continue;
    const id = await nextSequence(db, 'mastery');
    docs.push({
      id,
      userId,
      uploadId: uploadId || null,
      sourceFilename: filename || '',
      question,
      answer: item.answer || '',
      type: item.type || 'recall',
      createdAt: now,
      interval: 0,
      easeFactor: 2.5,
      repetitions: 0,
      nextReviewAt: now, // due right away
      lastReviewedAt: null,
      lastGrade: null,
      archived: false,
    });
  }

  if (docs.length) await db.collection('mastery').insertMany(docs);
  return docs;
}

async function getById(id, userId) {
  const db = await connectMongo();
  return db.collection('mastery').findOne({ id, userId }, { projection: { _id: 0 } });
}

// Archived topics (a student's own choice to pause reviewing something —
// e.g. last year's material) are excluded from the due queue and counts by
// default. `archived: { $ne: true }` treats older records with no archived
// field at all (from before this feature existed) as not archived, so no
// migration/backfill was needed for existing data.
const NOT_ARCHIVED = { archived: { $ne: true } };

async function listDue(userId, limit = 20) {
  const db = await connectMongo();
  const now = new Date().toISOString();
  return db.collection('mastery')
    .find({ userId, nextReviewAt: { $lte: now }, ...NOT_ARCHIVED }, { projection: { _id: 0 } })
    .sort({ nextReviewAt: 1 })
    .limit(limit)
    .toArray();
}

async function getStats(userId) {
  const db = await connectMongo();
  const col = db.collection('mastery');
  const now = new Date().toISOString();
  const [totalTracked, dueCount, masteredCount] = await Promise.all([
    col.countDocuments({ userId, ...NOT_ARCHIVED }),
    col.countDocuments({ userId, nextReviewAt: { $lte: now }, ...NOT_ARCHIVED }),
    col.countDocuments({
      userId,
      repetitions: { $gte: MASTERED_REPETITIONS },
      interval: { $gte: MASTERED_INTERVAL_DAYS },
      ...NOT_ARCHIVED,
    }),
  ]);
  return { totalTracked, dueCount, masteredCount };
}

// Groups a student's review items by source material so they can see their
// review queue divided by topic instead of one undifferentiated pile, and
// choose which topics stay in the long-term rotation (e.g. pause last
// year's material without losing progress on it — archiving, not deleting).
async function listTopics(userId) {
  const db = await connectMongo();
  const now = new Date().toISOString();
  return db.collection('mastery').aggregate([
    { $match: { userId } },
    {
      $group: {
        _id: '$sourceFilename',
        total: { $sum: 1 },
        due: { $sum: { $cond: [{ $and: [{ $lte: ['$nextReviewAt', now] }, { $ne: ['$archived', true] }] }, 1, 0] } },
        archived: { $max: { $cond: [{ $eq: ['$archived', true] }, 1, 0] } }, // 1 if ALL items in this topic are archived
        allArchived: { $min: { $cond: [{ $eq: ['$archived', true] }, 1, 0] } },
        latestCreatedAt: { $max: '$createdAt' },
      },
    },
    { $sort: { latestCreatedAt: -1 } },
  ]).toArray().then(rows => rows.map(r => ({
    sourceFilename: r._id || '(untitled)',
    total: r.total,
    due: r.due,
    archived: r.allArchived === 1, // only show as "archived" if the whole topic is paused
  })));
}

async function setTopicArchived(userId, sourceFilename, archived) {
  const db = await connectMongo();
  const result = await db.collection('mastery').updateMany(
    { userId, sourceFilename },
    { $set: { archived: !!archived } }
  );
  return { matched: result.matchedCount };
}

// Applies one review's outcome and returns the updated record (or null if
// the item doesn't exist / doesn't belong to this user).
//
// Note: this does a read-then-write rather than a single atomic Mongo
// operation, because the new interval/ease depend on the current values.
// That's a known, accepted simplification — the only way it could go wrong
// is the SAME student grading the SAME question twice within milliseconds
// of each other, which would at worst slightly miscalculate one review
// interval, not lose or corrupt any data.
async function gradeReview(id, userId, grade) {
  if (!VALID_GRADES.includes(grade)) {
    throw new Error(`Invalid grade — must be one of ${VALID_GRADES.join(', ')}.`);
  }
  const db = await connectMongo();
  const col = db.collection('mastery');
  const record = await col.findOne({ id, userId });
  if (!record) return null;

  record.easeFactor = Math.max(MIN_EASE, record.easeFactor + GRADE_DELTAS[grade]);

  if (grade === 'again') {
    record.repetitions = 0;
    record.interval = 1;
  } else {
    record.repetitions += 1;
    if (record.repetitions === 1) {
      record.interval = 1;
    } else if (record.repetitions === 2) {
      record.interval = 3;
    } else {
      const multiplier = grade === 'easy' ? record.easeFactor * 1.3 : record.easeFactor;
      record.interval = Math.round(Math.max(1, record.interval) * multiplier);
    }
  }

  const now = new Date();
  record.lastReviewedAt = now.toISOString();
  record.lastGrade = grade;
  record.nextReviewAt = new Date(now.getTime() + record.interval * 24 * 60 * 60 * 1000).toISOString();

  await col.updateOne({ id, userId }, {
    $set: {
      easeFactor: record.easeFactor,
      repetitions: record.repetitions,
      interval: record.interval,
      lastReviewedAt: record.lastReviewedAt,
      lastGrade: record.lastGrade,
      nextReviewAt: record.nextReviewAt,
    },
  });

  return record;
}

module.exports = { seedFromSelfTest, listDue, getStats, gradeReview, getById, listTopics, setTopicArchived, VALID_GRADES };
