/**
 * Post-extraction quality filter.
 * Cuts noise nodes that survived extraction — session-specific chatter,
 * generic entities, orphaned facts.
 */

const NOISE_TEXT = [
  /^(go to|let'?s |ok\b|thanks|sure|will do|sounds good|i'?ll |yes\b|no\b)/i,
  /^(join|check |look |try |see |run |open |send |start |stop |i'?m going)/i,
  /^(sorry|please |hey |hi |good morning|good night|gm\b|gn\b)/i,
  /^(raya will execute|raya will focus|i'll run|i'll use|i'll stop|i'll stay)/i,
  /^(schedule |add .+ to (the )?calendar|remove .+ from (the )?calendar)/i,
  /^(myles is going|raya is going|going to|headed to)/i,
  /^(raya (confirmed|scheduled|deleted|added|moved|unpacked|sent|stored|documented|fixed))/i,
  // Temporary status — "X is testing/fixing/finishing/working on..."
  /^\w+ (is|was) (testing|fixing|finishing|working|doing|checking|looking|pushing|deploying)/i,
  /^\w+ \w+ (is|was) (testing|fixing|finishing|working|doing|checking|looking|pushing|deploying)/i,
  // "Need to X" without specificity
  /^need to (set up|configure|fix|check|look|update|deploy|push|test)\b/i,
];

const NOISE_ENTITIES = new Set([
  'doc', 'docs', 'spreadsheet', 'file', 'files', 'link', 'links',
  'meeting', 'meetings', 'call', 'standup', 'email', 'emails',
  'message', 'messages', 'task', 'tasks', 'note', 'notes',
  'update', 'updates', 'fix', 'bug', 'issue', 'issues',
  'api', 'key', 'keys', 'token', 'tokens', 'url', 'config',
  'test', 'tests', 'code', 'data', 'repo', 'branch',
  'folder', 'directory', 'script', 'command', 'tool',
  'error', 'log', 'logs', 'output', 'input', 'response',
  'csv file', 'json file', 'text file',
]);

function isNoiseText(text) {
  if (!text) return true;
  if (text.length < 25) return true;
  if (text.length > 200) return true; // LLM dumped a paragraph
  return NOISE_TEXT.some(p => p.test(text.trim()));
}

function isNoiseEntity(name) {
  if (!name) return true;
  const lower = name.toLowerCase();
  if (NOISE_ENTITIES.has(lower)) return true;
  if (lower.length < 3) return true;
  if (/^\d+$/.test(lower)) return true;
  return false;
}

/**
 * Filter a MiniGraph in-place, removing low-signal nodes and their edges.
 * Returns { kept, cut } counts.
 */
export function filterGraph(graph) {
  const data = graph.export();

  // Index edges by node
  const meaningfulByNode = {};
  const aboutByNode = {};
  for (const e of data.edges) {
    const type = e.type || '';
    if (!['ABOUT', 'FROM_SOURCE'].includes(type)) {
      (meaningfulByNode[e.source] ||= []).push(e);
      (meaningfulByNode[e.target] ||= []).push(e);
    }
    if (type === 'ABOUT') {
      (aboutByNode[e.source] ||= []).push(e);
      (aboutByNode[e.target] ||= []).push(e);
    }
  }

  // Pass 1: which entities/people survive?
  const coreSurvivors = new Set();
  for (const n of data.nodes) {
    if (n.type === 'document') { coreSurvivors.add(n.id); continue; }

    if (n.type === 'entity') {
      if (isNoiseEntity(n.name)) continue;
      const mentions = n.mentions || 1;
      const rels = (meaningfulByNode[n.id] || []).length;
      // Must be mentioned 2+ times OR have 3+ meaningful relationships
      if (mentions >= 2 || rels >= 3) coreSurvivors.add(n.id);
    }

    if (n.type === 'person') {
      const rels = (meaningfulByNode[n.id] || []).length;
      if (rels >= 2) coreSurvivors.add(n.id);
    }
  }

  // Pass 2: text nodes survive if they connect to a core survivor AND pass quality
  const allSurvivors = new Set(coreSurvivors);
  for (const n of data.nodes) {
    if (['fact', 'decision', 'preference', 'frustration'].includes(n.type)) {
      const text = n.text || '';
      if (isNoiseText(text)) continue;

      // Must connect via ABOUT to at least one core survivor
      const about = aboutByNode[n.id] || [];
      const touchesCore = about.some(e => {
        const otherId = e.source === n.id ? e.target : e.source;
        return coreSurvivors.has(otherId);
      });
      if (touchesCore) allSurvivors.add(n.id);
    }
  }

  // Pass 3: among surviving text nodes, deduplicate near-identical content
  // (Flash Lite often extracts the same fact with slightly different wording)
  const textNodes = data.nodes.filter(n =>
    allSurvivors.has(n.id) && ['fact', 'decision', 'preference', 'frustration'].includes(n.type)
  );
  const seenTexts = new Map(); // normalized prefix → first node id
  for (const n of textNodes) {
    const normalized = (n.text || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 50);
    if (seenTexts.has(normalized)) {
      allSurvivors.delete(n.id); // dupe
    } else {
      seenTexts.set(normalized, n.id);
    }
  }

  // Rebuild graph
  const before = data.nodes.length;
  const survivingIds = allSurvivors;

  // Delete non-surviving nodes
  for (const n of data.nodes) {
    if (!survivingIds.has(n.id)) {
      graph._nodes.delete(n.id);
      graph._outEdges.delete(n.id);
      graph._inEdges.delete(n.id);
    }
  }

  // Rebuild edges (only between survivors)
  for (const [source, edges] of graph._outEdges) {
    graph._outEdges.set(source, edges.filter(e => survivingIds.has(e.target)));
  }
  for (const [target, edges] of graph._inEdges) {
    graph._inEdges.set(target, edges.filter(e => survivingIds.has(e.source)));
  }

  const after = graph.nodeCount;
  return { kept: after, cut: before - after };
}
