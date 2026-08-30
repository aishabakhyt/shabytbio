# ShabytBio — Design Summary

## Design philosophy

ShabytBio is built around one principle: a stressed student the night before a summative should never have to think about how to use the tool, only about what to study. Every design decision follows from that — minimal visual noise, clear hierarchy, and information revealed progressively rather than dumped all at once.

## Visual language

The interface uses a clean white-card layout on a light gray background, with a single blue accent color for primary actions (upload, sign-in, review). No decorative elements compete with the content — the design gets out of the way of the studying. Typography leans on bold weight for key terms throughout results (in Study Notes, Key Concepts, Likely Summative Topics, and self-test answers) so a student skimming under time pressure can find the important word in a sentence without rereading the whole thing.

## Information architecture

Results are split into nine focused tabs rather than one long scrollable page: Learning Objectives, Study Notes, Diagrams, Audio, Hidden Details, Key Concepts, Likely Summative Topics, Test Yourself, and Readiness Checklist. Each tab answers a different studying question ("what should I know," "what will I be tested on," "am I ready") instead of forcing a student to parse one undifferentiated wall of content.

## Progressive disclosure

Two specific choices reflect this principle directly:

- **Hidden Details** are collapsed by default behind a "Memory trick" toggle, so the page isn't visually overwhelming, but the depth is there the moment a student wants it.
- **Diagrams** render at a readable-but-contained size inline, with a one-click "Enlarge" button that opens a full-screen lightbox for anything detail-heavy — the default view stays clean, the detail is never lost.

## Honest, specific feedback over vague checkmarks

The Learning Objectives feature deliberately avoids a simple "covered / not covered" binary. Objectives are labeled "In Material," "Partially in Material," or "Missing from Material" — a more honest three-state signal that tells a student exactly where the gap is, rather than a false sense of completeness.

## Multi-modal by design

Not every student studies the same way. ShabytBio supports reading (Study Notes, Key Concepts), listening (a two-voice spoken study conversation), and doing (Test Yourself, the Readiness Checklist) — so the same uploaded material serves visual, auditory, and active-recall learners without requiring separate tools.

## Long-term habit, not one-off use

The mastery/review system (built on a spaced-repetition scheduling algorithm) turns every self-test question a student answers into part of a running review queue, shown as a small badge count in the header. This was a deliberate choice to make ShabytBio something a student returns to across a whole semester, not a tool used once per upload and forgotten.

## Resilience as a design value

Error states were designed to never be dead ends — a failed history load includes a one-click "try again" link rather than a bare error message, and a failed sign-in session recovers gracefully instead of losing a student's in-progress work. For a tool used under exam-week stress, small moments of friction compound; removing them was treated as seriously as any visual design decision.
