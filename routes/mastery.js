const express = require('express');
const { listDue, getStats, gradeReview } = require('../services/mastery');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Sign in with Google to use ShabytBio.' });
  }
  next();
}

router.use(requireAuth);

// Items due for review right now (question/answer/type — enough to run a
// review session without exposing internal scheduling fields).
router.get('/due', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const items = await listDue(req.session.userId, limit);
    res.json(items.map(({ id, question, answer, type, sourceFilename }) => ({
      id, question, answer, type, sourceFilename,
    })));
  } catch (err) {
    res.status(500).json({ error: `Failed to load review queue: ${err.message}` });
  }
});

router.get('/stats', async (req, res) => {
  try {
    res.json(await getStats(req.session.userId));
  } catch (err) {
    res.status(500).json({ error: `Failed to load review stats: ${err.message}` });
  }
});

router.post('/:id/review', async (req, res) => {
  const { grade } = req.body;
  try {
    const updated = await gradeReview(Number(req.params.id), req.session.userId, grade);
    if (!updated) return res.status(404).json({ error: 'Review item not found.' });
    res.json({ id: updated.id, nextReviewAt: updated.nextReviewAt, interval: updated.interval });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
