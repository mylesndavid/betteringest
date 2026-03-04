/**
 * LLM extraction — sends chunks to a cheap model, parses structured JSON back.
 */
import { chat } from './provider.js';

const EXTRACTION_PROMPT = `Extract structured knowledge from this document chunk.
Return valid JSON only, no markdown fencing.

{
  "entities": [{"name": "...", "type": "project|service|tool|place|organization|concept", "aliases": ["synonym1", "synonym2"]}],
  "people": [{"name": "...", "role": "..."}],
  "facts": ["specific detail — names, numbers, dates, lists"],
  "decisions": ["concrete decision or conclusion"],
  "preferences": ["explicit preference or recommendation"],
  "frustrations": ["problem or pain point"],
  "relationships": [{"from": "EntityA", "to": "EntityB", "type": "USES|DEPENDS_ON|PART_OF|RELATED_TO"}]
}

ALIASES: For each entity, include 2-3 alternative search terms.
  "BetterBot" → aliases: ["betterbot", "bot framework", "agent"]
  "PostgreSQL" → aliases: ["postgres", "pg", "database"]

FACTS: Extract specific details that would be hard to re-derive.
  "Project uses port 3333 for the panel"
  "User takes 7 supplements: Quercetin, EPA/DHA, Taurine, D3+K2, B-Complex, Magnesium, Zinc"

RELATIONSHIPS: Link entities that are explicitly connected.
  {"from": "BetterBot", "to": "MiniGraph", "type": "USES"}
  {"from": "Gateway", "to": "Telegram", "type": "DEPENDS_ON"}

QUALITY BAR — only include items that pass ALL of these:
- Would someone search for this later?
- Is it a proper noun, named service, specific project, or concrete choice?
- Would connecting this to other documents reveal something useful?

Return empty arrays if nothing meets the bar. Empty is better than noise.
Limits: 5 entities, 3 people, 5 facts, 3 decisions, 2 preferences, 2 frustrations, 5 relationships.`;

export async function extract(config, chunk) {
  const contextPrefix = chunk.heading ? `[Section: ${chunk.heading}]\n[Source: ${chunk.source}]\n\n` : `[Source: ${chunk.source}]\n\n`;

  const response = await chat(config, [
    { role: 'system', content: EXTRACTION_PROMPT },
    { role: 'user', content: contextPrefix + chunk.text },
  ], { maxTokens: 1024 });

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
