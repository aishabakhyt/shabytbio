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
    // Every account created before the "school" field existed was, in
    // practice, an NIS student (that's the entire beta audience so far) —
    // backfilling to 'nis' preserves their existing NIS-specific wording
    // instead of silently switching it to generic on the next login. New
    // non-NIS students self-identify during onboarding instead.
    if (existing.school === undefined) updates.school = 'nis';

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
    school: 'nis', // 'nis' | 'other' — set via the profile panel; defaults to 'nis' since that's the current audience
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
const VALID_SCHOOLS = ['nis', 'other'];

async function updateUserProfile(id, { grade, language, defaultFocusInstructions, school }) {
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
  if (school !== undefined) {
    if (school !== null && !VALID_SCHOOLS.includes(school)) {
      throw new Error(`Invalid school — must be one of ${VALID_SCHOOLS.join(', ')}.`);
    }
    updates.school = school;
  }

  await users.updateOne({ id }, { $set: updates });
  return { ...existing, ...updates };
}

module.exports = { findOrCreateUser, getUserById, updateUserProfile, VALID_GRADES, VALID_SCHOOLS };
