require('dotenv').config();
const { saveUpload, getUpload, updateUploadResult, deleteUpload, listUploads } = require('../services/db');
const { seedFromSelfTest, deleteByUploadId } = require('../services/mastery');
const { connectMongo } = require('../services/mongo');

// Isolates the NEW code from the "regenerate in my language" feature (the
// db.js schema fields, updateUploadResult, and mastery reconciliation) from
// Gemini itself, using two canned fake results instead of real API calls.
// Run with: node scripts/test-db-mastery-only.js

const TEST_USER = 'TEST-REGEN-PROBE-USER';
const fakeEnResult = {
  video_search_query: 'test', audio_dialogue: [{ speaker: 'Alex', line: 'test EN' }],
  learning_objectives: [], mind_map: { mermaid: 'mindmap\n  root((Test))\n    Branch\n      Leaf fact here' },
  visual_diagrams: [], restructured: '## Section\ntest EN content', hidden_details: [],
  key_concepts: [], likely_summative_topics: [], readiness_checklist: [],
  self_test: [
    { question: 'What is X?', answer: 'X is Y.', type: 'recall' },
    { question: 'Why does Z happen?', answer: 'Because W.', type: 'application' },
  ],
};
const fakeRuResult = {
  ...fakeEnResult,
  restructured: '## Раздел\nтестовый RU контент',
  self_test: [
    { question: 'Что такое X?', answer: 'X это Y.', type: 'recall' },
    { question: 'Почему происходит Z?', answer: 'Потому что W.', type: 'application' },
  ],
};
function looksCyrillic(str) { return /[Ѐ-ӿ]/.test(str || ''); }

async function main() {
  console.log('1. saveUpload with new fields (extractedText/language/school/grade)...');
  const uploadId = await saveUpload({
    userId: TEST_USER, filename: 'TEST.txt', charCount: 100, focusInstructions: '',
    result: fakeEnResult, qualityWarnings: [],
    extractedText: 'fake source text', language: 'en', school: 'nis', grade: '11-12',
  });
  const rec = await getUpload(uploadId, TEST_USER);
  console.log(`   language=${rec.language} school=${rec.school} grade=${rec.grade} extracted_text="${rec.extracted_text}"`);
  if (rec.language !== 'en' || rec.extracted_text !== 'fake source text') throw new Error('saveUpload fields not round-tripping');

  console.log('2. Seed mastery from EN self_test...');
  await seedFromSelfTest({ userId: TEST_USER, uploadId, filename: rec.filename, selfTest: fakeEnResult.self_test });
  const db = await connectMongo();
  let items = await db.collection('mastery').find({ userId: TEST_USER, uploadId }).toArray();
  console.log(`   ${items.length} items seeded (expected 2).`);
  if (items.length !== 2) throw new Error('EN seeding count wrong');

  console.log('3. updateUploadResult -> RU...');
  const updated = await updateUploadResult(uploadId, TEST_USER, { result: fakeRuResult, qualityWarnings: [], language: 'ru', school: 'nis', grade: '11-12' });
  console.log(`   returned language=${updated.language} regenerated_at set=${!!updated.regenerated_at}`);
  const rec2 = await getUpload(uploadId, TEST_USER);
  console.log(`   re-read language=${rec2.language} cyrillic=${looksCyrillic(rec2.result.restructured)}`);
  if (rec2.language !== 'ru' || !looksCyrillic(rec2.result.restructured)) throw new Error('updateUploadResult not applying');

  console.log('4. Reconcile mastery: delete EN, reseed RU...');
  const del = await deleteByUploadId(TEST_USER, uploadId);
  console.log(`   deleted ${del.deleted} (expected 2)`);
  await seedFromSelfTest({ userId: TEST_USER, uploadId, filename: rec2.filename, selfTest: fakeRuResult.self_test });
  items = await db.collection('mastery').find({ userId: TEST_USER, uploadId }).toArray();
  const nonCyr = items.filter(i => !looksCyrillic(i.question));
  console.log(`   ${items.length} items now (expected 2), non-Cyrillic leftovers=${nonCyr.length} (expected 0)`);
  if (items.length !== 2 || nonCyr.length !== 0) throw new Error('mastery reconciliation not clean');

  console.log('5. listUploads projection check...');
  const list = await listUploads(TEST_USER);
  const entry = list.find(r => r.id === uploadId);
  console.log(`   language=${entry.language} has extracted_text=${'extracted_text' in entry} has result=${'result' in entry}`);
  if ('extracted_text' in entry || 'result' in entry) throw new Error('listUploads leaking heavy fields');

  console.log('6. Cleanup...');
  await deleteUpload(uploadId, TEST_USER);
  const finalDel = await deleteByUploadId(TEST_USER, uploadId);
  const leftoverM = await db.collection('mastery').countDocuments({ userId: TEST_USER });
  const leftoverH = await db.collection('history').countDocuments({ userId: TEST_USER });
  console.log(`   deleted history + ${finalDel.deleted} mastery item(s). leftover mastery=${leftoverM} leftover history=${leftoverH}`);
  if (leftoverM !== 0 || leftoverH !== 0) throw new Error('cleanup incomplete');

  console.log('\nALL CHECKS PASSED. Clean.');
  process.exit(0);
}
main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
