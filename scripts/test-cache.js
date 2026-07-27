require('dotenv').config();
const { getCached, setCached } = require('../services/resultCache');
const { connectMongo } = require('../services/mongo');

// Verifies the resultCache round-trip actually works end-to-end against the
// real database: same (text, focus, grade, language, school) should hit the
// cache; different text/grade/language/school should miss. Cleans up its
// own test doc afterward so it doesn't leave junk in the real resultCache
// collection.
// Run with: node scripts/test-cache.js

async function main() {
  const sampleText = 'TEST-CACHE-PROBE: mitochondria produce ATP via oxidative phosphorylation.';
  const dummyResult = { restructured: 'test content', self_test: [] };

  console.log('1. Setting a cache entry...');
  await setCached(sampleText, '', '9-10', 'en', 'nis', dummyResult);

  console.log('2. Reading it back with the EXACT same inputs (should HIT)...');
  const hit = await getCached(sampleText, '', '9-10', 'en', 'nis');
  console.log(hit ? '   HIT — got a result back as expected.' : '   MISS — unexpected, cache is not working!');

  console.log('3. Reading with different content (should MISS)...');
  const miss1 = await getCached(sampleText + ' extra sentence', '', '9-10', 'en', 'nis');
  console.log(miss1 === null ? '   MISS — correct.' : '   HIT — unexpected, cache is not distinguishing content!');

  console.log('4. Reading with same content but different grade (should MISS — different students get independent results)...');
  const miss2 = await getCached(sampleText, '', '11-12', 'en', 'nis');
  console.log(miss2 === null ? '   MISS — correct, grade-level is part of the cache key.' : '   HIT — unexpected!');

  console.log('5. Reading with same content/grade but different language (should MISS — a Kazakh-medium student must never get an English cached result)...');
  const miss3 = await getCached(sampleText, '', '9-10', 'kk', 'nis');
  console.log(miss3 === null ? '   MISS — correct, language is part of the cache key.' : '   HIT — unexpected!');

  console.log('6. Reading with same content/grade/language but different school (should MISS — an NIS-tuned result must never be served to a non-NIS student)...');
  const miss4 = await getCached(sampleText, '', '9-10', 'en', 'other');
  console.log(miss4 === null ? '   MISS — correct, school is part of the cache key.' : '   HIT — unexpected!');

  console.log('7. Cleaning up test doc...');
  const db = await connectMongo();
  const crypto = require('crypto');
  const { PROMPT_VERSION } = require('../services/claude');
  const hash = crypto.createHash('sha256').update(`${PROMPT_VERSION} ${sampleText}  9-10 en nis`).digest('hex');
  const del = await db.collection('resultCache').deleteOne({ hash });
  console.log(`   Deleted ${del.deletedCount} test doc(s).`);

  process.exit(0);
}

main().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
