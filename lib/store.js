'use strict';
// 分鐘資料儲存：每個感測點一個 Store = 記憶體陣列 + data/<感測點 id>.jsonl (每行一筆 JSON，只增不改)。
// 每個感測點每天 1440 筆，量很小；要長期保存或做報表可換 SQLite。
const fs = require('node:fs');
const path = require('node:path');

class Store {
  constructor({ dir, name = 'readings', retainDays, persist = true }) {
    this.file = path.join(dir, name + '.jsonl');
    this.retainMs = retainDays * 86_400_000;
    this.persist = persist;
    this.points = [];
    if (persist) {
      fs.mkdirSync(dir, { recursive: true });
      this.load();
    }
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    const cutoff = Date.now() - this.retainMs;
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const p = JSON.parse(line);
        if (p.t >= cutoff) this.points.push(p);
      } catch {
        /* 略過壞掉的行 */
      }
    }
    this.points.sort((a, b) => a.t - b.t);
  }

  add(p) {
    this.points.push(p);
    const cutoff = Date.now() - this.retainMs;
    while (this.points.length && this.points[0].t < cutoff) this.points.shift();
    if (this.persist) fs.appendFile(this.file, JSON.stringify(p) + '\n', (err) => err && console.error('[store]', err.message));
  }

  since(ts) {
    // 資料依時間排序，從尾端往回找起點
    let i = this.points.length;
    while (i > 0 && this.points[i - 1].t >= ts) i--;
    return this.points.slice(i);
  }

  last() {
    return this.points[this.points.length - 1] || null;
  }
}

module.exports = { Store };
