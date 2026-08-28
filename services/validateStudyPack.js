// Checks a Gemini response against the structural rules already written
// into buildPrompt (services/claude.js) — mind map node count/depth/word
// length, hidden_details banned inline prefixes, diagram syntax rules that
// are known to break Mermaid rendering. This is NOT a Mermaid parser and
// it doesn't reject or retry anything; it's a tripwire. Every rule here
// exists because Gemini drifted from it at least once during development,
// and the only way that got noticed before was a screenshot from a student
// days later. This runs on every real request and logs violations with
// enough context to actually debug, instead of relying on someone noticing.
//
// Deliberately permissive (checks use looser bounds than the prompt asks
// for) — the goal is catching real drift, not flagging every response that
// isn't textbook-perfect.

const { isValidAnchor, findTemplate, templateMatchesText } = require('./diagramTemplates');

const REQUIRED_KEYS = [
  'video_search_query', 'audio_dialogue', 'learning_objectives', 'mind_map',
  'visual_diagrams', 'illustrated_diagram', 'restructured', 'hidden_details',
  'key_concepts', 'likely_summative_topics', 'readiness_checklist', 'self_test',
];

const BANNED_HIDDEN_DETAIL_PREFIXES = [
  /^terminology\s*:/i, /^formula\s*:/i, /^compare\s*:/i,
  /^multi-fact\s*\(/i, /^diagram\s*:/i, /^multi-level\s*\(/i,
];

function wordCount(str) {
  return str.trim().split(/\s+/).filter(Boolean).length;
}

// Strips leading "**" bold markers before counting words, so a bolded term
// like "**Cristae**" doesn't get penalized for the markdown syntax itself.
function stripMarkdown(str) {
  return str.replace(/\*\*/g, '').trim();
}

function validateMindMap(mindMap, warnings) {
  const mermaid = mindMap && mindMap.mermaid;
  if (typeof mermaid !== 'string' || !mermaid.trim()) {
    warnings.push('mind_map.mermaid is missing or empty.');
    return;
  }
  const lines = mermaid.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim());
  if (!lines[0] || lines[0].trim() !== 'mindmap') {
    warnings.push(`mind_map.mermaid doesn't start with "mindmap" on its own line (got: "${(lines[0] || '').slice(0, 40)}").`);
  }

  const nodeLines = lines.slice(1);
  // Depth is relative to the root line's own indent (the prompt's example
  // indents "root((...))" itself by 2 spaces, so measuring raw indent/2
  // would count root as depth 1 and a leaf as depth 3 — off by one against
  // the "root, branch, leaf" = 2 levels of nesting the prompt asks for).
  const rootLine = nodeLines.find(l => /root\(\(/.test(l));
  const rootIndent = rootLine ? rootLine.match(/^ */)[0].length : 0;
  let maxDepth = 0;
  for (const line of nodeLines) {
    const indent = line.match(/^ */)[0].length;
    maxDepth = Math.max(maxDepth, Math.round((indent - rootIndent) / 2));
  }
  if (nodeLines.length < 6) {
    warnings.push(`mind_map has only ${nodeLines.length} nodes — likely too sparse to be a useful overview.`);
  } else if (nodeLines.length > 20) {
    warnings.push(`mind_map has ${nodeLines.length} nodes (target: 10-16) — likely to overlap/clutter given Mermaid's mindmap layout has no collision detection.`);
  }
  if (maxDepth > 2) {
    warnings.push(`mind_map nests ${maxDepth} levels deep (target: 2 — root, branch, leaf) — deeper nesting is a common cause of overlapping branches.`);
  }

  let bareKeywordCount = 0;
  for (const line of nodeLines) {
    const text = stripMarkdown(line.replace(/root\(\(/, '').replace(/\)\)/, ''));
    const words = wordCount(text);
    if (words > 8) {
      warnings.push(`mind_map node text is long (${words} words): "${text.slice(0, 60)}" — target is 2-6 words.`);
    } else if (words <= 1 && text.length > 0) {
      // A single bare word is exactly the "meaningless keyword" pattern
      // Aisha flagged — every node should state a fact, not just a term.
      bareKeywordCount++;
    }
  }
  if (bareKeywordCount >= 3) {
    warnings.push(`mind_map has ${bareKeywordCount} single-word nodes — likely bare keywords instead of meaningful facts (e.g. "Cristae" instead of "Cristae increase surface area").`);
  }
}

function validateDiagrams(diagrams, warnings) {
  if (!Array.isArray(diagrams)) {
    warnings.push('visual_diagrams is not an array.');
    return;
  }
  if (diagrams.length > 3) {
    warnings.push(`visual_diagrams has ${diagrams.length} entries (max should be 3).`);
  }
  diagrams.forEach((d, i) => {
    const mermaid = d && d.mermaid;
    if (typeof mermaid !== 'string' || !mermaid.trim()) {
      warnings.push(`visual_diagrams[${i}] ("${d && d.title}") has no mermaid content.`);
      return;
    }
    const firstLine = mermaid.split('\n')[0].trim();
    if (!/^graph (TD|LR)/.test(firstLine)) {
      warnings.push(`visual_diagrams[${i}] ("${d.title}") doesn't start with "graph TD"/"graph LR" (got: "${firstLine.slice(0, 30)}").`);
    }
    if (/subgraph/i.test(mermaid)) {
      warnings.push(`visual_diagrams[${i}] ("${d.title}") uses the banned "subgraph" keyword.`);
    }
    // A round-bracket node shape (e.g. "B(ADP + Pi)") is the single most
    // common real cause of a diagram failing to render, per the sanitizer's
    // own comments in public/index.html.
    if (/[A-Za-z][A-Za-z0-9_]*\([^)]*\)/.test(mermaid.replace(/-->\|[^|]*\|/g, ''))) {
      warnings.push(`visual_diagrams[${i}] ("${d.title}") appears to use a round-bracket node shape instead of square brackets.`);
    }
  });
}

// Unlike Mermaid's syntax rules (checked but never corrected here), a bad
// anchor id in illustrated_diagram is fixable in code with total confidence
// — the registry is the ground truth — so this doesn't just warn, it
// mutates `diagram` in place to drop anything invalid before the record is
// ever saved/cached. A dropped label still shows up in this function's
// warnings so the drift is visible, same as everything else this file logs.
function validateAndSanitizeIllustratedDiagram(diagram, warnings, sourceText) {
  if (!diagram || typeof diagram !== 'object' || !diagram.template) return;
  const template = findTemplate(diagram.template);
  if (!template) {
    warnings.push(`illustrated_diagram references unknown template "${diagram.template}" — dropping it.`);
    diagram.template = null;
    diagram.labels = [];
    return;
  }
  // Confirmed live (Aug 28, 2026): the model can select a template whose
  // topic has nothing to do with the uploaded content -- it picked
  // "synapse" for an ADH/kidney upload, directly against its own
  // instruction to omit illustrated_diagram when nothing matches. That
  // instruction alone isn't a reliable enough gate, especially with few
  // templates to contrast against, so this checks the actual source text
  // deterministically instead of trusting the model's own judgment on its
  // own pick.
  if (!templateMatchesText(diagram.template, sourceText)) {
    warnings.push(`illustrated_diagram picked template "${diagram.template}" but the source content shows no real topical match for it — clearing (likely a forced/incorrect template pick).`);
    diagram.template = null;
    diagram.labels = [];
    return;
  }
  if (!Array.isArray(diagram.labels)) {
    diagram.labels = [];
    return;
  }
  const validCategories = new Set(['structure', 'process', 'clinical']);
  const before = diagram.labels.length;
  diagram.labels = diagram.labels.filter(l => {
    if (!l || typeof l.anchor !== 'string' || !isValidAnchor(diagram.template, l.anchor)) return false;
    if (!l.text || typeof l.text !== 'string' || !l.text.trim()) return false;
    if (!validCategories.has(l.category)) l.category = 'structure'; // safe default rather than dropping an otherwise-good label
    return true;
  });
  const dropped = before - diagram.labels.length;
  if (dropped > 0) {
    warnings.push(`illustrated_diagram ("${diagram.template}") had ${dropped} label(s) with an invalid/unknown anchor id — dropped.`);
  }
  if (diagram.labels.length === 0) {
    warnings.push(`illustrated_diagram ("${diagram.template}") ended up with zero valid labels — clearing template so it doesn't render empty.`);
    diagram.template = null;
  }
}

function validateHiddenDetails(groups, warnings) {
  if (!Array.isArray(groups)) {
    warnings.push('hidden_details is not an array.');
    return;
  }
  let redundantPrefixCount = 0;
  groups.forEach(group => {
    (group.items || []).forEach(item => {
      const text = typeof item === 'string' ? item : (item.text || '');
      if (BANNED_HIDDEN_DETAIL_PREFIXES.some(re => re.test(text.trim()))) {
        redundantPrefixCount++;
      }
    });
  });
  if (redundantPrefixCount > 0) {
    warnings.push(`hidden_details has ${redundantPrefixCount} item(s) starting with a redundant category-name prefix (e.g. "TERMINOLOGY:") that should have been dropped per the prompt's formatting rule.`);
  }
}

function validateSelfTest(items, warnings) {
  if (!Array.isArray(items) || items.length === 0) {
    warnings.push('self_test is empty — no review questions will be generated for this upload.');
    return;
  }
  const incomplete = items.filter(i => !i || !i.question || !i.answer);
  if (incomplete.length) {
    warnings.push(`self_test has ${incomplete.length} item(s) missing a question or answer.`);
  }
}

// Returns { warnings: string[] } — never throws. A validation failure
// should never take down an otherwise-successful upload; it's purely for
// visibility into how often Gemini drifts from the rules we've written.
function validateStudyPack(result, sourceText) {
  const warnings = [];
  if (!result || typeof result !== 'object') {
    return { warnings: ['Result is not an object.'] };
  }

  const missingKeys = REQUIRED_KEYS.filter(k => !(k in result));
  if (missingKeys.length) {
    warnings.push(`Missing keys: ${missingKeys.join(', ')}.`);
  }

  try { validateMindMap(result.mind_map, warnings); } catch (err) { warnings.push(`mind_map validation crashed: ${err.message}`); }
  try { validateDiagrams(result.visual_diagrams, warnings); } catch (err) { warnings.push(`visual_diagrams validation crashed: ${err.message}`); }
  try { validateAndSanitizeIllustratedDiagram(result.illustrated_diagram, warnings, sourceText); } catch (err) { warnings.push(`illustrated_diagram validation crashed: ${err.message}`); }
  try { validateHiddenDetails(result.hidden_details, warnings); } catch (err) { warnings.push(`hidden_details validation crashed: ${err.message}`); }
  try { validateSelfTest(result.self_test, warnings); } catch (err) { warnings.push(`self_test validation crashed: ${err.message}`); }

  return { warnings };
}

module.exports = { validateStudyPack, REQUIRED_KEYS };
