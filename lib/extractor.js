/**
 * LLM extraction — sends chunks to a cheap model, parses structured JSON back.
 * Auto-detects chat vs document and uses appropriate prompt.
 * Pre-scan pass builds a "guide" (roster + key entities) from sampled chunks.
 */
import { chat } from './provider.js';

const PRESCAN_PROMPT = `You are analyzing sampled sections from a larger document/conversation to build a knowledge extraction guide.
Identify ALL people mentioned, the key entities, and how entities relate to each other.
Return valid JSON only, no markdown fencing.

{
  "people": [{"name": "Full Name or Display Name", "role": "their role/title if apparent, otherwise null"}],
  "entities": [{"name": "...", "type": "project|service|tool|place|organization|concept", "aliases": ["other names used for this"]}],
  "entity_groups": [{"parent": "MainProject", "children": ["Component1", "Component2"], "relationship": "PART_OF"}],
  "context": "1-2 sentence summary of what this content is about"
}

Be EXHAUSTIVE for people — include everyone mentioned by name, even if they only appear once.
For entities, focus on proper nouns: named projects, products, tools, companies, services.
For entity_groups, identify when multiple entities are components/features of a larger project or organization.
For aliases, include common misspellings, abbreviations, or alternate names used in the text.`;

const DOC_PROMPT = `Extract ONLY high-value knowledge from this document chunk.
Return valid JSON only, no markdown fencing.

{
  "entities": [{"name": "...", "type": "project|service|tool|place|organization|concept", "aliases": ["synonym1"]}],
  "people": [{"name": "...", "role": "..."}],
  "facts": ["specific searchable detail — names, numbers, dates, technical specifics"],
  "decisions": ["concrete decision with lasting impact"],
  "preferences": ["strong explicit preference that should persist"],
  "frustrations": ["significant recurring problem"],
  "relationships": [{"from": "PersonOrEntity", "to": "PersonOrEntity", "type": "USES|DEPENDS_ON|PART_OF|RELATED_TO|MANAGES|WORKS_ON|BLOCKED_BY|COLLABORATES"}]
}

CRITICAL QUALITY RULES:
- If it wouldn't matter 2 weeks from now, SKIP IT.
- Routine actions are NOT decisions ("go to sleep", "join standup", "check email" = SKIP)
- Temporary states are NOT facts ("going to gym at 1pm today", "will do X later" = SKIP)
- Only extract preferences that reveal lasting values, not momentary choices
- An entity must be a proper noun, named project, specific tool, or concrete concept — never generic words like "doc", "spreadsheet", "file", "link", "meeting"
- RELATIONSHIPS are the highest-value output. Every entity MUST connect to something.

EMPTY ARRAYS ARE GOOD. Return empty for any category where nothing meets the bar.
Most chunks should have 0-2 entities, 0-2 facts, and 2-5 relationships. Less is more.`;

const CHAT_PROMPT = `Extract ONLY high-value knowledge from this conversation.
Focus on: WHO works on WHAT, WHO relates to WHO, and concrete decisions/facts that matter long-term.
Return valid JSON only, no markdown fencing.

{
  "entities": [{"name": "...", "type": "project|service|tool|place|organization|concept", "aliases": ["synonym1"]}],
  "people": [{"name": "...", "role": "..."}],
  "facts": ["specific searchable detail worth remembering weeks later"],
  "decisions": ["concrete commitment or architectural/life decision with lasting impact"],
  "preferences": ["strong, lasting preference — not momentary choices"],
  "frustrations": ["significant recurring problem or blocker"],
  "relationships": [{"from": "Person", "to": "PersonOrEntity", "type": "WORKS_ON|MANAGES|COLLABORATES|BLOCKED_BY|OWNS|USES|DEPENDS_ON|HELPED|REQUESTED"}]
}

CRITICAL QUALITY RULES:
- SKIP routine chatter: greetings, scheduling logistics, "join the call", "ok", "thanks"
- SKIP temporary states: "going to gym", "will check later", "running late"
- SKIP vague actions: "let's verify", "I'll look into it", "sounds good"
- Decisions must have LASTING IMPACT — "switch to gemini-3 to save money" YES, "go to sleep" NO
- Facts must be SEARCHABLE — "BetterBot uses port 3333" YES, "we discussed the project" NO
- Entities must be PROPER NOUNS or NAMED THINGS — "BetterBot" YES, "spreadsheet" NO, "doc" NO
- RELATIONSHIPS are the most valuable output. Connect people to projects, tools, each other.

EMPTY IS BETTER THAN NOISE. If this conversation is just small talk or logistics, return all empty arrays.
Target: 0-3 entities, 0-3 facts, 0-2 decisions, 3-8 relationships per chunk.`;

function parseJSON(raw) {
  let jsonStr = raw.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  const braceStart = jsonStr.indexOf('{');
  const braceEnd = jsonStr.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    jsonStr = jsonStr.slice(braceStart, braceEnd + 1);
  }
  return JSON.parse(jsonStr);
}

/**
 * Pre-scan: sample chunks evenly, ask LLM for a full roster + entity list.
 * Returns a guide string to inject into extraction prompts, or null if too few chunks.
 */
export async function prescan(config, chunks, { onLog } = {}) {
  if (chunks.length < 3) return null;

  // Sample ~8 chunks: first, last, and evenly spread through the middle
  // First and last often have intros/outros with names and context
  const sampleCount = Math.min(8, chunks.length);
  const indices = new Set([0, chunks.length - 1]);
  const innerCount = sampleCount - 2;
  const step = Math.floor(chunks.length / (innerCount + 1));
  for (let i = 1; i <= innerCount; i++) {
    indices.add(Math.min(i * step, chunks.length - 1));
  }
  const samples = [...indices].sort((a, b) => a - b).map(i => chunks[i]);

  // Give each sample ~3k chars — enough to catch names and context
  const perSample = Math.min(3000, Math.floor(24000 / samples.length));
  const sampledText = samples.map((c, i) =>
    `--- Sample ${i + 1} (chunk ${c.chunkIndex}/${c.totalChunks}) ---\n${c.text.slice(0, perSample)}`
  ).join('\n\n');

  if (onLog) onLog('Pre-scanning for people & entities...');

  const response = await chat(config, [
    { role: 'system', content: PRESCAN_PROMPT },
    { role: 'user', content: sampledText },
  ], { maxTokens: 1500 });

  const result = parseJSON(response.content);

  // Build the guide string
  const parts = [];
  if (result.context) {
    parts.push(`CONTEXT: ${result.context}`);
  }
  if (result.people?.length) {
    const roster = result.people.map(p =>
      p.role ? `${p.name} (${p.role})` : p.name
    ).join(', ');
    parts.push(`KNOWN PEOPLE: ${roster}`);
  }
  if (result.entities?.length) {
    const ents = result.entities.map(e => {
      const aliases = e.aliases?.length ? ` [also: ${e.aliases.join(', ')}]` : '';
      return `${e.name} (${e.type})${aliases}`;
    }).join(', ');
    parts.push(`KNOWN ENTITIES: ${ents}`);
  }
  if (result.entity_groups?.length) {
    const groups = result.entity_groups.map(g =>
      `${g.parent} includes: ${g.children.join(', ')}`
    ).join('; ');
    parts.push(`ENTITY GROUPS: ${groups}`);
  }

  const guide = parts.join('\n');
  if (onLog) {
    const groups = result.entity_groups?.length || 0;
    onLog(`Pre-scan found ${result.people?.length || 0} people, ${result.entities?.length || 0} entities, ${groups} entity groups`);
  }
  return { guide: guide || null, prescanResult: result };
}

const CONSOLIDATE_PROMPT = `You are consolidating a list of extracted entity names from a knowledge graph.
Some entries refer to the same thing with different spelling, casing, or abbreviations.
Return valid JSON only, no markdown fencing.

{
  "merges": [
    {"canonical": "BestName", "aliases": ["altname1", "altname2"]}
  ],
  "part_of": [
    {"child": "ComponentName", "parent": "ParentProject"}
  ]
}

STRICT RULES FOR MERGES:
- ONLY merge if two names are literally the SAME THING with different spelling
  - YES: "HeyGen" / "Haygen" (typo of same product)
  - YES: "Devcore" / "Devvcore" (typo of same company)
  - NO: A client/customer is NEVER an alias of the company that serves them
  - NO: A subdomain (fricks.devcorecode.com) does NOT make "fricks" an alias of "devcore"
  - NO: Two different projects/products are never aliases even if related
- When in doubt, do NOT merge. False merges destroy information.

STRICT RULES FOR PART_OF:
- A feature/component that is built AS PART of a larger project
  - YES: "Auto Responder" PART_OF "Paradigm" (feature of the product)
  - YES: "DAA" PART_OF "Fricks" (deliverable for the client)
  - NO: "Asana" is NOT part of "Devcore" (external tool they use)
  - NO: "Heroku" is NOT part of "Paradigm" (hosting provider, not a component)`;

/**
 * Post-extraction consolidation: merge duplicate entities and discover PART_OF relationships.
 * Takes entity names, returns merge instructions. One LLM call.
 */
export async function consolidate(config, entityNames, { onLog } = {}) {
  if (entityNames.length < 3) return { merges: [], part_of: [] };

  if (onLog) onLog('Consolidating entities...');

  const response = await chat(config, [
    { role: 'system', content: CONSOLIDATE_PROMPT },
    { role: 'user', content: `Entity names to consolidate:\n${entityNames.join('\n')}` },
  ], { maxTokens: 1000 });

  try {
    const result = parseJSON(response.content);
    const merges = result.merges || [];
    const partOf = result.part_of || [];
    if (onLog) onLog(`Consolidation: ${merges.length} merges, ${partOf.length} part-of relationships`);
    return { merges, part_of: partOf };
  } catch {
    return { merges: [], part_of: [] };
  }
}

export async function extract(config, chunk, guide) {
  const isChat = chunk.isChat;
  const basePrompt = isChat ? CHAT_PROMPT : DOC_PROMPT;

  // Inject guide into system prompt if available
  const prompt = guide
    ? `${basePrompt}\n\n--- EXTRACTION GUIDE (from pre-scan of full content) ---\n${guide}\n\nIMPORTANT: The guide above helps you recognize key people and entities, but DO NOT limit yourself to only these. Extract ANY person or entity that appears in this chunk — the guide just helps you use consistent full names and correct types. If someone not in the guide appears, extract them too.`
    : basePrompt;

  const contextPrefix = chunk.heading
    ? `[Context: ${chunk.heading}]\n[Source: ${chunk.source}]\n\n`
    : `[Source: ${chunk.source}]\n\n`;

  const response = await chat(config, [
    { role: 'system', content: prompt },
    { role: 'user', content: contextPrefix + chunk.text },
  ], { maxTokens: 1500 });

  const extracted = parseJSON(response.content);
  return {
    ...extracted,
    usage: response.usage,
  };
}
