const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { parseOffice } = require('officeparser');
const { restructureWithClaude, translateSelfTest } = require('../services/claude');
const { saveUpload, listUploads, getUpload, deleteUpload, updateUploadResult } = require('../services/db');
const { getUserById } = require('../services/users');
const { seedFromSelfTest, deleteByUploadId, reconcileTranslatedSelfTest } = require('../services/mastery');
const { getCached, setCached } = require('../services/resultCache');
const { searchVideos } = require('../services/youtube');
const { validateStudyPack } = require('../services/validateStudyPack');
const { queueLength, RPM_LIMIT } = require('../services/rateLimiter');

const router = express.Router();

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Sign in with Google to use ShabytBio.' });
  }
  next();
}

router.use(requireAuth);

// The quality_warnings flag (services/validateStudyPack.js) is internal
// QA — raw rule-violation text meant for debugging the prompt, not for a
// student to stumble into on their own upload history. Gated to a single
// email (overridable via DEV_EMAIL) rather than any real role/permission
// system, since right now there's exactly one developer using this.
const DEV_EMAIL = (process.env.DEV_EMAIL || 'aishabakhyt08@gmail.com').toLowerCase();
function isDevUser(req) {
  return !!(req.session.email && req.session.email.toLowerCase() === DEV_EMAIL);
}
function stripQualityWarnings(item) {
  if (!item) return item;
  const { quality_warnings, ...rest } = item;
  return rest;
}

// Lets the frontend show a real "the server is busy, here's roughly how
// long" message instead of a dead spinner during a burst (e.g. a whole
// class uploading around the same time) — polled while a request is
// waiting on the Gemini rate limiter (see services/rateLimiter.js).
// Deliberately cheap/synchronous: just reads in-memory counters, no DB
// or network call, safe to poll every few seconds.
router.get('/queue-status', (req, res) => {
  res.json({ queueLength: queueLength(), rpmLimit: RPM_LIMIT });
});


const MAX_FILES_PER_UPLOAD = 3;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB PER FILE
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'text/plain', PPTX_MIME];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF (.pdf), plain text (.txt), or PowerPoint (.pptx) files are allowed.'));
    }
  },
});

// A student's material for one lesson is often split across several files
// (slides + a separate handout, or a deck exported as two parts) -- capped
// at 3 rather than unlimited to keep a single upload's combined extracted
// text (and therefore the Gemini prompt built from it) bounded, and because
// the client UI presents this as "a few files for one topic", not a bulk
// importer.
function buildCombinedFilename(filenames) {
  if (filenames.length === 1) return filenames[0];
  const joined = filenames.join(' + ');
  // Long joined names get unwieldy in history lists, dashboard topic
  // labels, etc. -- fall back to a short summary once it crosses a
  // reasonable display width instead of letting it wrap everywhere.
  return joined.length <= 100 ? joined : `${filenames.length} files (${filenames[0]} + ${filenames.length - 1} more)`;
}

router.post('/upload', upload.array('files', MAX_FILES_PER_UPLOAD), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  // Each file keeps its own extracted text, clearly labeled, rather than
  // silently concatenated -- so Gemini (and anyone reading extracted_text
  // later) can tell where one file's content ends and the next begins,
  // which matters when e.g. slide numbering or headings repeat across
  // files.
  let extractedText;
  try {
    const parts = [];
    for (const file of req.files) {
      let text;
      if (file.mimetype === 'application/pdf') {
        text = (await pdfParse(file.buffer)).text;
      } else if (file.mimetype === PPTX_MIME) {
        text = (await parseOffice(file.buffer, { fileType: 'pptx' })).toText();
      } else {
        text = file.buffer.toString('utf-8');
      }
      parts.push(req.files.length > 1 ? `--- ${file.originalname} ---\n${text}` : text);
    }
    extractedText = parts.join('\n\n');
  } catch (err) {
    return res.status(422).json({ error: `Text extraction failed: ${err.message}` });
  }

  const combinedFilename = buildCombinedFilename(req.files.map(f => f.originalname));

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
  let qualityWarnings = [];
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

      // Checks the response against the structural rules already written
      // into the prompt (mind map node count/depth, banned hidden_details
      // prefixes, diagram syntax) — only on a fresh generation, since a
      // cache hit was already checked the first time it was generated.
      // Deliberately run BEFORE setCached below, not after: validation now
      // also SANITIZES result in place (e.g. dropping an illustrated_diagram
      // label with an invalid anchor id — see validateStudyPack.js), and
      // that has to happen before this exact object is written to the
      // cache, or a classmate's cache hit would serve the unsanitized copy
      // forever. Never blocks the response either way — just logs/records
      // what it found and fixed.
      try {
        qualityWarnings = validateStudyPack(result, extractedText).warnings;
        if (qualityWarnings.length) {
          console.warn(`[quality] ${combinedFilename} (user ${req.session.userId}, school ${school || 'unset'}, lang ${language}):`, qualityWarnings);
        }
      } catch (err) {
        console.error('Quality validation crashed (non-fatal):', err.message);
      }

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
      filename: combinedFilename,
      charCount: extractedText.length,
      focusInstructions,
      result,
      qualityWarnings,
      extractedText,
      language,
      school,
      grade,
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
      filename: combinedFilename,
      selfTest: result.self_test,
    });
  } catch (err) {
    console.error('Failed to seed mastery queue:', err.message);
  }

  res.json({
    id: historyId,
    filename: combinedFilename,
    charCount: extractedText.length,
    extractedText,
    result,
    fromCache,
  });
});

// Multer errors (wrong file type from fileFilter, a file over the 50MB
// limit, or now more than MAX_FILES_PER_UPLOAD files at once) used to fall
// through to Express's default error handler and come back as a plain
// HTML/text 500 -- not the JSON { error } shape the client always expects
// and renders in the status line. Normalizes all of them to that shape.
// Router-level error middleware (4 args) only needs to sit after the
// routes it protects, which is why this comes right after /upload.
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || (err && /Only PDF|PowerPoint/.test(err.message || ''))) {
    const message = err.code === 'LIMIT_UNEXPECTED_FILE'
      ? `You can upload up to ${MAX_FILES_PER_UPLOAD} files at once.`
      : err.code === 'LIMIT_FILE_SIZE'
      ? 'One of your files is over the 50MB limit.'
      : err.message;
    return res.status(400).json({ error: message });
  }
  next(err);
});

// ── History (each user only ever sees their own) ───────────
router.get('/history', async (req, res) => {
  try {
    const items = await listUploads(req.session.userId);
    res.json(isDevUser(req) ? items : items.map(stripQualityWarnings));
  } catch (err) {
    res.status(500).json({ error: `Failed to load history: ${err.message}` });
  }
});

router.get('/history/:id', async (req, res) => {
  try {
    const record = await getUpload(Number(req.params.id), req.session.userId);
    if (!record) return res.status(404).json({ error: 'Upload not found.' });
    res.json(isDevUser(req) ? record : stripQualityWarnings(record));
  } catch (err) {
    res.status(500).json({ error: `Failed to load upload: ${err.message}` });
  }
});

// Re-runs analysis for an existing history item using the student's
// CURRENT profile language/grade/school instead of whatever it was
// originally generated with — the fix for "I switched my language but my
// old uploads are still in English": the UI chrome (nav, buttons, labels)
// re-translates instantly via the client-side i18n dictionary, but the
// actual AI-generated content is a snapshot from generation time and can't
// retroactively follow a later profile change on its own.
// Only possible for records saved after extracted_text started being
// persisted (see services/db.js) — older records predate this and have no
// text to regenerate from without the original file.
router.post('/history/:id/regenerate-language', async (req, res) => {
  const uploadId = Number(req.params.id);
  let record;
  try {
    record = await getUpload(uploadId, req.session.userId);
  } catch (err) {
    return res.status(500).json({ error: `Failed to load upload: ${err.message}` });
  }
  if (!record) return res.status(404).json({ error: 'Upload not found.' });
  if (!record.extracted_text) {
    return res.status(422).json({
      error: 'This item was saved before language regeneration was supported — re-upload the original file to get it in your new language.',
    });
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

  let result;
  let fromCache = false;
  let qualityWarnings = [];
  try {
    // Same cross-student cache as a fresh upload: a classmate switching to
    // the same language on the same content gets an instant result too.
    const cached = await getCached(record.extracted_text, record.focus_instructions, grade, language, school);
    if (cached) {
      result = cached;
      fromCache = true;
    } else {
      result = await restructureWithClaude(record.extracted_text, record.focus_instructions, grade, language, school);

      // Sanitize BEFORE caching (see the identical comment on the /upload
      // route above) — validation now mutates result in place, and that has
      // to land before this object is written to the shared cache.
      try {
        qualityWarnings = validateStudyPack(result, record.extracted_text).warnings;
        if (qualityWarnings.length) {
          console.warn(`[quality] regenerate #${uploadId} (user ${req.session.userId}, school ${school || 'unset'}, lang ${language}):`, qualityWarnings);
        }
      } catch (err) {
        console.error('Quality validation crashed (non-fatal):', err.message);
      }

      setCached(record.extracted_text, record.focus_instructions, grade, language, school, result).catch(err => {
        console.error('Failed to cache regenerated result:', err.message);
      });
    }
  } catch (err) {
    return res.status(500).json({ error: `Claude call failed: ${err.message}` });
  }

  // The old self_test questions were in a different language, so
  // dedup-by-text (see services/mastery.js) can't match them to a freshly
  // generated set -- without SOME reconciliation, a language switch would
  // leave the old-language review items orphaned forever alongside a
  // brand-new set, silently doubling the review queue for this upload.
  //
  // Preferred path: translate the OLD self_test 1:1 (same count/order --
  // see translateSelfTest in services/claude.js) and update this upload's
  // existing mastery records' text in place (reconcileTranslatedSelfTest in
  // services/mastery.js), so a student's spaced-repetition progress
  // (interval/easeFactor/repetitions/nextReviewAt) survives the switch
  // instead of resetting. This used to always reset -- see the fallback
  // below, kept for when translation/reconciliation can't be done safely.
  const oldSelfTest = Array.isArray(record.result && record.result.self_test) ? record.result.self_test : [];
  let reconciled = false;
  if (oldSelfTest.length > 0) {
    try {
      const translated = await translateSelfTest(oldSelfTest, language);
      reconciled = await reconcileTranslatedSelfTest(req.session.userId, uploadId, translated);
      if (reconciled) {
        // Use the translated OLD set (not the fresh restructuring call's own
        // new self_test) so what's saved matches what the mastery records
        // now say, and what the student sees matches what's being tracked.
        result.self_test = translated;
      }
    } catch (err) {
      console.warn(`Failed to translate self_test in place for upload ${uploadId} (falling back to reseed):`, err.message);
    }
  }

  let updated;
  try {
    updated = await updateUploadResult(uploadId, req.session.userId, { result, qualityWarnings, language, school, grade });
  } catch (err) {
    return res.status(500).json({ error: `Failed to save regenerated result: ${err.message}` });
  }

  if (!reconciled) {
    // Fallback: translation failed, or the mastery doc count for this
    // upload didn't match the old self_test count 1:1 (e.g. some questions
    // were deduped against another upload's identical text back when this
    // one was first seeded) -- reconciling by position wouldn't be safe, so
    // fall back to the original behavior: delete this upload's old items,
    // then reseed from the new self_test. Any spaced-repetition progress on
    // the old-language questions resets in this path, same as before.
    try {
      await deleteByUploadId(req.session.userId, uploadId);
      await seedFromSelfTest({
        userId: req.session.userId,
        uploadId,
        filename: record.filename,
        selfTest: result.self_test,
      });
    } catch (err) {
      console.error('Failed to reconcile mastery queue after regeneration:', err.message);
    }
  }

  res.json({ id: uploadId, filename: record.filename, result, language, fromCache });
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
