# ShabytBio — Roadmap Notes

## Decision (Jul 19, 2026)
Launch biology-only first. Beta testers asked for physics, chemistry, etc. — strong signal, but deliberately holding off to keep the biology launch stable and focused.

## Next session — pending items

**Needs one more push (already coded, not yet deployed):**
- Mermaid "bomb" error graphic cleanup fix (services: public/index.html) — ready, just run `git add . && git commit -m "Clean up stray mermaid error graphics" && git push`

**Quick fixes from beta feedback, not yet built:**
- "Test Yourself" doesn't read as a quiz — rename/label it clearer (e.g. "Quiz Time")
- Study Notes sometimes too wall-of-text — nudge prompt toward shorter chunks + tables
- Learning Objectives inconsistency between runs on the same material — lower Gemini's temperature (currently unset/default) in `services/claude.js` for more consistent verdicts on borderline objectives — Aisha was deciding on this, no answer yet
- Audio voices sound robotic — limited fix available (pick better browser voices from what's on the device); full fix needs paid TTS, not worth it now

**Bigger roadmap items (post-launch, not this week):**
- Free-text flashcard answers with AI grading instead of Easy/Good/Hard (Мадина's suggestion — strong idea, real feature work)
- Apple/iCloud sign-in (needs paid Apple Developer account — blocked on cost)
- Multi-subject expansion (physics, chemistry, etc.) — biology launches first per Jul 19 decision below

**Already done this session:** Related Videos tab (real YouTube videos via Data API), mobile tab bar horizontal-scroll fix, design + marketing summary docs, git history had to be reset once due to an accidentally-committed `.env` (now clean, confirmed nothing leaked to GitHub).

## Multi-subject expansion (future, post-launch)
- Technically feasible without a rewrite: the core engine (Learning Objectives check, Hidden Details, Checklist, mastery/spaced-repetition, Diagrams) is built around *how NIS summatives work*, not biology content specifically.
- The only hardcoded biology-specific piece is the system prompt in `services/claude.js` ("You are an expert biology tutor...") — extending this means making the subject a parameter and generalizing the prompt wording, not redesigning features.
- Open question to decide later, not now: keep "ShabytBio" as the brand and expand its scope, or treat other subjects as a separate product/brand. Worth deciding once biology has real usage data to point to.
