/**
 * 资料模块路由：清单 / 分类 / 点赞 / 下载 / 预览，
 * 以及管理侧的**上传与分类维护**。
 *
 * `restricted=1` 时要求有效会话（临时浏览账号即可，对应「浏览受限内容」的权限）。
 *
 * ---------------------------------------------------------------------------
 * 上传为什么用「原始二进制 + 查询参数」而不是 multipart/form-data
 * ---------------------------------------------------------------------------
 * 后端硬约束是**零第三方运行时依赖**。解析 multipart 要自己处理 boundary 切分、
 * 头部解析、CRLF 折叠，涉及几十行极易出错的字节级代码；而浏览器侧用
 * `fetch(url, { body: file })` 直接发原始流是标准能力，配合查询参数传元数据
 * 完全够用。少一个自定义解析器，就少一处「大文件上传偶发损坏」的来源。
 *
 * 代价是 CORS 预检不需要新增允许头（参数都在 URL 上），也算顺带的好处。
 */
import { createReadStream, promises as fsp } from 'node:fs';
import { statSync } from 'node:fs';
import path from 'node:path';
import { ALL_CATEGORY, ALL_DISPLAY_CATEGORIES, MODULES } from '../lib/categorize.js';
import {
  RESTRICTED_CATEGORIES,
  loadResourceMeta,
  runScan,
  upsertResourceMeta,
} from '../lib/scan.js';

/** 允许的展示类目（白名单来自 categorize.js，不在此处重复列举） */
const VALID_DISPLAY_CATEGORIES = new Set(ALL_DISPLAY_CATEGORIES);

/**
 * 磁盘目录名白名单正则。
 *
 * 允许中文（协会的目录都是中文命名）、字母数字、空格与 `-_`。
 * 刻意**不允许** `.` `/` `\` —— 前者会产生 `.`/`..` 这类特殊目录，
 * 后者是路径分隔符，任何一个都足以造成目录穿越。
 */
const SAFE_DIR_NAME = /^[\u4e00-\u9fa5A-Za-z0-9 _-]{1,40}$/;

/**
 * 净化上传文件名。
 *
 * 三层处理，缺一不可：
 * 1. 只取最后一段路径（`a/b/c.pdf` → `c.pdf`），挡掉相对路径；
 * 2. 剔除 `..`、控制字符与 Windows 保留字符（`<>:"|?*`）——
 *    这些在 Windows 上会让 `createWriteStream` 抛错，错误信息还很难懂；
 * 3. 拒绝纯点开头（隐藏文件），因为扫描器会跳过它们 ——
 *    文件上传成功了却在资料库里找不到，是最难排查的一类「成功失败」。
 *
 * @param {string} raw
 * @returns {string | null} 合法则返回文件名，否则 null
 */
export function sanitizeFileName(raw) {
  let name = String(raw ?? '').trim();
  if (!name) return null;
  // 统一分隔符后只取末段
  name = name.replace(/\\/g, '/').split('/').pop() ?? '';
  // 控制字符 + Windows 保留字符
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '');
  name = name.trim().replace(/\.+$/, '');
  if (!name || name.startsWith('.')) return null;
  if (name.includes('..')) return null;
  // 必须有扩展名：没有扩展名的文件进不了分类器，也拿不到 MIME
  if (!/\.[A-Za-z0-9]{1,10}$/.test(name)) return null;
  // 长度上限：Windows 单段上限 255，留出余量给「重名」后缀
  if (name.length > 180) return null;
  return name;
}

/**
 * 归一化相对于素材根目录的路径，并做**二次**越界校验。
 *
 * 已有 `resources.absolutePathOf()` 做同样的事，但那是针对**库中已有记录**的。
 * 这里的目标路径是**尚未入库**的新上传，必须独立校验一遍 —— 否则
 * 一次 `../../` 就能把文件写到素材目录之外。
 *
 * @param {string} materialsDir
 * @param {string} categoryDir
 * @param {string} fileName
 * @returns {{ ok: true, abs: string, rel: string, dir: string } | { ok: false, code: string, message: string }}
 */
export function resolveUploadTarget(materialsDir, categoryDir, fileName) {
  const dir = String(categoryDir ?? '').trim();
  if (!SAFE_DIR_NAME.test(dir) || dir === '.' || dir === '..') {
    return {
      ok: false,
      code: 'INVALID_DIR',
      message: '分类目录名非法：只允许中文、字母、数字、空格与 - _（1–40 字）',
    };
  }
  const safeName = sanitizeFileName(fileName);
  if (!safeName) {
    return {
      ok: false,
      code: 'INVALID_FILENAME',
      message: '文件名非法：不能含路径分隔符、保留字符，且必须带扩展名',
    };
  }

  const root = path.resolve(materialsDir);
  const abs = path.resolve(root, dir, safeName);
  // 双重防线：解析后必须仍在素材根目录内
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return { ok: false, code: 'FORBIDDEN_PATH', message: '目标路径超出素材目录范围' };
  }
  return { ok: true, abs, rel: `${dir}/${safeName}`, dir };
}

export function createResourceRoutes(ctx) {
  const { resources, http, guards, config } = ctx;

  /** 受限内容的会话校验 */
  function requireSession(req, res) {
    const identity = ctx.identityOf(req);
    if (!identity.authenticated) {
      http.sendError(
        res,
        401,
        'UNAUTHENTICATED',
        '该内容仅对已登录成员（含临时浏览账号）开放',
        ctx.cors
      );
      return null;
    }
    return identity;
  }

  /**
   * 按条目自身的 access_level 做准入判定。
   *
   * 写操作（点赞/取消）与读操作必须共用它，否则会出现
   * 「读不到但能改」的裂缝：受限条目的标题、体积、点赞数会经由写接口的
   * 返回值泄露给未登录访客。
   *
   * @returns {object|null} 放行时返回条目行；被拒时已发送响应并返回 null
   */
  function requireItemAccess(req, res, id) {
    const row = resources.getRowById(id);
    if (!row) {
      http.sendError(res, 404, 'NOT_FOUND', '资料不存在', ctx.cors);
      return null;
    }
    if (row.access_level === 'member' && !requireSession(req, res)) return null;
    return row;
  }

  /**
   * 统一处理「下载 / 预览」的 Range。
   * @param {'inline'|'attachment'} disposition
   */
  async function serveFile(req, res, params, disposition) {
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return http.sendError(res, 400, 'INVALID_ID', '资料 ID 非法', ctx.cors);
    }

    const opened = await resources.openFile(id);
    if (!opened.ok) {
      const status = opened.code === 'NOT_FOUND' ? 404 : 500;
      return http.sendError(res, status, opened.code, opened.message, ctx.cors);
    }

    // 受限资料需要会话
    if (opened.row.access_level === 'member' && !requireSession(req, res)) return;

    const etag = `W/"${id}-${opened.size}-${new Date(String(opened.row.mtime)).getTime()}"`;
    const baseHeaders = {
      'Content-Type': opened.mimeType,
      // 中文文件名必须走 RFC 5987 的 filename* 形式
      'Content-Disposition': ctx.http.contentDisposition(opened.fileName, disposition),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=300',
      ETag: etag,
      ...ctx.cors,
    };

    // 条件请求：内容未变直接 304
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, baseHeaders);
      res.end();
      return;
    }

    const range = ctx.http.parseRange(req.headers.range, opened.size);

    if (!range) {
      res.writeHead(200, {
        ...baseHeaders,
        'Content-Length': String(opened.size),
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(opened.path).pipe(res);
      return;
    }

    const { start, end } = range;
    res.writeHead(206, {
      ...baseHeaders,
      'Content-Range': `bytes ${start}-${end}/${opened.size}`,
      'Content-Length': String(end - start + 1),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(opened.path, { start, end }).pipe(res);
  }

  return {
    /**
     * GET /api/resources?module=&category=&displayCategory=&ext=&kind=&sort=&restricted=
     *
     * `module`          —— `library`（默认，资料与数据）/ `productions`（社团成员产出）
     * `category`        —— 磁盘目录（归档结构，面向整理者）
     * `displayCategory` —— 展示类目（电子书籍/数据/研报/课程资源，面向读者）
     * 公开接口，不含任何文件内容，只回清单元数据。
     */
    list(req, res) {
      const url = new URL(req.url, 'http://localhost');
      const restricted = url.searchParams.get('restricted') === '1';
      const category = url.searchParams.get('category');
      /** 模块作用域：决定本请求是看「资料」还是看「成员作品」，两者互不串台 */
      const module = url.searchParams.get('module') === 'productions' ? 'productions' : 'library';

      // 受限视图必须带有效会话
      if (restricted && !requireSession(req, res)) return;

      const identity = ctx.identityOf(req);
      const canViewRestricted = Boolean(identity.authenticated);

      // 首页「会友去向／合作单位」要读 logo 素材，而 logo 属于非资料目录。
      // 放行面必须**按目录收窄**：只有显式点名 logo 才放行，否则一律排除。
      // 用一个独立的布尔变量表达意图，避免读代码的人以为「没传 includeNonLibrary
      // 就等于排除」是巧合——它是刻意写死的默认值。
      const wantsLogoAssets = category === 'logo';

      const fingerprint = ctx.fingerprintOf(req);
      const rows = resources.list({
        module,
        category,
        displayCategory: url.searchParams.get('displayCategory') || undefined,
        ext: url.searchParams.get('ext') || undefined,
        kind: url.searchParams.get('kind') || undefined,
        sort: url.searchParams.get('sort') || undefined,
        minAccess: restricted ? 'member' : undefined,
        // 关键：可见性必须由服务端裁决，不能听客户的。
        // 未登录访客一律排除 access_level='member' 的条目，
        // 否则只要不传 restricted=1 就能拿到全部受限资料。
        excludeAccessLevel: canViewRestricted ? undefined : 'member',
        // logo 素材点名放行；其余非资料目录（未来若新增）继续排除。
        excludeNonLibrary: !wantsLogoAssets,
      });

      const items = rows.map((row) => resources.toPublic(row, isLiked(ctx, row.id, fingerprint)));

      // 统计与分类同样按「可见性 + 模块」裁剪，避免访客从计数上看出受限内容规模
      const scope = {
        module,
        ...(canViewRestricted ? {} : { excludeAccessLevel: 'member' }),
      };

      return http.sendOk(
        res,
        {
          items,
          total: items.length,
          module,
          sort: url.searchParams.get('sort') || 'newest',
          displayCategory: url.searchParams.get('displayCategory') || ALL_CATEGORY,
          restricted,
          canViewRestricted,
          summary: resources.summary(scope),
          categories: resources.categorySummary(scope),
        },
        200,
        ctx.cors
      );
    },

    /** GET /api/resources/categories?module= */
    categories(req, res) {
      // 与 list 一致：访客只看到公开条目的统计
      const url = new URL(req.url, 'http://localhost');
      const module = url.searchParams.get('module') === 'productions' ? 'productions' : 'library';
      const canViewRestricted = Boolean(ctx.identityOf(req).authenticated);
      const scope = {
        module,
        ...(canViewRestricted ? {} : { excludeAccessLevel: 'member' }),
      };
      return http.sendOk(
        res,
        {
          module,
          categories: resources.categorySummary(scope),
          summary: resources.summary(scope),
          canViewRestricted,
        },
        200,
        ctx.cors
      );
    },

    /** GET /api/resources/:id */
    detail(req, res, params) {
      const id = Number(params.id);
      const fingerprint = ctx.fingerprintOf(req);
      const item = resources.getById(id, fingerprint);
      if (!item) return http.sendError(res, 404, 'NOT_FOUND', '资料不存在', ctx.cors);
      if (item.accessLevel === 'member' && !requireSession(req, res)) return;
      return http.sendOk(res, { item }, 200, ctx.cors);
    },

    /** POST /api/resources/:id/like —— 幂等，同一指纹重复调用不增加计数 */
    like(req, res, params) {
      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return http.sendError(res, 400, 'INVALID_ID', '资料 ID 非法', ctx.cors);
      }
      // 与 detail/preview/download 保持同一道闸门：受限条目对访客既不可读也不可写。
      // 漏掉这一步会让未登录访客直接读到受限条目的名称与点赞数（信息泄露 + 计数被污染）。
      const gate = requireItemAccess(req, res, id);
      if (gate === null) return;
      const fingerprint = ctx.fingerprintOf(req);

      /**
       * 频次闸门（指纹去重之外的**第二道**防线）。
       *
       * 指纹去重只保证「同一人对同一条只计一次」，不限制请求速率：
       * 脚本仍可在一秒内对上万条资料各点一次赞。
       * 点赞对匿名开放，因此这里必须限流。
       *
       * 放在 `requireItemAccess` **之后**：先确认条目存在且有权访问，
       * 再消耗配额 —— 否则一个不存在的 id 也能把配额烧掉，
       * 变成「用错 id 试几次就被限流」这种莫名其妙的体验。
       */
      const limit = ctx.throttles?.like?.hit(fingerprint);
      if (limit && !limit.allowed) {
        return http.sendError(
          res,
          429,
          'TOO_MANY_REQUESTS',
          `操作过于频繁，请 ${limit.retryAfterSec} 秒后再试`,
          ctx.cors
        );
      }

      const result = resources.like(id, fingerprint);
      if (!result.ok) {
        return http.sendError(res, 404, result.code, result.message, ctx.cors);
      }
      return http.sendOk(res, result, 200, ctx.cors);
    },

    /** DELETE /api/resources/:id/like —— 取消点赞，同样幂等 */
    unlike(req, res, params) {
      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return http.sendError(res, 400, 'INVALID_ID', '资料 ID 非法', ctx.cors);
      }
      const gate = requireItemAccess(req, res, id);
      if (gate === null) return;
      const fingerprint = ctx.fingerprintOf(req);

      // 取消点赞也计入同一配额：否则「点赞→取消」可无限循环刷请求
      const limit = ctx.throttles?.like?.hit(fingerprint);
      if (limit && !limit.allowed) {
        return http.sendError(
          res,
          429,
          'TOO_MANY_REQUESTS',
          `操作过于频繁，请 ${limit.retryAfterSec} 秒后再试`,
          ctx.cors
        );
      }

      const result = resources.unlike(id, fingerprint);
      if (!result.ok) {
        return http.sendError(res, 404, result.code, result.message, ctx.cors);
      }
      return http.sendOk(res, result, 200, ctx.cors);
    },

    /** GET|HEAD /api/resources/:id/download —— 强制附件下载 */
    download(req, res, params) {
      return serveFile(req, res, params, 'attachment');
    },

    /** GET|HEAD /api/resources/:id/preview —— 内联预览（PDF / 图片可直接在浏览器打开） */
    preview(req, res, params) {
      return serveFile(req, res, params, 'inline');
    },

    /* ═══════════════════════ 管理侧：上传与分类 ═══════════════════════ */

    /**
     * GET /api/admin/resources/upload-options
     *
     * 上传表单需要的全部候选项，一次给全，避免前端硬编码分类名单
     * （硬编码的那份迟早会与 `categorize.js` 漂移，表现是「选了一个
     * 后端不认的类目，上传后被静默归到别的类目」）。
     */
    async uploadOptions(req, res) {
      const admin = guards.resources(req, res);
      if (!admin) return;

      // 列出素材根目录下已存在的**一级目录**，供管理员选择归档位置
      let directories = [];
      try {
        const entries = await fsp.readdir(path.resolve(config.materialsDir), {
          withFileTypes: true,
        });
        directories = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b, 'zh-CN'));
      } catch {
        directories = [];
      }

      return http.sendOk(
        res,
        {
          directories,
          displayCategories: ALL_DISPLAY_CATEGORIES,
          modules: Object.values(MODULES).map((m) => ({
            id: m.id,
            label: m.label,
            categories: m.categories,
          })),
          accessLevels: [
            { value: 'public', label: '公开（所有访客可见）' },
            { value: 'member', label: '仅成员（需登录，含临时账号）' },
          ],
          maxBytes: config.uploadMaxBytes,
          /** 前端据此给出「单文件上限 xx MB」的提示 */
          maxSizeText: resources.humanSize(config.uploadMaxBytes),
          /** 受限目录：这些目录下的文件默认按 member 处理 */
          restrictedDirs: [...(config.restrictedCategories ?? [])],
        },
        200,
        ctx.cors
      );
    },

    /**
     * POST /api/admin/resources/upload
     * query: fileName, categoryDir, displayCategory, accessLevel, title?, author?,
     *        authorTitle?, authorNote?, summary?, tags?
     * body:  原始二进制文件内容
     *
     * 完整链路：**落盘 → 写覆写表 → 重扫入库 → 回传条目**。
     *
     * 写覆写表这一步不能省：分类器只看文件名推断，管理员勾的类目若只写进
     * 数据库，下一次扫描就会被 `classifyItem()` 覆盖掉，表现为
     * 「昨天选的『数据』今天变成了『研报』」。
     */
    async upload(req, res) {
      const admin = guards.resources(req, res);
      if (!admin) return;

      const url = new URL(req.url, 'http://localhost');
      const q = url.searchParams;

      const target = resolveUploadTarget(
        config.materialsDir,
        q.get('categoryDir'),
        q.get('fileName')
      );
      if (!target.ok) {
        return http.sendError(res, 400, target.code, target.message, ctx.cors);
      }

      const displayCategory = String(q.get('displayCategory') ?? '').trim();
      if (displayCategory && !VALID_DISPLAY_CATEGORIES.has(displayCategory)) {
        return http.sendError(
          res,
          400,
          'INVALID_CATEGORY',
          `展示类目非法，可选：${ALL_DISPLAY_CATEGORIES.join(' / ')}`,
          ctx.cors
        );
      }

      const accessLevel = String(q.get('accessLevel') ?? '').trim();
      if (accessLevel && !['public', 'member'].includes(accessLevel)) {
        return http.sendError(res, 400, 'INVALID_ACCESS_LEVEL', '访问级别只能是 public 或 member', ctx.cors);
      }

      // 重名直接拒绝，不自动改名。
      // 自动改成 `xxx (2).pdf` 会让资料库里出现两个几乎同名的条目，
      // 而管理员并不知道自己刚造了副本 —— 报错让人改名是更诚实的行为。
      try {
        await fsp.access(target.abs);
        return http.sendError(
          res,
          409,
          'FILE_EXISTS',
          `素材目录中已存在「${target.dir}/${path.basename(target.abs)}」，请改名后重传或先删除旧文件`,
          ctx.cors
        );
      } catch {
        /* 不存在 = 可以写 */
      }

      try {
        await fsp.mkdir(path.dirname(target.abs), { recursive: true });
        await http.writeBodyToFile(req, target.abs, config.uploadMaxBytes);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'BODY_TOO_LARGE') {
          return http.sendError(
            res,
            413,
            'FILE_TOO_LARGE',
            `文件超过上限 ${resources.humanSize(config.uploadMaxBytes)}`,
            ctx.cors
          );
        }
        return http.sendError(res, 500, 'WRITE_FAILED', `写入素材目录失败：${message}`, ctx.cors);
      }

      // 写覆写表（分类、访问级别与作品属性）
      const metaPatch = {
        displayCategory,
        accessLevel,
        title: q.get('title') ?? '',
        author: q.get('author') ?? '',
        authorTitle: q.get('authorTitle') ?? '',
        authorNote: q.get('authorNote') ?? '',
        summary: q.get('summary') ?? '',
      };
      const tags = String(q.get('tags') ?? '').trim();
      if (tags) {
        metaPatch.tags = tags
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean);
      }
      // 覆写表路径取自 config（与 materialsDir 成对配置）。
      // 直接用默认值会让测试/第二实例写进生产那张表里，属于静默污染。
      upsertResourceMeta(target.rel, metaPatch, config.resourceMetaPath);

      // 重扫入库。runScan 会重新读覆写表，因此刚才写的内容立即生效。
      let scan = null;
      try {
        scan = runScan(ctx.db, {
          materialsDir: config.materialsDir,
          restrictedCategories: config.restrictedCategories,
          resourceMeta: loadResourceMeta(config.resourceMetaPath),
        });
      } catch (err) {
        return http.sendError(
          res,
          500,
          'SCAN_FAILED',
          `文件已写入，但入库扫描失败：${err instanceof Error ? err.message : String(err)}。请运行「重新扫描」。`,
          ctx.cors
        );
      }

      const row = resources.getRawByRelPath(target.rel);
      if (!row) {
        return http.sendError(
          res,
          500,
          'NOT_REGISTERED',
          '文件已写入，但未在资料库中登记（可能是目录被扫描器排除）。',
          ctx.cors
        );
      }

      return http.sendOk(
        res,
        {
          item: resources.toPublic(row),
          scan: { inserted: scan.inserted, updated: scan.updated, removed: scan.removed },
          /** 供前端做「联动创建内容」时拼接附件地址 */
          downloadUrl: `/api/resources/${Number(row.id)}/download`,
          previewUrl: `/api/resources/${Number(row.id)}/preview`,
        },
        201,
        ctx.cors
      );
    },

    /**
     * PATCH /api/admin/resources/:id
     * body: { displayCategory?, accessLevel?, title?, author?, authorTitle?,
     *         authorNote?, summary?, tags? }
     *
     * 修改已入库条目的分类与属性。同样写覆写表 + 重扫，
     * 保证「改完不会被下次扫描翻回去」。
     */
    async updateMeta(req, res, params) {
      const admin = guards.resources(req, res);
      if (!admin) return;

      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return http.sendError(res, 400, 'INVALID_ID', '资料 ID 非法', ctx.cors);
      }
      const row = resources.getRowById(id);
      if (!row) return http.sendError(res, 404, 'NOT_FOUND', '资料不存在', ctx.cors);

      const body = await http.readJsonBody(req);
      const patch = {};

      if (body?.displayCategory !== undefined) {
        const value = String(body.displayCategory).trim();
        if (!VALID_DISPLAY_CATEGORIES.has(value)) {
          return http.sendError(
            res,
            400,
            'INVALID_CATEGORY',
            `展示类目非法，可选：${ALL_DISPLAY_CATEGORIES.join(' / ')}`,
            ctx.cors
          );
        }
        patch.displayCategory = value;
      }
      if (body?.accessLevel !== undefined) {
        const value = String(body.accessLevel).trim();
        if (!['public', 'member'].includes(value)) {
          return http.sendError(res, 400, 'INVALID_ACCESS_LEVEL', '访问级别只能是 public 或 member', ctx.cors);
        }
        patch.accessLevel = value;
      }
      for (const key of ['title', 'author', 'authorTitle', 'authorNote', 'summary']) {
        if (body?.[key] !== undefined) patch[key] = String(body[key]).trim();
      }
      if (body?.tags !== undefined) {
        patch.tags = String(body.tags)
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean);
      }

      if (!Object.keys(patch).length) {
        return http.sendError(res, 400, 'NOTHING_TO_UPDATE', '没有需要更新的字段', ctx.cors);
      }

      const written = upsertResourceMeta(String(row.rel_path), patch, config.resourceMetaPath);
      if (!written.ok) {
        return http.sendError(res, 500, 'META_WRITE_FAILED', `覆写表写入失败：${written.message}`, ctx.cors);
      }

      try {
        runScan(ctx.db, {
          materialsDir: config.materialsDir,
          restrictedCategories: config.restrictedCategories,
          resourceMeta: loadResourceMeta(config.resourceMetaPath),
        });
      } catch (err) {
        return http.sendError(
          res,
          500,
          'SCAN_FAILED',
          `覆写已保存，但入库扫描失败：${err instanceof Error ? err.message : String(err)}`,
          ctx.cors
        );
      }

      const updated = resources.getById(id, ctx.fingerprintOf(req));
      return http.sendOk(res, { item: updated }, 200, ctx.cors);
    },

    /**
     * POST /api/admin/resources/rescan
     *
     * 手动重扫素材目录。用途：管理员直接往磁盘里放了文件（没走上传接口），
     * 或删了文件想让库同步。平时不需要调用 —— 启动时与每次上传后都会自动扫。
     */
    rescan(req, res) {
      const admin = guards.resources(req, res);
      if (!admin) return;

      try {
        const result = runScan(ctx.db, {
          materialsDir: config.materialsDir,
          restrictedCategories: config.restrictedCategories,
          resourceMeta: loadResourceMeta(config.resourceMetaPath),
        });
        return http.sendOk(
          res,
          {
            inserted: result.inserted,
            updated: result.updated,
            removed: result.removed,
            total: result.total,
          },
          200,
          ctx.cors
        );
      } catch (err) {
        return http.sendError(
          res,
          500,
          'SCAN_FAILED',
          `扫描失败：${err instanceof Error ? err.message : String(err)}`,
          ctx.cors
        );
      }
    },
  };

  /** 判断该资料是否已被当前指纹点过赞 */
  function isLiked(context, resourceId, fingerprint) {
    if (!fingerprint) return false;
    try {
      return context.resources.hasLike(Number(resourceId), fingerprint);
    } catch {
      return false;
    }
  }
}

/** 供外部复用的静态检查：确保素材目录存在（启动时提示用） */
export function materialsDirExists(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
