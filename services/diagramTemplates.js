const fs = require('fs');
const path = require('path');

// Single source of truth for illustrated-diagram templates, shared between
// the server (to build the prompt registry description + validate AI output)
// and the browser (to actually render the SVG) — see public/diagram-templates.json.
// Kept as JSON specifically so both sides load the exact same data with no
// risk of drifting out of sync, which is exactly the kind of bug the
// existing Mermaid prompt/validator/renderer trio has hit before.
const REGISTRY_PATH = path.join(__dirname, '..', 'public', 'diagram-templates.json');
const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));

function getTemplates() {
  return registry.templates;
}

function findTemplate(id) {
  return registry.templates.find(t => t.id === id) || null;
}

function isValidAnchor(templateId, anchorId) {
  const template = findTemplate(templateId);
  if (!template) return false;
  return template.anchors.some(a => a.id === anchorId);
}

// Deterministic backstop for a real failure mode caught in supervised
// testing (Aug 28, 2026): with only one template in the registry, Gemini
// picked "synapse" for content that was actually about ADH/kidney water
// reabsorption -- directly contradicting its own instruction to omit
// illustrated_diagram when nothing genuinely matches. The instruction
// alone isn't reliable, especially with few templates to contrast against,
// so this checks the ORIGINAL uploaded text (not the AI's own output --
// asking the model to grade its own template choice would have the same
// blind spot) against that template's keyword list. Requires 2+ distinct
// keyword hits, not just 1, so a single incidental word (e.g. a stray use
// of "channel") can't pass a genuinely unrelated upload.
function templateMatchesText(templateId, sourceText) {
  const template = findTemplate(templateId);
  if (!template || !Array.isArray(template.keywords) || !sourceText) return false;
  const haystack = sourceText.toLowerCase();
  const hits = new Set();
  for (const kw of template.keywords) {
    if (haystack.includes(kw.toLowerCase())) hits.add(kw.toLowerCase());
  }
  return hits.size >= 2;
}

// Builds the prompt-facing description of every available template — one
// paragraph naming it, when to use it, and the exact anchor ids it's allowed
// to use. Generated from the same registry the validator checks against, so
// the prompt and the validation rule can never drift apart the way a
// hand-copied second description would.
function describeTemplatesForPrompt() {
  return registry.templates.map(t => {
    const anchorList = t.anchors.map(a => `"${a.id}" (${a.hint})`).join(', ');
    return `- Template id "${t.id}" — ${t.name}. ${t.description}\n  Valid anchor ids for this template: ${anchorList}`;
  }).join('\n');
}

module.exports = { getTemplates, findTemplate, isValidAnchor, describeTemplatesForPrompt, templateMatchesText };
