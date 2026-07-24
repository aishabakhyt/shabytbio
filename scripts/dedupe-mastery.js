require('dotenv').config();
const { connectMongo } = require('../services/mongo');

// One-time cleanup: seedFromSelfTest used to insert a fresh review item
// every time the same material was uploaded again (re-testing a file, or a
// cache hit off a classmate's identical upload), so repeated testing during
// beta silently piled up duplicate questions in the review queue. The seed
// function itself is now fixed to not do this going forward — this script
// cleans up whatever duplicates already accumulated.
//
// For each (userId, question) group with more than one record, keeps the
// one with the most progress (highest repetitions — don't throw away real
// study progress), tie-broken by the oldest record, and deletes the rest.
//
// Run with: node scripts/dedupe-mastery.js

async function main() {
  const db = await connectMongo();
  const col = db.collection('mastery');

  const all = await col.find({}, { projection: { _id: 1, id: 1, userId: 1, question: 1, repetitions: 1, createdAt: 1 } }).toArray();

  const groups = new Map(); // key: `${userId}::${question}` -> records[]
  for (const doc of all) {
    if (!doc.question) continue;
    const key = `${doc.userId}::${doc.question}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(doc);
  }

  let duplicateGroups = 0;
  let deletedCount = 0;
  const idsToDelete = [];

  for (const [, records] of groups) {
    if (records.length <= 1) continue;
    duplicateGroups++;
    records.sort((a, b) => {
      if (b.repetitions !== a.repetitions) return b.repetitions - a.repetitions; // most progress first
      return new Date(a.createdAt) - new Date(b.createdAt); // then oldest first
    });
    const [, ...rest] = records; // keep the first (best), delete the rest
    idsToDelete.push(...rest.map(r => r._id));
    deletedCount += rest.length;
  }

  if (idsToDelete.length) {
    await col.deleteMany({ _id: { $in: idsToDelete } });
  }

  console.log(`Scanned ${all.length} review items.`);
  console.log(`Found ${duplicateGroups} question(s) with duplicates.`);
  console.log(`Deleted ${deletedCount} duplicate record(s), kept the best copy of each.`);
  process.exit(0);
}

main().catch(err => {
  console.error('Dedup failed:', err.message);
  process.exit(1);
});
