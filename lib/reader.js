/**
 * File readers — .txt, .md, .json, .csv, directories, stdin, .zip
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.tsv',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.swift', '.kt',
  '.html', '.css', '.scss', '.less', '.xml', '.yaml', '.yml', '.toml',
  '.sh', '.bash', '.zsh', '.fish', '.bat', '.ps1',
  '.sql', '.graphql', '.proto', '.env', '.ini', '.cfg', '.conf',
  '.log', '.rst', '.tex', '.org', '.adoc',
]);

function isTextFile(filepath) {
  const ext = extname(filepath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (basename(filepath).startsWith('.')) return false;
  // No extension — try reading a small sample
  if (!ext) return true;
  return false;
}

export async function readSource(source) {
  const s = await stat(source);
  if (s.isDirectory()) return readDirectory(source);
  if (source.endsWith('.zip')) return readZip(source);
  return [await readSingleFile(source)];
}

async function readSingleFile(filepath) {
  const content = await readFile(filepath, 'utf-8');
  const ext = extname(filepath).toLowerCase();
  return { path: filepath, filename: basename(filepath), content, ext, size: Buffer.byteLength(content) };
}

async function readDirectory(dir) {
  const results = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await readDirectory(full));
    } else if (isTextFile(full)) {
      try {
        results.push(await readSingleFile(full));
      } catch {
        // Skip unreadable files
      }
    }
  }
  return results;
}

function readZip(zipPath) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'betteringest-'));
  try {
    execSync(`unzip -o -q "${zipPath}" -d "${tmpDir}"`, { stdio: 'pipe' });
  } catch {
    return [];
  }

  const results = [];
  function walkSync(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkSync(full);
      } else if (isTextFile(full)) {
        try {
          const content = readFileSync(full, 'utf-8');
          results.push({
            path: `${zipPath}!${full.slice(tmpDir.length)}`,
            filename: entry.name,
            content,
            ext: extname(entry.name).toLowerCase(),
            size: Buffer.byteLength(content),
          });
        } catch { /* skip */ }
      }
    }
  }
  walkSync(tmpDir);
  return results;
}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const content = Buffer.concat(chunks).toString('utf-8');
  return [{ path: '<stdin>', filename: '<stdin>', content, ext: '.txt', size: Buffer.byteLength(content) }];
}
