# ShabytBio — Roadmap Notes

_Last updated: Aug 28, 2026_

## Self-test reliability fix (Aug 28, 2026, found during Aisha's supervised test run)

Live test (`scripts/test-language-regenerate.js`, real Gemini calls) caught a real bug: Gemini can return a syntactically complete, non-MAX_TOKENS JSON response that's still missing a required key — specifically `self_test`, on a Russian-language generation. Not a parsing bug (braces balanced, `finishReason` wasn't `MAX_TOKENS`) — the model just lost coverage of the last field in an increasingly long response. `validateStudyPack`'s tripwire warns on this but is deliberately non-blocking, so it would have reached a student silently: a regenerated upload with a broken or empty quiz tab, since `self_test` is what the whole spaced-repetition system runs on.

Two fixes, both in `services/claude.js`:
- **Reordered the output schema**: `audio_dialogue` moved from the 2nd key to the last, after `self_test`. `audio_dialogue` is now unbounded-length (20-turn floor, no ceiling, since this session's audio-depth change) and is the most expendable field if anything gets dropped; `self_test` is the least recoverable, so the schema now generates it first among the "back half" of fields instead of last.
- **Retry on missing required fields**: `restructureWithClaude` now checks the parsed result against `REQUIRED_KEYS` (newly exported from `validateStudyPack.js` so the two can't drift apart) plus an explicit empty-array check for `self_test`, and retries the whole generation once before giving up with a clear "please try again" error — instead of silently returning/caching/saving a broken result.
- Also guarded two unguarded `.self_test.length` reads in `scripts/test-language-regenerate.js` that crashed instead of reporting cleanly when this first surfaced.
- PROMPT_VERSION bumped (`v13-self-test-reliability-fix`).
- **Verified**: syntax-checked all three changed files. **Not yet verified**: whether the reorder+retry actually prevents a recurrence live — needs another supervised run.

## Illustrated diagrams (proof of concept built Aug 28, 2026)

Aisha's feedback on the mind map/process diagrams: even though nodes state real facts (not bare keywords), a box-and-arrow flowchart doesn't help memorization the way a real labeled textbook diagram would, and doesn't leverage dual coding / picture-superiority effects. Researched the learning-science literature first (Mayer's multimedia principles — signaling, spatial contiguity, coherence; dual coding theory; NCBI's review of illustration-based biology learning) before building, per Aisha's request — informed the design below.

- **Approach**: a small library of pre-built, hand-vetted SVG templates (base illustration + fixed anchor coordinates), NOT AI-generated art — Gemini only picks a template and maps facts to existing anchor ids, so the actual anatomy is always correct regardless of what the model does. Single JSON source of truth (`public/diagram-templates.json`) read by both the server (`services/diagramTemplates.js`, for the prompt registry description + anchor validation) and the browser (fetched once, used to render) — same reasoning as the existing Mermaid trio (prompt/validator/renderer) staying in sync.
- **First template**: `synapse` (chemical synapse cross-section — axon, presynaptic terminal, mitochondrion, vesicles, calcium channel, synaptic cleft, enzyme, postsynaptic membrane, receptor, postsynaptic neuron — 12 anchors total).
- **Prompt** (`services/claude.js`, new ILLUSTRATED DIAGRAM section): Gemini only ever chooses an existing anchor id and writes the fact + a category (structure/process/clinical, drives label color — the signaling principle) for it; never draws anything itself. `illustrated_diagram: {template, labels[]}` added to the output schema, nullable — omitted when nothing matches. PROMPT_VERSION bumped (`v12-illustrated-diagrams`).
- **Validation** (`services/validateStudyPack.js`): unlike every other check in this file (which only warns), an invalid anchor id here gets silently dropped from the result before it's cached/saved — the registry is ground truth, so this is fixable with total confidence rather than just flagged. Caught and fixed a real ordering bug while building this: validation used to run AFTER `setCached()` was called, so a sanitized/mutated result could still get cached in its unsanitized form for the next classmate — reordered so sanitization always happens before caching (applies to both `/upload` and the new `/history/:id/regenerate-language` route).
- **Rendering** (`public/index.html`): base illustration centered, labels laid out as callout boxes in left/right margins (side comes from the template, not the AI), connected to their exact anchor point with a dashed leader line — spatial contiguity without cluttering the illustration itself. Box height adapts to wrapped text; canvas height adapts to however many labels landed on the fuller side, so it never compresses/overlaps regardless of how many facts a given upload has for a given structure.
- **Fallback**: content that doesn't match any template gets today's mind map/flowchart treatment, unchanged — nothing regresses.
- **Verified so far**: full pipeline tested with hand-crafted label data (all 12 anchors, 2 anchors, 0 anchors, one-per-side) rendered through Playwright — no NaN/undefined leaks, layout holds up, leader lines correctly connect labels to anatomy. **Not yet verified**: an actual live Gemini call correctly picking the synapse template and mapping real slide content to the right anchors — Gemini's API isn't reachable from either automated shell available in this session (see the language-regeneration entry above for the same limitation). Needs Aisha to upload a real synapse/neurotransmission slide via `npm run dev` to confirm end-to-end.
- **Not yet built**: more templates beyond synapse (cyclic pathway, branching tree, comparison, and more labeled-cross-section structures like mitochondrion/chloroplast/nephron/alveolus/heart/DNA/sarcomere) — this was scoped as a proof-of-concept first, on purpose, before investing in the rest of the library.

## Audio depth + "regenerate in my language" (built Aug 28, 2026)

Aisha's feedback: audio dialogue felt thin, and switching profile language after uploading didn't actually translate old content (only the UI chrome re-translates instantly; the AI content was a frozen snapshot from generation time).

- **Audio dialogue** (`services/claude.js`): replaced the flat 10-16 turn cap with scaling to content depth — roughly 3-4 turns per major notes section, 20-turn floor, no ceiling — and told the model to walk every section systematically instead of sampling "highest-yield" bits, so listening alone gets close to full coverage. Output token budget raised 32768 -> 49152 to avoid truncating the longer response. PROMPT_VERSION bumped (`v11-longer-audio-dialogue`).
- **Language regeneration**: root cause was that `extracted_text` (and the language/school/grade a result was generated with) was never persisted on a history record — so there was no way to regenerate old content without the original file. Fixed: `services/db.js` now stores `extracted_text`/`language`/`school`/`grade` per upload and adds `updateUploadResult()` to overwrite a record's result in place; new route `POST /api/history/:id/regenerate-language` re-runs analysis with the student's *current* profile language against the stored text (still goes through the shared cache) and reconciles the mastery queue (`deleteByUploadId` then `seedFromSelfTest`) since old-language question text can't dedup-match new-language questions. Frontend shows a banner + "Regenerate in [language]" button on any history item whose stored language no longer matches the profile; records saved before this change (no `extracted_text`) get a plain "re-upload to get this in your language" message instead of a button that would just fail.
- **Known trade-off, flagged not fixed**: regenerating an upload's language resets spaced-repetition progress on that upload's review questions — the old question text and the new-language question text can never dedup-match, so there's no way to carry interval/ease/repetition history across a language change on the same content. Aisha wants this revisited after the bigger in-flight work (illustrated diagrams, motivation/relatedness features) is done, not now.
- **Testing note**: could not run a live end-to-end test (real Gemini + real Mongo) from either available automated shell in this session — both are network-sandboxed and block `generativelanguage.googleapis.com` / `mongodb.net`. Verified instead: every changed file's syntax, and the database/mastery mechanics specifically (schema round-trip, update-in-place, reconcile-don't-duplicate) via `scripts/test-db-mastery-only.js` with canned fake results in place of real Gemini calls — that script still needs a normal (non-sandboxed) terminal to actually run. `scripts/test-language-regenerate.js` does the same check with real Gemini calls (en + ru) for whenever Aisha runs it herself with normal network access.


## Second beta feedback round (built Jul 27-28, 2026)

Aisha's response to the dashboard/language rollout raised 8 points; all built except reflection prompts (deferred, see below):

- **Dedicated dashboard page.** New `/` nav "Dashboard" button (and a "View full dashboard →" link from the home sidebar card) opens a full page: motivation hero, per-topic progress with no 5-item cap, full upload history, and an "Edit profile" shortcut — consolidating what was split across the sidebar card, Recent Uploads, and Manage Topics. Streak is now also a 7-day dot row (GitHub/Duolingo-style, active/inactive per day) — self-evident without reading the "How does this work?" explainer, which stays as an optional collapsed fallback.
- **UI smoothness pass.** Every button now has a consistent hover/press transition; tabs, diagram cards, hidden-detail groups, and the dashboard hero fade in instead of snapping into place.
- **Audio was a real bug, not a limitation.** The voice-picker was hardcoded to always select an English voice regardless of the chosen language, so Kazakh/Russian dialogue (already correctly translated) was read aloud with English pronunciation. Fixed to match the actual voice to the student's language; the Audio tab now hides itself entirely if the browser has no voice for that language at all (expected for Kazakh — mainstream browsers essentially never ship one) rather than mispronouncing it.
- **NIS is now conditional, not hardcoded.** New `school` profile field (`nis` | `other`, defaults to `nis` for the current all-NIS audience). ~20 places in the prompt that said "NIS" unconditionally now only do so for students who actually said they're at an NIS school; everyone else gets the same six-pattern exam intelligence with generic wording. Cache key updated to include `school`.
- **"Hidden Details" renamed to "Easy to Miss."**
- **Mind map density fix, take two.** The first density fix (fewer nodes so branches stop overlapping) accidentally pushed toward bare 1-4 word keyword nodes — exactly what Aisha then flagged as "meaningless." Corrected: every node must now state an actual fact or relationship ("Cristae increase surface area", not "Cristae"), 2-6 words. Researched mind-map design principles (see PROMPT_VERSION v9 commit) — the conclusion: density belongs in Study Notes/Hidden Details, the mind map's job is a readable overview made of meaningful phrases, not more bare nodes.
- **Comparison diagrams** (`graph LR`, e.g. "Relaxed vs Contracted Sarcomere") got an explicit two-chain template after one failed to render — steers the model away from untested "subgraph" syntax toward the same node+arrow syntax process diagrams already use reliably.
- **Not built yet, deliberately deferred:** motivation-block ideas beyond what exists (weekly recap, visible milestone history) — proposed to Aisha, no build decision yet. Subject/brand scope (stay ShabytBio, biology-only through launch) — recommended, not a code change.

Known limitation: cached/already-saved upload results don't retroactively pick up any of the above — a student has to re-upload (or re-run "Upload & Analyse" on the same file) to get the new diagram/prompt behavior on old content.

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
  - **Pre-summative exam-date encouragement (built Jul 25, per-topic scope, as Aisha requested):** each topic in Manage Topics can have an optional exam date (`services/mastery.js`'s `setTopicExamDate`, denormalized onto the topic's items same as rename/archive). When an exam is within 30 days, the dashboard shows a calm, factual reminder — "12 days until your X exam — you've reviewed 4 of 9 questions here" — never a countdown-timer or hype framing. Up to 3 upcoming reminders shown, soonest first.
  - **Not yet built:** reflection prompts with a tracked 1-5 confidence rating — Aisha chose to hold this for after launch (bigger scope: new DB collection, new post-analysis UI flow).

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
