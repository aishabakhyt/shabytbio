require('dotenv').config();
const { restructureWithClaude, translateSelfTest, PROMPT_VERSION } = require('../services/claude');
const { validateStudyPack } = require('../services/validateStudyPack');
const { saveUpload, getUpload, updateUploadResult, deleteUpload } = require('../services/db');
const { seedFromSelfTest, deleteByUploadId, reconcileTranslatedSelfTest, gradeReview } = require('../services/mastery');
const { connectMongo } = require('../services/mongo');

// Supervised end-to-end check for "regenerate in my language", covering the
// 5 Sep 2026 fix for spaced-repetition progress being lost on every
// language switch: translateSelfTest (services/claude.js) now translates
// the OLD self_test 1:1 instead of letting a fresh restructuring call
// generate a brand-new, differently-ordered/counted one, and
// reconcileTranslatedSelfTest (services/mastery.js) updates each existing
// mastery record's question/answer text IN PLACE by position rather than
// deleting and reseeding -- so interval/easeFactor/repetitions/
// nextReviewAt all survive the switch. The old delete+reseed behavior is
// kept only as a fallback for when the counts don't line up 1:1 (see
// routes/upload.js) and is intentionally NOT exercised as the main path
// here anymore.
//
// Runs 2 real Gemini calls (en + ru translation) against real Mongo, under
// a clearly fake test userId/uploadId, and deletes everything it creates
// afterward. Run with: node scripts/test-language-regenerate.js

const TEST_USER = 'TEST-REGEN-PROBE-USER';

const SAMPLE_TEXT = `Cholinergic Synapse Transmission

Learning objectives:
- Describe the structure of a cholinergic synapse
- Explain how an action potential triggers neurotransmitter release
- Explain how acetylcholine is broken down to terminate the signal

The presynaptic neuron's axon terminal (synaptic knob) contains mitochondria and synaptic vesicles filled with acetylcholine (ACh). When an action potential arrives at the terminal, voltage-gated calcium channels open and Ca2+ ions diffuse in. The rise in calcium causes synaptic vesicles to fuse with the presynaptic membrane and release ACh into the synaptic cleft by exocytosis. ACh diffuses across the cleft and binds to receptors on the postsynaptic membrane, opening sodium channels and triggering a new action potential in the postsynaptic neuron. The enzyme acetylcholinesterase then hydrolyses ACh in the cleft, breaking the signal and allowing the choline to be recycled back into the presynaptic neuron.`;

function looksCyrillic(str) {
  return /[Ѐ-ӿ]/.test(str || '');
}

async function main() {
  console.log(`Using PROMPT_VERSION: ${PROMPT_VERSION}\n`);

  console.log('0. Pre-flight: sweeping any leftover test data from a previous run...');
  const preDb = await connectMongo();
  const preHistory = await preDb.collection('history').deleteMany({ userId: TEST_USER });
  const preMastery = await preDb.collection('mastery').deleteMany({ userId: TEST_USER });
  if (preHistory.deletedCount || preMastery.deletedCount) {
    console.log(`   Swept ${preHistory.deletedCount} leftover history doc(s) and ${preMastery.deletedCount} leftover mastery doc(s) from a previous run.`);
  } else {
    console.log('   Nothing to sweep — clean start.');
  }

  console.log('\n1. Generating ENGLISH result (real Gemini call)...');
  const enResult = await restructureWithClaude(SAMPLE_TEXT, '', '11-12', 'en', 'nis');
  const enWarnings = validateStudyPack(enResult).warnings;
  console.log(`   self_test has ${(enResult.self_test || []).length} item(s). validateStudyPack warnings: ${enWarnings.length ? enWarnings.join(' | ') : 'none'}`);

  console.log('\n2. Saving as a fake history record...');
  const uploadId = await saveUpload({
    userId: TEST_USER,
    filename: 'TEST-cholinergic-synapse.txt',
    charCount: SAMPLE_TEXT.length,
    focusInstructions: '',
    result: enResult,
    qualityWarnings: enWarnings,
    extractedText: SAMPLE_TEXT,
    language: 'en',
    school: 'nis',
    grade: '11-12',
  });
  console.log(`   Saved as history id ${uploadId}.`);
  const savedRecord = await getUpload(uploadId, TEST_USER);

  console.log('\n3. Seeding mastery queue from the English self_test...');
  await seedFromSelfTest({ userId: TEST_USER, uploadId, filename: savedRecord.filename, selfTest: enResult.self_test });
  const db = await connectMongo();
  const enItems = await db.collection('mastery').find({ userId: TEST_USER, uploadId }).sort({ id: 1 }).toArray();
  console.log(`   ${enItems.length} English mastery items seeded (self_test had ${(enResult.self_test || []).length}).`);

  console.log('\n4. Simulating real study progress on the FIRST item before switching languages (this is exactly what used to get silently wiped out)...');
  await gradeReview(enItems[0].id, TEST_USER, 'good');
  await gradeReview(enItems[0].id, TEST_USER, 'good');
  const progressedBefore = await db.collection('mastery').findOne({ id: enItems[0].id, userId: TEST_USER });
  console.log(`   Item #${enItems[0].id} after 2x "good": repetitions=${progressedBefore.repetitions}, interval=${progressedBefore.interval}, easeFactor=${progressedBefore.easeFactor.toFixed(2)}.`);
  if (progressedBefore.repetitions !== 2) console.log('   !! WARNING: expected repetitions=2 before the language switch.');

  console.log('\n5. Translating the self_test to RUSSIAN in place (translateSelfTest — the actual fix, 1 real Gemini call)...');
  const translated = await translateSelfTest(enResult.self_test, 'ru');
  console.log(`   Translated ${translated.length} item(s) (expected ${enResult.self_test.length}).`);
  const translatedIsCyrillic = looksCyrillic(translated[0].question) && looksCyrillic(translated[0].answer);
  console.log(`   First translated item looks Cyrillic: ${translatedIsCyrillic}`);
  if (translated.length !== enResult.self_test.length) console.log('   !! WARNING: count mismatch — reconcile should refuse and the route would fall back to reseed.');
  if (!translatedIsCyrillic) console.log('   !! WARNING: expected Russian content to contain Cyrillic text.');

  console.log('\n6. Reconciling mastery queue IN PLACE (reconcileTranslatedSelfTest — no delete, no reseed)...');
  const reconciled = await reconcileTranslatedSelfTest(TEST_USER, uploadId, translated);
  console.log(`   reconcileTranslatedSelfTest returned: ${reconciled} (expected true).`);
  if (!reconciled) console.log('   !! WARNING: expected reconciliation to succeed for a clean 1:1 count match.');

  const afterItems = await db.collection('mastery').find({ userId: TEST_USER, uploadId }).sort({ id: 1 }).toArray();
  const afterFirst = afterItems.find(i => i.id === enItems[0].id);
  console.log(`   Item count after reconcile: ${afterItems.length} (expected ${enItems.length} — same ids, not new documents).`);
  console.log(`   Item #${afterFirst.id} question is now Cyrillic: ${looksCyrillic(afterFirst.question)}`);
  console.log(`   Item #${afterFirst.id} progress AFTER reconcile: repetitions=${afterFirst.repetitions}, interval=${afterFirst.interval}, easeFactor=${afterFirst.easeFactor.toFixed(2)} (should be UNCHANGED from step 4).`);
  const progressSurvived = afterFirst.repetitions === progressedBefore.repetitions
    && afterFirst.interval === progressedBefore.interval
    && afterFirst.easeFactor === progressedBefore.easeFactor
    && afterFirst.nextReviewAt === progressedBefore.nextReviewAt;
  console.log(`\n   >>> THE FIX: spaced-repetition progress survived the language switch: ${progressSurvived} <<<`);
  if (!progressSurvived) console.log('   !! FAILURE: progress did not survive — the bug is not fixed.');

  console.log('\n7. Cleaning up test data...');
  await deleteUpload(uploadId, TEST_USER);
  const finalDel = await deleteByUploadId(TEST_USER, uploadId);
  console.log(`   Deleted history record and ${finalDel.deleted} remaining mastery item(s).`);
  const leftoverMastery = await db.collection('mastery').countDocuments({ userId: TEST_USER });
  const leftoverHistory = await db.collection('history').countDocuments({ userId: TEST_USER });
  console.log(`   Sanity check — leftover mastery docs: ${leftoverMastery}, leftover history docs: ${leftoverHistory}`);

  const allGood = progressSurvived && reconciled && translated.length === enResult.self_test.length && leftoverMastery === 0 && leftoverHistory === 0;
  console.log('\n' + (allGood ? 'DONE. All checks passed — progress-loss bug is fixed and cleanup was clean.' : '!! DONE WITH WARNINGS — see above.'));
  process.exit(allGood ? 0 : 1);
}

main().catch(err => {
  console.error('FAILED:', err.message, err.stack);
  process.exit(1);
});
