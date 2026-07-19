const { connectMongo } = require('./mongo');
const { nextSequence } = require('./counters');

// User accounts + profile, now backed by MongoDB Atlas (free tier) instead
// of a local JSON file — see services/db.js for why that switch was needed.

// Finds an existing user by their Google account ID, or creates one.
// Returns the user record either way.
async function findOrCreateUser({ googleId, email, name, picture }) {
  const db = await connectMongo();
  const users = db.collection('users');

  const existing = await users.findOne({ googleId });
  if (existing) {
    // Keep profile info fresh (name/picture can change on the Google side).
    const updates = { email, name, picture, lastLoginAt: new Date().toISOString() };
    // Backfill defaults for accounts created before profile fields existed.
    if (existing.grade === undefined) updates.grade = null;
    if (existing.language === undefined) updates.language = 'en';
    if (existing.defaultFocusInstructions === undefined) updates.defaultFocusInstructions = '';

    await users.updateOne({ googleId }, { $set: updates });
    return { ...existing, ...updates };
  }

  const id = await nextSequence(db, 'users');
  const user = {
    id,
    googleId,
    email,
    name,
    picture,
    grade: null, // '7-8' | '9-10' | '11-12' — set via the profile panel
    language: 'en', // 'en' is the only functional option until language support ships
    defaultFocusInstructions: '',
    createdAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString(),
  };
  await users.insertOne(user);
  return user;
}

async function getUserById(id) {
  const db = await connectMongo();
  return db.collection('users').findOne({ id }, { projection: { _id: 0 } });
}

const VALID_GRADES = ['7-8', '9-10', '11-12'];

async function updateUserProfile(id, { grade, language, defaultFocusInstructions }) {
  const db = await connectMongo();
  const users = db.collection('users');

  const existing = await users.findOne({ id });
  if (!existing) return null;

  const updates = {};
  if (grade !== undefined) {
    if (grade !== null && !VALID_GRADES.includes(grade)) {
      throw new Error(`Invalid grade — must be one of ${VALID_GRADES.join(', ')}.`);
    }
    updates.grade = grade;
  }
  if (language !== undefined) {
    updates.language = language || 'en';
  }
  if (defaultFocusInstructions !== undefined) {
    updates.defaultFocusInstructions = String(defaultFocusInstructions).slice(0, 500);
  }

  await users.updateOne({ id }, { $set: updates });
  return { ...existing, ...updates };
}

module.exports = { findOrCreateUser, getUserById, updateUserProfile, VALID_GRADES };
