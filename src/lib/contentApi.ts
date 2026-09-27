/**
 * 内容数据访问层（基于平台「数据表 SQL 操作 API」，本质是工作流）。
 *
 * 调用路径：POST /api/page/w/{token}
 *  - 同源调用，浏览器自动携带登录态，**不要**在请求头里放 Authorization。
 *  - 查询类业务数据在 `data.outputList`；写操作只回 `success`，不回填新 id。
 *
 * ⚠️ 端点 token 一律从 `.project.md` 取，不要凭记忆。
 * ⚠️ 对任意 API 执行 table-sql-update 后 token 会重新生成，必须同步更新下表。
 */
import type {
  Article,
  ArticleCategory,
  OrgMember,
  PublishStatus,
  SettingRow,
  TimelineEvent,
} from './types';

/** 功能名 → 端点 token（来源：.project.md §3） */
export const ENDPOINTS = {
  articleList: '17898056835263239',
  articleInsert: '17898056835263240',
  articleUpdate: '17898056835263241',
  articleDelete: '17898056845263242',
  timelineList: '17898056845263243',
  timelineInsert: '17898056845263244',
  timelineUpdate: '17898056845263245',
  timelineDelete: '17898056845263246',
  memberList: '17898056855263247',
  memberInsert: '17898056855263248',
  memberUpdate: '17898056855263249',
  memberDelete: '17898056855263250',
  settingList: '17898057015263251',
  settingInsert: '17898056865263252',
  settingUpdate: '17898056865263253',
  settingDelete: '17898056865263254',
} as const;

const API_PATH_PREFIX = '/api/page/w';

/** 统一响应外壳 */
interface ApiEnvelope<T> {
  success: boolean;
  message: string;
  data?: { outputList?: T[]; rowNum?: number } | null;
}

/** 云端不可达时抛出的错误，供上层判定是否降级为本地演示模式 */
export class CloudUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudUnavailableError';
  }
}

/**
 * 调用一个数据表 SQL 操作 API。
 * @param token 端点 token
 * @param params 入参（键名 = 建表 fieldName）
 * @param timeoutMs 超时时间
 */
export async function callEndpoint<T = Record<string, unknown>>(
  token: string,
  params: Record<string, unknown> = {},
  timeoutMs = 20000
): Promise<T[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_PATH_PREFIX}/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new CloudUnavailableError(`数据接口返回 HTTP ${res.status}`);
    }
    const result = (await res.json()) as ApiEnvelope<T>;
    if (!result.success) {
      throw new CloudUnavailableError(result.message || '数据接口调用失败');
    }
    return result.data?.outputList ?? [];
  } catch (err) {
    if (err instanceof CloudUnavailableError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new CloudUnavailableError(message);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 字段映射：后端原始行 → 前端模型
// ---------------------------------------------------------------------------

/** 数值列兜底：空串 / undefined 一律落回默认值，避免写入 INT 列报错 */
const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const str = (v: unknown, fallback = ''): string =>
  v === null || v === undefined ? fallback : String(v);

const status = (v: unknown): PublishStatus =>
  String(v) === 'draft' ? 'draft' : 'published';

interface RawArticle {
  id?: number | string;
  category?: string;
  title?: string;
  subtitle?: string;
  summary?: string;
  content?: string;
  cover?: string;
  author?: string;
  source?: string;
  event_date?: string;
  tags?: string;
  file_url?: string;
  link_url?: string;
  sort_index?: number | string;
  pinned?: number | string;
  status?: string;
  created?: string;
  modified?: string;
}

export const toArticle = (r: RawArticle): Article => ({
  id: String(r.id ?? ''),
  category: (str(r.category, 'news') as ArticleCategory) || 'news',
  title: str(r.title),
  subtitle: str(r.subtitle),
  summary: str(r.summary),
  content: str(r.content),
  cover: str(r.cover),
  author: str(r.author),
  source: str(r.source),
  eventDate: str(r.event_date),
  tags: str(r.tags),
  fileUrl: str(r.file_url),
  linkUrl: str(r.link_url),
  sortIndex: num(r.sort_index, 100),
  pinned: num(r.pinned, 0),
  status: status(r.status),
  createdAt: str(r.created),
  updatedAt: str(r.modified),
});

interface RawTimeline {
  id?: number | string;
  year?: string;
  title?: string;
  description?: string;
  image?: string;
  sort_index?: number | string;
  status?: string;
  created?: string;
  modified?: string;
}

export const toTimeline = (r: RawTimeline): TimelineEvent => ({
  id: String(r.id ?? ''),
  year: str(r.year),
  title: str(r.title),
  description: str(r.description),
  image: str(r.image),
  sortIndex: num(r.sort_index, 100),
  status: status(r.status),
  createdAt: str(r.created),
  updatedAt: str(r.modified),
});

interface RawMember {
  id?: number | string;
  dept?: string;
  role?: string;
  name?: string;
  avatar?: string;
  grade?: string;
  intro?: string;
  sort_index?: number | string;
  status?: string;
  created?: string;
  modified?: string;
}

export const toMember = (r: RawMember): OrgMember => ({
  id: String(r.id ?? ''),
  dept: str(r.dept),
  role: str(r.role),
  name: str(r.name),
  avatar: str(r.avatar),
  grade: str(r.grade),
  intro: str(r.intro),
  sortIndex: num(r.sort_index, 100),
  status: status(r.status),
  createdAt: str(r.created),
  updatedAt: str(r.modified),
});

interface RawSetting {
  id?: number | string;
  setting_key?: string;
  setting_value?: string;
  description?: string;
}

export const toSetting = (r: RawSetting): SettingRow => ({
  id: String(r.id ?? ''),
  key: str(r.setting_key),
  value: str(r.setting_value),
  description: str(r.description),
});

// ---------------------------------------------------------------------------
// 入参映射：前端模型 → 后端列名
// ---------------------------------------------------------------------------

const articleParams = (a: ArticleInput) => ({
  category: a.category,
  title: a.title,
  subtitle: a.subtitle,
  summary: a.summary,
  content: a.content,
  cover: a.cover,
  author: a.author,
  source: a.source,
  event_date: a.eventDate,
  tags: a.tags,
  file_url: a.fileUrl,
  link_url: a.linkUrl,
  sort_index: num(a.sortIndex, 100),
  pinned: num(a.pinned, 0),
  status: a.status,
});

const timelineParams = (t: TimelineInput) => ({
  year: t.year,
  title: t.title,
  description: t.description,
  image: t.image,
  sort_index: num(t.sortIndex, 100),
  status: t.status,
});

const memberParams = (m: MemberInput) => ({
  dept: m.dept,
  role: m.role,
  name: m.name,
  avatar: m.avatar,
  grade: m.grade,
  intro: m.intro,
  sort_index: num(m.sortIndex, 100),
  status: m.status,
});

/** 内容类型：前端模型 + 表格配置 */
export type EntityKind = 'article' | 'timeline' | 'member' | 'setting';

export type ArticleInput = Omit<Article, 'id' | 'createdAt' | 'updatedAt'>;
export type TimelineInput = Omit<
  TimelineEvent,
  'id' | 'createdAt' | 'updatedAt'
>;
export type MemberInput = Omit<OrgMember, 'id' | 'createdAt' | 'updatedAt'>;
export type SettingInput = { key: string; value: string; description: string };

// ---------------------------------------------------------------------------
// 远端（云端）CRUD
// ---------------------------------------------------------------------------

export const remoteApi = {
  async listArticles(): Promise<Article[]> {
    const rows = await callEndpoint<RawArticle>(ENDPOINTS.articleList);
    return rows.map(toArticle);
  },
  async createArticle(input: ArticleInput): Promise<void> {
    await callEndpoint(ENDPOINTS.articleInsert, articleParams(input));
  },
  async updateArticle(id: string, input: ArticleInput): Promise<void> {
    await callEndpoint(ENDPOINTS.articleUpdate, {
      ...articleParams(input),
      id: num(id, 0),
    });
  },
  async removeArticle(id: string): Promise<void> {
    await callEndpoint(ENDPOINTS.articleDelete, { id: num(id, 0) });
  },

  async listTimeline(): Promise<TimelineEvent[]> {
    const rows = await callEndpoint<RawTimeline>(ENDPOINTS.timelineList);
    return rows.map(toTimeline);
  },
  async createTimeline(input: TimelineInput): Promise<void> {
    await callEndpoint(ENDPOINTS.timelineInsert, timelineParams(input));
  },
  async updateTimeline(id: string, input: TimelineInput): Promise<void> {
    await callEndpoint(ENDPOINTS.timelineUpdate, {
      ...timelineParams(input),
      id: num(id, 0),
    });
  },
  async removeTimeline(id: string): Promise<void> {
    await callEndpoint(ENDPOINTS.timelineDelete, { id: num(id, 0) });
  },

  async listMembers(): Promise<OrgMember[]> {
    const rows = await callEndpoint<RawMember>(ENDPOINTS.memberList);
    return rows.map(toMember);
  },
  async createMember(input: MemberInput): Promise<void> {
    await callEndpoint(ENDPOINTS.memberInsert, memberParams(input));
  },
  async updateMember(id: string, input: MemberInput): Promise<void> {
    await callEndpoint(ENDPOINTS.memberUpdate, {
      ...memberParams(input),
      id: num(id, 0),
    });
  },
  async removeMember(id: string): Promise<void> {
    await callEndpoint(ENDPOINTS.memberDelete, { id: num(id, 0) });
  },

  async listSettings(): Promise<SettingRow[]> {
    const rows = await callEndpoint<RawSetting>(ENDPOINTS.settingList);
    return rows.map(toSetting);
  },
  async createSetting(input: SettingInput): Promise<void> {
    await callEndpoint(ENDPOINTS.settingInsert, {
      setting_key: input.key,
      setting_value: input.value,
      description: input.description,
    });
  },
  async updateSetting(id: string, input: SettingInput): Promise<void> {
    await callEndpoint(ENDPOINTS.settingUpdate, {
      setting_key: input.key,
      setting_value: input.value,
      description: input.description,
      id: num(id, 0),
    });
  },
  async removeSetting(id: string): Promise<void> {
    await callEndpoint(ENDPOINTS.settingDelete, { id: num(id, 0) });
  },
};

/** 远端接口健康探测：任一张表能读到即认为云端可用 */
export async function probeCloud(): Promise<boolean> {
  try {
    await callEndpoint(ENDPOINTS.settingList, {}, 8000);
    return true;
  } catch {
    return false;
  }
}
