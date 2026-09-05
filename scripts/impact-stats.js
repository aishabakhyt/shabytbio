require('dotenv').config();
const { connectMongo } = require('../services/mongo');

// Pulls the impact numbers that are honestly computable from what's already
// tracked, no new instrumentation required -- for Aisha's college
// application. Run this from your own machine (needs a real network path
// to MongoDB Atlas, which no Claude sandbox has):
//   node scripts/impact-stats.js
//
// A note on "accuracy improved over time": that number is NOT here on
// purpose. It needs a history of graded review answers, and that only
// started being recorded on 5 Sep 2026 (services/gradeHistory.js) -- there
// was nowhere to retroactively pull it from before that. Re-run this
// script again in a few weeks once grade_history has real data in it; the
// section below will pick it up automatically once it exists.

const MASTERED_REPETITIONS = 4;
const MASTERED_INTERVAL_DAYS = 21;

async function main() {
  const db = await connectMongo();

  const [
    totalUsers,
    totalUploads,
    uniqueCacheEntries,
    totalMasteryItems,
    masteredItems,
    languageBreakdown,
    gradeHistoryCount,
    gradeHistoryBreakdown,
  ] = await Promise.all([
    db.collection('users').countDocuments({}),
    db.collection('history').countDocuments({}),
    db.collection('resultCache').countDocuments({}),
    db.collection('mastery').countDocuments({}),
    db.collection('mastery').countDocuments({
      repetitions: { $gte: MASTERED_REPETITIONS },
      interval: { $gte: MASTERED_INTERVAL_DAYS },
    }),
    db.collection('history').aggregate([
      { $group: { _id: '$language', count: { $sum: 1 } } },
    ]).toArray(),
    db.collection('grade_history').countDocuments({}).catch(() => 0),
    db.collection('grade_history').aggregate([
      { $group: { _id: '$verdict', count: { $sum: 1 } } },
    ]).toArray().catch(() => []),
  ]);

  console.log('=== ShabytBio impact stats ===\n');

  console.log(`Students signed up: ${totalUsers}`);
  console.log(`Uploads processed (total submissions, including cache hits): ${totalUploads}`);
  console.log(`Unique pieces of content actually analyzed by Gemini: ${uniqueCacheEntries}`);

  if (totalUploads > 0) {
    const cacheHitCount = Math.max(0, totalUploads - uniqueCacheEntries);
    const cacheHitPct = ((cacheHitCount / totalUploads) * 100).toFixed(1);
    console.log(`\n--> Adoption/network-effect number: ~${cacheHitPct}% of uploads (${cacheHitCount} of ${totalUploads}) were served instantly`);
    console.log(`    from a classmate's identical upload instead of triggering a new AI call.`);
    console.log(`    (This is a lower bound -- it assumes every cache entry was reused at most`);
    console.log(`    once; the real reuse rate could be higher.)`);
  }

  console.log(`\nQuestions currently tracked for spaced repetition: ${totalMasteryItems}`);
  console.log(`Questions reached "mastered" status (4 correct reviews, 3+ weeks apart): ${masteredItems}`);
  if (totalMasteryItems > 0) {
    console.log(`--> ${((masteredItems / totalMasteryItems) * 100).toFixed(1)}% of all tracked questions are mastered.`);
  }

  console.log('\nUploads by language:');
  languageBreakdown.sort((a, b) => b.count - a.count).forEach(row => {
    console.log(`  ${row._id || 'unknown'}: ${row.count}`);
  });

  console.log(`\nGraded review answers logged so far: ${gradeHistoryCount}`);
  if (gradeHistoryCount > 0) {
    gradeHistoryBreakdown.forEach(row => console.log(`  ${row._id}: ${row.count}`));
    const correct = gradeHistoryBreakdown.find(r => r._id === 'correct');
    if (correct) {
      console.log(`--> ${((correct.count / gradeHistoryCount) * 100).toFixed(1)}% of graded answers so far were marked correct on the first try.`);
    }
    console.log('    (Once there is enough history, compare this rate month-over-month for the same');
    console.log('    students to get a real "improved over time" number -- not possible yet with only');
    console.log('    one snapshot in time.)');
  } else {
    console.log('  No data yet -- this started logging 5 Sep 2026. Check back in a few weeks.');
  }

  console.log('\n(Numbers are aggregate across all students -- no individual student data shown.)');
  process.exit(0);
}

main().catch(err => {
  console.error('Failed to compute stats:', err.message);
  process.exit(1);
});
