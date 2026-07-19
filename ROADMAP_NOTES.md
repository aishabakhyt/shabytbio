# ShabytBio — Roadmap Notes

## Decision (Jul 19, 2026)
Launch biology-only first. Beta testers asked for physics, chemistry, etc. — strong signal, but deliberately holding off to keep the biology launch stable and focused.

## Multi-subject expansion (future, post-launch)
- Technically feasible without a rewrite: the core engine (Learning Objectives check, Hidden Details, Checklist, mastery/spaced-repetition, Diagrams) is built around *how NIS summatives work*, not biology content specifically.
- The only hardcoded biology-specific piece is the system prompt in `services/claude.js` ("You are an expert biology tutor...") — extending this means making the subject a parameter and generalizing the prompt wording, not redesigning features.
- Open question to decide later, not now: keep "ShabytBio" as the brand and expand its scope, or treat other subjects as a separate product/brand. Worth deciding once biology has real usage data to point to.
