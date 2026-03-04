/**
 * Intelligent text splitting — markdown sections, paragraph windows, JSON/CSV.
 */
import { createHash } from 'node:crypto';

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function contentHash(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function chunk(file, maxTokens = 6000) {
  if (file.ext === '.md' || file.ext === '.markdown') {
    return chunkMarkdown(file, maxTokens);
  }
  if (file.ext === '.json') {
    return chunkJSON(file, maxTokens);
  }
  if (file.ext === '.csv' || file.ext === '.tsv') {
    return chunkCSV(file, maxTokens);
  }
  return chunkParagraphs(file, maxTokens);
}

function chunkMarkdown(file, maxTokens) {
  const sections = [];
  const lines = file.content.split('\n');
  let current = { heading: '', lines: [] };

  for (const line of lines) {
    if (/^#{1,3}\s/.test(line) && current.lines.length > 0) {
      sections.push(current);
      current = { heading: line.replace(/^#+\s*/, ''), lines: [] };
    } else {
      if (!current.heading && /^#{1,3}\s/.test(line)) {
        current.heading = line.replace(/^#+\s*/, '');
      }
      current.lines.push(line);
    }
  }
  if (current.lines.length > 0) sections.push(current);

  const chunks = [];
  for (const section of sections) {
    const text = section.lines.join('\n').trim();
    if (!text) continue;

    if (estimateTokens(text) <= maxTokens) {
      chunks.push({ text, source: file.path, heading: section.heading, contentHash: contentHash(text) });
    } else {
      // Section too big — fall through to paragraph chunker
      const subChunks = chunkParagraphs({ ...file, content: text }, maxTokens);
      for (const sc of subChunks) {
        sc.heading = section.heading;
        chunks.push(sc);
      }
    }
  }

  return chunks.map((c, i) => ({ ...c, chunkIndex: i, totalChunks: chunks.length }));
}

function chunkParagraphs(file, maxTokens) {
  const paragraphs = file.content.split(/\n\s*\n/).filter(p => p.trim());
  if (paragraphs.length === 0) return [];

  const chunks = [];
  let current = [];
  let currentTokens = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i].trim();
    const tokens = estimateTokens(p);

    if (currentTokens + tokens > maxTokens && current.length > 0) {
      const text = current.join('\n\n');
      chunks.push({ text, source: file.path, heading: '', contentHash: contentHash(text) });
      // 2-paragraph overlap
      const overlap = current.slice(-2);
      current = overlap;
      currentTokens = estimateTokens(overlap.join('\n\n'));
    }

    current.push(p);
    currentTokens += tokens;
  }

  if (current.length > 0) {
    const text = current.join('\n\n');
    // Avoid duplicate of last chunk
    const hash = contentHash(text);
    if (!chunks.length || chunks[chunks.length - 1].contentHash !== hash) {
      chunks.push({ text, source: file.path, heading: '', contentHash: hash });
    }
  }

  return chunks.map((c, i) => ({ ...c, chunkIndex: i, totalChunks: chunks.length }));
}

function chunkJSON(file, maxTokens) {
  let parsed;
  try { parsed = JSON.parse(file.content); } catch { return chunkParagraphs(file, maxTokens); }

  if (!Array.isArray(parsed)) {
    // Single object — chunk as text
    return chunkParagraphs(file, maxTokens);
  }

  const chunks = [];
  const itemsPerChunk = Math.max(1, Math.floor(maxTokens / Math.max(1, estimateTokens(JSON.stringify(parsed[0], null, 2)))));

  for (let i = 0; i < parsed.length; i += itemsPerChunk) {
    const slice = parsed.slice(i, i + itemsPerChunk);
    const text = JSON.stringify(slice, null, 2);
    chunks.push({ text, source: file.path, heading: `items ${i}-${i + slice.length - 1}`, contentHash: contentHash(text) });
  }

  return chunks.map((c, i) => ({ ...c, chunkIndex: i, totalChunks: chunks.length }));
}

function chunkCSV(file, maxTokens) {
  const lines = file.content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return chunkParagraphs(file, maxTokens);

  const header = lines[0];
  const headerTokens = estimateTokens(header);
  const rowsPerChunk = Math.max(1, Math.floor((maxTokens - headerTokens) / Math.max(1, estimateTokens(lines[1]))));

  const chunks = [];
  for (let i = 1; i < lines.length; i += rowsPerChunk) {
    const rows = lines.slice(i, i + rowsPerChunk);
    const text = [header, ...rows].join('\n');
    chunks.push({ text, source: file.path, heading: `rows ${i}-${i + rows.length - 1}`, contentHash: contentHash(text) });
  }

  return chunks.map((c, i) => ({ ...c, chunkIndex: i, totalChunks: chunks.length }));
}
