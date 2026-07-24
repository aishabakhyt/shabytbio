# ShabytBio — Roadmap Notes

_Last updated: Jul 24, 2026_

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
