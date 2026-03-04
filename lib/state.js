/**
 * Resume state — skip already-processed chunks.
 * State file: <output-dir>/betteringest-state.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class State {
  constructor(outputPath) {
    this.path = join(dirname(outputPath), 'betteringest-state.json');
    this.data = { processedChunks: {}, totalCost: 0 };
    this._load();
  }

  _load() {
    try {
      this.data = JSON.parse(readFileSync(this.path, 'utf-8'));
    } catch {
      // Fresh state
    }
  }

  isProcessed(contentHash) {
    return !!this.data.processedChunks[contentHash];
  }

  markProcessed(contentHash, tokens = 0) {
    this.data.processedChunks[contentHash] = { extractedAt: new Date().toISOString(), tokens };
    this._save();
  }

  addCost(cost) {
    this.data.totalCost = (this.data.totalCost || 0) + cost;
    this._save();
  }

  _save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.data, null, 2));
    } catch { /* best effort */ }
  }
}
