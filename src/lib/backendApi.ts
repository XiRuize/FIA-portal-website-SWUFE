/**
 * 自建后端的接口客户端。
 *
 * 与 `contentApi.ts` 的分工：
 * - `contentApi.ts` 管**内容**（文章、时间线、组织架构、站点配置）；
 * - 本文件管**身份与受保护资源**（登录态、账号、资料库、财经时事、行情）。
 *
 * 设计要点：
 * 1. **同源优先**：默认走相对路径 `/api/*`，由 Vite 的 proxy 或生产环境的
 *    Nginx 转发到后端。这样浏览器看到的是同源请求，Cookie 能正常携带，
 *    也不会踩到 HTTPS 页面请求 HTTP 后端的**混合内容（Mixed Content）**限制。
 * 2. **Cookie 鉴权**：会话放在 httpOnly Cookie 里，JS 读不到——这是刻意的，
 *    避免 XSS 直接窃取会话。因此所有请求都要带 `credentials: 'include'`。
 * 3. **不静默降级**：后端不可达时如实抛出错误，绝不用本地假数据顶替，
 *    否则「接入真实数据源」这条需求会在无声无息中失效。
 */

/** 后端基地址。默认同源（走代理），可用 VITE_API_BASE 覆盖。 */
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';

/** 统一响应包 */
interface OkEnvelope<T> {
  ok: true;
  data: T;
}
interface ErrEnvelope {
  ok: false;
  error: { code: string; message: string };
}

/** 业务错误：带上后端返回的错误码，方便上层分支处理 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
  /** 会话无效或已过期 */
  get isUnauthenticated() {
    return this.status === 401;
  }
  /** 已登录但权限不足 */
  get isForbidden() {
    return this.status === 403;
  }
}

/** 请求选项 */
export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  /** 查询参数，`undefined` / `null` 的项会被丢弃 */
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** 超时（毫秒），默认 12 秒。行情与新闻抓取可能稍慢，可按需放宽 */
  timeoutMs?: number;
  /** 外部取消信号 */
  signal?: AbortSignal;
}

/** 把查询参数拼成 query string */
function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${API_BASE}${path}`;
  if (!query) return url;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * 核心请求函数。
 * 所有接口调用都收口到这里，便于统一处理超时、错误码与鉴权。
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', query, body, timeoutMs = 12_000, signal } = options;

  // 自建超时控制：AbortSignal.timeout 在 Safari 上支持较晚，这里手动实现
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('TIMEOUT')), timeoutMs);
  const onOuterAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  try {
    const res = await fetch(buildUrl(path, query), {
      method,
      credentials: 'include', // 关键：带上 httpOnly 会话 Cookie
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    let parsed: OkEnvelope<T> | ErrEnvelope | null = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as OkEnvelope<T> | ErrEnvelope;
      } catch {
        // 非 JSON 响应（例如 Nginx 返回的 HTML 错误页）
        throw new ApiError(
          res.status,
          'NON_JSON_RESPONSE',
          `服务端返回了非 JSON 内容（HTTP ${res.status}）：${text.slice(0, 120)}`
        );
      }
    }

    if (!res.ok || (parsed && 'ok' in parsed && parsed.ok === false)) {
      const err = parsed && 'error' in parsed ? parsed.error : null;
      throw new ApiError(
        res.status,
        err?.code ?? 'HTTP_ERROR',
        err?.message ?? `请求失败（HTTP ${res.status}）`
      );
    }

    return (parsed as OkEnvelope<T>).data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ApiError(0, 'TIMEOUT', `请求超时（${timeoutMs}ms）`);
    }
    // 网络层失败：后端没起来、被代理拦截、跨域被拒等
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      `无法连接后端服务（${API_BASE || '同源'}）。请确认后端已启动：cd server && npm start`
    );
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

// ---------------------------------------------------------------------------
// 身份与权限
// ---------------------------------------------------------------------------

/** 角色 */
export type Role = 'admin' | 'viewer';

/** 能力标识 —— 前端路由守卫据此判断能否进入某页面 */
export type Capability =
  | 'canViewRestricted'
  | 'canManageContent'
  | 'canManageAccounts'
  | 'canViewProductions'
  | string;

/** 账号公开信息（后端保证不含口令哈希） */
export interface Account {
  id: number;
  username: string;
  role: Role;
  displayName: string;
  note: string;
  expiresAt: string | null;
  revokedAt: string | null;
  /** 临时账号是否已过期 */
  expired: boolean;
  /** 是否仍可用（未吊销且未过期） */
  active: boolean;
  /**
   * 距到期的剩余秒数。
   * `null` = 长期有效（管理账号），`0` = 已过期。
   * 后台的倒计时用这个字段，不用 `expiresAt` 自己算 ——
   * 本机时钟可能不准，而服务端时间才是判据。
   */
  remainingSec: number | null;
  capabilities: Capability[];
  createdAt: string;
  /** 账号来源：seed（种子）/ manual（后台新建）/ application（申请批准） */
  source?: AccountSource;
  /** 申请批准时留存的手机号（也是账号名），便于后台联系 */
  phone?: string;
  /** 累计延长次数（轻量审计痕迹） */
  extendedCount?: number;
  /** 累计重置次数 */
  resetCount?: number;
  lastLoginAt?: string | null;
  passwordChangedAt?: string | null;
  /** 角色中文名，如「临时浏览权限账号」 */
  roleLabel?: string;
}

/** 账号来源 */
export type AccountSource = 'seed' | 'manual' | 'application';

/** 当前身份 */
export interface Identity {
  authenticated: boolean;
  role: Role | 'guest';
  account: Account | null;
  capabilities: Capability[];
  expiresAt: string | null;
  /** 距过期剩余秒数（临时账号用） */
  expiresInSec: number | null;
}

export const authApi = {
  /** 登录。成功后会由浏览器保存 httpOnly Cookie */
  login: (username: string, password: string) =>
    request<{ account: Account; expiresAt: string; sessionTtlHours: number }>(
      '/api/auth/login',
      { method: 'POST', body: { username, password } }
    ),

  logout: () => request<{ loggedOut: boolean }>('/api/auth/logout', { method: 'POST' }),

  /** 取当前身份。未登录时返回 `authenticated: false`，不会抛错 */
  me: () => request<Identity>('/api/auth/me', { timeoutMs: 8000 }),

  /** 轻量权限探测，供路由守卫用 */
  guard: (capability?: Capability) =>
    request<{ allowed: boolean; authenticated: boolean; role: Role | 'guest'; capabilities: Capability[] }>(
      '/api/auth/guard',
      { query: capability ? { capability } : undefined, timeoutMs: 8000 }
    ),

  changePassword: (oldPassword: string, newPassword: string) =>
    request<{ changed: boolean }>('/api/auth/password', {
      method: 'POST',
      body: { oldPassword, newPassword },
    }),
};

// ---------------------------------------------------------------------------
// 账号管理（仅管理权限）
// ---------------------------------------------------------------------------

export interface CreateAccountInput {
  username: string;
  password: string;
  role: Role;
  displayName?: string;
  note?: string;
  /** 临时账号的到期时间；不传则用后端默认值 */
  expiresAt?: string;
}

export const accountsApi = {
  list: (role?: Role) =>
    request<{ accounts: Account[]; total: number; defaultViewerDays?: number }>(
      '/api/admin/accounts',
      { query: { role } }
    ),

  create: (input: CreateAccountInput) =>
    request<{ account: Account }>('/api/admin/accounts', { method: 'POST', body: input }),

  revoke: (id: number) =>
    request<{ revoked: boolean; account: Account }>(`/api/admin/accounts/${id}`, {
      method: 'DELETE',
    }),

  /**
   * 一键延长权限。
   *
   * 语义是**续期**：后端从 `max(现在, 原到期时间)` 往后加天数。
   * 对已过期的账号同样有效（从当前时刻重新起算），这正是过期后最需要的操作。
   */
  extend: (id: number, days?: number) =>
    request<{ account: Account; extendedDays: number }>(`/api/admin/accounts/${id}/extend`, {
      method: 'POST',
      body: { days },
    }),

  /**
   * 一键重置权限。
   *
   * 不传 `password` 时后端生成 6 位数字口令；明文**只在响应里出现一次**。
   * ⚠️ 重置会清空该账号的全部会话（拿到旧 Cookie 的人立刻失效）。
   */
  reset: (id: number, password?: string) =>
    request<{ account: Account; issuedPassword: string; generated: boolean; revokedSessions: number }>(
      `/api/admin/accounts/${id}/reset`,
      { method: 'POST', body: password ? { password } : {} }
    ),
};

// ---------------------------------------------------------------------------
// 资料与数据
// ---------------------------------------------------------------------------

/** 后端登记的资料条目 */
export interface ResourceItem {
  id: number;
  relPath: string;
  name: string;
  fileName: string;
  /** 磁盘目录（归档结构，面向整理者）。不要用它做展示标签 */
  category: string;
  /**
   * 展示类目：电子书籍 / 数据 / 研报 / 课程资源 / 社团成员产出。
   *
   * 与 `category` 解耦 —— 一个文件存在哪个文件夹，和读者该在哪个标签下
   * 找它，是两件事。列表与标签筛选一律用这个字段。
   */
  displayCategory: string;
  ext: string;
  /** 字节数 */
  size: number;
  /** 人类可读体积，如 "4.0 MB" */
  sizeText: string;
  /** 入库/修改时间（ISO），前端按时间排序的依据 */
  uploadedAt: string;
  kind: string;
  accessLevel: 'public' | 'member';
  /** 服务端嗅探后的真实 MIME（可纠正扩展名误标） */
  mimeType?: string;
  /** 是否可浏览器内联预览 */
  previewable?: boolean;
  previewUrl?: string;
  downloadUrl?: string;
  likes: number;
  /** 本人是否已点赞 */
  liked: boolean;

  // —— 作品属性（仅「社团成员产出」有值，资料条目为空）——
  /** 作者 / 作者团队署名 */
  author: string;
  /** 作者身份（部门、年级、指导教师等） */
  authorTitle: string;
  /** 作者简介 */
  authorNote: string;
  /** 作品简介 */
  summary: string;
  /** 标签 */
  tags: string[];
  /** 作品截图 / 报表预览（已由后端解析为受控的预览地址） */
  screenshots: Array<{ url: string; caption: string }>;
  /**
   * 部门（研发部 / 培训部 / 宣传中心）—— 「社团成员产出」页面顶部的
   * **纵向筛选**维度，与 `displayCategory` 正交。
   *
   * `displayCategory` 决定这条记录属于「资料与数据」还是「社团成员产出」
   * （模块隔离的依据）；`department` 只在产出模块内部再切一刀。
   * 空串 = 未标部门，这类作品在「全部」下可见，但不进任何具体部门标签。
   */
  department: string;
}

/**
 * 「社团成员产出」的展示类目名。
 * 与后端 `lib/categorize.js` 的 PRODUCTION_CATEGORY 必须一致。
 */
export const PRODUCTION_DISPLAY_CATEGORY = '社团成员产出';

/**
 * 展示模块。
 * - `library`：资料与数据（外部资料：研报 / 教材 / 数据 / 课程）
 * - `productions`：社团成员产出（自产作品）
 *
 * 两者共用一张 `resources` 表，由后端按 `display_category` 分流；
 * 前端只传模块名，不自行拼类目，避免两端规则漂移。
 */
export type ResourceModule = 'library' | 'productions';

/** 分类统计（后端用 `category` 作为名称字段） */
export interface ResourceCategory {
  category: string;
  count: number;
  bytes?: number;
  sizeText?: string;
  restricted?: boolean;
  /** true 表示这是「全部」聚合项，不是实体类目 */
  aggregate?: boolean;
}

export interface ResourceListResult {
  items: ResourceItem[];
  total: number;
  sort?: ResourceSort;
  /** 本次请求生效的展示模块 */
  module?: ResourceModule;
  /** 本次请求生效的展示类目 */
  displayCategory?: string;
  /** 本次请求生效的部门筛选；未传即「全部」。仅产出模块有意义 */
  department?: string;
  /** 当前会话是否具备查看受限资料的权限 */
  canViewRestricted?: boolean;
  /** 被过滤掉的受限条目数（匿名访客时 > 0） */
  restricted?: number;
  summary?: { total: number; bytes: number; sizeText: string; categories?: number };
  /** 当前会话能看到的分类（受限分类对匿名访客不出现） */
  categories: ResourceCategory[];
  /**
   * 部门清单（含各自份数）。**只有产出模块会返回**，资料模块是 `undefined`。
   *
   * 不含「全部」聚合项 —— 它的份数由 `total` 提供，单一来源，
   * 避免出现「标签写 12、列表渲染 11」这种对不上的情况。
   */
  departments?: ResourceDepartment[];
}

/**
 * 「社团成员产出」的部门筛选维度。
 *
 * 与展示类目是两回事：展示类目决定记录属于哪个**模块**（资料 / 产出），
 * 部门只在产出模块内部再切一刀。顺序由后端 `PRODUCTION_DEPARTMENTS` 给定，
 * 前端不自行排序，两端保持一致。
 */
export interface ResourceDepartment {
  department: string;
  count: number;
}

/** 排序方式 */
export type ResourceSort = 'time' | 'likes';

/**
 * 「资料与数据」的展示类目，顺序即前端标签顺序。
 * 与后端 `lib/categorize.js` 的 CATEGORY_ORDER 保持一致。
 */
export const RESOURCE_DISPLAY_CATEGORIES = ['全部', '电子书籍', '数据', '研报', '课程资源'] as const;
export type ResourceDisplayCategory = (typeof RESOURCE_DISPLAY_CATEGORIES)[number];
/** 「全部」标签：聚合项，不代表某个实体类目 */
export const ALL_DISPLAY_CATEGORY: ResourceDisplayCategory = '全部';

export const resourcesApi = {
  list: (params: {
    /** 展示模块；省略等同 `library`（资料与数据） */
    module?: ResourceModule;
    /** 磁盘目录过滤（一般不用，展示一律走 displayCategory） */
    category?: string;
    /** 展示类目过滤；传「全部」或省略即不按类目过滤 */
    displayCategory?: string;
    /**
     * 部门过滤（「社团成员产出」页面的纵向维度）。
     * 传「全部」或省略即不按部门过滤 —— 未标部门的作品只在这些情况下出现。
     */
    department?: string;
    sort?: ResourceSort;
    /** 只返回需要登录的资料（受限视图） */
    restricted?: boolean;
    page?: number;
    pageSize?: number;
    keyword?: string;
  }) =>
    request<ResourceListResult>('/api/resources', {
      query: {
        module: params.module,
        category: params.category,
        displayCategory: params.displayCategory,
        department: params.department,
        sort: params.sort,
        restricted: params.restricted ? 1 : undefined,
        page: params.page,
        pageSize: params.pageSize,
        keyword: params.keyword,
      },
    }),

  categories: (module?: ResourceModule) =>
    request<{
      module?: ResourceModule;
      categories: ResourceCategory[];
      summary?: ResourceListResult['summary'];
      canViewRestricted?: boolean;
    }>('/api/resources/categories', { query: { module } }),

  /**
   * 单条明细。
   *
   * ⚠️ 后端这一支返回的是 `{ item }`，而 `request()` 已经把最外层 `data` 剥掉了，
   * 所以这里必须再解一层 —— 早先直接标成 `ResourceItem`，导致 `item.tags` /
   * `item.screenshots` 全是 `undefined`，详情页一读 `.length` 就整页崩溃。
   */
  detail: (id: number) =>
    request<{ item: ResourceItem }>(`/api/resources/${id}`).then((res) => res.item),

  like: (id: number) =>
    request<{ likes: number; liked: boolean; alreadyLiked?: boolean }>(
      `/api/resources/${id}/like`,
      { method: 'POST' }
    ),

  unlike: (id: number) =>
    request<{ likes: number; liked: boolean }>(`/api/resources/${id}/like`, {
      method: 'DELETE',
    }),

  /** 直接可用的预览地址（浏览器内联打开） */
  previewUrl: (id: number) => `${API_BASE}/api/resources/${id}/preview`,
  /** 直接可用的下载地址 */
  downloadUrl: (id: number) => `${API_BASE}/api/resources/${id}/download`,
};

// ---------------------------------------------------------------------------
// 财经时事
// ---------------------------------------------------------------------------

export interface NewsItem {
  id: number;
  title: string;
  url: string;
  source: string;
  /** 发布时间（ISO）。展示时取时分即可 */
  publishedAt: string;
  likes: number;
  liked: boolean;
}

/** 每日时事的响应包 */
export interface NewsDailyResult {
  items: NewsItem[];
  /** 该批数据归属的日期 YYYY-MM-DD */
  date: string;
  /** 请求的日期 */
  requestedDate?: string;
  total: number;
  /** 是否返回了过期缓存（当日抓取失败时的降级） */
  stale?: boolean;
  fromCache?: boolean;
  /** 降级说明 */
  message?: string;
  /** 归档中可切换的全部日期（倒序，含条数）。不受 ?date= 影响 */
  dates?: NewsArchiveDate[];
  /** 归档保留天数 */
  keepDays?: number;
}

/** 归档中的某一天 */
export interface NewsArchiveDate {
  date: string;
  count: number;
}

export const newsApi = {
  /**
   * 取每日财经时事。
   * @param limit 条数上限
   * @param date  指定日期（YYYY-MM-DD）；省略则取当日并在必要时抓取。
   *              历史日期只读归档，不会触发抓取。
   */
  daily: (limit = 10, date?: string) =>
    request<NewsDailyResult>('/api/news/daily', {
      query: { limit, date },
      timeoutMs: 20_000,
    }),

  /** 归档中可切换的日期列表 */
  dates: () =>
    request<{ dates: NewsArchiveDate[]; keepDays: number }>('/api/news/dates'),

  status: () =>
    request<{
      sources: Array<{ id: string; label: string; hasDirectUrl: boolean; urlNote: string | null }>;
      states: Array<Record<string, unknown>>;
      lastError: string | null;
      refreshIntervalMs: number;
    }>('/api/news/status'),

  like: (id: number) =>
    request<{ likes: number; liked: boolean }>(`/api/news/${id}/like`, { method: 'POST' }),

  unlike: (id: number) =>
    request<{ likes: number; liked: boolean }>(`/api/news/${id}/like`, { method: 'DELETE' }),
};

// ---------------------------------------------------------------------------
// 行情
// ---------------------------------------------------------------------------

/** 行情快照 */
export interface Quote {
  code: string;
  name: string;
  price: number;
  /** 涨跌额 */
  change: number;
  /** 涨跌幅（%）。后端字段名为 `changePct` */
  changePct: number;
  open: number;
  high: number;
  low: number;
  /** 昨收 */
  prevClose: number;
  volume: number;
  /** 成交量单位（如「手」） */
  volumeUnit?: string;
  /** 成交额 */
  amount?: number;
  /** 数据归属交易日 YYYY-MM-DD */
  date: string;
  /** 实际数据来源：free-stockdb / tencent 等 */
  source: string;
  /** 是否发生了数据源回退 */
  fallbackUsed?: boolean;
  fallbackReason?: string;
}

/** 单个标的在批量查询中的结果 */
export interface QuoteEntry {
  code: string;
  ok: boolean;
  name?: string;
  price?: number;
  prevClose?: number;
  change?: number;
  changePct?: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  date?: string;
  source?: string;
  fallbackUsed?: boolean;
  error?: string;
}

/** 数据源可用状态。后端用 id 而非 name */
export interface StockStatus {
  primary: { id: string; base?: string; available: boolean; error?: string };
  fallback: { id: string; available: boolean; note?: string };
  activeSource: string;
  checkedAt?: string;
}

/** K 线单点 */
export interface Kline {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  amount?: number;
}

export const stockApi = {
  /** 单只标的实时快照。`/api/stock/quote` 直接把报价平铺在 data 上 */
  quote: (code: string) =>
    request<Quote>('/api/stock/quote', {
      query: { code },
      timeoutMs: 15_000,
    }),

  /** 批量快照。返回体为 { quotes, total, okCount } */
  multi: (codes: string[]) =>
    request<{ quotes: QuoteEntry[]; total: number; okCount: number }>('/api/stock/multi', {
      query: { codes: codes.join(',') },
      timeoutMs: 20_000,
    }),

  kline: (code: string, limit = 120, date?: string) =>
    request<{
      code: string;
      name?: string;
      klines: Kline[];
      count: number;
      source: string;
      fallbackUsed?: boolean;
      fallbackReason?: string;
    }>('/api/stock/kline', {
      query: { code, limit, date },
      timeoutMs: 15_000,
    }),

  status: () => request<StockStatus>('/api/stock/status', { timeoutMs: 10_000 }),
};

// ---------------------------------------------------------------------------
// 站点设置（公开部分，不含口令）
// ---------------------------------------------------------------------------

export const settingsApi = {
  list: () =>
    request<{
      settings: Array<{ key: string; value: string; description: string; secret: boolean }>;
      filteredSecretCount: number;
      total: number;
    }>('/api/settings'),
};

// ---------------------------------------------------------------------------
// 临时权限申请（公开接口）
// ---------------------------------------------------------------------------

/** 申请公开视图。⚠️ 后端只回**打码**手机号，明文绝不下发 */
export interface AccessRequestPublic {
  id: number;
  phoneMasked: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

export const accessRequestApi = {
  /**
   * 提交临时权限申请。
   *
   * 公开接口，后端按指纹（3 次/小时）+ 全局（30 次/小时）两道限流。
   * 同一手机号已有待审申请时不会重复建单，返回 `duplicate: true` ——
   * 这不是错误，申请人反复点提交是常见行为。
   */
  submit: (input: { phone: string; name?: string; org?: string; reason?: string }) =>
    request<{ request: AccessRequestPublic; duplicate: boolean; message: string }>(
      '/api/access-requests',
      { method: 'POST', body: input }
    ),
};

// ---------------------------------------------------------------------------
// 站点浏览量上报（公开接口）
// ---------------------------------------------------------------------------

export const statsApi = {
  /**
   * 上报一次页面访问。
   *
   * 这是「尽力而为」的调用：后端返回 204 无响应体，前端**不应该**因为有返回值
   * 就去做后续处理，更不该让它的失败影响浏览体验 —— 调用方请吞掉异常。
   *
   * @param path 前端路由路径，如 `/news`。后端会归一化
   *             （去掉 hash、查询串与末尾斜杠），所以传 `#/news` 也行。
   */
  pageView: (path: string) =>
    request<null>('/api/stats/pageview', { method: 'POST', body: { path }, timeoutMs: 6000 }),
};

// ---------------------------------------------------------------------------
// 后台 · 数据面板
// ---------------------------------------------------------------------------

/** 逐日访问量 */
export interface DailyViewPoint {
  day: string;
  views: number;
  visitors: number;
}

/** 单条路径的访问统计 */
export interface PathViewStat {
  path: string;
  views: number;
  visitors: number;
}

/**
 * 浏览量口径。
 *
 * ⚠️ `totalViews` 与 `uniqueVisitors` 是**两个独立口径，不能互相推算**：
 * - 浏览量 = 「人 × 页面 × 天」的组合数，反映内容热度；
 * - 独立访客 = 按浏览器指纹跨天去重的人数。
 *
 * 同理 `last7dVisitors` **不等于** `daily` 里各天 visitors 之和 ——
 * 同一个人连着来 5 天会被计 5 次。后端单独做了跨天 DISTINCT。
 */
export interface ViewsOverview {
  totalViews: number;
  uniqueVisitors: number;
  pathCount: number;
  todayViews: number;
  todayVisitors: number;
  last7dViews: number;
  last7dVisitors: number;
  /** 数据起始日；null = 还没有任何记录 */
  since: string | null;
  daily: DailyViewPoint[];
  topPaths: PathViewStat[];
}

/** 申请队列计数 */
export interface RequestSummary {
  pending: number;
  approved: number;
  rejected: number;
  total: number;
}

/** 通知发件箱计数 */
export interface NotificationSummary {
  pending: number;
  sent: number;
  failed: number;
  total: number;
}

/** 数据面板的完整响应 */
export interface AdminStats {
  views: ViewsOverview;
  accounts: {
    viewers: Account[];
    /** 仍可用的访客账号 */
    activeViewers: Account[];
    /** 已过期但未吊销 —— 面板要红字提示并可一键延长 */
    expiredViewers: Account[];
    admins: Account[];
  };
  requests: RequestSummary;
  notifications: NotificationSummary;
  /** 服务端当前时间，前端据此校正倒计时（本机时钟可能不准） */
  serverTime: string;
}

export const adminStatsApi = {
  /**
   * 「数据」面板的唯一数据源。
   *
   * 后端刻意一次返回全部（浏览量 + 账号 + 计数），而不是拆成多个端点：
   * 拆开会让首屏产生多个并发请求，且各块数字来自不同时刻，
   * 站长大致会对不上数（例如「账号数」在两张卡片里不一样）。
   */
  get: () => request<AdminStats>('/api/admin/stats'),
};

// ---------------------------------------------------------------------------
// 后台 · 临时权限申请队列与通知发件箱
// ---------------------------------------------------------------------------

/** 后台看到的申请（含明文手机号 —— 它就是账号名，管理员需要它才能联系到人） */
export interface AccessRequestAdmin {
  id: number;
  phone: string;
  phoneMasked: string;
  name: string;
  org: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  handledAt: string | null;
  handledBy: string | null;
  accountId: number | null;
  handleNote: string;
}

/** 通知发件箱条目 */
export interface NotificationItem {
  id: number;
  channel: string;
  to: string;
  toMasked: string;
  subject: string;
  body: string;
  status: 'pending' | 'sent' | 'failed';
  refType: string;
  refId: number | null;
  createdAt: string;
  sentAt: string | null;
  error: string;
}

export const adminAccessApi = {
  listRequests: (status?: 'pending' | 'approved' | 'rejected') =>
    request<{ requests: AccessRequestAdmin[]; summary: RequestSummary; defaultDays: number }>(
      '/api/admin/access-requests',
      { query: { status } }
    ),

  /**
   * 批准申请 → 以手机号为账号名建号 + 生成 6 位口令 + 写通知。
   *
   * `issuedPassword` **只在这个响应里出现一次**（库中只有 scrypt 哈希），
   * 界面必须立刻展示给管理员，否则只能重置一次口令才能拿到新的。
   *
   * `reused: true` 表示该手机号已有账号，后端走的是「续期」路径
   * （重置口令 + 延长有效期），而不是新建 —— 这是**正常情况**而非错误。
   */
  approve: (id: number, input?: { days?: number; displayName?: string; note?: string }) =>
    request<{
      request: AccessRequestAdmin;
      account: Account;
      issuedPassword: string;
      reused: boolean;
      notification: NotificationItem;
      notice: string;
    }>(`/api/admin/access-requests/${id}/approve`, { method: 'POST', body: input ?? {} }),

  reject: (id: number, note?: string) =>
    request<{ request: AccessRequestAdmin }>(`/api/admin/access-requests/${id}/reject`, {
      method: 'POST',
      body: { note },
    }),

  listNotifications: (status?: 'pending' | 'sent' | 'failed') =>
    request<{ notifications: NotificationItem[]; summary: NotificationSummary }>(
      '/api/admin/notifications',
      { query: { status } }
    ),

  /** 管理员手工转发后回填状态。站点未接短信网关，投递靠人肉完成 */
  markNotificationSent: (id: number) =>
    request<{ notification: NotificationItem }>(`/api/admin/notifications/${id}/sent`, {
      method: 'POST',
      body: {},
    }),
};

// ---------------------------------------------------------------------------
// 后台 · 内容上传与管理
// ---------------------------------------------------------------------------

/** 上传表单的候选项（全部由后端给出，前端不硬编码分类名单） */
export interface UploadOptions {
  /** 素材根目录下已存在的一级目录，供选择归档位置 */
  directories: string[];
  /** 展示类目白名单（电子书籍 / 数据 / 研报 / 课程资源 / 社团成员产出） */
  displayCategories: string[];
  modules: Array<{ id: ResourceModule; label: string; categories: string[] }>;
  accessLevels: Array<{ value: 'public' | 'member'; label: string }>;
  maxBytes: number;
  maxSizeText: string;
  /** 受限目录：这些目录下的文件默认按 member 处理 */
  restrictedDirs: string[];
}

/** 上传时可一并写入的元数据（勾选分类 + 作品/资讯属性） */
export interface UploadMetaPatch {
  displayCategory?: string;
  accessLevel?: 'public' | 'member';
  title?: string;
  author?: string;
  authorTitle?: string;
  authorNote?: string;
  summary?: string;
  tags?: string[];
}

export interface UploadResult {
  item: ResourceItem;
  scan: { inserted: number; updated: number; removed: number };
  downloadUrl: string;
  previewUrl: string;
}

export const adminResourcesApi = {
  uploadOptions: () => request<UploadOptions>('/api/admin/resources/upload-options'),

  /**
   * 上传文件。
   *
   * ## 为什么不是 multipart
   *
   * 后端是零第三方依赖的 Node 服务，解析 multipart 要手写 boundary 切分与
   * 头部解析（几十行极易出错的字节级代码）。而浏览器直接发原始流是标准能力
   * （`fetch(url, { body: file })`），配合查询参数传元数据完全够用。
   *
   * 元数据走 query 而不是自定义请求头，是因为**这样连 CORS 预检都不用改**。
   *
   * @param file     浏览器 File 对象
   * @param progress 上传进度回调（0–100）
   */
  upload: async (
    file: File,
    params: {
      categoryDir: string;
      meta?: UploadMetaPatch;
    },
    progress?: (percent: number) => void
  ): Promise<UploadResult> => {
    const { categoryDir, meta = {} } = params;
    const query = new URLSearchParams();
    query.set('categoryDir', categoryDir);
    query.set('fileName', file.name);
    if (meta.displayCategory) query.set('displayCategory', meta.displayCategory);
    if (meta.accessLevel) query.set('accessLevel', meta.accessLevel);
    if (meta.title) query.set('title', meta.title);
    if (meta.author) query.set('author', meta.author);
    if (meta.authorTitle) query.set('authorTitle', meta.authorTitle);
    if (meta.authorNote) query.set('authorNote', meta.authorNote);
    if (meta.summary) query.set('summary', meta.summary);
    if (meta.tags?.length) query.set('tags', meta.tags.join(','));

    /**
     * 上传不用 `XMLHttpRequest` 就拿不到进度，但用 XHR 就要把
     * Cookie / 错误码解析再实现一遍。折中：**没有 progress 回调时用 fetch**
     * （最常见路径，代码走 `request()` 的同一套错误处理），
     * 需要进度时才退到 XHR。
     */
    if (!progress) {
      const res = await fetch(buildUrl('/api/admin/resources/upload', Object.fromEntries(query)), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      return parseUploadResponse(res);
    }

    return new Promise<UploadResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', buildUrl('/api/admin/resources/upload', Object.fromEntries(query)), true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) {
          progress(Math.round((e.loaded / e.total) * 100));
        }
      };
      xhr.onerror = () =>
        reject(new ApiError(0, 'NETWORK_ERROR', '上传失败：无法连接后端服务'));
      xhr.onabort = () => reject(new ApiError(0, 'ABORTED', '上传已取消'));
      xhr.onload = () => {
        let parsed: OkEnvelope<UploadResult> | ErrEnvelope | null = null;
        try {
          parsed = JSON.parse(xhr.responseText) as OkEnvelope<UploadResult> | ErrEnvelope;
        } catch {
          reject(
            new ApiError(
              xhr.status,
              'NON_JSON_RESPONSE',
              `服务端返回了非 JSON 内容（HTTP ${xhr.status}）`
            )
          );
          return;
        }
        if (xhr.status >= 400 || (parsed && 'ok' in parsed && parsed.ok === false)) {
          const e = parsed && 'error' in parsed ? parsed.error : null;
          reject(new ApiError(xhr.status, e?.code ?? 'HTTP_ERROR', e?.message ?? '上传失败'));
          return;
        }
        resolve((parsed as OkEnvelope<UploadResult>).data);
      };
      xhr.send(file);
    });
  },

  /** 修改已入库条目的分类与属性（写覆写表 + 重扫，改完不会被下次扫描翻回去） */
  updateMeta: (id: number, patch: UploadMetaPatch) =>
    request<{ item: ResourceItem }>(`/api/admin/resources/${id}`, {
      method: 'PATCH',
      body: patch,
    }),

  /** 手动重扫素材目录（管理员直接往磁盘放了文件、或删了文件想让库同步时用） */
  rescan: () =>
    request<{ inserted: number; updated: number; removed: number; total: number }>(
      '/api/admin/resources/rescan',
      { method: 'POST', body: {}, timeoutMs: 60_000 }
    ),
};

/** 解析 fetch 版上传的响应（与 `request()` 同一套错误语义） */
async function parseUploadResponse(res: Response): Promise<UploadResult> {
  const text = await res.text();
  let parsed: OkEnvelope<UploadResult> | ErrEnvelope | null = null;
  try {
    parsed = text ? (JSON.parse(text) as OkEnvelope<UploadResult> | ErrEnvelope) : null;
  } catch {
    throw new ApiError(
      res.status,
      'NON_JSON_RESPONSE',
      `服务端返回了非 JSON 内容（HTTP ${res.status}）：${text.slice(0, 120)}`
    );
  }
  if (!res.ok || (parsed && 'ok' in parsed && parsed.ok === false)) {
    const err = parsed && 'error' in parsed ? parsed.error : null;
    throw new ApiError(
      res.status,
      err?.code ?? 'HTTP_ERROR',
      err?.message ?? `上传失败（HTTP ${res.status}）`
    );
  }
  return (parsed as OkEnvelope<UploadResult>).data;
}

export { API_BASE };
