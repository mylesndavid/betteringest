/**
 * LLM extraction — sends chunks to a cheap model, parses structured JSON back.
 * Auto-detects chat vs document and uses appropriate prompt.
 */
import { chat } from './provider.js';

const DOC_PROMPT = `Extract structured knowledge from this document chunk.
Return valid JSON only, no markdown fencing.

{
  "entities": [{"name": "...", "type": "project|service|tool|place|organization|concept", "aliases": ["synonym1", "synonym2"]}],
  "people": [{"name": "...", "role": "..."}],
  "facts": ["specific detail — names, numbers, dates, lists"],
  "decisions": ["concrete decision or conclusion"],
  "preferences": ["explicit preference or recommendation"],
  "frustrations": ["problem or pain point"],
  "relationships": [{"from": "PersonOrEntity", "to": "PersonOrEntity", "type": "USES|DEPENDS_ON|PART_OF|RELATED_TO|MANAGES|WORKS_ON|BLOCKED_BY|COLLABORATES"}]
}

RELATIONSHIPS are the most important output. Connect people to what they work on, tools to projects, services to each other. Every entity should have at least one relationship.
  {"from": "Myles", "to": "BetterBot", "type": "WORKS_ON"}
  {"from": "BetterBot", "to": "MiniGraph", "type": "USES"}
  {"from": "Alice", "to": "Bob", "type": "COLLABORATES"}

FACTS: Extract specific details that would be hard to re-derive.
ALIASES: For each entity, include 2-3 alternative search terms.

Return empty arrays if nothing meets the quality bar. Empty > noise.
Limits: 5 entities, 5 people, 5 facts, 3 decisions, 2 preferences, 2 frustrations, 8 relationships.`;

const CHAT_PROMPT = `Extract structured knowledge from this conversation segment.
The input is a group chat. Focus on WHO said WHAT, WHO works on WHAT, and HOW people relate.
Return valid JSON only, no markdown fencing.

{
  "entities": [{"name": "...", "type": "project|service|tool|place|organization|concept", "aliases": ["synonym1"]}],
  "people": [{"name": "...", "role": "..."}],
  "facts": ["specific factual detail mentioned in conversation"],
  "decisions": ["concrete decision, action item, or commitment made"],
  "preferences": ["explicit preference stated by someone"],
  "frustrations": ["problem, complaint, or blocker raised"],
  "relationships": [{"from": "Person", "to": "PersonOrEntity", "type": "RELATIONSHIP_TYPE"}]
}

RELATIONSHIPS are the most important output. You MUST extract at least 3-5.
Types: WORKS_ON, MANAGES, COLLABORATES, BLOCKED_BY, REPORTED, ASSIGNED, OWNS, HELPED, DISCUSSED, DEPENDS_ON, USES, REQUESTED

Examples:
  {"from": "Sam", "to": "Backend API", "type": "WORKS_ON"}
  {"from": "Dan", "to": "Sam", "type": "COLLABORATES"}
  {"from": "Myles", "to": "Sprint planning", "type": "MANAGES"}
  {"from": "Dave", "to": "Frontend deploy", "type": "BLOCKED_BY"}

Every person mentioned should appear in at least one relationship.
Every entity should be connected to at least one person.

PEOPLE: Include role if inferrable (e.g., "lead", "developer", "designer").
FACTS: Only specific, searchable details (URLs, dates, numbers, names, technical specifics).

Return empty arrays if nothing meets the bar. Limits: 5 entities, 8 people, 5 facts, 3 decisions, 2 preferences, 2 frustrations, 10 relationships.`;

export async function extract(config, chunk) {
  const isChat = chunk.isChat;
  const prompt = isChat ? CHAT_PROMPT : DOC_PROMPT;
  const contextPrefix = chunk.heading
    ? `[Context: ${chunk.heading}]\n[Source: ${chunk.source}]\n\n`
    : `[Source: ${chunk.source}]\n\n`;

  const response = await chat(config, [
    { role: 'system', content: prompt },
    { role: 'user', content: contextPrefix + chunk.text },
  ], { maxTokens: 1500 });

  let jsonStr = response.content.trim();
  // Strip markdown fencing
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  // Find JSON object
  const braceStart = jsonStr.indexOf('{');
  const braceEnd = jsonStr.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    jsonStr = jsonStr.slice(braceStart, braceEnd + 1);
  }

  const extracted = JSON.parse(jsonStr);
  return {
    ...extracted,
    usage: response.usage,
  };
}
