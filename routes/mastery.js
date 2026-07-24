const express = require('express');
const { listDue, getStats, gradeReview, getById, listTopics, setTopicArchived } = require('../services/mastery');
const { gradeAnswer } = require('../services/claude');

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

// Review items grouped by source material, so a student can see the queue
// divided by topic and choose which topics stay in the long-term rotation
// instead of being stuck reviewing everything they've ever uploaded.
router.get('/topics', async (req, res) => {
  try {
    res.json(await listTopics(req.session.userId));
  } catch (err) {
    res.status(500).json({ error: `Failed to load topics: ${err.message}` });
  }
});

router.post('/topics/archive', async (req, res) => {
  const { sourceFilename, archived } = req.body;
  if (typeof sourceFilename !== 'string') {
    return res.status(400).json({ error: 'sourceFilename is required.' });
  }
  try {
    const result = await setTopicArchived(req.session.userId, sourceFilename, !!archived);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: `Failed to update topic: ${err.message}` });
  }
});

router.get('/stats', async (req, res) => {
  try {
    res.json(await getStats(req.session.userId));
  } catch (err) {
    res.status(500).json({ error: `Failed to load review stats: ${err.message}` });
  }
});

// Grades the student's own typed answer against the model answer — a
// separate step from /:id/review, which just records the spaced-repetition
// grade. This one costs a small Gemini call, so it's its own endpoint
// rather than folded into /due (which just returns questions, no AI cost).
router.post('/:id/grade-answer', async (req, res) => {
  const { studentAnswer } = req.body;
  if (!studentAnswer || !studentAnswer.trim()) {
    return res.status(400).json({ error: 'No answer provided.' });
  }
  try {
    const item = await getById(Number(req.params.id), req.session.userId);
    if (!item) return res.status(404).json({ error: 'Review item not found.' });
    const result = await gradeAnswer(item.question, item.answer, studentAnswer);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: `Grading failed: ${err.message}` });
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
