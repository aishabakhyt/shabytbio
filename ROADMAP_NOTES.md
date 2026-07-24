# ShabytBio — Roadmap Notes

_Last updated: Jul 24, 2026_

## Language support + motivational dashboard (built Jul 24, 2026)

Aisha prioritized these two of the real gaps below — both are now built:

**Kazakh/Russian language support, full scope (AI content + whole UI):**
- `services/claude.js`: `buildPrompt`/`restructureWithClaude` take a `language` param ('en'/'kk'/'ru'); when non-English, a new OUTPUT LANGUAGE prompt block tells Gemini to write every text field (notes, hidden details, key concepts, self-test, audio dialogue, diagram/mind-map labels, mnemonics) in that language, using real NIS classroom terminology, not literal translation. `video_search_query` deliberately stays English (better YouTube results). `gradeAnswer`'s feedback text is also localized. PROMPT_VERSION bumped so this doesn't get masked by old cache entries.
- `services/resultCache.js`: language is now part of the cache key — a Kazakh-medium student can never get served an English/Russian classmate's cached result for the same file.
- `routes/upload.js` / `routes/mastery.js`: pass the signed-in user's `language` (from their profile) through to both AI calls.
- Frontend (`public/index.html`): full i18n system — a `TRANSLATIONS` dictionary (en/kk/ru, 105 keys, verified equal key sets across all three), a `t()`/`tf()` lookup+interpolation helper, `data-i18n`/`data-i18n-placeholder` attributes on static markup, and `applyTranslations()`/`setLanguage()`/`syncLanguageFromUser()` wiring so the language switches instantly on profile save and persists (via the user's saved profile once signed in, via `localStorage` before sign-in). Covers the welcome/onboarding screen, upload screen, nav, all 10 result tabs and headers, the full review flow (grading, grade buttons, empty states), and Manage Topics. The profile's language dropdown (`kk`/`ru` options) is no longer disabled/"coming soon" — it's live.
- Known incomplete spots (acceptable follow-up, not blocking): a handful of raw server-side error messages (e.g. network error text, validation errors) are still English-only, since translating those means localizing backend error strings too — lower priority than the content students actually study from.

**Motivational/confidence dashboard ("Your Progress" card):**
- `services/mastery.js`: `getDashboard(userId)` computes a study streak (consecutive active days, built retroactively from existing `mastery.lastReviewedAt` + `history.uploaded_at` timestamps, not a new tracked field), the longest streak ever recorded (a full scan of all active dates, not just the current run — this is the "weekly/monthly record" Aisha asked for), overall mastered-question count, and per-topic status. Per topic: `status` is `'unstudied'`/`'light'`/`'deep'` based on average repetitions on that topic's items, and `needsAttention` flags a topic not reviewed in 10+ days. Streak logic has a one-day grace period. Verified with unit tests (streak gap/no-gap/empty, longest-streak scan across multiple runs).
- `routes/mastery.js`: `GET /api/mastery/dashboard`.
- Frontend (rewritten Jul 25 in response to Aisha's detailed spec — "plant fits the biology/green theme better than a flame", non-harsh comeback messaging, color-coded topic map, no evaluative scores): "Your Progress" card between the upload box and Recent Uploads, now in the sidebar column of a two-column layout so it doesn't leave the page looking empty on wide screens.
  - Streak is shown as a 4-stage growing plant (seed → sprout → young plant → bloom, via `plantIcon()`/`plantStageForStreak()`) instead of a flame — matches the green biology theme and reads as "tending something" rather than a raw counter.
  - When a streak breaks, the dashboard shows a non-punitive "comeback" message (`streakComeback`) instead of a flat "0" — and still surfaces the best streak ever recorded (`streakBest`) so a broken streak doesn't erase the evidence of past consistency.
  - Per-topic progress is a color-coded dot (grey = not studied, light green = studied a little, deep green = reviewed several times) instead of a percentage bar, with a "could use a revisit" flag on neglected topics — a glance, not a score.
  - Copy follows Aisha's confidence-language rules throughout: no evaluative percentages, no comparison to other students, "yet"/invitation framing on empty and reset states.
  - One milestone message at a time (highest-value first: 7-day streak > 50 mastered > 3-day streak > 10 mastered > "study today" nudge). Refreshes after every upload and every review session.
  - Not yet built from Aisha's fuller spec: pre-summative exam-date encouragement, and reflection prompts with a tracked 1-5 confidence rating — both need new data model fields and haven't been scoped yet.

## Original plan vs. what's built (checked Jul 24, 2026)

Aisha's original requirements doc ("ShabytBio — Full Requirements Summary") named a target audience of NIS Grade 11-12 (English, primary) plus Grade 7-10 (Kazakh/Russian, secondary), a July→October V1-V4 timeline, and a longer feature list than what the earlier sessions' working notes tracked. Cross-checked against the actual code:

**Done, several expanded well beyond the original spec:** file upload + AI restructuring (now 11 output sections, not the original 4), Learning Objectives extractor, student focus-instruction input, visual diagrams (mind map + process diagrams), spaced repetition (plus full topic management — rename/archive/delete — beyond original scope), practice question generator (plus AI-graded free-text answers, beyond original scope), Google OAuth accounts. All 6 "Immediate Fixes Needed" from that doc (markdown asterisks, hidden-details quality, memorization-friendly formatting, objective extractor, prompt input, diagrams) are done.

**Real gaps — status:**
- ~~Kazakh/Russian language support~~ — **done, see above.**
- ~~Motivational/confidence block~~ — **done, see above.**
- **Community content sharing.** Not built. Current caching is invisible/automatic (dedup by content hash, so classmates don't re-trigger AI calls) — different from the plan's description of students browsing/sharing each other's notes.
- **Explicit learning-style selector.** The plan describes a student picking a style (visual/auditory/reading/kinesthetic) and getting adapted output. What's built instead gives every student all four modalities as tabs (notes/diagrams/audio/quiz) to freely choose between — arguably better UX, but a different design than planned. Needs Aisha's call on whether that's fine as-is.
- **Design palette.** Plan specified "calm green (biology association)"; actual CSS is blue-primary throughout (`#3182ce`/`#2b6cb0` used pervasively, green only on one toggle switch). Unclear if this was an intentional pivot — needs Aisha's call.

**Stack deviations (not gaps, just different tools than originally named):** Gemini 2.5 Flash (not 1.5), Render (not Vercel), MongoDB Atlas (not Firebase/Supabase).

**Timeline read:** original plan was July=V1, August=V2 (spaced repetition + practice questions + accounts), September=V3 (motivational block + community + feedback), October=V4 (refinements + launch beyond NIS). Most of V2 is already done ahead of schedule. The real gaps above are legitimately V3/unscheduled work, not things that slipped — except language support, which the plan lists as a target-audience requirement without an assigned month.

## Decision (Jul 19, 2026)
Launch biology-only first. Beta testers asked for physics, chemistry, etc. — strong signal, but deliberately holding off to keep the biology launch stable and focused.

## Beta feedback — status

**Done and deployed:**
- Free-text answers with AI grading in Review (Мадина's suggestion)
- Per-topic Manage Topics: rename, pause/resume, cascade-delete, manual delete for orphaned topics
- "Test Yourself" / "Review" labeling clarified as a quiz (both the in-results tab and the top-nav button)
- Study Notes: markdown tables for genuine comparisons, `[STEP]` sequences for ordered processes, `[KEY]` callouts for standout terms
- Mobile tab bar horizontal-scroll fix
- Audio voice quality improved (best available browser voice, not just first match)
- Diagram color — switched from grayscale 'neutral' theme to colored 'default' theme
- Diagram reliability — fixed unicode/special-character handling and edge-label/node-shape syntax that were silently breaking Mermaid parsing; diagram render errors now show technical details for debugging instead of just failing silently
- Learning Objectives consistency — lowered Gemini temperature to reduce run-to-run verdict flips
- Duplicate review items from re-uploads — fixed going forward (dedup by question text)
- Emoji icons replaced with a consistent monochrome SVG icon set (looked "AI generated")
- Result cache now versioned to the prompt, so prompt improvements don't get silently masked by stale cached results

**Still open / needs a decision:**
- Confirm `node scripts/dedupe-mastery.js` was run to clean up pre-existing duplicate review items from before the dedup fix (one-time cleanup, not yet confirmed done)
- Apple/iCloud sign-in — blocked on cost (needs paid Apple Developer account)
- "Motivation block" / reward system — discussed, deliberately deferred post-beta
- Multi-subject expansion (physics, chemistry) — deferred, biology launches first

## Verified this session
- Cross-user result caching works as designed: cache key is content + focus instructions + grade level, with no userId in it, so any student uploading a file a classmate already uploaded gets an instant result with no extra Gemini call. `scripts/test-cache.js` added to re-verify this against the live database anytime (run `node scripts/test-cache.js`).
- `services/mastery.js`'s `gradeAnswer` (AI grading of typed review answers) shares the same Gemini rate limit (`GEMINI_RPM_LIMIT`, currently 5 requests/min) and API cost as uploads — it's a small, cheap call (1024 max output tokens vs. 32,768 for a full upload) but it does count against the same free-tier request budget, so heavy review-session use and heavy upload use compete for the same queue.

## Multi-subject expansion (future, post-launch)
- Technically feasible without a rewrite: the core engine (Learning Objectives check, Hidden Details, Checklist, mastery/spaced-repetition, Diagrams) is built around *how NIS summatives work*, not biology content specifically.
- The only hardcoded biology-specific piece is the system prompt in `services/claude.js` ("You are an expert biology tutor...") — extending this means making the subject a parameter and generalizing the prompt wording, not redesigning features.
- Open question to decide later, not now: keep "ShabytBio" as the brand and expand its scope, or treat other subjects as a separate product/brand. Worth deciding once biology has real usage data to point to.
