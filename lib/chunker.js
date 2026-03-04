/**
 * Intelligent text splitting — chat messages, markdown sections, paragraph windows, JSON/CSV.
 */
import { createHash } from 'node:crypto';

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function contentHash(text) {
  return createHash('sha256').update(text).digest('hex');
}

// WhatsApp/chat timestamp patterns
const CHAT_LINE = /^\[?\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4},?\s+\d{1,2}:\d{2}/;
const CHAT_SENDER = /^\[?\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4},?\s+\d{1,2}:\d{2}[:\d]*\s*(?:AM|PM)?\]?\s*[-–]?\s*([^:]+):/;

function isChat(content) {
  const lines = content.split('\n').slice(0, 20);
  let chatLines = 0;
  for (const line of lines) {
    if (CHAT_LINE.test(line)) chatLines++;
  }
  return chatLines >= 3;
}

export function chunk(file, maxTokens = 6000) {
  // Auto-detect chat format
  if (isChat(file.content)) {
    return chunkChat(file, maxTokens);
  }
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

/**
 * Chat-aware chunking — groups messages by time gaps (10 min).
 * Each chunk is a conversation segment with participants listed.
 */
function chunkChat(file, maxTokens) {
  const lines = file.content.split('\n');
  const messages = [];

  // Parse messages with timestamps
  let currentMsg = null;
  for (const line of lines) {
    const senderMatch = line.match(CHAT_SENDER);
    if (senderMatch) {
      if (currentMsg) messages.push(currentMsg);
      // Extract timestamp roughly
      const tsMatch = line.match(/^\[?(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}),?\s+(\d{1,2}:\d{2}[:\d]*\s*(?:AM|PM)?)/);
      let ts = 0;
      if (tsMatch) {
        try { ts = new Date(tsMatch[1] + ' ' + tsMatch[2]).getTime(); } catch { ts = 0; }
      }
      currentMsg = { sender: senderMatch[1].trim(), text: line, ts };
    } else if (currentMsg) {
      currentMsg.text += '\n' + line;
    }
  }
  if (currentMsg) messages.push(currentMsg);

  if (messages.length === 0) return chunkParagraphs(file, maxTokens);

  // Group by time gaps (10 minutes) or token limit
  const GAP_MS = 10 * 60 * 1000;
  const segments = [];
  let current = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const gap = messages[i].ts && current[current.length - 1].ts
      ? messages[i].ts - current[current.length - 1].ts
      : 0;
    const currentText = current.map(m => m.text).join('\n');

    if ((gap > GAP_MS && current.length > 3) || estimateTokens(currentText) > maxTokens) {
      segments.push(current);
      current = [];
    }
    current.push(messages[i]);
  }
  if (current.length > 0) segments.push(current);

  // Build chunks with participant metadata
  const chunks = [];
  for (const segment of segments) {
    const participants = [...new Set(segment.map(m => m.sender))];
    const text = segment.map(m => m.text).join('\n');
    if (!text.trim()) continue;

    // If segment is too big, split further
    if (estimateTokens(text) > maxTokens) {
      const subSegments = splitSegment(segment, maxTokens);
      for (const sub of subSegments) {
        const subParticipants = [...new Set(sub.map(m => m.sender))];
        const subText = sub.map(m => m.text).join('\n');
        chunks.push({
          text: subText,
          source: file.path,
          heading: `Conversation: ${subParticipants.join(', ')}`,
          participants: subParticipants,
          contentHash: contentHash(subText),
          isChat: true,
        });
      }
    } else {
      chunks.push({
        text,
        source: file.path,
        heading: `Conversation: ${participants.join(', ')}`,
        participants,
        contentHash: contentHash(text),
        isChat: true,
      });
    }
  }

  return chunks.map((c, i) => ({ ...c, chunkIndex: i, totalChunks: chunks.length }));
}

function splitSegment(messages, maxTokens) {
  const result = [];
  let current = [];
  let tokens = 0;
  for (const m of messages) {
    const t = estimateTokens(m.text);
    if (tokens + t > maxTokens && current.length > 0) {
      result.push(current);
      current = [];
      tokens = 0;
    }
    current.push(m);
    tokens += t;
  }
  if (current.length > 0) result.push(current);
  return result;
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
      const overlap = current.slice(-2);
      current = overlap;
      currentTokens = estimateTokens(overlap.join('\n\n'));
    }

    current.push(p);
    currentTokens += tokens;
  }

  if (current.length > 0) {
    const text = current.join('\n\n');
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
