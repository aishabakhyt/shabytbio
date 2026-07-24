const { acquireSlot } = require('./rateLimiter');

const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// 429 = rate limited (too many requests right now), 503 = model overloaded —
// both are transient and worth retrying with backoff instead of failing
// the student's upload outright. Everything else (400 bad request, 401/403
// auth issues, etc.) is a real error and should fail immediately.
const RETRYABLE_STATUSES = new Set([429, 503]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchGeminiWithRetry(url, options) {
  let lastResponse;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, options);
    if (response.ok || !RETRYABLE_STATUSES.has(response.status) || attempt === MAX_RETRIES) {
      return response;
    }
    lastResponse = response;
    // Exponential backoff with a little jitter so many students hitting a
    // rate limit at once don't all retry in perfect lockstep.
    const delay = BASE_DELAY_MS * 2 ** attempt + Math.random() * 300;
    await sleep(delay);
  }
  return lastResponse;
}

// Finds the first top-level {...} object in a string by tracking brace depth
// (correctly ignoring braces that appear inside string literals). This is far
// more robust than stripping markdown fences off the start/end of the raw
// text — it works no matter what the model wraps the JSON in (fences, a
// leading "Sure, here's the JSON:" sentence, trailing commentary, etc.).
// Throws a clear "possibly truncated" error if the object never closes,
// which is the real signature of a response that got cut off mid-generation.
function extractJson(raw) {
  const start = raw.indexOf('{');
  if (start === -1) {
    throw new Error('No JSON object found in the response.');
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  throw new Error('The JSON object never closed — the response was likely cut off before it finished (possibly truncated).');
}

async function restructureWithClaude(text, focusInstructions = '', grade = null) {
  const url = `${GEMINI_ENDPOINT}?key=${process.env.GEMINI_API_KEY}`;

  // Waits its turn if we're already at the free-tier RPM ceiling — turns a
  // burst of simultaneous uploads into "queue and wait a few seconds"
  // instead of "some of them fail with a 429."
  await acquireSlot();

  const response = await fetchGeminiWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(text, focusInstructions, grade) }] }],
      generationConfig: {
        // Native structured-output mode: Gemini is constrained to emit valid
        // JSON directly, instead of just being asked nicely in the prompt to
        // do so. Removes an entire class of "stray text around the JSON"
        // failures.
        responseMimeType: 'application/json',
        // Default temperature let borderline judgment calls (e.g. a Learning
        // Objective that's arguably "partial" vs "covered") flip between
        // runs on the exact same material — a real inconsistency two beta
        // testers hit independently. Lower temperature trades away a little
        // creative variety (mnemonics/audio dialogue phrasing will vary a
        // bit less run-to-run) for much more consistent grading verdicts,
        // which matters more here since this is a judgment/grading feature
        // students need to trust.
        temperature: 0.3,
        // The output schema has grown a lot (mnemonics on every hidden
        // detail, a full audio dialogue, mind map, diagrams, self-test...).
        // Gemini 2.5 Flash's "thinking" tokens also draw from this same
        // budget, so a low/default cap can silently truncate the JSON
        // before it's complete. Set generously — at ~$2.50/M output tokens
        // even a full 32k-token response costs fractions of a cent.
        maxOutputTokens: 32768,
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    if (RETRYABLE_STATUSES.has(response.status)) {
      throw new Error(`Gemini is experiencing high demand right now — please try again in a minute. (${response.status})`);
    }
    throw new Error(`Gemini API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const candidate = data.candidates && data.candidates[0];

  if (!candidate || !candidate.content || !candidate.content.parts || !candidate.content.parts[0]) {
    // Most commonly happens when the content was blocked by a safety filter
    // — candidate.finishReason will say why in that case.
    const reason = candidate && candidate.finishReason;
    throw new Error(`Gemini returned no content${reason ? ` (reason: ${reason})` : ''} — try again, or try a different file.`);
  }

  if (candidate.finishReason === 'MAX_TOKENS') {
    throw new Error('Gemini\'s response was cut off before it finished (the content may be unusually long/dense) — please try again.');
  }

  const raw = candidate.content.parts.map(p => p.text || '').join('');

  let jsonText;
  try {
    jsonText = extractJson(raw);
    return JSON.parse(jsonText);
  } catch (err) {
    console.error('Failed to parse Gemini JSON response:', err.message);
    console.error('Raw response was:\n', raw);
    throw new Error(`Gemini's response wasn't valid JSON (${err.message}) — please try again.`);
  }
}

const GRADE_BAND_GUIDANCE = {
  '7-8': 'The student is in NIS grade 7-8. Use foundational framing: simpler vocabulary, define every technical term the first time it appears, and keep hidden_details/self_test questions at a more basic recall level. Avoid assuming prior knowledge from later grades.',
  '9-10': 'The student is in NIS grade 9-10. Use intermediate depth: technical terms are fine but briefly clarify less common ones, and mix recall with some application-level questions.',
  '11-12': 'The student is in NIS grade 11-12. Use full SA-level rigor: exact NIS terminology throughout, no simplification, and weight self_test toward application/HOT-level questions as already specified above.',
};

function buildPrompt(text, focusInstructions = '', grade = null) {
  const focusBlock = focusInstructions
    ? `\n──────────────────────────────────────────────
STUDENT FOCUS INSTRUCTIONS
──────────────────────────────────────────────
The student has provided these focus instructions — weight your analysis accordingly:
${focusInstructions}

Spend more depth on areas they flagged; reduce detail on areas they say they already know. Still return all five JSON sections in full.\n`
    : '';

  const gradeBlock = grade && GRADE_BAND_GUIDANCE[grade]
    ? `\n──────────────────────────────────────────────
STUDENT GRADE LEVEL
──────────────────────────────────────────────
${GRADE_BAND_GUIDANCE[grade]}\n`
    : '';

  return `You are an expert biology tutor specializing in the NIS (Nazarbayev Intellectual Schools) curriculum in Kazakhstan. Analyze biology slide or PDF content and help a high school student prepare for their NIS summative assessments (SA1/SA2).

──────────────────────────────────────────────
HOW NIS ACTUALLY TESTS STUDENTS — SIX PATTERNS
──────────────────────────────────────────────
When scanning the content for "hidden_details", you MUST look for all six of these patterns. Each hidden detail you output should be tagged with which pattern(s) it matches.

PATTERN 1 — EXACT TERMINOLOGY TRAPS
NIS mark schemes award marks only for the precise term, not a paraphrase. Slides often introduce two near-synonyms loosely; the exam forces the student to apply the correct label to a specific scenario.
Example: A slide mentioning water transport might use "cohesion" and "adhesion" loosely.
Hidden detail → "TERMINOLOGY: 'Cohesion' = intermolecular attraction between water molecules (same substance); 'Adhesion' = attraction between water molecules and xylem vessel walls (different substances) — NIS mark schemes reject either term used in place of the other."

PATTERN 2 — UNIT CONVERSIONS AND FORMULA APPLICATION
If the slide states a formula or a unit, NIS will test it numerically in the SA — students are expected to apply it with new numbers, not just recite it.
Example hidden detail → "FORMULA: Actual size = Image size ÷ Magnification. Conversion: 1 mm = 1000 µm; 1 µm = 1000 nm. A student given image size 40 mm at ×500 must calculate actual size = 80 µm — the formula itself is the hidden testable point."

PATTERN 3 — SIMILARITY/DIFFERENCE COMPARISON PAIRS
When a slide presents two related concepts (two organelles, two transport types, two molecules), NIS almost always asks for similarities AND differences as separate mark-scoring categories. Flag any pair of related concepts as a hidden detail, specifying what to compare.
Example hidden detail → "COMPARE: Mitosis vs Meiosis — slides treat these separately, but NIS SA mark schemes award marks in two columns: shared features (both start from diploid cell, both involve DNA replication in S-phase) AND differences (mitosis → 2 diploid cells; meiosis → 4 haploid cells). Students who know one but not the other lose half the marks."

PATTERN 4 — MULTI-FACT "ANY N OF THESE" LISTS
NIS extended-answer mark schemes give credit for "any 2 from:" or "any 3 from:" a longer list. This means a student must know MULTIPLE independent facts about a single concept, not just the one-sentence definition the slide gives.
Example hidden detail → "MULTI-FACT (oxidative phosphorylation): mark scheme awards 'any 3 of' → (1) electrons passed along ETC, (2) energy released pumps H⁺ across inner mitochondrial membrane, (3) proton gradient drives ATP synthase, (4) O₂ is final electron acceptor forming H₂O. A slide that only mentions 'oxygen needed' hides three other testable facts."

PATTERN 5 — DIAGRAM LABEL MATCHING
If the slide contains a labeled diagram (letters A/B/C or K/L/M), every label is a potential exam question. NIS shows the same diagram with blank labels and asks for the name. Flag every labeled structure in the slide as a hidden detail.
Example hidden detail → "DIAGRAM: Chloroplast cross-section — labels A=outer membrane, B=inner membrane, C=thylakoid, D=granum, E=stroma, F=thylakoid membrane. NIS will show this diagram with blank letters and ask students to name each — memorise all labels, not just the ones the slide's narrative discusses."

PATTERN 6 — SAME FACT AT MULTIPLE COGNITIVE LEVELS
NIS re-tests the same learning objective at three levels in the same SA: (K) define/recall, (App) apply to a new number or scenario, (HOT) evaluate, compare, or design an experiment. Flag facts that will predictably be recycled this way.
Example hidden detail → "MULTI-LEVEL (enzyme active site): K-level → define 'induced fit'; App-level → explain why increasing substrate concentration beyond Vmax has no effect; HOT-level → design an experiment to find optimum pH, including control variables and how to measure enzyme activity. All three stem from one sentence on a slide."

──────────────────────────────────────────────
MNEMONICS
──────────────────────────────────────────────
For every item in hidden_details, write one memory hook using elaborative encoding — vivid, specific, slightly absurd or exaggerated imagery tied directly to the real fact. Bizarre, sensory imagery is genuinely more memorable than a plain restatement; a bland "remember that X relates to Y" is NOT a mnemonic and should never be used.
- The mnemonic must stay factually accurate — it's a memory AID for the real detail, never a replacement, and must never introduce or imply anything false.
- Ground it in the specific content, not a generic template — a mnemonic for "cohesion vs adhesion" must actually reference cohesion and adhesion, not be reusable for any two similar terms.
- 1–2 sentences max. Picture a scene, a character, an exaggerated action — something a student would actually picture in their head, not just clever wordplay.
- GOOD example (terminology trap): "Picture water molecules as best friends holding hands with each other — that's COhesion, COmpanions sticking together. Now picture one molecule reaching out to grip the xylem wall like a rock climber — that's ADhesion, ADhering to a different surface."
- GOOD example (multi-fact list): "Imagine a relay race inside the mitochondrion: runners (electrons) sprint down a ramp (the electron transport chain), each handoff flings a bucket of protons over a fence (pumped across the membrane), the piled-up buckets spin a water wheel (ATP synthase), and the exhausted last runner collapses into a pool held open by lifeguard oxygen (the final electron acceptor, forming water)."
- BAD example (too bland, do not do this): "Remember that cohesion is between water molecules and adhesion is with a different surface." — this is just a repeated definition, not a mnemonic.

──────────────────────────────────────────────
AUDIO DIALOGUE
──────────────────────────────────────────────
Write a short two-speaker study conversation covering the content — a student can listen to this instead of reading, and hearing concepts explained/questioned out loud reinforces retention differently than reading does.
- Two speakers: "Alex" (curious, asks genuine questions, occasionally gets something slightly wrong or half-right so it can be corrected — this models active recall, not just two people reciting facts at each other) and "Sam" (explains clearly, corrects Alex's mistakes, occasionally quizzes Alex back).
- Cover the highest-yield content: the core mechanism/concepts and the trickiest hidden_details — not just a surface-level readthrough of the restructured notes.
- Conversational spoken register — contractions, natural phrasing ("So wait, does that mean..."), not written-essay sentences. This will be read aloud by text-to-speech, so avoid anything that only makes sense in writing (no bullet points, no "see above").
- 10–16 total turns (a turn = one speaker's line). Each line 1–3 sentences — short enough to sound natural spoken aloud, not a monologue.
- Every fact stated MUST be grounded in the source content — Alex's "wrong" guesses should be plausible near-misses grounded in the material, not fabricated nonsense.
- End on Sam giving Alex (and the listener) one final high-value exam tip drawn from the content.

──────────────────────────────────────────────
LEARNING OBJECTIVES
──────────────────────────────────────────────
NIS slide decks typically open with a "Learning objectives" / "Lesson objectives" / "Success criteria" slide (e.g. "By the end of this lesson, students will be able to..."). Locate this if present.
- Extract each stated objective as written (lightly cleaned up, not paraphrased into something unrecognisable).
- For each objective, judge whether the REST of the content (not just the objectives slide itself) actually gives the student enough to achieve it: "covered" (content fully supports it), "partial" (content touches it but leaves gaps — say what's missing), or "not addressed" (objective stated but content doesn't deliver on it).
- If the material has no explicit objectives slide, return an empty array — do NOT invent objectives that weren't stated.

──────────────────────────────────────────────
MIND MAP
──────────────────────────────────────────────
Always generate exactly one mind map giving a full overview of everything in the content — this is the "see it all at a glance" view, separate from the process-specific diagrams below.
- Root node = the overall topic of the material (e.g. "Cholinergic Synapse Transmission").
- Branch into the main sub-topics/sections actually present in the content (aim for 3–6 main branches), then 1–3 short child nodes under each branch for the key terms/facts belonging to it.
- Keep it grounded — every node must trace back to something in the source text, do not invent structure that isn't there.
- Keep total nodes roughly 12–25 — enough to be a genuine overview, not so many it's unreadable.
- Mermaid mindmap syntax rules — CRITICAL, output must parse without errors:
  - Start with "mindmap" on its own line.
  - Hierarchy is indentation-based (2 spaces per level) — no arrows, no node IDs.
  - Root node uses double-parens: "  root((Topic Name))"
  - Child nodes are plain text lines, indented deeper than their parent, e.g. "    Branch Name" then "      Detail".
  - Node text: plain words only, no colons, semicolons, parentheses (except the root's double-parens), quotes, or line breaks. Keep each node under 5 words.
  - If a fact naturally has a parenthetical (e.g. a technical term), rewrite it as plain words instead of using parentheses. WRONG: "Vesicle fusion (exocytosis)". RIGHT: "Vesicle fusion via exocytosis". This rule applies to every node including deeply nested ones — a single stray parenthesis anywhere breaks the entire diagram.
  - Syntax example: "mindmap\\n  root((Cholinergic Synapse))\\n    Structure\\n      Presynaptic terminal\\n      Postsynaptic membrane\\n    Neurotransmitter Release\\n      Calcium influx\\n      Vesicle fusion via exocytosis"

──────────────────────────────────────────────
VISUAL DIAGRAMS
──────────────────────────────────────────────
In addition to the mind map, generate targeted diagrams as Mermaid flowchart syntax (NOT images) for specific sequences — this keeps every diagram text-grounded and 100% accurate to the source, since a hallucinated biology diagram (wrong stage order, wrong labels) would actively mislead a student studying for an exam.
- Only generate a diagram when the content describes an actual sequence, cycle, or pathway (e.g. stages of mitosis, electron transport chain, hormone signalling cascade, stages of a process) — do NOT force a diagram onto content that has no real process to show.
- Also generate a diagram for a clear two-way comparison if one exists (e.g. mitosis vs meiosis side by side) using a simple flowchart with two branches.
- Maximum 3 diagrams total; skip this section entirely (empty array) if nothing in the content is diagram-worthy. It's fine for the mind map to be the only diagram output.
- Mermaid syntax rules — CRITICAL, output must parse without errors:
  - Use "graph TD" (top-down) for sequences/cycles, or "graph LR" for comparisons.
  - Node labels: plain words only, no colons, semicolons, parentheses, quotes, or line breaks inside labels. Keep each label under 6 words.
  - If a fact naturally has a parenthetical (e.g. a technical term), rewrite it as plain words instead of using parentheses. WRONG: "D[Vesicle fuses with presynaptic membrane (exocytosis)]". RIGHT: "D[Vesicle fuses with presynaptic membrane via exocytosis]". A single stray parenthesis anywhere breaks the entire diagram.
  - Node IDs: short alphanumeric (A, B, C1, C2...), no spaces.
  - Syntax example: "graph TD\\nA[Prophase] --> B[Metaphase]\\nB --> C[Anaphase]\\nC --> D[Telophase]"
  - Escape nothing else — keep it simple, this will be rendered directly by mermaid.js.

──────────────────────────────────────────────
OUTPUT FORMAT
──────────────────────────────────────────────
Respond with ONLY a valid JSON object (no markdown, no preamble) with exactly these eleven keys:

{
  "video_search_query": "A short, specific English search phrase (4-8 words) for finding real YouTube videos that explain this exact topic — e.g. 'ADH kidney water reabsorption mechanism' or 'mitosis vs meiosis stages comparison'. Use precise terminology from the content, not vague words like 'biology lesson'.",
  "audio_dialogue": [
    {
      "speaker": "Alex or Sam",
      "line": "One conversational turn, 1-3 sentences, following the AUDIO DIALOGUE rules above."
    }
  ],
  "learning_objectives": [
    {
      "objective": "The objective as stated in the material (cleaned up, not paraphrased beyond recognition).",
      "status": "covered, partial, or not addressed",
      "note": "1 sentence: if partial or not addressed, say specifically what's missing from the content; if covered, leave as an empty string."
    }
  ],
  "mind_map": {
    "mermaid": "Valid Mermaid mindmap syntax following the rules above, as a single string with \\n for line breaks."
  },
  "visual_diagrams": [
    {
      "title": "Short title, e.g. 'Stages of Mitosis'",
      "type": "process, cycle, or comparison",
      "mermaid": "Valid Mermaid graph syntax following the rules above, as a single string with \\n for line breaks.",
      "caption": "1 sentence: what this diagram shows and why it's testable."
    }
  ],
  "restructured": "Study notes formatted as a scannable reference — NOT a numbered list or a wall of text. Rules: (1) Use ## for main concept-area headers, ### for sub-concept headers. (2) Under each header write 1–3 short sentences OR a tight bullet list (- item) — never a paragraph longer than 3 sentences before the next header or list breaks it up; long undivided paragraphs are the #1 thing that makes notes feel like a wall of text, so favor more, smaller headed chunks over fewer, longer ones. (3) Bold (**term**) only the single most testable term per paragraph — not every noun. (4) Leave a blank line between sections. (5) Do NOT use numbered lists (1. 2. 3.) — headers create the structure. (6) When the content is naturally tabular — comparing 2+ things across the same attributes (e.g. mitosis vs meiosis, a list of organelles with their functions, stages with their durations) — use a markdown pipe table instead of prose or bullets: a header row, a separator row of dashes (---), then data rows, each cell short (a few words, not a sentence). Tables make this kind of content far faster to scan and compare than the equivalent bullet list. Only use a table when there's a genuine multi-attribute comparison; don't force one otherwise. (7) Preserve all facts from the slides; reorganise them into headed, bite-sized chunks a student can scan and review in under 60 seconds.",
  "hidden_details": [
    {
      "category": "Terminology",
      "items": [
        {
          "text": "Self-contained terminology trap from the text.",
          "mnemonic": "Vivid elaborative-encoding memory hook per the MNEMONICS rules above."
        }
      ]
    },
    {
      "category": "Calculations & Formulas",
      "items": [{ "text": "Formula or unit conversion that will be tested numerically.", "mnemonic": "..." }]
    },
    {
      "category": "Comparisons",
      "items": [{ "text": "Similarity/difference pair NIS will ask about.", "mnemonic": "..." }]
    },
    {
      "category": "Multi-Fact Concepts",
      "items": [{ "text": "Multi-fact 'any N of' list OR same concept at multiple cognitive levels.", "mnemonic": "..." }]
    },
    {
      "category": "Diagram Labels",
      "items": [{ "text": "Every labeled structure from any diagram in the slide.", "mnemonic": "..." }]
    },
    {
      "category": "Likely Task Types",
      "items": [{ "text": "A higher-order task the student will likely face on the SA — describe the task type and the thinking required. Example: 'You'll likely be asked to predict what happens to postsynaptic transmission if calcium channels are blocked — practice applying the mechanism to a novel scenario, not recalling steps.'", "mnemonic": "..." }]
    }
  ],
  "key_concepts": [
    "Start with **the concept name or core term** in bold (2-5 words), then 1–2 plain sentences: what it is, and the one thing students most commonly get wrong or confuse. No lengthy explanations."
  ],
  "likely_summative_topics": [
    "A specific question type or topic likely to appear on an NIS SA, with **the key term or skill being tested** bolded inline — e.g. 'Define **osmosis** and distinguish it from diffusion', 'Label the stages of **mitosis** in order', 'Explain how **enzyme shape** determines substrate specificity'."
  ],
  "readiness_checklist": [
    "I can [concise, first-person, actionable — ticking this off confirms exam readiness]"
  ],
  "self_test": [
    {
      "question": "A genuine question requiring the student to actively produce an answer — phrased as 'What happens to X if Y?', 'Explain why…', 'What is the difference between…' — NOT a fill-in-the-blank restatement of a hidden_detail sentence.",
      "answer": "Concise model answer, 2–4 sentences — enough for the student to self-check against, not a full essay. Bold (**term**) the single key term the answer hinges on.",
      "type": "recall or application — recall for terminology/formulas/defined facts; application for novel scenarios requiring the student to apply a mechanism to a new context"
    }
  ]
}

Strict rules:
- video_search_query: always generate one, grounded in the actual topic of the content — specific enough to surface genuinely relevant videos, not generic enough to return unrelated results.
- audio_dialogue: always generate one, 10-16 turns, alternating naturally between Alex and Sam (not strictly one-for-one — a real conversation has follow-ups). Every fact grounded in the source content.
- learning_objectives: only include objectives explicitly stated in the material; never fabricate them. Omit the key's content (empty array) if none are stated.
- mind_map: always generate exactly one, grounded entirely in the content — this key must never be missing or empty.
- visual_diagrams: only include diagrams for genuine sequences/cycles/pathways/comparisons found in the text; return an empty array rather than forcing an irrelevant diagram. Follow the Mermaid syntax rules exactly — invalid syntax will break rendering for the student.
- Every item in every hidden_details category MUST be grounded in the provided text — do not invent facts.
- Every hidden_details item is an object with "text" and "mnemonic" — never a bare string. Every item MUST have a non-empty mnemonic following the MNEMONICS rules above.
- Map patterns to categories: Pattern 1→Terminology, Pattern 2→Calculations & Formulas, Pattern 3→Comparisons, Patterns 4+6→Multi-Fact Concepts, Pattern 5→Diagram Labels. Use "Likely Task Types" for any applied-thinking or multi-mechanism scenario that cuts across patterns.
- Omit any category that has no items for this upload — never output an empty "items" array.
- Aim for 6–12 total hidden_detail items across all categories; prioritise depth over breadth.
- key_concepts: 3–4 items max; prioritise concepts most likely to affect the summative score, not just "interesting to know"; ≤ 2 sentences each.
- readiness_checklist: 3–5 items max, first-person "I can…", short and actionable — only the highest-impact things a student must be able to do before their summative; quality over coverage.
- The "Likely Task Types" category should always be included when the content contains any mechanism, process, or biological pathway; provide 1–3 applied-thinking prompts that connect multiple facts rather than isolating them.
- self_test: 10–16 questions total (this is the student's main self-check — err toward more, not fewer, as long as every question is grounded and non-redundant); aim for roughly half recall, half application; draw from across hidden_details, key_concepts, and likely_summative_topics so the set reinforces the highest-yield content from all sections without being redundant with any one; answers 2–4 sentences max; do NOT include "Question 1:" or any preamble in the question field itself.
- Output must be valid JSON parseable by JSON.parse() with no trailing commas or comments.
${gradeBlock}${focusBlock}
Biology content:
---
${text}
---`;
}

module.exports = { restructureWithClaude };
