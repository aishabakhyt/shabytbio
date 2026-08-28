require('dotenv').config();
const { restructureWithClaude, PROMPT_VERSION } = require('../services/claude');
const { validateStudyPack } = require('../services/validateStudyPack');
const { saveUpload, getUpload, updateUploadResult, deleteUpload } = require('../services/db');
const { seedFromSelfTest, deleteByUploadId } = require('../services/mastery');
const { connectMongo } = require('../services/mongo');

// Supervised end-to-end check for two changes made together:
//  1. Audio dialogue now scales with content depth instead of a flat 10-16
//     turn cap.
//  2. "Regenerate in my language": extracted_text/language/school/grade are
//     now persisted per upload, updateUploadResult overwrites a record's
//     result in place, and the mastery queue is reconciled (old-language
//     items deleted, new-language items reseeded) rather than doubling up.
// Runs 2 real Gemini calls (en + ru) against real Mongo, under a clearly
// fake test userId/uploadId, and deletes everything it creates afterward.
// Run with: node scripts/test-language-regenerate.js

const TEST_USER = 'TEST-REGEN-PROBE-USER';

const SAMPLE_TEXT = `Cholinergic Synapse Transmission

Learning objectives:
- Describe the structure of a cholinergic synapse
- Explain how an action potential triggers neurotransmitter release
- Explain how acetylcholine is broken down to terminate the signal

The presynaptic neuron's axon terminal (synaptic knob) contains mitochondria and synaptic vesicles filled with acetylcholine (ACh). When an action potential arrives at the terminal, voltage-gated calcium channels open and Ca2+ ions diffuse in. The rise in calcium causes synaptic vesicles to fuse with the presynaptic membrane and release ACh into the synaptic cleft by exocytosis. ACh diffuses across the cleft and binds to receptors on the postsynaptic membrane, opening sodium channels and triggering a new action potential in the postsynaptic neuron. The enzyme acetylcholinesterase then hydrolyses ACh in the cleft, breaking the signal and allowing the choline to be recycled back into the presynaptic neuron.`;

function countHeaders(restructured) {
  return (restructured.match(/^##\s/gm) || []).length;
}

function looksCyrillic(str) {
  return /[Ѐ-ӿ]/.test(str || '');
}

async function main() {
  console.log(`Using PROMPT_VERSION: ${PROMPT_VERSION}\n`);

  // A run that crashes before step 7 (as the very first run of this script
  // did, before the self_test reliability fix) leaves its fake test record
  // behind forever, since cleanup only ever runs on the success path for
  // THAT run's own uploadId. Sweeping every pre-existing TEST_USER record
  // here means a crashed run's debris gets cleaned up automatically on the
  // next run instead of silently accumulating in the real database.
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
  const enHeaders = countHeaders(enResult.restructured);
  const enTurns = (enResult.audio_dialogue || []).length;
  console.log(`   restructured has ${enHeaders} section headers.`);
  console.log(`   audio_dialogue has ${enTurns} turns (floor is 20; old cap was a flat 10-16).`);
  if (enTurns < 20) console.log('   !! WARNING: below the new 20-turn floor.');
  const enWarnings = validateStudyPack(enResult).warnings;
  console.log(`   validateStudyPack warnings: ${enWarnings.length ? enWarnings.join(' | ') : 'none'}`);

  console.log('\n2. Saving as a fake history record (exercises the new saveUpload fields)...');
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
  console.log(`   Re-read record: language=${savedRecord.language}, has extracted_text=${!!savedRecord.extracted_text}, extracted_text length=${savedRecord.extracted_text.length}`);

  console.log('\n3. Seeding mastery queue from the English self_test...');
  await seedFromSelfTest({ userId: TEST_USER, uploadId, filename: savedRecord.filename, selfTest: enResult.self_test });
  const db = await connectMongo();
  const enItemCount = await db.collection('mastery').countDocuments({ userId: TEST_USER, uploadId });
  console.log(`   ${enItemCount} English mastery items seeded (self_test had ${(enResult.self_test || []).length}).`);
  const oneEnItem = await db.collection('mastery').findOne({ userId: TEST_USER, uploadId });
  console.log(`   Sample question: "${(oneEnItem.question || '').slice(0, 70)}..."`);

  console.log('\n4. Generating RUSSIAN result (real Gemini call, the "regenerate in my language" step)...');
  const ruResult = await restructureWithClaude(SAMPLE_TEXT, '', '11-12', 'ru', 'nis');
  const ruTurns = (ruResult.audio_dialogue || []).length;
  const restructuredIsCyrillic = looksCyrillic(ruResult.restructured);
  const audioIsCyrillic = looksCyrillic((ruResult.audio_dialogue[0] || {}).line);
  console.log(`   audio_dialogue has ${ruTurns} turns.`);
  console.log(`   restructured notes contain Cyrillic: ${restructuredIsCyrillic}`);
  console.log(`   first audio line contains Cyrillic: ${audioIsCyrillic}`);
  if (!restructuredIsCyrillic || !audioIsCyrillic) console.log('   !! WARNING: expected Russian content to contain Cyrillic text.');
  const ruWarnings = validateStudyPack(ruResult).warnings;
  console.log(`   validateStudyPack warnings: ${ruWarnings.length ? ruWarnings.join(' | ') : 'none'}`);

  console.log('\n5. Overwriting the record via updateUploadResult (the actual regenerate-language route logic)...');
  const updated = await updateUploadResult(uploadId, TEST_USER, {
    result: ruResult, qualityWarnings: ruWarnings, language: 'ru', school: 'nis', grade: '11-12',
  });
  console.log(`   updateUploadResult returned language=${updated.language}, regenerated_at=${updated.regenerated_at}`);
  const reread = await getUpload(uploadId, TEST_USER);
  console.log(`   Re-read after update: language=${reread.language}, result.restructured matches new Russian text: ${reread.result.restructured === ruResult.restructured}`);

  console.log('\n6. Reconciling mastery queue: delete old-language items, reseed from Russian self_test...');
  const delResult = await deleteByUploadId(TEST_USER, uploadId);
  console.log(`   Deleted ${delResult.deleted} old (English) mastery items.`);
  await seedFromSelfTest({ userId: TEST_USER, uploadId, filename: reread.filename, selfTest: ruResult.self_test });
  const finalItems = await db.collection('mastery').find({ userId: TEST_USER, uploadId }).toArray();
  console.log(`   ${finalItems.length} mastery items now exist for this upload (Russian self_test had ${(ruResult.self_test || []).length}).`);
  const staleEnglish = finalItems.filter(i => !looksCyrillic(i.question));
  console.log(`   Items that are NOT Cyrillic (should be 0 — confirms no old English items survived): ${staleEnglish.length}`);

  console.log('\n7. Cleaning up test data...');
  await deleteUpload(uploadId, TEST_USER);
  const finalDel = await deleteByUploadId(TEST_USER, uploadId);
  console.log(`   Deleted history record and ${finalDel.deleted} remaining mastery item(s).`);
  const leftoverCheck = await db.collection('mastery').countDocuments({ userId: TEST_USER });
  const leftoverHistory = await db.collection('history').countDocuments({ userId: TEST_USER });
  console.log(`   Sanity check — leftover mastery docs for test user: ${leftoverCheck}, leftover history docs: ${leftoverHistory}`);

  console.log('\nDONE.' + (leftoverCheck === 0 && leftoverHistory === 0 ? ' Clean — no test data left behind.' : ' !! CLEANUP INCOMPLETE — manual check needed.'));
  process.exit(0);
}

main().catch(err => {
  console.error('FAILED:', err.message, err.stack);
  process.exit(1);
});
