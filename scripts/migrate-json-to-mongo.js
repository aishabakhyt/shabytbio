// One-time migration: copies your existing local data/*.json test data
// (accounts, upload history, review queue) into MongoDB Atlas, so you don't
// lose it when the app switches over to Mongo-backed storage.
//
// Run this ONCE, after you've set MONGODB_URI in your .env, and BEFORE you
// deploy. Safe to run more than once — it skips records that already exist
// in Mongo (matched by their `id` field) instead of duplicating them.
//
// Usage:  node scripts/migrate-json-to-mongo.js

require('dotenv').config();
const path = require('path');
const fs = require('fs/promises');
const { connectMongo } = require('../services/mongo');

const DATA_DIR = path.join(__dirname, '..', 'data');

async function readJsonSafe(filename) {
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, filename), 'utf-8');
    return raw.trim() ? JSON.parse(raw) : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function migrateCollection(db, filename, collectionName) {
  const records = await readJsonSafe(filename);
  if (records.length === 0) {
    console.log(`  ${filename}: nothing to migrate (file missing or empty).`);
    return;
  }

  const col = db.collection(collectionName);
  let inserted = 0;
  let skipped = 0;

  for (const record of records) {
    const existing = await col.findOne({ id: record.id });
    if (existing) {
      skipped++;
      continue;
    }
    await col.insertOne(record);
    inserted++;
  }

  console.log(`  ${filename} → "${collectionName}": ${inserted} inserted, ${skipped} already present.`);
}

async function bumpCounterPastExisting(db, collectionName, counterName) {
  // Make sure future nextSequence() calls don't collide with the IDs we
  // just migrated in — set the counter to at least the highest existing id.
  const highest = await db.collection(collectionName)
    .find({}, { projection: { id: 1 } })
    .sort({ id: -1 })
    .limit(1)
    .toArray();
  const maxId = highest.length ? highest[0].id : 0;
  await db.collection('counters').updateOne(
    { _id: counterName },
    { $max: { seq: maxId } },
    { upsert: true }
  );
}

async function main() {
  console.log('Connecting to MongoDB...');
  const db = await connectMongo();
  console.log('Connected. Migrating local JSON files into Mongo collections:\n');

  await migrateCollection(db, 'users.json', 'users');
  await migrateCollection(db, 'history.json', 'history');
  await migrateCollection(db, 'mastery.json', 'mastery');

  await bumpCounterPastExisting(db, 'users', 'users');
  await bumpCounterPastExisting(db, 'history', 'history');
  await bumpCounterPastExisting(db, 'mastery', 'mastery');

  console.log('\nDone. Your existing account/history/review data now lives in MongoDB Atlas.');
  process.exit(0);
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
