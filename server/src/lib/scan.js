/**
 * 素材目录扫描：把 `资料分享模块素材/` 的文件清单写入 SQLite。
 *
 * 从 `scripts/scan-resources.mjs` 抽出来做成可复用模块，原因是：
 * CLI 脚本与集成测试需要**同一份**扫描逻辑。若各自实现一套，
 * 「受限分类标记」「幂等 upsert」「幽灵记录清理」这几条规则迟早会漂移，
 * 测试就失去意义。
 *
 * 设计要点：
 * - **只读**：只 stat 与 readdir，绝不写、删、改素材目录里的任何文件。
 * - **幂等**：以「相对路径」为业务主键做 upsert；文件被删除时条目一并清理。
 * - 分类取一级目录名；根目录下的散文件归入「未分类」。
 * - 「上传时间」取文件系统 mtime —— 素材目录里唯一可得的可靠时间信息。
 */
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { plain } from './db.js';
import { classifyItem } from './categorize.js';

/**
 * 作品元数据（sidecar）位置：`server/data/production-meta.json`。
 *
 * 用 `import.meta.url` 定位而不是 `process.cwd()`：扫描脚本可能从任意目录被调用
 * （CLI、测试、启动自检），相对 cwd 的路径会静默读不到文件 ——
 * 而「读不到就退回自动归类」的行为会让这个 bug 完全无声。
 */
const META_URL = new URL('../../data/production-meta.json', import.meta.url);

/**
 * 读取作品元数据覆写表。
 *
 * 为什么要有这个文件：文件名能表达的语义有限。`具身智能之“灵巧手”_DOCX.rar`
 * 里没有任何可判定的体裁词，而它显然是协会自产的作品；再强的通用正则也不该
 * 为单个文件写死规则。于是把「不可推导的判断」集中到一张**显式、可审计、
 * 一处可改**的声明表里，比在分类器里堆特例要稳。
 *
 * 文件缺失或损坏时返回空表：退回纯自动归类，不影响扫描主流程。
 *
 * @param {URL|string} [metaUrl]
 * @returns {Record<string, object>}
 */
export function loadResourceMeta(metaUrl = META_URL) {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaUrl, 'utf8'));
    const items = parsed?.items;
    return items && typeof items === 'object' ? items : {};
  } catch {
    return {};
  }
}

/** 把元数据条目规整成可直接写库的字段（缺省即空，绝不 undefined） */
function normalizeMeta(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((t) => String(t).trim()).filter(Boolean).join(',')
    : '';
  // 截图：既支持 { src, caption } 对象，也支持直接写字符串（等价于只有 src）
  const shots = Array.isArray(entry.screenshots)
    ? entry.screenshots
        .map((s) =>
          typeof s === 'string'
            ? { src: s.trim(), caption: '' }
            : s && typeof s === 'object' && typeof s.src === 'string'
              ? { src: s.src.trim(), caption: str(s.caption) }
              : null
        )
        .filter((s) => s && s.src)
    : [];
  return {
    displayCategory: str(entry.displayCategory),
    title: str(entry.title),
    author: str(entry.author),
    authorTitle: str(entry.authorTitle),
    authorNote: str(entry.authorNote),
    summary: str(entry.summary),
    tags,
    screenshots: JSON.stringify(shots),
  };
}

/** 扩展名 → 粗分类 */
export const KIND_BY_EXT = {
  pdf: 'doc',
  doc: 'doc',
  docx: 'doc',
  xls: 'data',
  xlsx: 'data',
  csv: 'data',
  ppt: 'doc',
  pptx: 'doc',
  epub: 'doc',
  txt: 'doc',
  md: 'doc',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
};

/**
 * 需要会话才能访问的分类（内部资料不对外公开）。
 * 这是**默认拒绝**的名单：不在名单里的分类按公开处理。
 * 若要新增加密分类，改这里即可，前端无需改动。
 */
export const RESTRICTED_CATEGORIES = new Set(['研发部内部资料']);

/** 判断某分类是否属于受限内容 */
export function isRestrictedCategory(categoryDir) {
  return RESTRICTED_CATEGORIES.has(String(categoryDir));
}

const kindOf = (ext) => KIND_BY_EXT[ext] ?? 'other';

/**
 * 递归遍历目录，返回文件清单。
 * @param {string} root
 * @returns {Promise<Array<{relPath:string,name:string,fileName:string,categoryDir:string,ext:string,size:number,mtime:string,kind:string}>>}
 */
export async function walkMaterials(root) {
  const out = [];
  const rootResolved = path.resolve(root);

  async function visit(absDir, relativeParts) {
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      // 跳过隐藏文件与 macOS 元数据
      if (entry.name.startsWith('.')) continue;

      const abs = path.join(absDir, entry.name);
      const relParts = [...relativeParts, entry.name];

      if (entry.isDirectory()) {
        await visit(abs, relParts);
        continue;
      }
      if (!entry.isFile()) continue;

      let stat;
      try {
        stat = await fsp.stat(abs);
      } catch {
        continue;
      }

      const fileName = entry.name;
      const dot = fileName.lastIndexOf('.');
      const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
      const name = dot > 0 ? fileName.slice(0, dot) : fileName;

      // 分类 = 相对根目录的第一段；根目录下的散文件归入「未分类」
      const categoryDir = relParts.length > 1 ? relParts[0] : '未分类';

      out.push({
        // 统一用 POSIX 分隔符存库，跨平台一致
        relPath: relParts.join('/'),
        name,
        fileName,
        categoryDir,
        ext,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        kind: kindOf(ext),
      });
    }
  }

  await visit(rootResolved, []);
  return out;
}

/**
 * 扫描并入库（在单个事务内完成，失败回滚）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ materialsDir: string, restrictedCategories?: Set<string> }} config
 * @returns {{ total:number, inserted:number, updated:number, removed:number, categories:Array }}
 */
export function runScan(db, config) {
  const materialsDir = config.materialsDir;
  const restricted = config.restrictedCategories ?? RESTRICTED_CATEGORIES;
  /** 显式覆写表：按相对路径点名，优先级高于按文件名的自动归类 */
  const metaTable = config.resourceMeta ?? loadResourceMeta();

  // walkMaterials 是 async，但 index.js 的启动自检需要同步调用；
  // 这里用同步 readdir 版本保证 runScan 是纯同步函数（便于测试与启动期调用）。
  const files = walkSync(materialsDir);
  const now = new Date().toISOString();

  const upsert = db.prepare(`
    INSERT INTO resources
      (rel_path, name, file_name, category_dir, display_category, ext, size_bytes,
       mtime, kind, access_level, sort_index, created_at, updated_at,
       author, author_title, author_note, summary, screenshots, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 100, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(rel_path) DO UPDATE SET
      name = excluded.name,
      file_name = excluded.file_name,
      category_dir = excluded.category_dir,
      display_category = excluded.display_category,
      ext = excluded.ext,
      size_bytes = excluded.size_bytes,
      mtime = excluded.mtime,
      kind = excluded.kind,
      access_level = excluded.access_level,
      updated_at = excluded.updated_at,
      author = excluded.author,
      author_title = excluded.author_title,
      author_note = excluded.author_note,
      summary = excluded.summary,
      screenshots = excluded.screenshots,
      tags = excluded.tags
  `);

  let inserted = 0;
  let updated = 0;
  let removed = 0;

  db.exec('BEGIN');
  try {
    for (const file of files) {
      const accessLevel = restricted.has(file.categoryDir) ? 'member' : 'public';
      // 展示类目与磁盘目录解耦：读者按内容形态找资料，不按它被存在哪个文件夹。
      // 元数据里点名覆写的优先，否则交给分类器推断。
      const meta = normalizeMeta(metaTable[file.relPath]);
      const displayCategory = meta?.displayCategory || classifyItem(file);
      const before = plain(
        db.prepare('SELECT id FROM resources WHERE rel_path = ?').get(file.relPath)
      );
      upsert.run(
        file.relPath,
        // 作品可以用展示名覆盖文件名派生的名字（列表按它显示）
        meta?.title || file.name,
        file.fileName,
        file.categoryDir,
        displayCategory,
        file.ext,
        file.size,
        file.mtime,
        file.kind,
        accessLevel,
        now,
        now,
        meta?.author ?? '',
        meta?.authorTitle ?? '',
        meta?.authorNote ?? '',
        meta?.summary ?? '',
        meta?.screenshots ?? '[]',
        meta?.tags ?? ''
      );
      if (before) updated += 1;
      else inserted += 1;
    }

    // 清理磁盘上已不存在的条目（素材被移除后不留幽灵记录）
    const known = new Set(files.map((f) => f.relPath));
    const stale = db
      .prepare('SELECT id, rel_path FROM resources')
      .all()
      .filter((row) => !known.has(String(row.rel_path)));
    for (const row of stale) {
      db.prepare('DELETE FROM resources WHERE id = ?').run(Number(row.id));
      removed += 1;
    }

    // 为所有资料补一行统计记录，保证列表查询左连接不落空
    db.prepare(`
      INSERT OR IGNORE INTO resource_stats (resource_id, likes)
      SELECT id, 0 FROM resources
    `).run();

    // 让统计与明细对齐（防止手工改库造成的漂移）
    db.prepare(`
      UPDATE resource_stats SET likes =
        (SELECT COUNT(*) FROM resource_likes l WHERE l.resource_id = resource_stats.resource_id)
    `).run();

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const summary = plain(
    db.prepare('SELECT COUNT(*) AS total FROM resources').get()
  );
  const categories = db
    .prepare(
      'SELECT category_dir, COUNT(*) AS n FROM resources GROUP BY category_dir ORDER BY category_dir'
    )
    .all()
    .map((r) => ({
      category: String(r.category_dir),
      count: Number(r.n),
      restricted: restricted.has(String(r.category_dir)),
    }));

  return {
    total: Number(summary?.total ?? 0),
    inserted,
    updated,
    removed,
    categories,
  };
}

/**
 * 同步版目录遍历（供 runScan 使用）。
 * 与 walkMaterials 规则保持一致：跳过隐藏文件、分类取一级目录、根目录散文件归「未分类」。
 */
export function walkSync(root) {
  const out = [];
  const rootResolved = path.resolve(root);

  function visit(absDir, relativeParts) {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(absDir, entry.name);
      const relParts = [...relativeParts, entry.name];
      if (entry.isDirectory()) {
        visit(abs, relParts);
        continue;
      }
      if (!entry.isFile()) continue;

      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      const fileName = entry.name;
      const dot = fileName.lastIndexOf('.');
      const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
      const name = dot > 0 ? fileName.slice(0, dot) : fileName;
      const categoryDir = relParts.length > 1 ? relParts[0] : '未分类';

      out.push({
        relPath: relParts.join('/'),
        name,
        fileName,
        categoryDir,
        ext,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        kind: kindOf(ext),
      });
    }
  }

  visit(rootResolved, []);
  return out;
}
