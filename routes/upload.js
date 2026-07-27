const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { parseOffice } = require('officeparser');
const { restructureWithClaude } = require('../services/claude');
const { saveUpload, listUploads, getUpload, deleteUpload } = require('../services/db');
const { getUserById } = require('../services/users');
const { seedFromSelfTest, deleteByUploadId } = require('../services/mastery');
const { getCached, setCached } = require('../services/resultCache');
const { searchVideos } = require('../services/youtube');

const router = express.Router();

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Sign in with Google to use ShabytBio.' });
  }
  next();
}

router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'text/plain', PPTX_MIME];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF (.pdf), plain text (.txt), or PowerPoint (.pptx) files are allowed.'));
    }
  },
});

router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  let extractedText;
  try {
    if (req.file.mimetype === 'application/pdf') {
      const parsed = await pdfParse(req.file.buffer);
      extractedText = parsed.text;
    } else if (req.file.mimetype === PPTX_MIME) {
      extractedText = (await parseOffice(req.file.buffer, { fileType: 'pptx' })).toText();
    } else {
      extractedText = req.file.buffer.toString('utf-8');
    }
  } catch (err) {
    return res.status(422).json({ error: `Text extraction failed: ${err.message}` });
  }

  let user;
  try {
    user = await getUserById(req.session.userId);
  } catch (err) {
    user = null;
  }
  const grade = user ? user.grade : null;
  const language = (user && user.language) || 'en';
  const school = (user && user.school) || null;

  const focusInstructions = req.body.focusInstructions || '';

  let result;
  let fromCache = false;
  try {
    // Classmates very often upload the exact same slide deck (same
    // teacher, same lesson) — if someone's already gotten a result for
    // this exact content + focus + grade + language + school combination,
    // reuse it instantly instead of spending another call against the
    // free-tier rate limit. Language and school are both part of the cache
    // key so an English-medium classmate — or a non-NIS student — never
    // gets served a result generated for someone else's language/school.
    const cached = await getCached(extractedText, focusInstructions, grade, language, school);
    if (cached) {
      result = cached;
      fromCache = true;
    } else {
      result = await restructureWithClaude(extractedText, focusInstructions, grade, language, school);
      setCached(extractedText, focusInstructions, grade, language, school, result).catch(err => {
        console.error('Failed to cache result:', err.message);
      });
    }
  } catch (err) {
    return res.status(500).json({ error: `Claude call failed: ${err.message}` });
  }

  let historyId = null;
  try {
    historyId = await saveUpload({
      userId: req.session.userId,
      filename: req.file.originalname,
      charCount: extractedText.length,
      focusInstructions,
      result,
    });
  } catch (err) {
    // Persistence is a nice-to-have — don't fail the request if saving history breaks.
    console.error('Failed to save upload history:', err.message);
  }

  try {
    // Turns this upload's self_test questions into a spaced-repetition queue
    // the student can come back to across sessions. Best-effort — a seeding
    // failure shouldn't fail the upload response itself.
    await seedFromSelfTest({
      userId: req.session.userId,
      uploadId: historyId,
      filename: req.file.originalname,
      selfTest: result.self_test,
    });
  } catch (err) {
    console.error('Failed to seed mastery queue:', err.message);
  }

  res.json({
    id: historyId,
    filename: req.file.originalname,
    charCount: extractedText.length,
    extractedText,
    result,
    fromCache,
  });
});

// ── History (each user only ever sees their own) ───────────
router.get('/history', async (req, res) => {
  try {
    res.json(await listUploads(req.session.userId));
  } catch (err) {
    res.status(500).json({ error: `Failed to load history: ${err.message}` });
  }
});

router.get('/history/:id', async (req, res) => {
  try {
    const record = await getUpload(Number(req.params.id), req.session.userId);
    if (!record) return res.status(404).json({ error: 'Upload not found.' });
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: `Failed to load upload: ${err.message}` });
  }
});

router.delete('/history/:id', async (req, res) => {
  const uploadId = Number(req.params.id);
  try {
    const ok = await deleteUpload(uploadId, req.session.userId);
    if (!ok) return res.status(404).json({ error: 'Upload not found.' });
  } catch (err) {
    return res.status(500).json({ error: `Failed to delete upload: ${err.message}` });
  }

  try {
    // Beta feedback: deleting an upload used to leave its review items
    // behind as an "orphaned" topic in Manage Topics with no corresponding
    // history entry, which was confusing. Best-effort — a cleanup failure
    // here shouldn't turn the (already-successful) history deletion into an
    // error response.
    await deleteByUploadId(req.session.userId, uploadId);
  } catch (err) {
    console.error('Failed to clean up review items for deleted upload:', err.message);
  }

  res.status(204).end();
});

// ── Video suggestions (real YouTube videos, not AI-generated) ───────────
router.get('/videos', async (req, res) => {
  const query = (req.query.q || '').toString();
  try {
    const videos = await searchVideos(query);
    res.json({ videos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Multer error handler (file type / size rejections)
router.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message });
});

module.exports = router;
