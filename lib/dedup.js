/**
 * Cross-chunk entity dedup + merging.
 * Canonical ID: type:name_lowercase — matches betterclaw convention.
 */

export function buildAliasIndex(extractions) {
  // Map alias → canonical entity name
  const aliasMap = new Map();

  for (const ext of extractions) {
    for (const entity of (ext.entities || [])) {
      if (!entity.name) continue;
      const canonical = entity.name.toLowerCase();
      aliasMap.set(canonical, canonical);
      for (const alias of (entity.aliases || [])) {
        const a = alias.toLowerCase();
        if (!aliasMap.has(a)) aliasMap.set(a, canonical);
      }
    }
  }

  return aliasMap;
}

export function canonicalId(type, name) {
  return `${type}:${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
}

export function dedup(extractions) {
  const aliasMap = buildAliasIndex(extractions);

  // Resolve entity name through alias index
  function resolveEntity(name) {
    const lower = name.toLowerCase();
    return aliasMap.get(lower) || lower;
  }

  // Merge entities — accumulate aliases, track mentions
  const entities = new Map();
  const people = new Map();
  const facts = new Map();
  const decisions = new Map();
  const preferences = new Map();
  const frustrations = new Map();
  const relationships = [];

  for (const ext of extractions) {
    for (const entity of (ext.entities || []).slice(0, 5)) {
      if (!entity.name) continue;
      const resolved = resolveEntity(entity.name);
      const id = canonicalId('entity', resolved);
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

    for (const person of (ext.people || []).slice(0, 3)) {
      if (!person?.name) continue;
      const id = canonicalId('person', person.name);
      const existing = people.get(id);
      if (existing) {
        existing.mentions++;
        if (person.role && !existing.role) existing.role = person.role;
      } else {
        people.set(id, { id, name: person.name, role: person.role || '', mentions: 1 });
      }
    }

    for (const fact of (ext.facts || []).slice(0, 5)) {
      if (!fact) continue;
      const id = canonicalId('fact', fact.slice(0, 60));
      facts.set(id, { id, text: fact });
    }

    for (const d of (ext.decisions || []).slice(0, 3)) {
      if (!d) continue;
      const id = canonicalId('decision', d.slice(0, 60));
      decisions.set(id, { id, text: d });
    }

    for (const p of (ext.preferences || []).slice(0, 2)) {
      if (!p) continue;
      const id = canonicalId('preference', p.slice(0, 60));
      preferences.set(id, { id, text: p });
    }

    for (const f of (ext.frustrations || []).slice(0, 2)) {
      if (!f) continue;
      const id = canonicalId('frustration', f.slice(0, 60));
      frustrations.set(id, { id, text: f });
    }

    for (const rel of (ext.relationships || []).slice(0, 5)) {
      if (!rel?.from || !rel?.to) continue;
      const fromResolved = resolveEntity(rel.from);
      const toResolved = resolveEntity(rel.to);
      relationships.push({
        source: canonicalId('entity', fromResolved),
        target: canonicalId('entity', toResolved),
        type: rel.type || 'RELATED_TO',
      });
    }
  }

  return { entities, people, facts, decisions, preferences, frustrations, relationships };
}
