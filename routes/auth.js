const express = require('express');
const { verifyGoogleIdToken } = require('../services/auth');
const { findOrCreateUser, getUserById, updateUserProfile } = require('../services/users');

const router = express.Router();

function serializeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    picture: user.picture,
    grade: user.grade,
    language: user.language,
    school: user.school,
    defaultFocusInstructions: user.defaultFocusInstructions,
  };
}

// Lets the frontend fetch the Client ID from .env instead of it being
// hardcoded into the static HTML — .env stays the single source of truth.
// (The Client ID is public by design in the Google Identity Services flow,
// not a secret — only the ID token verification on our server matters for security.)
router.get('/config', (_req, res) => {
  res.json({ clientId: process.env.GOOGLE_CLIENT_ID || null });
});

// Called by the frontend with the `credential` (ID token) from the
// Google Sign In button. Verifies it, finds/creates the user, and starts
// a session — no OAuth redirect flow needed for this token-based approach.
router.post('/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) {
    return res.status(400).json({ error: 'Missing credential.' });
  }

  let profile;
  try {
    profile = await verifyGoogleIdToken(credential);
  } catch (err) {
    return res.status(401).json({ error: `Google sign-in failed: ${err.message}` });
  }

  let user;
  try {
    user = await findOrCreateUser(profile);
  } catch (err) {
    return res.status(500).json({ error: `Failed to save account: ${err.message}` });
  }
  req.session.userId = user.id;
  // Cached here (not just looked up by id later) so routes that need to
  // gate something by "is this me, the developer" — e.g. the quality-
  // warning flag on the history list — can check it for free on every
  // request instead of adding a DB lookup just for that check.
  req.session.email = user.email;

  res.json(serializeUser(user));
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.status(204).end();
  });
});

router.get('/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not signed in.' });
  }
  let user;
  try {
    user = await getUserById(req.session.userId);
  } catch (err) {
    return res.status(500).json({ error: `Failed to load account: ${err.message}` });
  }
  if (!user) {
    // Session points at a user that no longer exists (e.g. data file was reset).
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Not signed in.' });
  }
  res.json(serializeUser(user));
});

router.patch('/profile', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not signed in.' });
  }
  const { grade, language, defaultFocusInstructions, school } = req.body;
  let updated;
  try {
    updated = await updateUserProfile(req.session.userId, { grade, language, defaultFocusInstructions, school });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!updated) {
    return res.status(404).json({ error: 'User not found.' });
  }
  res.json(serializeUser(updated));
});

module.exports = router;
