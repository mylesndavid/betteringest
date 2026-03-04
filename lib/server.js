/**
 * Web UI server for betteringest — port 3335.
 * Upload files, run ingestion, visualize the graph.
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join, extname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { resolveConfig } from './config.js';
import { ingestForUI } from './ingest.js';
import { MiniGraph } from './graph.js';

const PORT = 3335;
const UPLOAD_DIR = join(tmpdir(), 'betteringest-uploads');
const __dirname = new URL('.', import.meta.url).pathname;

// Ingestion state shared with UI
const state = {
  status: 'idle', // idle | running | done | error
  progress: { current: 0, total: 0, label: '' },
  logs: [],
  graphPath: './graph.json',
};

function log(msg) {
  state.logs.push({ time: Date.now(), msg });
  if (state.logs.length > 200) state.logs.shift();
}

async function ensureUploadDir() {
  await mkdir(UPLOAD_DIR, { recursive: true });
}

// Parse multipart form data (zero-dep)
function parseMultipart(buf, boundary) {
  const files = [];
  const delim = Buffer.from(`--${boundary}`);
  let pos = 0;

  while (pos < buf.length) {
    const start = buf.indexOf(delim, pos);
    if (start === -1) break;
    const next = buf.indexOf(delim, start + delim.length);
    if (next === -1) break;

    const part = buf.slice(start + delim.length, next);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) { pos = next; continue; }

    const headerStr = part.slice(0, headerEnd).toString('utf-8');
    const body = part.slice(headerEnd + 4, part.length - 2); // trim trailing \r\n

    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);

    if (filenameMatch) {
      files.push({ fieldName: nameMatch?.[1] || 'file', filename: filenameMatch[1], data: body });
    }
    pos = next;
  }
  return files;
}

async function handleUpload(req) {
  await ensureUploadDir();
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) throw new Error('No boundary in content-type');

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const buf = Buffer.concat(chunks);

  const files = parseMultipart(buf, boundaryMatch[1]);
  const saved = [];

  for (const file of files) {
    const id = randomUUID().slice(0, 8);
    const ext = extname(file.filename) || '.txt';
    const safeName = `${id}-${file.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const dest = join(UPLOAD_DIR, safeName);
    await writeFile(dest, file.data);
    saved.push({ name: file.filename, path: dest, size: file.data.length });
    log(`Uploaded: ${file.filename} (${(file.data.length / 1024).toFixed(1)} KB)`);
  }

  return saved;
}

async function handleIngest(body) {
  if (state.status === 'running') throw new Error('Ingestion already running');

  const config = resolveConfig({
    output: resolve(body.output || state.graphPath),
    yes: true,
    verbose: true,
    model: body.model,
    apiKey: body.apiKey,
  });
  state.graphPath = config.output;
  state.status = 'running';
  state.progress = { current: 0, total: 0, label: 'Starting...' };
  state.logs = [];
  log('Starting ingestion...');

  // Gather source paths
  let sources = [];
  try {
    await ensureUploadDir();
    const entries = await readdir(UPLOAD_DIR);
    sources = entries.map(e => join(UPLOAD_DIR, e));
  } catch { /* empty */ }

  if (body.rawText) {
    const tmpFile = join(UPLOAD_DIR, `raw-${randomUUID().slice(0, 8)}.txt`);
    await writeFile(tmpFile, body.rawText);
    sources.push(tmpFile);
    log('Added raw text input');
  }

  if (sources.length === 0) {
    state.status = 'error';
    log('No files to ingest');
    return;
  }

  // Run ingestion async
  ingestForUI(sources, config, {
    onProgress: (current, total, label) => {
      state.progress = { current, total, label };
    },
    onLog: (msg) => log(msg),
    onDone: () => {
      state.status = 'done';
      log('Ingestion complete!');
    },
    onError: (err) => {
      state.status = 'error';
      log(`Error: ${err.message}`);
    },
  }).catch(err => {
    state.status = 'error';
    log(`Fatal: ${err.message}`);
  });
}

async function getGraphData() {
  try {
    const raw = await readFile(resolve(state.graphPath), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { nodes: [], edges: [] };
  }
}

async function clearUploads() {
  try {
    const entries = await readdir(UPLOAD_DIR);
    for (const e of entries) await unlink(join(UPLOAD_DIR, e)).catch(() => {});
    log('Cleared uploads');
  } catch { /* empty */ }
}

async function listUploads() {
  try {
    await ensureUploadDir();
    const entries = await readdir(UPLOAD_DIR);
    const files = [];
    for (const e of entries) {
      const { size } = statSync(join(UPLOAD_DIR, e));
      // Strip the UUID prefix for display
      const displayName = e.replace(/^[a-f0-9]{8}-/, '');
      files.push({ name: displayName, path: join(UPLOAD_DIR, e), size });
    }
    return files;
  } catch { return []; }
}

function sendJSON(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

export async function startServer(cliFlags = {}) {
  const config = resolveConfig(cliFlags);
  state.graphPath = config.output;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    try {
      // API routes
      if (url.pathname === '/api/upload' && req.method === 'POST') {
        const saved = await handleUpload(req);
        sendJSON(res, { ok: true, files: saved });
      }
      else if (url.pathname === '/api/ingest' && req.method === 'POST') {
        const body = await readBody(req);
        await handleIngest(body);
        sendJSON(res, { ok: true });
      }
      else if (url.pathname === '/api/status') {
        sendJSON(res, { status: state.status, progress: state.progress, logs: state.logs.slice(-50) });
      }
      else if (url.pathname === '/api/graph') {
        const data = await getGraphData();
        sendJSON(res, data);
      }
      else if (url.pathname === '/api/uploads') {
        const files = await listUploads();
        sendJSON(res, { files });
      }
      else if (url.pathname === '/api/uploads' && req.method === 'DELETE') {
        await clearUploads();
        sendJSON(res, { ok: true });
      }
      else if (url.pathname === '/api/clear' && req.method === 'POST') {
        await clearUploads();
        state.status = 'idle';
        state.logs = [];
        sendJSON(res, { ok: true });
      }
      else if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = await readFile(join(__dirname, 'panel.html'), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      }
      else {
        res.writeHead(404);
        res.end('Not found');
      }
    } catch (err) {
      sendJSON(res, { error: err.message }, 500);
    }
  });

  server.listen(PORT, () => {
    console.log(`\n  betteringest UI → http://localhost:${PORT}\n`);
    console.log(`  Output: ${resolve(state.graphPath)}`);
    console.log(`  Model:  ${config.model}\n`);
  });
}
