/**
 * Cross-chunk entity dedup + merging.
 * Canonical ID: type:name_lowercase — matches betterclaw convention.
 */

export function canonicalId(type, name) {
  return `${type}:${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
}

export function dedup(extractions) {
  // Build alias → canonical name index across all extractions
  const aliasMap = new Map();  // lowercase alias → { canonical, type: 'entity'|'person' }

  for (const ext of extractions) {
    for (const entity of (ext.entities || [])) {
      if (!entity.name) continue;
      const canonical = entity.name.toLowerCase();
      aliasMap.set(canonical, { canonical, nodeType: 'entity' });
      for (const alias of (entity.aliases || [])) {
        const a = alias.toLowerCase();
        if (!aliasMap.has(a)) aliasMap.set(a, { canonical, nodeType: 'entity' });
      }
    }
    for (const person of (ext.people || [])) {
      if (!person?.name) continue;
      const canonical = person.name.toLowerCase();
      // People take priority in the alias map for name resolution
      aliasMap.set(canonical, { canonical, nodeType: 'person' });
    }
  }

  // Resolve a name from a relationship to its actual node ID
  function resolveToNodeId(name) {
    const lower = name.toLowerCase();
    const entry = aliasMap.get(lower);
    if (entry) return canonicalId(entry.nodeType, entry.canonical);
    // Fall back to entity
    return canonicalId('entity', lower);
  }

  // Merge entities — accumulate aliases, track mentions
  const entities = new Map();
  const people = new Map();
  const facts = new Map();
  const decisions = new Map();
  const preferences = new Map();
  const frustrations = new Map();
  const relationships = [];
  // Track which entities appear in which chunk (for per-chunk source linking)
  const chunkEntities = []; // per-extraction: Set of node IDs

  for (const ext of extractions) {
    const thisChunkNodes = new Set();

    for (const entity of (ext.entities || []).slice(0, 8)) {
      if (!entity.name) continue;
      const lower = entity.name.toLowerCase();
      const resolved = aliasMap.get(lower)?.canonical || lower;
      const id = canonicalId('entity', resolved);
      thisChunkNodes.add(id);
      const existing = entities.get(id);
      if (existing) {
        existing.mentions++;
        const allAliases = new Set([...existing.aliases, ...(entity.aliases || [])]);
        existing.aliases = [...allAliases];
      } else {
        entities.set(id, {
          id, name: entity.name, type: entity.type || 'concept',
          aliases: entity.aliases || [], mentions: 1,
        });
      }
    }

    for (const person of (ext.people || []).slice(0, 8)) {
      if (!person?.name) continue;
      const id = canonicalId('person', person.name);
      thisChunkNodes.add(id);
      const existing = people.get(id);
      if (existing) {
        existing.mentions++;
        if (person.role && !existing.role) existing.role = person.role;
      } else {
        people.set(id, { id, name: person.name, role: person.role || '', mentions: 1 });
      }
    }

    for (let fact of (ext.facts || []).slice(0, 5)) {
      if (!fact) continue;
      if (typeof fact !== 'string') fact = JSON.stringify(fact);
      const id = canonicalId('fact', fact.slice(0, 60));
      thisChunkNodes.add(id);
      facts.set(id, { id, text: fact });
    }

    for (let d of (ext.decisions || []).slice(0, 3)) {
      if (!d) continue;
      if (typeof d !== 'string') d = JSON.stringify(d);
      const id = canonicalId('decision', d.slice(0, 60));
      thisChunkNodes.add(id);
      decisions.set(id, { id, text: d });
    }

    for (let p of (ext.preferences || []).slice(0, 2)) {
      if (!p) continue;
      if (typeof p !== 'string') p = JSON.stringify(p);
      const id = canonicalId('preference', p.slice(0, 60));
      thisChunkNodes.add(id);
      preferences.set(id, { id, text: p });
    }

    for (let f of (ext.frustrations || []).slice(0, 2)) {
      if (!f) continue;
      if (typeof f !== 'string') f = JSON.stringify(f);
      const id = canonicalId('frustration', f.slice(0, 60));
      thisChunkNodes.add(id);
      frustrations.set(id, { id, text: f });
    }

    for (const rel of (ext.relationships || []).slice(0, 10)) {
      if (!rel?.from || !rel?.to) continue;
      relationships.push({
        source: resolveToNodeId(rel.from),
        target: resolveToNodeId(rel.to),
        type: rel.type || 'RELATED_TO',
      });
    }

    chunkEntities.push(thisChunkNodes);
  }

  return { entities, people, facts, decisions, preferences, frustrations, relationships, chunkEntities };
}
