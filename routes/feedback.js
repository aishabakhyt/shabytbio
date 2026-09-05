const express = require('express');
const { submitFeedback, listFeedback } = require('../services/feedback');

const router = express.Router();

// Same dev-gating convention as routes/upload.js's isDevUser: identifies
// Aisha by session email rather than any real role/permission system.
const DEV_EMAIL = (process.env.DEV_EMAIL || 'aishabakhyt08@gmail.com').toLowerCase();
function isDevUser(req) {
  return !!(req.session.email && req.session.email.toLowerCase() === DEV_EMAIL);
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Sign in with Google to use ShabytBio.' });
  }
  next();
}

router.use(requireAuth);

// Any signed-in student can submit feedback about whatever page they were on.
router.post('/', async (req, res) => {
  try {
    const doc = await submitFeedback({
      userId: req.session.userId,
      userEmail: req.session.email || null,
      message: req.body.message,
      page: req.body.page,
    });
    res.json({ id: doc.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Only Aisha can read what's been submitted -- this is the "I see it" half
// of "a place where they can report it to me and i see it."
router.get('/', async (req, res) => {
  if (!isDevUser(req)) {
    return res.status(403).json({ error: 'Not available.' });
  }
  try {
    const items = await listFeedback();
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: `Failed to load feedback: ${err.message}` });
  }
});

module.exports = router;
