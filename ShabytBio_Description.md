# ShabytBio — AI Study Companion for Biology Students

## What it is

ShabytBio is an AI-powered study companion built specifically for NIS (Nazarbayev Intellectual Schools) biology students preparing for summative assessments. A student uploads their lesson material — a PDF, a plain text file, or a PowerPoint slide deck — and ShabytBio turns it into a complete, structured study package within about a minute, tailored to what NIS summatives actually test.

## Core features

**Learning Objectives check.** ShabytBio evaluates whether the uploaded material actually covers what it claims to teach, labeling each objective "In Material," "Partially in Material," or "Missing from Material." This surfaces gaps a student might otherwise not notice until the exam itself.

**Study Notes.** A clean, restructured rewrite of the source material, with key terms bolded for fast scanning and review.

**Visual Diagrams.** Auto-generated mind maps and process diagrams for visual learners, with a full-screen enlarge view for detail-heavy diagrams that don't fit comfortably in a small card.

**Listen — a study conversation.** A two-voice spoken dialogue (using the browser's built-in text-to-speech, so it's free and instant, no audio files to generate or host) that walks through the material conversationally — useful for students who retain information better by ear, or who want to review while doing something else.

**Hidden Details.** Specific facts, exceptions, or details that commonly appear on summatives but are easy to skim past in normal notes, each paired with a collapsible memory trick so the page isn't overwhelming by default.

**Key Concepts.** The core ideas of the material distilled and explained in plain language, with bolded terminology.

**Likely Summative Topics.** A predictive list of what's most likely to be tested, based on how the material is structured and weighted.

**Test Yourself.** 10–16 self-test questions with answers, generated directly from the uploaded material, for active recall practice rather than passive rereading.

**Readiness Checklist.** A tick-off list of concrete things a student should be able to do or know before walking into the summative.

**Mastery tracking (spaced repetition).** Every self-test question a student answers feeds into a personal review queue, using a spaced-repetition algorithm (grading questions as Again/Hard/Good/Easy and rescheduling them accordingly). This turns one-off uploads into a running, long-term study habit rather than a single-use tool — students build up mastery over their whole semester of material, not just one lesson at a time.

**Personalization.** Students can add free-text focus instructions per upload ("I already know the vocab, focus on calculations") so the output adapts to what they specifically need, not a generic summary.

## Why it's distinct

Most AI study tools are generic — built for any student, any curriculum, any exam format. ShabytBio is built around one specific, well-defined context: the NIS biology summative format. It doesn't just summarize; it reframes material the way an NIS teacher actually tests it — objective coverage checks, summative-style hidden-detail traps, and a checklist format that mirrors how NIS students are taught to self-assess. That specificity is the whole value proposition: a tool built for everyone ends up optimized for no one, and ShabytBio deliberately narrows its scope to be maximally useful for exactly this audience.

## Why it's efficient

Two design choices keep it fast and reliable even on a free-tier budget:

- **Result caching.** Classmates in the same class frequently upload the exact same slide deck. The second (and every subsequent) student to upload identical content gets an instant cached result, with zero additional AI processing.
- **Request queueing.** If usage spikes — a whole class studying the night before a summative — requests queue automatically instead of failing, so nobody sees an error even under load.

Together, these mean the app stays responsive and cost-free to run even as more students start using it, without needing paid infrastructure to handle bursts of simultaneous studying.
