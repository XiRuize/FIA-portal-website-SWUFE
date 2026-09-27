/**
 * 资料服务：清单查询、点赞去重、流式下载/预览（含 Range）。
 *
 * 文件读取采用「只读 + 路径白名单校验」：
 * 数据库里的 rel_path 是唯一可信来源，请求路径必须能匹配到库中记录，
 * 因此不存在 `../` 目录穿越的可能。
 */
import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { plain, plainAll } from './db.js';
import {
  ALL_CATEGORY,
  MODULES,
  NON_LIBRARY_DIRS,
  PRODUCTION_CATEGORY,
  isLibraryItem,
} from './categorize.js';

/** MIME 表：覆盖素材目录里实际出现的类型 */
const MIME_BY_EXT = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  // ICO：素材目录的 logo/ 下有 9 个 .ico（16~48px 的 favicon 来源）。
  // 原先这里没有这一项，于是它们全被当成 `application/octet-stream` 返回
  // —— 浏览器靠内容嗅探仍能渲染，但语义错误，且严格模式/CDN 协商下会出问题。
  ico: 'image/x-icon',
  cur: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  epub: 'application/epub+zip',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/**
 * 按文件头「魔数」推断 MIME。
 *
 * 为什么需要它：扩展名是**不可信**的。实测素材目录里 `腾讯.png` 实际是 JPEG
 * 数据（文件头 `ff d8 ff e0`）。若只按扩展名回 `image/png`，浏览器虽然多数
 * 情况下仍能渲染，但在严格模式、下载另存、以及 CDN 缓存协商时会出问题，
 * 排查起来很费时间。这里以文件内容为准，扩展名仅作兜底。
 *
 * @param {Buffer} head 文件的前若干字节（建议 >= 12）
 * @returns {string | null} 识别出的 MIME，未识别返回 null
 */
export function sniffMime(head) {
  if (!head || head.length < 4) return null;
  const b = head;

  // JPEG: ff d8 ff
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4e 47 0d 0a 1a 0a
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  // GIF: "GIF8"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  // PDF: "%PDF"
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  // ZIP 家族（docx/xlsx/pptx 本质上都是 zip）
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) {
    return 'application/zip';
  }
  // RAR: "Rar!"
  if (b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21) {
    return 'application/vnd.rar';
  }
  // 7z: 37 7a bc af
  if (b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf) {
    return 'application/x-7z-compressed';
  }
  // WEBP: "RIFF"...."WEBP"
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return 'image/webp';
  }
  // ICO / CUR：`00 00 01 00` / `00 00 02 00`
  //
  // ⚠️ 这里**必须放在最后几个分支**里也可以，但不能省 —— 史上漏了这一段，
  // 结果是 logo/ 下的 .ico 一律落到扩展名兜底，被当二进制流下发。
  // 注意 ICO 的魔数是 4 字节里的**前两字节为 0**，写成「32 位小端 == 0x00000100」
  // 很容易把字节序搞反，故直接按字节比较。
  if (b[0] === 0x00 && b[1] === 0x00 && b[3] === 0x00 && (b[2] === 0x01 || b[2] === 0x02)) {
    return 'image/x-icon';
  }
  return null;
}

/** 需要做内容嗅探的扩展名（压缩包与 Office 文档不在此列：zip 头无法区分具体格式，反而不如信扩展名） */
const SNIFFABLE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf']);

/** 可直接在浏览器内联预览的类型（PDF 与图片） */
const INLINE_EXT = new Set([
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'ico',
  'txt',
  'md',
]);

/** 排序方式白名单 */
const SORTS = {
  /** 按上传（文件修改）时间倒序，最新在前 */
  newest: 'r.mtime DESC, r.id DESC',
  /** `time` 是 `newest` 的别名 —— 前端排序开关用的是「按时间」，语义更直白 */
  time: 'r.mtime DESC, r.id DESC',
  /** 按点赞数倒序，并列时新的在前 */
  likes: 'COALESCE(s.likes, 0) DESC, r.mtime DESC, r.id DESC',
  /** 按文件名升序 */
  name: 'r.name ASC',
  /** 按大小倒序 */
  size: 'r.size_bytes DESC',
};

/**
 * 模块作用域 → 展示类目过滤条件。
 *
 * 两个模块（资料与数据 / 社团成员产出）共用 `resources` 一张表，
 * 靠 `display_category` 分流。**必须双向过滤**：
 * 只写「等于产出」会让资料页把作品也算进「全部」，
 * 只写「不等于产出」会让产出页拿到全部资料。
 *
 * @param {string|undefined} module
 * @returns {{ sql: string, param: string | null }}
 */
function moduleScope(module) {
  if (module === 'productions') return { sql: 'r.display_category = ?', param: PRODUCTION_CATEGORY };
  return { sql: 'r.display_category != ?', param: PRODUCTION_CATEGORY };
}

/** 模块 → 该模块下的实体类目顺序（不含「全部」） */
export function categoriesOfModule(module) {
  return MODULES[module]?.categories ?? MODULES.library.categories;
}

/**
 * RFC 5987 / RFC 6266 兼容的 Content-Disposition。
 *
 * 中文文件名必须用 `filename*=UTF-8''<百分号编码>` 形式，否则部分浏览器会
 * 把文件名截断或显示成乱码。同时给出一个 ASCII 回退 `filename=`。
 *
 * @param {string} fileName 原始文件名（可含中文）
 * @param {'inline'|'attachment'} disposition
 */
export function contentDisposition(fileName, disposition = 'attachment') {
  // ASCII 回退：非 ASCII 字符替换为下划线，并把引号/反斜杠转义
  const asciiFallback = fileName
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

/** 把字节数格式化为人类可读 */
function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * 资料服务工厂。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ materialsDir: string }} config
 */
export function createResourceService(db, config) {
  const stmt = {
    list: db.prepare('SELECT r.*, COALESCE(s.likes, 0) AS likes FROM resources r LEFT JOIN resource_stats s ON s.resource_id = r.id'),
    byId: db.prepare(
      'SELECT r.*, COALESCE(s.likes, 0) AS likes FROM resources r LEFT JOIN resource_stats s ON s.resource_id = r.id WHERE r.id = ?'
    ),
    byRelPath: db.prepare('SELECT * FROM resources WHERE rel_path = ?'),
    /** 相对路径 → id，用于把作品截图里的素材路径解析成受控的预览地址 */
    idByRelPath: db.prepare('SELECT id FROM resources WHERE rel_path = ?'),
    stats: db.prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(size_bytes), 0) AS bytes,
         COUNT(DISTINCT category_dir) AS categories
       FROM resources`
    ),
    countByCategory: db.prepare(
      'SELECT category_dir, COUNT(*) AS count, COALESCE(SUM(size_bytes),0) AS bytes FROM resources GROUP BY category_dir ORDER BY category_dir'
    ),
    insertLike: db.prepare(
      'INSERT OR IGNORE INTO resource_likes (resource_id, fingerprint, created_at) VALUES (?, ?, ?)'
    ),
    deleteLike: db.prepare(
      'DELETE FROM resource_likes WHERE resource_id = ? AND fingerprint = ?'
    ),
    hasLike: db.prepare(
      'SELECT 1 AS x FROM resource_likes WHERE resource_id = ? AND fingerprint = ?'
    ),
    countLikes: db.prepare(
      'SELECT COUNT(*) AS n FROM resource_likes WHERE resource_id = ?'
    ),
    ensureStats: db.prepare(
      'INSERT OR IGNORE INTO resource_stats (resource_id, likes) VALUES (?, 0)'
    ),
    setStats: db.prepare(
      'UPDATE resource_stats SET likes = ? WHERE resource_id = ?'
    ),
    /**
     * 重建统计（供扫描脚本与测试调用，保证计数与明细一致）。
     * 注意：SQLite 的 INSERT ... SELECT 走 UPSERT 时，解析器要求
     * SELECT 之后必须有 WHERE 子句消歧，否则 `ON CONFLICT` 会被当成
     * JOIN 的一部分而报 `near "DO": syntax error`。故显式写 WHERE 1。
     */
    rebuildStats: db.prepare(`
      INSERT INTO resource_stats (resource_id, likes)
      SELECT r.id, (SELECT COUNT(*) FROM resource_likes l WHERE l.resource_id = r.id)
      FROM resources r
      WHERE 1
      ON CONFLICT(resource_id) DO UPDATE SET likes = excluded.likes
    `),
  };

  /**
   * 把作品截图条目解析成浏览器可直接加载的地址。
   *
   * 两种形态都支持：
   * - `http(s)://…` 外链 —— 原样返回；
   * - 素材目录内的**相对路径** —— 反查该文件的资源 id，返回受控的
   *   `/api/resources/:id/preview`，从而**复用同一道权限闸门**。
   *
   * 为什么不在元数据里直接写 URL：那样就绕过了 `access_level` 判定，
   * 受限作品的截图会变成任何人都能直接拉取的公开图片。
   *
   * @param {string} raw JSON 数组字符串（库里的 screenshots 列）
   * @returns {Array<{ url: string, caption: string }>}
   */
  function resolveScreenshots(raw) {
    let list;
    try {
      list = JSON.parse(String(raw ?? '[]'));
    } catch {
      return [];
    }
    if (!Array.isArray(list)) return [];

    const out = [];
    for (const item of list) {
      const src = String(item?.src ?? '').trim();
      if (!src) continue;
      const caption = String(item?.caption ?? '');
      if (/^https?:\/\//i.test(src)) {
        out.push({ url: src, caption });
        continue;
      }
      // 相对路径必须先存在于库中 —— 只信数据库里的记录，不接受任意路径
      const hit = plain(stmt.idByRelPath.get(src));
      if (!hit) continue;
      out.push({ url: `/api/resources/${Number(hit.id)}/preview`, caption });
    }
    return out;
  }

  /** 逗号分隔标签 → 数组 */
  function splitTags(raw) {
    return String(raw ?? '')
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  /** 行 → 对外 JSON 视图 */
  function toPublic(row, liked = false) {
    if (!row) return null;
    return {
      id: Number(row.id),
      relPath: String(row.rel_path),
      name: String(row.name),
      fileName: String(row.file_name),
      /** 磁盘目录：面向整理者，保留归档结构 */
      category: String(row.category_dir),
      /** 展示类目：面向读者，见 lib/categorize.js 的归集规则 */
      displayCategory: String(row.display_category ?? ''),
      ext: String(row.ext),
      size: Number(row.size_bytes),
      sizeText: humanSize(row.size_bytes),
      /** 展示为「上传时间」，取自文件系统修改时间 */
      uploadedAt: String(row.mtime),
      kind: String(row.kind),
      accessLevel: String(row.access_level),
      likes: Number(row.likes ?? 0),
      liked: Boolean(liked),
      /** 作品属性（仅「社团成员产出」有值，其余为空） */
      author: String(row.author ?? ''),
      authorTitle: String(row.author_title ?? ''),
      authorNote: String(row.author_note ?? ''),
      summary: String(row.summary ?? ''),
      tags: splitTags(row.tags),
      screenshots: resolveScreenshots(row.screenshots),
      mimeType: MIME_BY_EXT[String(row.ext)] ?? 'application/octet-stream',
      /** 可直接在浏览器内联预览（PDF / 图片 / 文本） */
      previewable: INLINE_EXT.has(String(row.ext)),
      previewUrl: `/api/resources/${Number(row.id)}/preview`,
      downloadUrl: `/api/resources/${Number(row.id)}/download`,
    };
  }

  /** 取某资料的物理绝对路径（列表与下载共用，做统一校验） */
  function absolutePathOf(row) {
    const root = path.resolve(config.materialsDir);
    const abs = path.resolve(root, String(row.rel_path));
    // 双重防线：解析后的路径必须仍在素材根目录内
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    return abs;
  }

  return {
    toPublic,
    absolutePathOf,
    humanSize,

    /**
     * 查询资料清单。
     *
     * ## 非资料目录（logo）的准入规则
     *
     * 默认只返回「资料与数据」模块的条目（`isLibraryItem` 为真），公司 logo 一律排除
     * ——它们不属于可下载资料。但 `category_dir` **显式等于**某个非资料目录时视为
     * 「点名索取」，予以放行。
     *
     * 为什么要有后半句：logo 是**首页「会友去向／合作单位」的渲染素材**，
     * 前端必须能读到它们。早先只按 `includeNonLibrary` 开关放行，而路由层从未
     * 转发该参数，导致 logo 被无条件滤掉、首页两个版块静默 `return null` 一直空白。
     * 点名 `category=logo` 是比全局开关更**窄**的授权面：它只放行被点名的那个目录，
     * 不会像 `includeNonLibrary=true` 那样把所有非资料目录一次性敞开。
     *
     * 注意：「不放行」与「点名叫」是两件事，所以 `excludeNonLibrary` 的优先级高于
     * 点名放行——路由层对普通读者一律走排除路径。
     *
     * @param {{ category?: string, displayCategory?: string, ext?: string, kind?: string,
     *           sort?: string, accessLevel?: string, minAccess?: 'public'|'member',
     *           excludeAccessLevel?: string, includeNonLibrary?: boolean,
     *           excludeNonLibrary?: boolean }} [query]
     */
    list(query = {}) {
      const where = [];
      const params = [];
      // 模块作用域：把「资料与数据」与「社团成员产出」分开。
      // 放在最前面执行，后面的类目/目录过滤都在这道范围内叠加。
      const scope = moduleScope(query.module);
      where.push(scope.sql);
      params.push(scope.param);
      if (query.category) {
        where.push('r.category_dir = ?');
        params.push(query.category);
      }
      // 展示类目过滤：传「全部」等价于不过滤（但仍旧排除非资料条目）
      if (query.displayCategory && query.displayCategory !== ALL_CATEGORY) {
        where.push('r.display_category = ?');
        params.push(query.displayCategory);
      }
      if (query.ext) {
        where.push('r.ext = ?');
        params.push(String(query.ext).toLowerCase().replace(/^\./, ''));
      }
      if (query.kind) {
        where.push('r.kind = ?');
        params.push(query.kind);
      }
      if (query.accessLevel) {
        where.push('r.access_level = ?');
        params.push(query.accessLevel);
      }
      // minAccess = 'member' 时只返回需要会话的条目（前端「受限资料」视图用）
      if (query.minAccess === 'member') {
        where.push("r.access_level = 'member'");
      }
      // 访客视图：排除受限条目。由路由层根据会话裁定，不看客户端参数。
      if (query.excludeAccessLevel) {
        where.push('r.access_level != ?');
        params.push(query.excludeAccessLevel);
      }

      const orderBy = SORTS[query.sort] ?? SORTS.newest;
      const sql = `SELECT r.*, COALESCE(s.likes, 0) AS likes
        FROM resources r
        LEFT JOIN resource_stats s ON s.resource_id = r.id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY ${orderBy}`;
      // 非资料目录（logo 等）在 SQL 之外剔除：目录清单极小且集中在
      // NON_LIBRARY_DIRS 常量里，用 JS 过滤比拼 SQL IN (...) 更不易出错，
      // 也不会因为目录名带引号而破坏语句。
      //
      // 三条放行规则，按优先级：
      // 1. `excludeNonLibrary` —— 强制排除（路由层给普通读者的默认视图）；
      // 2. `includeNonLibrary` —— 全局放行（仅调试用，会敞开所有非资料目录）；
      // 3. `category` 显式点名某个非资料目录 —— 窄放行，首页素材走这条。
      const namedNonLibraryDir = NON_LIBRARY_DIRS.has(String(query.category)) ? query.category : null;
      return plainAll(db.prepare(sql).all(...params)).filter((row) => {
        if (query.excludeNonLibrary === true) return isLibraryItem(row.category_dir);
        if (query.includeNonLibrary === true) return true;
        if (namedNonLibraryDir && String(row.category_dir) === namedNonLibraryDir) return true;
        return isLibraryItem(row.category_dir);
      });
    },

    /**
     * 展示类目统计（供前端渲染分类卡片）。
     * 返回顺序固定为该模块的类目顺序，并在首位插入「全部」。
     * 空类目保留（count 为 0），使前端标签始终齐全、不因数据缺失而抖动。
     *
     * @param {{ excludeAccessLevel?: string, module?: string }} [query]
     */
    categorySummary(query = {}) {
      const params = [];
      const scope = moduleScope(query.module);
      let where = `WHERE ${scope.sql}`;
      params.push(scope.param);
      if (query.excludeAccessLevel) {
        where += ' AND access_level != ?';
        params.push(query.excludeAccessLevel);
      }
      const rows = plainAll(
        db
          .prepare(
            `SELECT display_category, category_dir, COUNT(*) AS count, COALESCE(SUM(size_bytes),0) AS bytes
             FROM resources r ${where}
             GROUP BY display_category, category_dir`
          )
          .all(...params)
      ).filter((r) => isLibraryItem(r.category_dir));

      const byCategory = new Map();
      let totalCount = 0;
      let totalBytes = 0;
      for (const r of rows) {
        const key = String(r.display_category ?? '');
        const prev = byCategory.get(key) ?? { count: 0, bytes: 0 };
        prev.count += Number(r.count);
        prev.bytes += Number(r.bytes);
        byCategory.set(key, prev);
        totalCount += Number(r.count);
        totalBytes += Number(r.bytes);
      }

      return [
        {
          category: ALL_CATEGORY,
          count: totalCount,
          bytes: totalBytes,
          sizeText: humanSize(totalBytes),
          /** 标记为聚合项，前端可据此把「全部」排在标签首位而不当作实体类目 */
          aggregate: true,
        },
        ...categoriesOfModule(query.module).map((name) => {
          const hit = byCategory.get(name) ?? { count: 0, bytes: 0 };
          return {
            category: name,
            count: hit.count,
            bytes: hit.bytes,
            sizeText: humanSize(hit.bytes),
            aggregate: false,
          };
        }),
      ];
    },

    /**
     * 总体统计。excludeAccessLevel 用于访客视图排除受限条目。
     * 与列表口径保持一致：非资料目录（logo）不计入，且只在指定模块内统计。
     */
    summary(query = {}) {
      const params = [];
      const scope = moduleScope(query.module);
      let where = `WHERE ${scope.sql}`;
      params.push(scope.param);
      if (query.excludeAccessLevel) {
        where += ' AND access_level != ?';
        params.push(query.excludeAccessLevel);
      }
      const rows = plainAll(
        db
          .prepare(
            `SELECT category_dir, display_category, size_bytes FROM resources r ${where}`
          )
          .all(...params)
      ).filter((r) => isLibraryItem(r.category_dir));

      const bytes = rows.reduce((sum, r) => sum + Number(r.size_bytes ?? 0), 0);
      // 注意用 display_category 这个真实列名 —— 上面的查询没有走 toPublic 映射，
      // 行里不存在驼峰别名，写 displayCategory 会静默得到 undefined，
      // 类目数就会算成 0（前端卡片会显示「0 个分类」）。
      const categories = new Set(
        rows.map((r) => String(r.display_category ?? '')).filter(Boolean)
      );
      return {
        total: rows.length,
        bytes,
        sizeText: humanSize(bytes),
        /**
         * 这里给的是**展示类目**数量（最多 4），不是磁盘目录数量。
         * 前端卡片写的是「4 个分类」，口径必须与标签栏一致。
         */
        categories: categories.size,
      };
    },

    /** 按 id 取单条（含点赞数与「我是否点过」） */
    getById(id, fingerprint) {
      const row = plain(stmt.byId.get(Number(id)));
      if (!row) return null;
      const liked = fingerprint ? Boolean(plain(stmt.hasLike.get(Number(id), fingerprint))) : false;
      return this.toPublic(row, liked);
    },

    /**
     * 按 id 取**数据库原始行**（不做公开字段映射）。
     *
     * 路由层做准入判定时需要 `access_level` 这个原始字段，
     * 而 `getById` 返回的是 `toPublic` 映射后的对象，不宜用于鉴权判断。
     */
    getRowById(id) {
      return plain(stmt.byId.get(Number(id)));
    },

    /** 该指纹是否已给这条资料点过赞（列表接口逐条判断用） */
    hasLike(id, fingerprint) {
      if (!fingerprint) return false;
      return Boolean(plain(stmt.hasLike.get(Number(id), fingerprint)));
    },

    /** 按相对路径取原始行（脚本与测试使用） */
    getRawByRelPath(relPath) {
      return plain(stmt.byRelPath.get(String(relPath)));
    },

    /**
     * 点赞（幂等）。同一指纹重复点赞不会增加计数。
     * @returns {{ ok: true, likes: number, liked: true, alreadyLiked: boolean } | { ok: false, code: string, message: string }}
     */
    like(id, fingerprint) {
      const resourceId = Number(id);
      if (!plain(stmt.byId.get(resourceId))) {
        return { ok: false, code: 'NOT_FOUND', message: '资料不存在' };
      }
      if (!fingerprint) {
        return { ok: false, code: 'NO_FINGERPRINT', message: '缺少客户端指纹' };
      }

      const before = Boolean(plain(stmt.hasLike.get(resourceId, fingerprint)));
      if (!before) {
        stmt.insertLike.run(resourceId, fingerprint, new Date().toISOString());
      }
      // 统计与明细保持一致（这里直接以明细 COUNT 为准，最不容易漂移）
      const likes = Number(plain(stmt.countLikes.get(resourceId))?.n ?? 0);
      stmt.ensureStats.run(resourceId);
      stmt.setStats.run(likes, resourceId);

      return { ok: true, likes, liked: true, alreadyLiked: before };
    },

    /**
     * 取消点赞（幂等）。
     */
    unlike(id, fingerprint) {
      const resourceId = Number(id);
      if (!plain(stmt.byId.get(resourceId))) {
        return { ok: false, code: 'NOT_FOUND', message: '资料不存在' };
      }
      if (!fingerprint) {
        return { ok: false, code: 'NO_FINGERPRINT', message: '缺少客户端指纹' };
      }
      stmt.deleteLike.run(resourceId, fingerprint);
      const likes = Number(plain(stmt.countLikes.get(resourceId))?.n ?? 0);
      stmt.ensureStats.run(resourceId);
      stmt.setStats.run(likes, resourceId);
      return { ok: true, likes, liked: false };
    },

    /** 重建全部点赞统计（扫描脚本调用） */
    rebuildLikeStats() {
      stmt.rebuildStats.run();
    },

    /**
     * 打开文件流（下载 / 预览共用）。
     * @param {number} id
     * @returns {Promise<{ ok: false, code: string, message: string } | {
     *   ok: true, path: string, size: number, mimeType: string, fileName: string,
     *   inline: boolean, row: object }}>}
     */
    async openFile(id) {
      const row = plain(stmt.byId.get(Number(id)));
      if (!row) return { ok: false, code: 'NOT_FOUND', message: '资料不存在' };

      const abs = absolutePathOf(row);
      if (!abs) return { ok: false, code: 'FORBIDDEN_PATH', message: '路径非法' };

      let stat;
      try {
        stat = await fsp.stat(abs);
      } catch {
        return {
          ok: false,
          code: 'FILE_MISSING',
          message: '磁盘上找不到该文件，请重新运行扫描脚本',
        };
      }
      if (!stat.isFile()) {
        return { ok: false, code: 'NOT_A_FILE', message: '该条目不是文件' };
      }

      const ext = String(row.ext);

      // 对图片与 PDF 做内容嗅探：扩展名可能是错的（素材目录里 `腾讯.png` 实为 JPEG）。
      // 只读前 16 字节，开销可忽略。嗅探失败则回落到扩展名映射。
      let mimeType = MIME_BY_EXT[ext] ?? 'application/octet-stream';
      if (SNIFFABLE_EXT.has(ext)) {
        try {
          const fd = await fsp.open(abs, 'r');
          try {
            const buf = Buffer.alloc(16);
            const { bytesRead } = await fd.read(buf, 0, 16, 0);
            const sniffed = sniffMime(buf.subarray(0, bytesRead));
            if (sniffed) mimeType = sniffed;
          } finally {
            await fd.close();
          }
        } catch {
          // 读取失败就用扩展名兜底，不因为这个细节让整个下载失败
        }
      }

      return {
        ok: true,
        path: abs,
        size: stat.size,
        mimeType,
        fileName: String(row.file_name),
        inline: INLINE_EXT.has(ext),
        row,
      };
    },

    /** 创建可读流（支持起止字节，用于 Range 响应） */
    createStream(absPath, start, end) {
      return start === undefined
        ? createReadStream(absPath)
        : createReadStream(absPath, { start, end });
    },
  };
}

/**
 * 解析 Range 请求头。
 * 支持单区间 `bytes=start-end` / `bytes=start-` / `bytes=-suffix`。
 * 多区间返回 null（退化为整体 200 响应，符合规范允许的实现策略）。
 *
 * @param {string | undefined} header
 * @param {number} size 文件总字节数
 * @returns {{ start: number, end: number } | null}
 */
export function parseRange(header, size) {
  if (!header || !/^bytes=/i.test(header)) return null;
  const spec = header.slice(6).trim();
  if (spec.includes(',')) return null;

  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start;
  let end;
  if (rawStart === '') {
    // 后缀形式：最后 N 字节
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}
