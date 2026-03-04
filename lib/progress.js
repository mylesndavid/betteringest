/**
 * TTY-aware progress bar.
 */

export class Progress {
  constructor(total) {
    this.total = total;
    this.current = 0;
    this.startTime = Date.now();
    this.isTTY = process.stderr.isTTY;
  }

  tick(label = '') {
    this.current++;
    if (this.isTTY) {
      const pct = Math.round((this.current / this.total) * 100);
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
      const bar = '='.repeat(Math.floor(pct / 2.5)).padEnd(40, ' ');
      const info = label ? ` ${label}` : '';
      process.stderr.write(`\r  [${bar}] ${pct}% (${this.current}/${this.total}) ${elapsed}s${info}`);
    }
  }

  done() {
    if (this.isTTY) {
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
      process.stderr.write(`\r  Done: ${this.total} chunks in ${elapsed}s${''.padEnd(30)}\n`);
    }
  }
}
