/**
 * 站点内容仓库（React Context）。
 *
 * 职责：
 * 1. 启动时探测平台 SQL 操作 API 是否可用，决定运行在「云端模式」还是「本地演示模式」。
 * 2. 集中加载四张表的数据，向页面提供统一模型。
 * 3. 提供增删改入口，写入后统一重新拉取（写操作不回填 id，必须整表刷新）。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { remoteApi, probeCloud } from './contentApi';
import type {
  ArticleInput,
  MemberInput,
  SettingInput,
  TimelineInput,
} from './contentApi';
import { localApi, resetLocalDb } from './localDb';
import type {
  Article,
  DataMode,
  OrgMember,
  SettingRow,
  SettingsMap,
  TimelineEvent,
} from './types';

interface ContentState {
  mode: DataMode;
  /** 云端探测/加载过程中的错误信息（本地模式时用于提示） */
  notice: string;
  articles: Article[];
  timeline: TimelineEvent[];
  members: OrgMember[];
  settingRows: SettingRow[];
  settings: SettingsMap;
  loading: boolean;
  /** 重新加载全部数据 */
  reload: () => Promise<void>;
  /** 清空本地演示数据并恢复种子内容（仅本地模式有意义） */
  resetLocal: () => Promise<void>;

  createArticle: (input: ArticleInput) => Promise<void>;
  updateArticle: (id: string, input: ArticleInput) => Promise<void>;
  removeArticle: (id: string) => Promise<void>;

  createTimeline: (input: TimelineInput) => Promise<void>;
  updateTimeline: (id: string, input: TimelineInput) => Promise<void>;
  removeTimeline: (id: string) => Promise<void>;

  createMember: (input: MemberInput) => Promise<void>;
  updateMember: (id: string, input: MemberInput) => Promise<void>;
  removeMember: (id: string) => Promise<void>;

  saveSetting: (input: SettingInput) => Promise<void>;
  removeSetting: (id: string) => Promise<void>;
}

const ContentContext = createContext<ContentState | null>(null);

const toSettingsMap = (rows: SettingRow[]): SettingsMap =>
  rows.reduce<SettingsMap>((acc, row) => {
    if (row.key) acc[row.key] = row.value;
    return acc;
  }, {});

export function ContentProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<DataMode>('loading');
  const [notice, setNotice] = useState('');
  const [articles, setArticles] = useState<Article[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [settingRows, setSettingRows] = useState<SettingRow[]>([]);
  const [loading, setLoading] = useState(true);

  /** 加载全部数据；cloud 为真时走 SQL 操作 API，否则读取本地演示数据 */
  const load = useCallback(async (cloud: boolean) => {
    setLoading(true);
    try {
      if (cloud) {
        const [a, t, m, s] = await Promise.all([
          remoteApi.listArticles(),
          remoteApi.listTimeline(),
          remoteApi.listMembers(),
          remoteApi.listSettings(),
        ]);
        setArticles(a);
        setTimeline(t);
        setMembers(m);
        setSettingRows(s);
      } else {
        const [a, t, m, s] = await Promise.all([
          localApi.listArticles(),
          localApi.listTimeline(),
          localApi.listMembers(),
          localApi.listSettings(),
        ]);
        setArticles(a);
        setTimeline(t);
        setMembers(m);
        setSettingRows(s);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const reload = useCallback(async () => {
    await load(mode === 'cloud');
  }, [load, mode]);

  // 首次进入：先探测云端可用性，再加载对应数据源
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cloud = await probeCloud();
      if (cancelled) return;
      setNotice(
        cloud
          ? ''
          : '平台数据接口当前不可用，站点正以「本地演示模式」运行：浏览与编辑均只保存在本机浏览器，不会同步到云端数据表。'
      );
      setMode(cloud ? 'cloud' : 'local');
      await load(cloud);
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  /** 写操作统一走「执行 → 整表刷新」流程 */
  const runWrite = useCallback(
    async (fn: (api: typeof remoteApi) => Promise<void>) => {
      await fn(mode === 'cloud' ? remoteApi : (localApi as typeof remoteApi));
      await load(mode === 'cloud');
    },
    [mode, load]
  );

  const resetLocal = useCallback(async () => {
    resetLocalDb();
    await load(false);
  }, [load]);

  const value = useMemo<ContentState>(
    () => ({
      mode,
      notice,
      articles,
      timeline,
      members,
      settingRows,
      settings: toSettingsMap(settingRows),
      loading,
      reload,
      resetLocal,

      createArticle: (input) =>
        runWrite((api) => api.createArticle(input)),
      updateArticle: (id, input) =>
        runWrite((api) => api.updateArticle(id, input)),
      removeArticle: (id) => runWrite((api) => api.removeArticle(id)),

      createTimeline: (input) =>
        runWrite((api) => api.createTimeline(input)),
      updateTimeline: (id, input) =>
        runWrite((api) => api.updateTimeline(id, input)),
      removeTimeline: (id) => runWrite((api) => api.removeTimeline(id)),

      createMember: (input) => runWrite((api) => api.createMember(input)),
      updateMember: (id, input) =>
        runWrite((api) => api.updateMember(id, input)),
      removeMember: (id) => runWrite((api) => api.removeMember(id)),

      saveSetting: (input) => {
        const existing = settingRows.find((r) => r.key === input.key);
        return runWrite((api) =>
          existing
            ? api.updateSetting(existing.id, input)
            : api.createSetting(input)
        );
      },
      removeSetting: (id) => runWrite((api) => api.removeSetting(id)),
    }),
    [
      mode,
      notice,
      articles,
      timeline,
      members,
      settingRows,
      loading,
      reload,
      resetLocal,
      runWrite,
    ]
  );

  return (
    <ContentContext.Provider value={value}>{children}</ContentContext.Provider>
  );
}

/** 读取站点内容仓库 */
export function useContent(): ContentState {
  const ctx = useContext(ContentContext);
  if (!ctx) {
    throw new Error('useContent 必须在 ContentProvider 内部使用');
  }
  return ctx;
}
