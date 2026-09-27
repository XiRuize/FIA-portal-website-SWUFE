/**
 * 分批修复 pnpm store 内的空目录/断链。
 *
 * 背景：pnpm 在本机会把大量包内部的 node_modules 条目建成空目录，
 * 导致 vite build 报 `Cannot find package .../esbuild/index.js`。
 * mklink 每个都要起一次 cmd，全量 1200+ 个会很慢，因此分批跑。
 *
 * 用法：node scripts/repair-store-chunk.cjs <startIndex> <count>
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const start = Number(process.argv[2] || 0);
const count = Number(process.argv[3] || 300);

const store = path.join(process.cwd(), 'node_modules', '.pnpm');

/** 建立「包名 -> 真实包路径」索引（跳过空目录） */
function buildIndex() {
  const idx = new Map();
  const add = (name, p) => {
    try {
      if (fs.readdirSync(p).length === 0) return;
    } catch {
      return;
    }
    const prev = idx.get(name);
    if (!prev || p.length < prev.length) idx.set(name, p);
  };
  for (const d of fs.readdirSync(store)) {
    const inner = path.join(store, d, 'node_modules');
    let ents;
    try {
      ents = fs.readdirSync(inner, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (e.name.startsWith('@')) {
        const sc = path.join(inner, e.name);
        let subs;
        try {
          subs = fs.readdirSync(sc);
        } catch {
          continue;
        }
        for (const s of subs) add(`${e.name}/${s}`, path.join(sc, s));
      } else {
        add(e.name, path.join(inner, e.name));
      }
    }
  }
  return idx;
}

/** 收集所有空目录/断链 */
function collectJobs() {
  const jobs = [];
  for (const d of fs.readdirSync(store)) {
    const inner = path.join(store, d, 'node_modules');
    let ents;
    try {
      ents = fs.readdirSync(inner, { withFileTypes: true });
    } catch {
      continue;
    }
    const check = (name, p) => {
      let l;
      try {
        l = fs.lstatSync(p);
      } catch {
        return;
      }
      let c = 0;
      try {
        c = fs.readdirSync(p).length;
      } catch {
        c = 0;
      }
      if (c === 0) jobs.push({ name, p, sym: l.isSymbolicLink() });
    };
    for (const e of ents) {
      if (e.name.startsWith('@')) {
        const sc = path.join(inner, e.name);
        let subs;
        try {
          subs = fs.readdirSync(sc);
        } catch {
          continue;
        }
        for (const s of subs) check(`${e.name}/${s}`, path.join(sc, s));
      } else {
        check(e.name, path.join(inner, e.name));
      }
    }
  }
  return jobs;
}

const idx = buildIndex();
const jobs = collectJobs();
const slice = jobs.slice(start, start + count);

let ok = 0;
let miss = 0;
let fail = 0;
const missing = [];

for (const j of slice) {
  const target = idx.get(j.name);
  if (!target) {
    miss += 1;
    missing.push(j.name);
    continue;
  }
  try {
    fs.rmSync(j.p, { recursive: true, force: true });
    execFileSync('cmd', ['/c', 'mklink', '/J', j.p, target], { stdio: 'ignore' });
    ok += 1;
  } catch {
    fail += 1;
  }
}

console.log(
  `chunk[${start},${start + slice.length}) total=${jobs.length} ok=${ok} miss=${miss} fail=${fail}`
);
if (missing.length) {
  console.log('missing unique: ' + [...new Set(missing)].slice(0, 20).join(', '));
}
