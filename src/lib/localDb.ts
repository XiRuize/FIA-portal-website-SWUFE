/**
 * 本地演示数据层。
 *
 * 当平台 SQL 操作 API 不可达（未登录 / 端点未就绪）时，站点自动降级到本层：
 * 数据来自 `src/data/seed.ts`，改动写入 localStorage，仅在当前浏览器生效。
 * 该模式会在「内容管理」页顶部显式提示，不会静默降级。
 */
import {
  SEED_ARTICLES,
  SEED_MEMBERS,
  SEED_REV,
  SEED_SETTINGS,
  SEED_TIMELINE,
} from '@/data/seed';
import type {
  Article,
  OrgMember,
  SettingRow,
  SettingsMap,
  TimelineEvent,
} from './types';
import type {
  ArticleInput,
  MemberInput,
  SettingInput,
  TimelineInput,
} from './contentApi';

const STORAGE_KEY = 'swufe-fia-site-db-v1';

interface LocalDb {
  /** 写入时的种子版本，用于识别「缓存落后于 seed.ts」 */
  seedRev?: number;
  articles: Article[];
  timeline: TimelineEvent[];
  members: OrgMember[];
  settings: SettingRow[];
}

const nowIso = () => new Date().toISOString();

let counter = 0;
const localId = () => `local-${Date.now()}-${++counter}`;

/** 种子自带的行（id 形如 `seed-*` / `seed-setting-*`）与使用者后加的行（`local-*`） */
const isSeedRow = (row: { id?: unknown }) => String(row?.id ?? '').startsWith('seed-');

/**
 * 把上一版种子的缓存与当前种子合并。
 *
 * 规则只有一条，但很关键：**按 id 前缀判归属**。
 * - `seed-*` 是站点内容，来源就是 `seed.ts`，版本一变就整体换成新的；
 * - `local-*` 是使用者在「内容管理」里自己录的，必须原样留下，不能被重播种吞掉。
 *
 * 代价要说清楚：如果有人在本地模式下**编辑过种子自带的条目**（改标题、改统计数字），
 * 这类改动会随重播种被还原成最新种子值。本地模式本就是演示用途，
 * 站点内容的唯一出处是 `seed.ts`，所以这里选择「以代码为准」。
 */
function mergeSeed(old: LocalDb): LocalDb {
  const fresh = seedDb();
  const keepLocal = <T extends { id: string }>(list: T[] | undefined): T[] =>
    (Array.isArray(list) ? list : []).filter((row) => !isSeedRow(row));
  return {
    seedRev: SEED_REV,
    articles: [...fresh.articles, ...keepLocal(old.articles)],
    timeline: [...fresh.timeline, ...keepLocal(old.timeline)],
    members: [...fresh.members, ...keepLocal(old.members)],
    settings: [...fresh.settings, ...keepLocal(old.settings)],
  };
}

/** 首次进入时用种子数据初始化；已存在且版本未过期则读取 */
function read(): LocalDb {
  if (typeof window === 'undefined') {
    return seedDb();
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as LocalDb;
      if (parsed && Array.isArray(parsed.articles)) {
        if (parsed.seedRev === SEED_REV) return parsed;
        // 缓存是上一版种子：重播种后再交还，否则改了 seed.ts 的人会以为改动没生效
        const merged = mergeSeed(parsed);
        write(merged);
        return merged;
      }
    }
  } catch {
    // 解析失败时回落到种子数据
  }
  const fresh = seedDb();
  write(fresh);
  return fresh;
}

function write(db: LocalDb): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    // 超出配额时忽略：本地模式仅用于演示
  }
}

function seedDb(): LocalDb {
  return {
    seedRev: SEED_REV,
    articles: SEED_ARTICLES.map((a) => ({ ...a })),
    timeline: SEED_TIMELINE.map((t) => ({ ...t })),
    members: SEED_MEMBERS.map((m) => ({ ...m })),
    settings: Object.entries(SEED_SETTINGS).map(([key, value]) => ({
      id: `seed-setting-${key}`,
      key,
      value,
      description: '',
    })),
  };
}

const sortArticles = (list: Article[]) =>
  [...list].sort(
    (a, b) =>
      b.pinned - a.pinned ||
      a.sortIndex - b.sortIndex ||
      (a.id < b.id ? 1 : -1)
  );

const sortByIndex = <T extends { sortIndex: number }>(list: T[]) =>
  [...list].sort((a, b) => a.sortIndex - b.sortIndex);

export const localApi = {
  async listArticles(): Promise<Article[]> {
    return sortArticles(read().articles);
  },
  async createArticle(input: ArticleInput): Promise<void> {
    const db = read();
    db.articles.push({
      ...input,
      id: localId(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    write(db);
  },
  async updateArticle(id: string, input: ArticleInput): Promise<void> {
    const db = read();
    db.articles = db.articles.map((a) =>
      a.id === id ? { ...a, ...input, id, updatedAt: nowIso() } : a
    );
    write(db);
  },
  async removeArticle(id: string): Promise<void> {
    const db = read();
    db.articles = db.articles.filter((a) => a.id !== id);
    write(db);
  },

  async listTimeline(): Promise<TimelineEvent[]> {
    return sortByIndex(read().timeline);
  },
  async createTimeline(input: TimelineInput): Promise<void> {
    const db = read();
    db.timeline.push({
      ...input,
      id: localId(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    write(db);
  },
  async updateTimeline(id: string, input: TimelineInput): Promise<void> {
    const db = read();
    db.timeline = db.timeline.map((t) =>
      t.id === id ? { ...t, ...input, id, updatedAt: nowIso() } : t
    );
    write(db);
  },
  async removeTimeline(id: string): Promise<void> {
    const db = read();
    db.timeline = db.timeline.filter((t) => t.id !== id);
    write(db);
  },

  async listMembers(): Promise<OrgMember[]> {
    return sortByIndex(read().members);
  },
  async createMember(input: MemberInput): Promise<void> {
    const db = read();
    db.members.push({
      ...input,
      id: localId(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    write(db);
  },
  async updateMember(id: string, input: MemberInput): Promise<void> {
    const db = read();
    db.members = db.members.map((m) =>
      m.id === id ? { ...m, ...input, id, updatedAt: nowIso() } : m
    );
    write(db);
  },
  async removeMember(id: string): Promise<void> {
    const db = read();
    db.members = db.members.filter((m) => m.id !== id);
    write(db);
  },

  async listSettings(): Promise<SettingRow[]> {
    return read().settings;
  },
  async createSetting(input: SettingInput): Promise<void> {
    const db = read();
    const existing = db.settings.find((s) => s.key === input.key);
    if (existing) {
      db.settings = db.settings.map((s) =>
        s.key === input.key
          ? { ...s, value: input.value, description: input.description }
          : s
      );
    } else {
      db.settings.push({ id: localId(), ...input });
    }
    write(db);
  },
  async updateSetting(id: string, input: SettingInput): Promise<void> {
    const db = read();
    db.settings = db.settings.map((s) =>
      s.id === id ? { ...s, ...input } : s
    );
    write(db);
  },
  async removeSetting(id: string): Promise<void> {
    const db = read();
    db.settings = db.settings.filter((s) => s.id !== id);
    write(db);
  },
};

/** 将当前本地数据导出为键值配置（供页面消费） */
export async function readLocalSettings(): Promise<SettingsMap> {
  const rows = await localApi.listSettings();
  return rows.reduce<SettingsMap>((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});
}

/** 重置本地演示数据（内容管理页提供入口） */
export function resetLocalDb(): void {
  write(seedDb());
}
