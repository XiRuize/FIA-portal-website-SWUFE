/**
 * 资料模块路由：清单 / 分类 / 点赞 / 下载 / 预览。
 *
 * `restricted=1` 时要求有效会话（临时浏览账号即可，对应「浏览受限内容」的权限）。
 */
import { createReadStream } from 'node:fs';
import { statSync } from 'node:fs';
import { ALL_CATEGORY } from '../lib/categorize.js';

/**
 * @param {object} ctx
 */
export function createResourceRoutes(ctx) {
  const { resources, http } = ctx;

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
