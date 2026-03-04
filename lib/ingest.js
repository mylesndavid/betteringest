/**
 * Core orchestrator pipeline.
 * Sources → Reader → Chunker → Extractor (LLM) → Dedup → Graph
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readSource, readStdin } from './reader.js';
import { chunk } from './chunker.js';
import { extract } from './extractor.js';
import { dedup, canonicalId } from './dedup.js';
import { estimateCost, formatCost, confirmCost } from './cost.js';
import { Progress } from './progress.js';
import { State } from './state.js';
import { MiniGraph } from './graph.js';

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

  const progress = new Progress(newChunks.length);
  const extractions = [];
  const semaphore = { active: 0, max: config.maxConcurrent };

  async function processChunk(c) {
    while (semaphore.active >= semaphore.max) {
      await new Promise(r => setTimeout(r, 50));
    }
    semaphore.active++;
    try {
      const result = await extract(config, c);
      extractions.push(result);
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

  // 6. Build graph
  let graph;
  try {
    const existing = await readFile(config.output, 'utf-8');
    graph = MiniGraph.import(JSON.parse(existing));
  } catch {
    graph = new MiniGraph();
  }

  // Add document nodes
  for (const file of files) {
    const hash = createHash('sha256').update(file.path).digest('hex').slice(0, 12);
    const docId = `document:${hash}`;
    graph.mergeNode(docId, {
      type: 'document',
      path: file.path,
      filename: file.filename,
      size: file.size,
      ingestedAt: new Date().toISOString(),
    });
  }

  // Add extracted nodes + FROM_SOURCE edges
  const sourceDocIds = new Map();
  for (const file of files) {
    const hash = createHash('sha256').update(file.path).digest('hex').slice(0, 12);
    sourceDocIds.set(file.path, `document:${hash}`);
  }

  for (const [id, e] of merged.entities) {
    graph.mergeNode(id, { type: 'entity', entityType: e.type, name: e.name, aliases: e.aliases, mentions: e.mentions });
  }
  for (const [id, p] of merged.people) {
    graph.mergeNode(id, { type: 'person', name: p.name, role: p.role, mentions: p.mentions });
  }
  for (const [id, f] of merged.facts) {
    graph.mergeNode(id, { type: 'fact', text: f.text, timestamp: new Date().toISOString() });
  }
  for (const [id, d] of merged.decisions) {
    graph.mergeNode(id, { type: 'decision', text: d.text, timestamp: new Date().toISOString() });
  }
  for (const [id, p] of merged.preferences) {
    graph.mergeNode(id, { type: 'preference', text: p.text, timestamp: new Date().toISOString() });
  }
  for (const [id, f] of merged.frustrations) {
    graph.mergeNode(id, { type: 'frustration', text: f.text, timestamp: new Date().toISOString() });
  }

  // Add relationships from LLM
  for (const rel of merged.relationships) {
    graph.addEdge(rel.source, rel.target, { type: rel.type });
  }

  // Add FROM_SOURCE edges — link all extracted nodes to their source documents
  // We track this by mapping chunks to their source files
  for (const c of allChunks) {
    const docId = sourceDocIds.get(c.source);
    if (!docId) continue;
    // Link entities mentioned in this chunk's source to the document
    for (const [id] of merged.entities) {
      graph.addEdge(id, docId, { type: 'FROM_SOURCE' });
    }
  }

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

    onProgress(0, newChunks.length, 'Extracting...');
    const extractions = [];
    const semaphore = { active: 0, max: config.maxConcurrent };
    let completed = 0;

    async function processChunk(c) {
      while (semaphore.active >= semaphore.max) await new Promise(r => setTimeout(r, 50));
      semaphore.active++;
      try {
        const result = await extract(config, c);
        extractions.push(result);
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

    let graph;
    try {
      const existing = await readFile(config.output, 'utf-8');
      graph = MiniGraph.import(JSON.parse(existing));
    } catch { graph = new MiniGraph(); }

    // Document nodes
    for (const file of files) {
      const hash = createHash('sha256').update(file.path).digest('hex').slice(0, 12);
      graph.mergeNode(`document:${hash}`, { type: 'document', path: file.path, filename: file.filename, size: file.size, ingestedAt: new Date().toISOString() });
    }

    const sourceDocIds = new Map();
    for (const file of files) {
      const hash = createHash('sha256').update(file.path).digest('hex').slice(0, 12);
      sourceDocIds.set(file.path, `document:${hash}`);
    }

    for (const [id, e] of merged.entities) graph.mergeNode(id, { type: 'entity', entityType: e.type, name: e.name, aliases: e.aliases, mentions: e.mentions });
    for (const [id, p] of merged.people) graph.mergeNode(id, { type: 'person', name: p.name, role: p.role, mentions: p.mentions });
    for (const [id, f] of merged.facts) graph.mergeNode(id, { type: 'fact', text: f.text, timestamp: new Date().toISOString() });
    for (const [id, d] of merged.decisions) graph.mergeNode(id, { type: 'decision', text: d.text, timestamp: new Date().toISOString() });
    for (const [id, p] of merged.preferences) graph.mergeNode(id, { type: 'preference', text: p.text, timestamp: new Date().toISOString() });
    for (const [id, f] of merged.frustrations) graph.mergeNode(id, { type: 'frustration', text: f.text, timestamp: new Date().toISOString() });

    for (const rel of merged.relationships) graph.addEdge(rel.source, rel.target, { type: rel.type });

    for (const c of allChunks) {
      const docId = sourceDocIds.get(c.source);
      if (!docId) continue;
      for (const [id] of merged.entities) graph.addEdge(id, docId, { type: 'FROM_SOURCE' });
    }

    await mkdir(dirname(config.output), { recursive: true }).catch(() => {});
    await writeFile(config.output, JSON.stringify(graph.export(), null, 2));

    const stats = graph.export();
    onLog(`Graph: ${stats.nodes.length} nodes, ${stats.edges.length} edges → ${config.output}`);
    onDone();
  } catch (err) {
    onError(err);
  }
}
