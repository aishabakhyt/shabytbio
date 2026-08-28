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

module.exports = { getTemplates, findTemplate, isValidAnchor, describeTemplatesForPrompt };
