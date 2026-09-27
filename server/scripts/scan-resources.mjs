#!/usr/bin/env node
/**
 * 扫描 `资料分享模块素材/`，生成资料清单写入 SQLite。
 *
 * 本脚本**只负责参数解析与结果打印**，全部扫描规则（只读、幂等 upsert、
 * 幽灵记录清理、展示类目归集、受限分类标记）都委托给 `src/lib/scan.js`。
 *
 * 为什么必须这样分工：这里曾经复制过一份独立的 walk/upsert 实现，
 * 结果新增 `display_category` 列时只改了 `scan.js`，脚本照旧用旧 SQL，
 * 全部条目静默落成默认值「研报」——分类页一片空白且没有任何报错。
 * 两份实现必然漂移，因此只保留一份。
 *
 * 用法：
 *   node scripts/scan-resources.mjs
 *   node scripts/scan-resources.mjs --verbose
 *   node scripts/scan-resources.mjs --dir "D:/别的素材目录"   # 覆盖 MATERIALS_DIR
 */
import path from 'node:path';
import { buildConfig, createEnv } from '../src/lib/env.js';
import { openDatabase } from '../src/lib/db.js';
import { runScan, walkSync, isRestrictedCategory } from '../src/lib/scan.js';
import {
  classifyItem,
  isLibraryItem,
  CATEGORY_ORDER,
  PRODUCTION_CATEGORIES,
} from '../src/lib/categorize.js';

const env = createEnv();
const config = buildConfig(env);
const verbose = process.argv.includes('--verbose');

/** 允许命令行覆盖素材目录 */
const dirFlagIndex = process.argv.indexOf('--dir');
const materialsDir =
  dirFlagIndex >= 0 && process.argv[dirFlagIndex + 1]
    ? path.resolve(process.argv[dirFlagIndex + 1])
    : config.materialsDir;

console.log('─'.repeat(72));
console.log('扫描素材目录：', materialsDir);

const db = openDatabase(config.dbPath);

let result;
try {
  result = runScan(db, { materialsDir });
} catch (err) {
  console.error('写入失败，已回滚：', err);
  db.close();
  process.exit(1);
}

if (verbose) {
  // 明细只在 --verbose 下打印：文件多时刷屏会把汇总冲掉
  for (const file of walkSync(materialsDir)) {
    const tag = isLibraryItem(file.categoryDir) ? classifyItem(file) : '（非资料，不计入）';
    console.log(`  · [${file.categoryDir}] ${file.fileName}  →  ${tag}`);
  }
}

const summary = db
  .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(size_bytes),0) AS bytes FROM resources')
  .get();

console.log('─'.repeat(72));
console.log(`新增 ${result.inserted} 条，更新 ${result.updated} 条，清理 ${result.removed} 条`);
console.log(
  `数据库现有 ${Number(summary.total)} 条记录，合计 ${(Number(summary.bytes) / 1024 / 1024).toFixed(1)} MB`
);
console.log('');

// ── 磁盘目录视角（整理者关心的归档结构） ──────────────────────────────
console.log('磁盘目录明细：');
for (const row of result.categories) {
  const stmt = db.prepare(
    'SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS bytes FROM resources WHERE category_dir = ?'
  );
  const agg = stmt.get(row.category);
  const access = isRestrictedCategory(row.category) ? '（需登录）' : '（公开）';
  const note = isLibraryItem(row.category) ? '' : '  ← 不计入「资料与数据」';
  console.log(
    `  · ${row.category}  ${String(row.count).padStart(3)} 个  ` +
      `${(Number(agg.bytes) / 1024 / 1024).toFixed(1)} MB ${access}${note}`
  );
}

// ── 展示类目视角（读者看到的分类标签） ────────────────────────────────
//
// 口径必须与 `lib/resources.js` 的 summary/categorySummary 完全一致：
// **非资料目录（logo）不计入**。做法是先按目录过滤掉非资料条目，
// 再按类目聚合 —— 曾经先聚合再反查目录，结果第二组分组的 category_dir
// 取到的是任意一行，整个「研报」被误判成非资料目录、计数直接归零。
const libRows = db
  .prepare('SELECT display_category AS c, category_dir AS d, size_bytes AS b FROM resources')
  .all()
  .filter((r) => isLibraryItem(r.d));

const byDisplay = new Map();
for (const r of libRows) {
  const key = String(r.c ?? '');
  const prev = byDisplay.get(key) ?? { n: 0, bytes: 0 };
  prev.n += 1;
  prev.bytes += Number(r.b ?? 0);
  byDisplay.set(key, prev);
}

console.log('');
console.log('展示类目（「资料与数据」页面的标签）：');
let libN = 0;
let libBytes = 0;
for (const name of CATEGORY_ORDER) {
  const hit = byDisplay.get(name) ?? { n: 0, bytes: 0 };
  libN += hit.n;
  libBytes += hit.bytes;
  console.log(
    `  · ${name}  ${String(hit.n).padStart(3)} 个  ${(hit.bytes / 1024 / 1024).toFixed(1)} MB`
  );
}
console.log(
  `  · 全部  ${String(libN).padStart(3)} 个  ${(libBytes / 1024 / 1024).toFixed(1)} MB  （= 四个类目之和）`
);

// ── 展示类目视角二：社团成员产出（独立模块，不计入上面「全部」） ──────
console.log('');
console.log('展示类目（「社团成员产出」页面的标签）：');
let prodN = 0;
let prodBytes = 0;
for (const name of PRODUCTION_CATEGORIES) {
  const hit = byDisplay.get(name) ?? { n: 0, bytes: 0 };
  prodN += hit.n;
  prodBytes += hit.bytes;
  console.log(
    `  · ${name}  ${String(hit.n).padStart(3)} 个  ${(hit.bytes / 1024 / 1024).toFixed(1)} MB`
  );
}
console.log(
  `  · 合计  ${String(prodN).padStart(3)} 个  ${(prodBytes / 1024 / 1024).toFixed(1)} MB`
);
console.log('─'.repeat(72));

db.close();
