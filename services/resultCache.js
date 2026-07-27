const crypto = require('crypto');
const { connectMongo } = require('./mongo');
const { PROMPT_VERSION } = require('./claude');

// Caches Gemini results keyed by the content itself — if two students
// upload the exact same slide deck (extremely common: same teacher, same
// lesson, whole class has the identical file) with the same focus
// instructions and grade, the second+ student gets an instant cached
// result instead of triggering another Gemini call. Doubly valuable given
// the free tier's tight rate limit: a cache hit costs nothing against it.
const CACHE_TTL_DAYS = 30;

// PROMPT_VERSION is mixed into the hash so improving buildPrompt (new
// output fields, new formatting rules) automatically invalidates every
// existing cache entry instead of silently serving a stale-format result on
// the next re-upload of an already-cached file — this is exactly what
// happened with the [STEP]/[KEY] note formats before this existed.
// language is part of the key so a Kazakh-medium student never gets served
// an English (or Russian) classmate's cached result for the same file —
// same content, different language, genuinely different output. school is
// part of the key for the same reason — an NIS student and a non-NIS
// student uploading the identical file must not share a cached result now
// that the prompt's wording (mentioning "NIS" or not) depends on it.
function hashInput(text, focusInstructions, grade, language, school) {
  const normalized = `${PROMPT_VERSION} ${text} ${focusInstructions || ''} ${grade || ''} ${language || 'en'} ${school || ''}`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

async function getCached(text, focusInstructions, grade, language, school) {
  const db = await connectMongo();
  const hash = hashInput(text, focusInstructions, grade, language, school);
  const entry = await db.collection('resultCache').findOne({ hash });
  if (!entry) return null;

  // Best-effort staleness check — a cached result older than the TTL is
  // treated as a miss so content very occasionally gets a fresh pass
  // (e.g. if we improve the prompt later, old cache entries naturally
  // expire instead of being stuck forever).
  const ageMs = Date.now() - new Date(entry.createdAt).getTime();
  if (ageMs > CACHE_TTL_DAYS * 24 * 60 * 60 * 1000) return null;

  return entry.result;
}

async function setCached(text, focusInstructions, grade, language, school, result) {
  const db = await connectMongo();
  const hash = hashInput(text, focusInstructions, grade, language, school);
  await db.collection('resultCache').updateOne(
    { hash },
    { $set: { hash, result, createdAt: new Date().toISOString() } },
    { upsert: true }
  );
}

module.exports = { getCached, setCached };
