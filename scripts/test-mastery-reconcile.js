require('dotenv').config();
const { seedFromSelfTest, deleteByUploadId, gradeReview, reconcileTranslatedSelfTest } = require('../services/mastery');
const { connectMongo } = require('../services/mongo');

// Isolates reconcileTranslatedSelfTest (the core of the 5 Sep 2026 fix for
// spaced-repetition progress being lost on every language switch) from
// Gemini entirely, using a hand-crafted "translated" self_test instead of a
// real translateSelfTest() call -- needs only Mongo, no Gemini API key/
// quota, so it's the fast/cheap thing to run first. For the full pipeline
// including the real translation call, see test-language-regenerate.js.
// Run with: node scripts/test-mastery-reconcile.js

const TEST_USER = 'TEST-RECONCILE-PROBE-USER';
const enSelfTest = [
  { question: 'What is X?', answer: 'X is Y.', type: 'recall' },
  { question: 'Why does Z happen?', answer: 'Because W.', type: 'application' },
  { question: 'Define Q.', answer: 'Q is R.', type: 'recall' },
];
const ruSelfTestSameCount = [
  { question: 'Что такое X?', answer: 'X это Y.' },
  { question: 'Почему происходит Z?', answer: 'Потому что W.' },
  { question: 'Определите Q.', answer: 'Q это R.' },
];
const ruSelfTestWrongCount = ruSelfTestSameCount.slice(0, 2); // deliberately mismatched

async function main() {
  const db = await connectMongo();

  console.log('0. Pre-flight sweep...');
  await db.collection('mastery').deleteMany({ userId: TEST_USER });

  console.log('\n1. Seeding EN self_test (3 items)...');
  await seedFromSelfTest({ userId: TEST_USER, uploadId: 1, filename: 'TEST.txt', selfTest: enSelfTest });
  const items = await db.collection('mastery').find({ userId: TEST_USER, uploadId: 1 }).sort({ id: 1 }).toArray();
  console.log(`   ${items.length} items seeded (expected 3).`);
  if (items.length !== 3) throw new Error('seeding count wrong');

  console.log('\n2. Simulating study progress on item 0 and item 2 (item 1 stays untouched)...');
  await gradeReview(items[0].id, TEST_USER, 'good');
  await gradeReview(items[0].id, TEST_USER, 'good');
  await gradeReview(items[2].id, TEST_USER, 'easy');
  const before = await db.collection('mastery').find({ userId: TEST_USER, uploadId: 1 }).sort({ id: 1 }).toArray();
  console.log(`   item0: reps=${before[0].repetitions} interval=${before[0].interval} | item1: reps=${before[1].repetitions} | item2: reps=${before[2].repetitions} interval=${before[2].interval}`);

  console.log('\n3. reconcileTranslatedSelfTest with a matching count (3) — should succeed and update text only...');
  const ok = await reconcileTranslatedSelfTest(TEST_USER, 1, ruSelfTestSameCount);
  console.log(`   returned: ${ok} (expected true)`);
  const after = await db.collection('mastery').find({ userId: TEST_USER, uploadId: 1 }).sort({ id: 1 }).toArray();
  const idsUnchanged = after.every((doc, i) => doc.id === before[i].id);
  const textUpdated = after.every((doc, i) => doc.question === ruSelfTestSameCount[i].question && doc.answer === ruSelfTestSameCount[i].answer);
  const progressUnchanged = after.every((doc, i) =>
    doc.repetitions === before[i].repetitions && doc.interval === before[i].interval &&
    doc.easeFactor === before[i].easeFactor && doc.nextReviewAt === before[i].nextReviewAt);
  console.log(`   same document ids (no reseed happened): ${idsUnchanged}`);
  console.log(`   question/answer text updated to Russian: ${textUpdated}`);
  console.log(`   >>> spaced-repetition progress preserved: ${progressUnchanged} <<<`);
  if (!ok || !idsUnchanged || !textUpdated || !progressUnchanged) throw new Error('reconcile-with-matching-count case failed');

  console.log('\n4. reconcileTranslatedSelfTest with a MISMATCHED count (2 vs 3 tracked) — should refuse (return false) and touch nothing...');
  await deleteByUploadId(TEST_USER, 2); // clean slate for a second upload id
  await seedFromSelfTest({ userId: TEST_USER, uploadId: 2, filename: 'TEST2.txt', selfTest: enSelfTest });
  const beforeMismatch = await db.collection('mastery').find({ userId: TEST_USER, uploadId: 2 }).sort({ id: 1 }).toArray();
  const refused = await reconcileTranslatedSelfTest(TEST_USER, 2, ruSelfTestWrongCount);
  const afterMismatch = await db.collection('mastery').find({ userId: TEST_USER, uploadId: 2 }).sort({ id: 1 }).toArray();
  const untouched = afterMismatch.every((doc, i) => doc.question === beforeMismatch[i].question && doc.answer === beforeMismatch[i].answer);
  console.log(`   returned: ${refused} (expected false)`);
  console.log(`   documents left completely untouched: ${untouched}`);
  if (refused !== false || !untouched) throw new Error('mismatched-count fallback case failed — this should never overwrite with a misaligned mapping');

  console.log('\n5. Cleaning up...');
  const del1 = await deleteByUploadId(TEST_USER, 1);
  const del2 = await deleteByUploadId(TEST_USER, 2);
  const leftover = await db.collection('mastery').countDocuments({ userId: TEST_USER });
  console.log(`   deleted ${del1.deleted + del2.deleted} test docs, leftover: ${leftover}`);

  console.log('\nDONE. All checks passed.');
  process.exit(0);
}

main().catch(err => {
  console.error('FAILED:', err.message, err.stack);
  process.exit(1);
});
