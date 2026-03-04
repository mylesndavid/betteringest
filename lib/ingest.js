/**
 * Core orchestrator pipeline.
 * Sources → Reader → Chunker → Extractor (LLM) → Dedup → Graph
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readSource, readStdin } from './reader.js';
import { chunk } from './chunker.js';
import { extract, prescan, consolidate } from './extractor.js';
import { dedup, canonicalId } from './dedup.js';
import { estimateCost, formatCost, confirmCost } from './cost.js';
import { Progress } from './progress.js';
import { State } from './state.js';
import { MiniGraph } from './graph.js';
import { filterGraph } from './filter.js';

/**
 * Build the graph from deduped extractions.
 * Shared by both CLI and UI pipelines.
 */
function buildGraph(existingGraph, files, allChunks, merged, extractionChunkSources, consolidation) {
  const graph = existingGraph || new MiniGraph();
  const now = new Date().toISOString();

  // Apply consolidation merges: redirect alias entity IDs to canonical
  // But reject merges where the alias already exists as a standalone entity with 2+ mentions
  // (the dedup pass already decided they're separate things — don't override that)
  const idRemap = new Map(); // old entity id → new entity id
  if (consolidation?.merges) {
    for (const merge of consolidation.merges) {
      const canonId = canonicalId('entity', merge.canonical);
      for (const alias of merge.aliases) {
        const aliasId = canonicalId('entity', alias);
        if (aliasId === canonId) continue;
        const existing = merged.entities.get(aliasId);
        if (existing && existing.mentions >= 2) continue; // standalone entity, don't merge
        idRemap.set(aliasId, canonId);
      }
    }
  }

  // Helper: resolve an ID through remap
  function resolve(id) { return idRemap.get(id) || id; }

  // Merge entity data for consolidated entities
  if (idRemap.size > 0) {
    for (const [oldId, newId] of idRemap) {
      const old = merged.entities.get(oldId);
      if (!old) continue;
      const target = merged.entities.get(newId);
      if (target) {
        target.mentions += old.mentions;
        target.aliases = [...new Set([...target.aliases, ...old.aliases, old.name])];
      }
      merged.entities.delete(oldId);
    }
  }

  // Document nodes
  const sourceDocIds = new Map();
  for (const file of files) {
    const hash = createHash('sha256').update(file.path).digest('hex').slice(0, 12);
    const docId = `document:${hash}`;
    sourceDocIds.set(file.path, docId);
    graph.mergeNode(docId, { type: 'document', path: file.path, filename: file.filename, size: file.size, ingestedAt: now });
  }

  // Add all extracted nodes
  for (const [id, e] of merged.entities) {
    graph.mergeNode(id, { type: 'entity', entityType: e.type, name: e.name, aliases: e.aliases, mentions: e.mentions });
  }
  for (const [id, p] of merged.people) {
    graph.mergeNode(id, { type: 'person', name: p.name, role: p.role, mentions: p.mentions });
  }
  for (const [id, f] of merged.facts) {
    graph.mergeNode(id, { type: 'fact', text: f.text, timestamp: now });
  }
  for (const [id, d] of merged.decisions) {
    graph.mergeNode(id, { type: 'decision', text: d.text, timestamp: now });
  }
  for (const [id, p] of merged.preferences) {
    graph.mergeNode(id, { type: 'preference', text: p.text, timestamp: now });
  }
  for (const [id, f] of merged.frustrations) {
    graph.mergeNode(id, { type: 'frustration', text: f.text, timestamp: now });
  }

  // LLM-proposed relationships (entity↔entity, entity↔person)
  for (const rel of merged.relationships) {
    const src = resolve(rel.source);
    const tgt = resolve(rel.target);
    if (graph.hasNode(src) && graph.hasNode(tgt)) {
      graph.addEdge(src, tgt, { type: rel.type });
    }
  }

  // PART_OF edges from consolidation — fuzzy match by name
  if (consolidation?.part_of) {
    // Build name→id lookup for fuzzy matching
    const nameToId = new Map();
    for (const [id, e] of merged.entities) {
      nameToId.set(e.name.toLowerCase(), resolve(id));
      for (const alias of (e.aliases || [])) nameToId.set(alias.toLowerCase(), resolve(id));
    }
    for (const { child, parent } of consolidation.part_of) {
      const childId = nameToId.get(child.toLowerCase()) || resolve(canonicalId('entity', child));
      const parentId = nameToId.get(parent.toLowerCase()) || resolve(canonicalId('entity', parent));
      if (graph.hasNode(childId) && graph.hasNode(parentId)) {
        graph.addEdge(childId, parentId, { type: 'PART_OF' });
      }
    }
  }

  // Per-chunk co-occurrence edges with weight tracking
  const edgeCounts = new Map(); // "src|tgt|type" → count
  function trackEdge(src, tgt, type) {
    src = resolve(src);
    tgt = resolve(tgt);
    const key = `${src}|${tgt}|${type}`;
    edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
  }

  // Build name lookup for text-matching ABOUT edges
  const entityNames = new Map(); // entity/person node id → [lowercase names to match]
  for (const [id, e] of merged.entities) {
    const rid = resolve(id);
    const names = [e.name.toLowerCase(), ...(e.aliases || []).map(a => a.toLowerCase())];
    entityNames.set(rid, [...(entityNames.get(rid) || []), ...names]);
  }
  for (const [id, p] of merged.people) {
    const rid = resolve(id);
    const names = [p.name.toLowerCase()];
    // Also match first name
    const first = p.name.split(/\s/)[0].toLowerCase();
    if (first.length >= 3) names.push(first);
    entityNames.set(rid, [...(entityNames.get(rid) || []), ...names]);
  }

  for (let i = 0; i < merged.chunkEntities.length; i++) {
    const nodeIds = [...merged.chunkEntities[i]].map(resolve);
    const chunkSource = extractionChunkSources[i];
    const docId = sourceDocIds.get(chunkSource);

    const chunkEntityIds = nodeIds.filter(id => id.startsWith('entity:') || id.startsWith('person:'));
    const chunkFactIds = nodeIds.filter(id => id.startsWith('fact:') || id.startsWith('decision:') || id.startsWith('preference:') || id.startsWith('frustration:'));

    // ABOUT edges: only connect fact to entities actually mentioned in the fact text
    for (const factId of chunkFactIds) {
      const node = graph._nodes.get(factId);
      const text = (node?.text || '').toLowerCase();
      for (const entId of chunkEntityIds) {
        const names = entityNames.get(entId) || [];
        if (names.some(name => text.includes(name))) {
          trackEdge(factId, entId, 'ABOUT');
        }
      }
    }

    if (docId) {
      for (const nodeId of chunkEntityIds) {
        trackEdge(nodeId, docId, 'FROM_SOURCE');
      }
    }
  }

  // Add weighted co-occurrence edges
  for (const [key, count] of edgeCounts) {
    const [src, tgt, type] = key.split('|');
    if (graph.hasNode(src) && graph.hasNode(tgt)) {
      const attrs = { type };
      if (count > 1) attrs.weight = count;
      graph.addEdge(src, tgt, attrs);
    }
  }

  // Quality filter — cut noise nodes
  const { kept, cut } = filterGraph(graph);

  // PageRank — compute importance scores for surviving nodes
  const exported = graph.export();
  const nodeIds = exported.nodes.map(n => n.id);
  const N = nodeIds.length;
  if (N > 0) {
    const damping = 0.85;
    let scores = {};
    const outDegree = {};
    for (const id of nodeIds) { scores[id] = 1 / N; outDegree[id] = 0; }
    for (const e of exported.edges) outDegree[e.source] = (outDegree[e.source] || 0) + (e.weight || 1);

    for (let i = 0; i < 20; i++) {
      const next = {};
      for (const id of nodeIds) next[id] = (1 - damping) / N;
      for (const e of exported.edges) {
        const out = outDegree[e.source] || 1;
        const w = e.weight || 1;
        next[e.target] = (next[e.target] || 0) + damping * scores[e.source] * w / out;
      }
      scores = next;
    }

    // Normalize to 0-1 range and store on nodes
    const max = Math.max(...Object.values(scores));
    for (const id of nodeIds) {
      const node = graph._nodes.get(id);
      if (node) node.rank = max > 0 ? +(scores[id] / max).toFixed(4) : 0;
    }
  }

  return { graph, kept, cut };
}

export async function ingest(sources, config) {
  const isStdin = sources.length === 0;

  // 1. Read all sources
  process.stderr.write('  Reading sources...\n');
  let files = [];
  if (isStdin) {
    files = await readStdin();
  } else {
    for (const source of sources) {
      try {
        files.push(...await readSource(source));
      } catch (err) {
        process.stderr.write(`  Warning: ${source}: ${err.message}\n`);
      }
    }
  }
  if (files.length === 0) {
    process.stderr.write('  No files found.\n');
    return;
  }
  process.stderr.write(`  Found ${files.length} file${files.length === 1 ? '' : 's'}\n`);

  // 2. Chunk all files
  let allChunks = [];
  for (const file of files) {
    const chunks = chunk(file, config.chunkSize);
    allChunks.push(...chunks);
  }
  process.stderr.write(`  ${allChunks.length} chunk${allChunks.length === 1 ? '' : 's'}\n`);

  // Filter already-processed chunks
  const state = new State(config.output);
  const newChunks = allChunks.filter(c => !state.isProcessed(c.contentHash));
  const skipped = allChunks.length - newChunks.length;
  if (skipped > 0) {
    process.stderr.write(`  Skipping ${skipped} already-processed chunk${skipped === 1 ? '' : 's'}\n`);
  }
  if (newChunks.length === 0) {
    process.stderr.write('  Nothing new to process.\n');
    return;
  }

  // 3. Cost estimate
  const estimate = estimateCost(newChunks, config.model);
  if (config.dryRun) {
    process.stderr.write('\n  Dry run — cost estimate:\n');
    process.stderr.write(formatCost(estimate) + '\n');
    return;
  }
  if (!config.yes && !isStdin) {
    const proceed = await confirmCost(estimate);
    if (!proceed) {
      process.stderr.write('  Aborted.\n');
      return;
    }
  } else {
    process.stderr.write(formatCost(estimate) + '\n');
  }

  // 4. Extract from each chunk (with concurrency)
  if (!config.apiKey && config.provider !== 'ollama') {
    process.stderr.write('  Error: No API key. Set OPENROUTER_API_KEY or use --api-key\n');
    process.exit(1);
  }

  // Pre-scan: build extraction guide from sampled chunks
  const { guide } = await prescan(config, newChunks, {
    onLog: msg => process.stderr.write(`  ${msg}\n`),
  }) || { guide: null };

  const progress = new Progress(newChunks.length);
  const extractions = [];
  const extractionChunkSources = []; // parallel array: source path per extraction
  const semaphore = { active: 0, max: config.maxConcurrent };

  async function processChunk(c) {
    while (semaphore.active >= semaphore.max) {
      await new Promise(r => setTimeout(r, 50));
    }
    semaphore.active++;
    try {
      const result = await extract(config, c, guide);
      extractions.push(result);
      extractionChunkSources.push(c.source);
      state.markProcessed(c.contentHash, result.usage?.total_tokens || 0);
      if (config.verbose) {
        const e = result.entities?.length || 0;
        const f = result.facts?.length || 0;
        process.stderr.write(`\n    ${c.source} chunk ${c.chunkIndex}: ${e} entities, ${f} facts`);
      }
    } catch (err) {
      if (config.verbose) {
        process.stderr.write(`\n    ${c.source} chunk ${c.chunkIndex}: ERROR ${err.message}`);
      }
    } finally {
      semaphore.active--;
      progress.tick();
    }
  }

  const promises = newChunks.map(c => processChunk(c));
  await Promise.all(promises);
  progress.done();

  if (extractions.length === 0) {
    process.stderr.write('  No successful extractions.\n');
    return;
  }

  // 5. Dedup
  process.stderr.write('  Deduplicating...\n');
  const merged = dedup(extractions);

  // 5.5 Consolidate entities (merge duplicates, discover PART_OF)
  const entityNames = [...merged.entities.values()].map(e => e.name);
  const consolidation = await consolidate(config, entityNames, {
    onLog: msg => process.stderr.write(`  ${msg}\n`),
  });

  // 6. Build graph
  let existingGraph;
  try {
    const existing = await readFile(config.output, 'utf-8');
    existingGraph = MiniGraph.import(JSON.parse(existing));
  } catch {
    existingGraph = null;
  }

  const { graph, kept, cut } = buildGraph(existingGraph, files, allChunks, merged, extractionChunkSources, consolidation);
  process.stderr.write(`  Filtered: kept ${kept}, cut ${cut} noise nodes\n`);

  // 7. Save
  await mkdir(dirname(config.output), { recursive: true }).catch(() => {});
  await writeFile(config.output, JSON.stringify(graph.export(), null, 2));

  const stats = graph.export();
  process.stderr.write(`  Graph: ${stats.nodes.length} nodes, ${stats.edges.length} edges\n`);
  process.stderr.write(`  Saved to ${config.output}\n`);
}

/**
 * UI-friendly ingestion — reports progress via callbacks instead of stderr.
 */
export async function ingestForUI(sources, config, { onProgress, onLog, onDone, onError }) {
  try {
    onLog('Reading sources...');
    let files = [];
    for (const source of sources) {
      try {
        files.push(...await readSource(source));
      } catch (err) {
        onLog(`Warning: ${source}: ${err.message}`);
      }
    }
    if (files.length === 0) { onLog('No files found.'); onDone(); return; }
    onLog(`Found ${files.length} file${files.length === 1 ? '' : 's'}`);

    let allChunks = [];
    for (const file of files) {
      allChunks.push(...chunk(file, config.chunkSize));
    }
    onLog(`${allChunks.length} chunk${allChunks.length === 1 ? '' : 's'}`);

    const resumeState = new State(config.output);
    const newChunks = allChunks.filter(c => !resumeState.isProcessed(c.contentHash));
    const skipped = allChunks.length - newChunks.length;
    if (skipped > 0) onLog(`Skipping ${skipped} already-processed chunks`);
    if (newChunks.length === 0) { onLog('Nothing new to process.'); onDone(); return; }

    if (!config.apiKey && config.provider !== 'ollama') {
      onError(new Error('No API key configured'));
      return;
    }

    const estimate = estimateCost(newChunks, config.model);
    onLog(`Est. cost: $${estimate.estimatedCost.toFixed(4)} (${newChunks.length} chunks, ~${estimate.inputTokens.toLocaleString()} input tokens)`);

    // Pre-scan: build extraction guide
    const { guide } = await prescan(config, newChunks, { onLog }) || { guide: null };

    onProgress(0, newChunks.length, 'Extracting...');
    const extractions = [];
    const extractionChunkSources = [];
    const semaphore = { active: 0, max: config.maxConcurrent };
    let completed = 0;

    async function processChunk(c) {
      while (semaphore.active >= semaphore.max) await new Promise(r => setTimeout(r, 50));
      semaphore.active++;
      try {
        const result = await extract(config, c, guide);
        extractions.push(result);
        extractionChunkSources.push(c.source);
        resumeState.markProcessed(c.contentHash, result.usage?.total_tokens || 0);
        const ents = result.entities?.length || 0;
        const facts = result.facts?.length || 0;
        onLog(`Chunk ${c.chunkIndex}/${c.totalChunks} (${c.source.split('/').pop()}): ${ents} entities, ${facts} facts`);
      } catch (err) {
        onLog(`Chunk ${c.chunkIndex} error: ${err.message}`);
      } finally {
        semaphore.active--;
        completed++;
        onProgress(completed, newChunks.length, `${completed}/${newChunks.length} chunks`);
      }
    }

    await Promise.all(newChunks.map(c => processChunk(c)));

    if (extractions.length === 0) { onLog('No successful extractions.'); onDone(); return; }

    onLog('Deduplicating...');
    const merged = dedup(extractions);

    const entityNames = [...merged.entities.values()].map(e => e.name);
    const consolidation = await consolidate(config, entityNames, { onLog });

    let existingGraph;
    try {
      const existing = await readFile(config.output, 'utf-8');
      existingGraph = MiniGraph.import(JSON.parse(existing));
    } catch { existingGraph = null; }

    const { graph, kept, cut } = buildGraph(existingGraph, files, allChunks, merged, extractionChunkSources, consolidation);
    onLog(`Filtered: kept ${kept}, cut ${cut} noise nodes`);

    await mkdir(dirname(config.output), { recursive: true }).catch(() => {});
    await writeFile(config.output, JSON.stringify(graph.export(), null, 2));

    const stats = graph.export();
    onLog(`Graph: ${stats.nodes.length} nodes, ${stats.edges.length} edges → ${config.output}`);
    onDone();
  } catch (err) {
    onError(err);
  }
}
