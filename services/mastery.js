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

// How many days without a review before a topic is flagged as needing
// attention on the dashboard — a student who hasn't touched a topic in over
// a week is the kind of gentle nudge this is meant to give ("Unit X needs
// attention" per Aisha's spec), without being so aggressive it fires after
// a single day off.
const NEGLECTED_TOPIC_DAYS = 10;

// Powers the "Your Progress" dashboard — a study streak (consecutive days
// with real activity, plus the longest streak ever reached), overall
// mastery count, and a per-topic progress map. Built from data that already
// exists (review timestamps, upload timestamps, mastery repetitions/
// intervals) rather than a new tracked field, so it works retroactively for
// every student's existing history instead of only counting activity from
// the day this feature shipped.
async function getDashboard(userId) {
  const db = await connectMongo();
  const masteryCol = db.collection('mastery');
  const historyCol = db.collection('history');
  const now = new Date().toISOString();

  const [totalTracked, dueCount, masteredCount, reviewDates, uploadDates, topicRows] = await Promise.all([
    masteryCol.countDocuments({ userId, ...NOT_ARCHIVED }),
    masteryCol.countDocuments({ userId, nextReviewAt: { $lte: now }, ...NOT_ARCHIVED }),
    masteryCol.countDocuments({
      userId,
      repetitions: { $gte: MASTERED_REPETITIONS },
      interval: { $gte: MASTERED_INTERVAL_DAYS },
      ...NOT_ARCHIVED,
    }),
    masteryCol.distinct('lastReviewedAt', { userId, lastReviewedAt: { $ne: null } }),
    historyCol.distinct('uploaded_at', { userId }),
    masteryCol.aggregate([
      { $match: { userId } },
      {
        $group: {
          _id: '$sourceFilename',
          total: { $sum: 1 },
          mastered: {
            $sum: {
              $cond: [
                { $and: [{ $gte: ['$repetitions', MASTERED_REPETITIONS] }, { $gte: ['$interval', MASTERED_INTERVAL_DAYS] }] },
                1,
                0,
              ],
            },
          },
          totalRepetitions: { $sum: '$repetitions' },
          lastReviewedAt: { $max: '$lastReviewedAt' },
          allArchived: { $min: { $cond: [{ $eq: ['$archived', true] }, 1, 0] } },
          label: { $first: { $ifNull: ['$topicLabel', '$sourceFilename'] } },
          examDate: { $first: '$examDate' },
          latestCreatedAt: { $max: '$createdAt' },
        },
      },
      { $match: { allArchived: { $ne: 1 } } }, // paused topics don't clutter the motivational view
      { $sort: { latestCreatedAt: -1 } },
    ]).toArray(),
  ]);

  // Collapse every timestamp down to its UTC calendar date — the exact time
  // of day doesn't matter for a streak, only which days had any activity.
  const activeDates = new Set();
  for (const d of reviewDates) if (d) activeDates.add(String(d).slice(0, 10));
  for (const d of uploadDates) if (d) activeDates.add(String(d).slice(0, 10));

  // Counts consecutive active days ending today OR yesterday — a student
  // who studied every day through yesterday but hasn't opened the app yet
  // today shouldn't see their streak reset to 0 before the day is even over.
  let streak = 0;
  const cursor = new Date();
  if (activeDates.has(cursor.toISOString().slice(0, 10))) streak++;
  cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (activeDates.has(cursor.toISOString().slice(0, 10))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  // Longest streak ever, scanning the full activity history — powers the
  // "comeback" framing (a broken streak isn't shown as "back to zero", it's
  // shown next to the record it can beat again) and the weekly/monthly
  // streak record Aisha's spec asked for.
  const sortedDates = [...activeDates].sort();
  let longestStreak = 0;
  let run = 0;
  let prevDate = null;
  for (const dateStr of sortedDates) {
    if (prevDate) {
      const prev = new Date(prevDate);
      const cur = new Date(dateStr);
      const dayGap = Math.round((cur - prev) / (24 * 60 * 60 * 1000));
      run = dayGap === 1 ? run + 1 : 1;
    } else {
      run = 1;
    }
    longestStreak = Math.max(longestStreak, run);
    prevDate = dateStr;
  }

  // Last 7 calendar days (oldest first) as a simple active/inactive list —
  // powers a Duolingo/GitHub-style dot row on the dashboard so the streak is
  // self-evident at a glance instead of needing a text explanation of the
  // underlying rule.
  const last7Days = [];
  const dayCursor = new Date();
  dayCursor.setUTCDate(dayCursor.getUTCDate() - 6);
  const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  for (let i = 0; i < 7; i++) {
    const dateStr = dayCursor.toISOString().slice(0, 10);
    last7Days.push({
      label: WEEKDAY_LABELS[dayCursor.getUTCDay()],
      active: activeDates.has(dateStr),
      isToday: i === 6,
    });
    dayCursor.setUTCDate(dayCursor.getUTCDate() + 1);
  }

  const nowMs = Date.now();
  const todayStr = new Date(nowMs).toISOString().slice(0, 10);
  const topics = topicRows.map(r => {
    const avgRepetitions = r.total ? r.totalRepetitions / r.total : 0;
    // grey (not studied), light (studied a little), deep (reviewed several
    // times) — mirrors Aisha's "unstudied / studied once / reviewed
    // multiple times" color scale, using average repetitions per item as
    // the signal since it reflects real review activity, not just presence.
    const status = avgRepetitions === 0 ? 'unstudied' : avgRepetitions < 2 ? 'light' : 'deep';
    const daysSinceReview = r.lastReviewedAt
      ? Math.floor((nowMs - new Date(r.lastReviewedAt).getTime()) / (24 * 60 * 60 * 1000))
      : null;
    // Exam date is per-topic (set via setTopicExamDate), stored as a plain
    // 'YYYY-MM-DD' string — diffed against today's UTC date, not a precise
    // timestamp, since "days until the exam" is a calendar concept.
    const daysUntilExam = r.examDate
      ? Math.round((new Date(r.examDate) - new Date(todayStr)) / (24 * 60 * 60 * 1000))
      : null;
    return {
      sourceFilename: r._id || '(untitled)',
      label: r.label || r._id || '(untitled)',
      total: r.total,
      mastered: r.mastered,
      status,
      // Only flag as neglected if it's been studied before and then went
      // quiet — a topic that's simply new isn't "needs attention" yet.
      needsAttention: daysSinceReview !== null && daysSinceReview >= NEGLECTED_TOPIC_DAYS,
      examDate: r.examDate || null,
      daysUntilExam,
    };
  });

  // Only surface exam reminders once a summative is actually close —
  // Aisha's spec calls for acknowledging it "close to a summative date",
  // not turning every topic into a countdown. Past exam dates don't need
  // reminding, so those are dropped once they're behind today.
  const EXAM_REMINDER_WINDOW_DAYS = 30;
  const examReminders = topics
    .filter(t => t.daysUntilExam !== null && t.daysUntilExam >= 0 && t.daysUntilExam <= EXAM_REMINDER_WINDOW_DAYS)
    .sort((a, b) => a.daysUntilExam - b.daysUntilExam)
    .slice(0, 3)
    .map(t => ({ label: t.label, daysUntilExam: t.daysUntilExam, mastered: t.mastered, total: t.total }));

  return { streak, longestStreak, masteredCount, totalTracked, dueCount, topics, examReminders, last7Days };
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
        allArchived: { $min: { $cond: [{ $eq: ['$archived', true] }, 1, 0] } },
        latestCreatedAt: { $max: '$createdAt' },
        // Presentation filenames are often unclear (e.g. auto-generated
        // export names) — a custom label set via renameTopic() takes over
        // display everywhere it exists, falling back to the raw filename.
        // $topicLabel is set uniformly on every doc in the group by
        // renameTopic, so any single doc's value represents the whole topic.
        label: { $first: { $ifNull: ['$topicLabel', '$sourceFilename'] } },
        examDate: { $first: '$examDate' },
        uploadIds: { $addToSet: '$uploadId' },
      },
    },
    { $sort: { latestCreatedAt: -1 } },
  ]).toArray().then(rows => rows.map(r => ({
    sourceFilename: r._id || '(untitled)',
    label: r.label || r._id || '(untitled)',
    total: r.total,
    due: r.due,
    archived: r.allArchived === 1, // only show as "archived" if the whole topic is paused
    examDate: r.examDate || null,
    uploadIds: r.uploadIds.filter(Boolean),
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

async function renameTopic(userId, sourceFilename, label) {
  const db = await connectMongo();
  const trimmed = (label || '').trim();
  const result = await db.collection('mastery').updateMany(
    { userId, sourceFilename },
    { $set: { topicLabel: trimmed || null } } // empty label clears the override, reverting to the filename
  );
  return { matched: result.matchedCount };
}

// Sets (or clears, if examDate is falsy) the summative exam date a student
// is preparing for on this topic — stored as 'YYYY-MM-DD', denormalized
// onto every item in the topic the same way topicLabel/archived are.
// Powers the dashboard's pre-summative encouragement: a calm "X days left,
// here's what you've covered" reminder rather than a countdown timer.
async function setTopicExamDate(userId, sourceFilename, examDate) {
  const db = await connectMongo();
  const trimmed = (examDate || '').trim();
  if (trimmed && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error('Exam date must be in YYYY-MM-DD format.');
  }
  const result = await db.collection('mastery').updateMany(
    { userId, sourceFilename },
    { $set: { examDate: trimmed || null } }
  );
  return { matched: result.matchedCount };
}

// Permanently removes every review item for a topic — for topics whose
// source upload has already been deleted from history (orphaned before the
// cascade-delete fix existed) or that a student just wants gone entirely,
// as opposed to setTopicArchived's pause-but-keep-progress behavior.
async function deleteTopic(userId, sourceFilename) {
  const db = await connectMongo();
  const result = await db.collection('mastery').deleteMany({ userId, sourceFilename });
  return { deleted: result.deletedCount };
}

// Called when a history entry is deleted — keeps the review queue from
// accumulating "orphaned" topics with no corresponding upload, which was
// confusing (a topic showing up in Manage Topics that no longer exists
// anywhere else). Scoped to the specific uploadId, not the whole filename,
// since multiple uploads can share the same filename.
async function deleteByUploadId(userId, uploadId) {
  if (!uploadId) return { deleted: 0 };
  const db = await connectMongo();
  const result = await db.collection('mastery').deleteMany({ userId, uploadId });
  return { deleted: result.deletedCount };
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

module.exports = {
  seedFromSelfTest, listDue, getStats, getDashboard, gradeReview, getById,
  listTopics, setTopicArchived, renameTopic, setTopicExamDate, deleteTopic, deleteByUploadId,
  VALID_GRADES,
};
