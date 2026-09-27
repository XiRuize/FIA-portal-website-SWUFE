import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Cloud,
  CloudOff,
  Database,
  HardDriveDownload,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';
import { useContent } from '@/lib/store';
import { useAuth, roleLabel, CAP_MANAGE_ACCOUNTS } from '@/lib/auth';
import { CATEGORY_META, type ArticleCategory, type PublishStatus } from '@/lib/types';
import type {
  ArticleInput,
  MemberInput,
  TimelineInput,
} from '@/lib/contentApi';
import { SETTING_FIELDS } from '@/lib/siteConfig';
import { SEED_ARTICLES, SEED_MEMBERS, SEED_TIMELINE } from '@/data/seed';
import {
  AdminButton,
  Field,
  Modal,
  Panel,
  SelectInput,
  TextArea,
  TextInput,
} from '@/components/admin/AdminUI';
import ImageField from '@/components/admin/ImageField';
import AccountManager from '@/components/admin/AccountManager';
import PageHero from '@/components/site/PageHero';
import { cn } from '@/lib/utils';

type TabKey = 'article' | 'timeline' | 'member' | 'settings' | 'account';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'article', label: '内容条目' },
  { key: 'timeline', label: '历史沿革' },
  { key: 'member', label: '组织架构' },
  { key: 'account', label: '账号管理' },
  { key: 'settings', label: '站点设置' },
];

const CATEGORY_OPTIONS = Object.entries(CATEGORY_META) as [
  ArticleCategory,
  { label: string; hint: string },
][];

const emptyArticle = (): ArticleInput => ({
  category: 'news',
  title: '',
  subtitle: '',
  summary: '',
  content: '',
  cover: '',
  author: '',
  source: '',
  eventDate: '',
  tags: '',
  fileUrl: '',
  linkUrl: '',
  sortIndex: 100,
  pinned: 0,
  status: 'published',
});

const emptyTimeline = (): TimelineInput => ({
  year: '',
  title: '',
  description: '',
  image: '',
  sortIndex: 100,
  status: 'published',
});

const emptyMember = (): MemberInput => ({
  dept: '',
  role: '',
  name: '',
  avatar: '',
  grade: '',
  intro: '',
  sortIndex: 100,
  status: 'published',
});

/**
 * 内容管理后台。
 *
 * 鉴权说明：本页的准入由路由层的 <RequireAuth required={[CAP_MANAGE_CONTENT]}> 负责，
 * 页面内部不再自行校验口令。旧实现把 `admin_passcode` 当作「前端比对的字符串」，
 * 等于把管理口令公开在页面配置里——任何人打开开发者工具即可获得，
 * 也能手写 sessionStorage 标记绕过。现改为服务端会话判定，口令永不下发。
 */
export function Admin() {
  const content = useContent();
  const navigate = useNavigate();
  const { account, role, capabilities, logout } = useAuth();
  const [tab, setTab] = useState<TabKey>('article');
  const [busy, setBusy] = useState(false);

  const canManageAccounts = capabilities.includes(CAP_MANAGE_ACCOUNTS);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }, []);

  /** 一键导入演示数据（用于首次填充云端数据表） */
  const importSeed = () =>
    run(async () => {
      const ok = window.confirm(
        '将把内置演示内容（约 30 条内容、8 个时间轴节点、7 位成员）写入当前数据源。\n\n' +
          '· 该操作不会删除已有数据，但可能造成内容重复，建议仅在站点为空时执行；\n' +
          '· 写入过程逐条进行，可能需要几十秒，请勿关闭页面。\n\n是否继续？'
      );
      if (!ok) return;
      for (const a of SEED_ARTICLES) {
        const { id: _id, createdAt: _c, updatedAt: _u, ...input } = a;
        await content.createArticle(input);
      }
      for (const t of SEED_TIMELINE) {
        const { id: _id, createdAt: _c, updatedAt: _u, ...input } = t;
        await content.createTimeline(input);
      }
      for (const m of SEED_MEMBERS) {
        const { id: _id, createdAt: _c, updatedAt: _u, ...input } = m;
        await content.createMember(input);
      }
    });

  return (
    <div>
      <PageHero
        title='内容管理'
        description='按栏目维护站点内容；所有改动保存后立即在前台生效。'
      />

      <div className='mx-auto max-w-7xl px-4 py-10 sm:px-6'>
        <ModeBanner />

        <div className='mt-6 flex flex-wrap items-center gap-2 border-b border-gray-100 pb-4'>
          {TABS.map((t) => (
            <button
              key={t.key}
              type='button'
              onClick={() => setTab(t.key)}
              className={cn(
                'rounded-lg px-4 py-2 text-sm font-medium transition-colors',
                tab === t.key
                  ? 'bg-brand-800 text-white'
                  : 'bg-gray-50 text-gray-600 hover:bg-brand-50 hover:text-brand-800',
                // 没有账号管理权限时把该标签弱化，避免点进去才发现进不去
                t.key === 'account' && !canManageAccounts && 'cursor-not-allowed opacity-40'
              )}
              disabled={t.key === 'account' && !canManageAccounts}
              title={t.key === 'account' && !canManageAccounts ? '当前账号无账号管理权限' : undefined}
            >
              {t.label}
            </button>
          ))}

          <div className='ml-auto flex flex-wrap items-center gap-2'>
            <span className='num rounded-md border border-brand-200 bg-brand-50 px-2.5 py-1.5 text-[11px] text-brand-700'>
              {roleLabel(role)}
              {account?.displayName ? ` · ${account.displayName}` : ''}
            </span>
            <AdminButton
              variant='outline'
              onClick={() => void run(content.reload)}
              disabled={busy}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
              刷新数据
            </AdminButton>
            <AdminButton variant='outline' onClick={() => void importSeed()} disabled={busy}>
              <HardDriveDownload className='h-3.5 w-3.5' />
              导入演示数据
            </AdminButton>
            <AdminButton
              variant='ghost'
              onClick={() => {
                // 退出走真实后端接口：服务端作废会话并清除 Cookie。
                // 不能只清本地状态——那样会话在服务端仍然有效。
                void logout().then(() => navigate('/', { replace: true }));
              }}
            >
              <LogOut className='h-3.5 w-3.5' />
              退出
            </AdminButton>
          </div>
        </div>

        <div className='mt-6 space-y-6'>
          {tab === 'article' ? <ArticleManager busy={busy} run={run} /> : null}
          {tab === 'timeline' ? <TimelineManager busy={busy} run={run} /> : null}
          {tab === 'member' ? <MemberManager busy={busy} run={run} /> : null}
          {tab === 'account' ? <AccountManager /> : null}
          {tab === 'settings' ? <SettingsManager busy={busy} run={run} /> : null}
        </div>
      </div>
    </div>
  );
}

type Runner = (fn: () => Promise<void>) => Promise<void>;

/** 数据源状态提示：明确告知当前是云端还是本地演示模式 */
function ModeBanner() {
  const { mode, notice, loading } = useContent();
  if (loading) return null;
  const cloud = mode === 'cloud';
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-xl border p-4 text-sm',
        cloud
          ? 'border-emerald-100 bg-emerald-50/60 text-emerald-800'
          : 'border-amber-200 bg-amber-50/70 text-amber-800'
      )}
    >
      {cloud ? (
        <Cloud className='mt-0.5 h-5 w-5 shrink-0' />
      ) : (
        <CloudOff className='mt-0.5 h-5 w-5 shrink-0' />
      )}
      <div>
        <p className='font-medium'>
          {cloud
            ? '云端数据源已连接：内容保存在项目数据表中，所有访客可见。'
            : '当前为本地演示模式：内容仅保存在本机浏览器，刷新页面仍在，但不会同步到云端。'}
        </p>
        {!cloud && notice ? <p className='mt-1 text-xs'>{notice}</p> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 内容条目
// ---------------------------------------------------------------------------

function ArticleManager({ busy, run }: { busy: boolean; run: Runner }) {
  const { articles, createArticle, updateArticle, removeArticle } = useContent();
  const [editing, setEditing] = useState<ArticleInput & { id?: string } | null>(
    null
  );
  const [filter, setFilter] = useState<ArticleCategory | 'all'>('all');

  const list = useMemo(
    () =>
      filter === 'all'
        ? articles
        : articles.filter((a) => a.category === filter),
    [articles, filter]
  );

  const save = () =>
    run(async () => {
      if (!editing) return;
      if (!editing.title.trim()) {
        window.alert('请填写标题');
        return;
      }
      const { id, ...input } = editing;
      if (id) await updateArticle(id, input);
      else await createArticle(input);
      setEditing(null);
    });

  return (
    <Panel
      title='内容条目'
      description='覆盖首页轮播、活动回顾、社团记事、财经时事、资料分享与社团产出等全部内容。'
      action={
        <div className='flex items-center gap-2'>
          <SelectInput
            value={filter}
            onChange={(e) => setFilter(e.target.value as ArticleCategory | 'all')}
            className='h-9 w-36'
          >
            <option value='all'>全部分类</option>
            {CATEGORY_OPTIONS.map(([key, meta]) => (
              <option key={key} value={key}>
                {meta.label}
              </option>
            ))}
          </SelectInput>
          <AdminButton onClick={() => setEditing(emptyArticle())}>
            <Plus className='h-3.5 w-3.5' />
            新增内容
          </AdminButton>
        </div>
      }
    >
      <DataTable
        head={['分类', '标题', '日期', '状态', '操作']}
        empty='暂无内容，点击右上角「新增内容」开始添加。'
        rows={list.map((a) => ({
          key: a.id,
          cells: [
            CATEGORY_META[a.category]?.label ?? a.category,
            <span key='t' className='flex items-center gap-1.5'>
              {a.pinned ? (
                <span className='rounded bg-gold-100 px-1.5 py-0.5 text-xs text-gold-700'>
                  置顶
                </span>
              ) : null}
              <span className='line-clamp-1'>{a.title}</span>
            </span>,
            a.eventDate || '—',
            a.status === 'draft' ? (
              <span key='s' className='text-xs text-gray-400'>
                草稿
              </span>
            ) : (
              <span key='s' className='text-xs text-emerald-600'>
                已发布
              </span>
            ),
          ],
          actions: (
            <>
              <AdminButton
                variant='outline'
                onClick={() => {
                  const { id, createdAt: _c, updatedAt: _u, ...rest } = a;
                  setEditing({ ...rest, id });
                }}
              >
                <Pencil className='h-3.5 w-3.5' />
                编辑
              </AdminButton>
              <AdminButton
                variant='danger'
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`确认删除「${a.title}」？`)) {
                    void run(() => removeArticle(a.id));
                  }
                }}
              >
                <Trash2 className='h-3.5 w-3.5' />
              </AdminButton>
            </>
          ),
        }))}
      />

      <Modal
        open={!!editing}
        title={editing?.id ? '编辑内容' : '新增内容'}
        wide
        onClose={() => setEditing(null)}
        footer={
          <>
            <AdminButton variant='outline' onClick={() => setEditing(null)}>
              取消
            </AdminButton>
            <AdminButton onClick={() => void save()} disabled={busy}>
              <Save className='h-3.5 w-3.5' />
              保存
            </AdminButton>
          </>
        }
      >
        {editing ? (
          <div className='space-y-4'>
            <div className='grid gap-4 sm:grid-cols-2'>
              <Field label='分类 *'>
                <SelectInput
                  value={editing.category}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      category: e.target.value as ArticleCategory,
                    })
                  }
                >
                  {CATEGORY_OPTIONS.map(([key, meta]) => (
                    <option key={key} value={key}>
                      {meta.label}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              <Field label='状态'>
                <SelectInput
                  value={editing.status}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      status: e.target.value as PublishStatus,
                    })
                  }
                >
                  <option value='published'>已发布</option>
                  <option value='draft'>草稿</option>
                </SelectInput>
              </Field>
            </div>

            <Field label='标题 *'>
              <TextInput
                value={editing.title}
                onChange={(e) =>
                  setEditing({ ...editing, title: e.target.value })
                }
                placeholder='例如：2026 校园模拟投资大赛圆满收官'
              />
            </Field>

            <Field label='副标题' hint='展示在标题下方的小字，如活动地点、期号'>
              <TextInput
                value={editing.subtitle}
                onChange={(e) =>
                  setEditing({ ...editing, subtitle: e.target.value })
                }
              />
            </Field>

            <Field label='摘要' hint='列表卡片与详情页顶部展示'>
              <TextArea
                rows={3}
                value={editing.summary}
                onChange={(e) =>
                  setEditing({ ...editing, summary: e.target.value })
                }
              />
            </Field>

            <Field label='正文' hint='直接换行分段即可'>
              <TextArea
                rows={10}
                value={editing.content}
                onChange={(e) =>
                  setEditing({ ...editing, content: e.target.value })
                }
              />
            </Field>

            <ImageField
              label='封面图'
              value={editing.cover}
              onChange={(cover) => setEditing({ ...editing, cover })}
              hint='支持粘贴图片 URL 或上传本地图片（会自动压缩后内嵌保存）'
            />

            <div className='grid gap-4 sm:grid-cols-3'>
              <Field label='日期' hint='YYYY-MM-DD'>
                <TextInput
                  value={editing.eventDate}
                  onChange={(e) =>
                    setEditing({ ...editing, eventDate: e.target.value })
                  }
                  placeholder='2026-09-19'
                />
              </Field>
              <Field label='作者 / 发布人'>
                <TextInput
                  value={editing.author}
                  onChange={(e) =>
                    setEditing({ ...editing, author: e.target.value })
                  }
                />
              </Field>
              <Field label='来源'>
                <TextInput
                  value={editing.source}
                  onChange={(e) =>
                    setEditing({ ...editing, source: e.target.value })
                  }
                />
              </Field>
            </div>

            <div className='grid gap-4 sm:grid-cols-2'>
              <Field label='标签' hint='多个标签用英文逗号分隔'>
                <TextInput
                  value={editing.tags}
                  onChange={(e) =>
                    setEditing({ ...editing, tags: e.target.value })
                  }
                  placeholder='估值,DCF'
                />
              </Field>
              <div className='grid grid-cols-2 gap-4'>
                <Field label='排序值' hint='越小越靠前'>
                  <TextInput
                    type='number'
                    value={editing.sortIndex}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        sortIndex: Number(e.target.value) || 0,
                      })
                    }
                  />
                </Field>
                <Field label='置顶'>
                  <SelectInput
                    value={editing.pinned}
                    onChange={(e) =>
                      setEditing({ ...editing, pinned: Number(e.target.value) })
                    }
                  >
                    <option value={0}>否</option>
                    <option value={1}>是</option>
                  </SelectInput>
                </Field>
              </div>
            </div>

            <div className='grid gap-4 sm:grid-cols-2'>
              <Field label='附件 / 下载链接' hint='资料类内容可填网盘或文件地址'>
                <TextInput
                  value={editing.fileUrl}
                  onChange={(e) =>
                    setEditing({ ...editing, fileUrl: e.target.value })
                  }
                  placeholder='https://…'
                />
              </Field>
              <Field label='外部链接' hint='填写后卡片点击将跳转该地址'>
                <TextInput
                  value={editing.linkUrl}
                  onChange={(e) =>
                    setEditing({ ...editing, linkUrl: e.target.value })
                  }
                  placeholder='https://…'
                />
              </Field>
            </div>
          </div>
        ) : null}
      </Modal>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 历史沿革
// ---------------------------------------------------------------------------

function TimelineManager({ busy, run }: { busy: boolean; run: Runner }) {
  const { timeline, createTimeline, updateTimeline, removeTimeline } =
    useContent();
  const [editing, setEditing] = useState<
    (TimelineInput & { id?: string }) | null
  >(null);

  const save = () =>
    run(async () => {
      if (!editing) return;
      if (!editing.title.trim() || !editing.year.trim()) {
        window.alert('请填写年份与事件标题');
        return;
      }
      const { id, ...input } = editing;
      if (id) await updateTimeline(id, input);
      else await createTimeline(input);
      setEditing(null);
    });

  return (
    <Panel
      title='历史沿革'
      description='按年份维护时间轴节点，前台以流线型时间轴展示。'
      action={
        <AdminButton onClick={() => setEditing(emptyTimeline())}>
          <Plus className='h-3.5 w-3.5' />
          新增节点
        </AdminButton>
      }
    >
      <DataTable
        head={['年份', '事件', '状态', '操作']}
        empty='暂无时间轴节点。'
        rows={timeline.map((t) => ({
          key: t.id,
          cells: [
            t.year,
            <span key='t' className='line-clamp-1'>
              {t.title}
            </span>,
            t.status === 'draft' ? '草稿' : '已发布',
          ],
          actions: (
            <>
              <AdminButton
                variant='outline'
                onClick={() => {
                  const { id, createdAt: _c, updatedAt: _u, ...rest } = t;
                  setEditing({ ...rest, id });
                }}
              >
                <Pencil className='h-3.5 w-3.5' />
                编辑
              </AdminButton>
              <AdminButton
                variant='danger'
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`确认删除「${t.year} ${t.title}」？`)) {
                    void run(() => removeTimeline(t.id));
                  }
                }}
              >
                <Trash2 className='h-3.5 w-3.5' />
              </AdminButton>
            </>
          ),
        }))}
      />

      <Modal
        open={!!editing}
        title={editing?.id ? '编辑时间轴节点' : '新增时间轴节点'}
        onClose={() => setEditing(null)}
        footer={
          <>
            <AdminButton variant='outline' onClick={() => setEditing(null)}>
              取消
            </AdminButton>
            <AdminButton onClick={() => void save()} disabled={busy}>
              <Save className='h-3.5 w-3.5' />
              保存
            </AdminButton>
          </>
        }
      >
        {editing ? (
          <div className='space-y-4'>
            <div className='grid gap-4 sm:grid-cols-2'>
              <Field label='年份 / 时间 *' hint='如 2014 或 2014.09'>
                <TextInput
                  value={editing.year}
                  onChange={(e) =>
                    setEditing({ ...editing, year: e.target.value })
                  }
                />
              </Field>
              <Field label='排序值' hint='越小越靠前'>
                <TextInput
                  type='number'
                  value={editing.sortIndex}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      sortIndex: Number(e.target.value) || 0,
                    })
                  }
                />
              </Field>
            </div>
            <Field label='事件标题 *'>
              <TextInput
                value={editing.title}
                onChange={(e) =>
                  setEditing({ ...editing, title: e.target.value })
                }
              />
            </Field>
            <Field label='事件描述'>
              <TextArea
                rows={4}
                value={editing.description}
                onChange={(e) =>
                  setEditing({ ...editing, description: e.target.value })
                }
              />
            </Field>
            <ImageField
              label='配图'
              value={editing.image}
              onChange={(image) => setEditing({ ...editing, image })}
            />
            <Field label='状态'>
              <SelectInput
                value={editing.status}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    status: e.target.value as PublishStatus,
                  })
                }
              >
                <option value='published'>已发布</option>
                <option value='draft'>草稿</option>
              </SelectInput>
            </Field>
          </div>
        ) : null}
      </Modal>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 组织架构
// ---------------------------------------------------------------------------

function MemberManager({ busy, run }: { busy: boolean; run: Runner }) {
  const { members, createMember, updateMember, removeMember } = useContent();
  const [editing, setEditing] = useState<
    (MemberInput & { id?: string }) | null
  >(null);

  const save = () =>
    run(async () => {
      if (!editing) return;
      if (!editing.name.trim()) {
        window.alert('请填写姓名');
        return;
      }
      const { id, ...input } = editing;
      if (id) await updateMember(id, input);
      else await createMember(input);
      setEditing(null);
    });

  return (
    <Panel
      title='组织架构'
      description='同一「部门/组别」的成员会归入首页对应分组。'
      action={
        <AdminButton onClick={() => setEditing(emptyMember())}>
          <Plus className='h-3.5 w-3.5' />
          新增成员
        </AdminButton>
      }
    >
      <DataTable
        head={['部门', '姓名', '职务', '状态', '操作']}
        empty='暂无成员信息。'
        rows={members.map((m) => ({
          key: m.id,
          cells: [m.dept || '—', m.name, m.role || '—', m.status === 'draft' ? '草稿' : '已发布'],
          actions: (
            <>
              <AdminButton
                variant='outline'
                onClick={() => {
                  const { id, createdAt: _c, updatedAt: _u, ...rest } = m;
                  setEditing({ ...rest, id });
                }}
              >
                <Pencil className='h-3.5 w-3.5' />
                编辑
              </AdminButton>
              <AdminButton
                variant='danger'
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`确认删除成员「${m.name}」？`)) {
                    void run(() => removeMember(m.id));
                  }
                }}
              >
                <Trash2 className='h-3.5 w-3.5' />
              </AdminButton>
            </>
          ),
        }))}
      />

      <Modal
        open={!!editing}
        title={editing?.id ? '编辑成员' : '新增成员'}
        onClose={() => setEditing(null)}
        footer={
          <>
            <AdminButton variant='outline' onClick={() => setEditing(null)}>
              取消
            </AdminButton>
            <AdminButton onClick={() => void save()} disabled={busy}>
              <Save className='h-3.5 w-3.5' />
              保存
            </AdminButton>
          </>
        }
      >
        {editing ? (
          <div className='space-y-4'>
            <div className='grid gap-4 sm:grid-cols-2'>
              <Field label='部门 / 组别' hint='如 会长团、研究部'>
                <TextInput
                  value={editing.dept}
                  onChange={(e) =>
                    setEditing({ ...editing, dept: e.target.value })
                  }
                />
              </Field>
              <Field label='职务'>
                <TextInput
                  value={editing.role}
                  onChange={(e) =>
                    setEditing({ ...editing, role: e.target.value })
                  }
                />
              </Field>
            </div>
            <div className='grid gap-4 sm:grid-cols-2'>
              <Field label='姓名 *'>
                <TextInput
                  value={editing.name}
                  onChange={(e) =>
                    setEditing({ ...editing, name: e.target.value })
                  }
                />
              </Field>
              <Field label='年级 / 专业'>
                <TextInput
                  value={editing.grade}
                  onChange={(e) =>
                    setEditing({ ...editing, grade: e.target.value })
                  }
                />
              </Field>
            </div>
            <Field label='个人简介'>
              <TextArea
                rows={3}
                value={editing.intro}
                onChange={(e) =>
                  setEditing({ ...editing, intro: e.target.value })
                }
              />
            </Field>
            <ImageField
              label='头像'
              value={editing.avatar}
              onChange={(avatar) => setEditing({ ...editing, avatar })}
            />
            <div className='grid gap-4 sm:grid-cols-2'>
              <Field label='排序值' hint='越小越靠前'>
                <TextInput
                  type='number'
                  value={editing.sortIndex}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      sortIndex: Number(e.target.value) || 0,
                    })
                  }
                />
              </Field>
              <Field label='状态'>
                <SelectInput
                  value={editing.status}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      status: e.target.value as PublishStatus,
                    })
                  }
                >
                  <option value='published'>已发布</option>
                  <option value='draft'>草稿</option>
                </SelectInput>
              </Field>
            </div>
          </div>
        ) : null}
      </Modal>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 站点设置
// ---------------------------------------------------------------------------

function SettingsManager({ busy, run }: { busy: boolean; run: Runner }) {
  const { settings, saveSetting } = useContent();
  const [draft, setDraft] = useState<Record<string, string>>({});

  // 数据到达后同步到本地草稿
  useEffect(() => {
    setDraft((prev) => {
      const next = { ...prev };
      SETTING_FIELDS.forEach((f) => {
        if (next[f.key] === undefined) next[f.key] = settings[f.key] ?? '';
      });
      return next;
    });
  }, [settings]);

  const saveAll = () =>
    run(async () => {
      for (const f of SETTING_FIELDS) {
        const value = draft[f.key] ?? '';
        if (value === (settings[f.key] ?? '')) continue;
        await saveSetting({ key: f.key, value, description: f.label });
      }
    });

  const groups: { key: string; label: string }[] = [
    { key: 'basic', label: '基本信息' },
    { key: 'about', label: '协会介绍与组织架构' },
    { key: 'contact', label: '联系方式（页脚）' },
    { key: 'stock', label: '行情看板' },
    { key: 'admin', label: '安全管理' },
  ];

  return (
    <div className='space-y-6'>
      <Panel
        title='站点设置'
        description='修改后点击「保存全部」生效。留空的联系方式会在页脚显示为「信息待补充」。'
        action={
          <AdminButton onClick={() => void saveAll()} disabled={busy}>
            <Save className='h-3.5 w-3.5' />
            保存全部
          </AdminButton>
        }
      >
        <div className='space-y-8'>
          {groups.map((g) => {
            const fields = SETTING_FIELDS.filter((f) => f.group === g.key);
            if (!fields.length) return null;
            return (
              <div key={g.key}>
                <h4 className='mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-400'>
                  <Database className='h-3.5 w-3.5' />
                  {g.label}
                </h4>
                <div className='space-y-4'>
                  {fields.map((f) => (
                    <Field key={f.key} label={f.label} hint={f.hint}>
                      {f.multiline ? (
                        <TextArea
                          rows={f.key === 'about_content' ? 8 : 4}
                          value={draft[f.key] ?? ''}
                          onChange={(e) =>
                            setDraft({ ...draft, [f.key]: e.target.value })
                          }
                        />
                      ) : (
                        <TextInput
                          value={draft[f.key] ?? ''}
                          onChange={(e) =>
                            setDraft({ ...draft, [f.key]: e.target.value })
                          }
                        />
                      )}
                    </Field>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      <div className='flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50/70 p-4 text-xs text-amber-800'>
        <AlertTriangle className='mt-0.5 h-4 w-4 shrink-0' />
        <p>
          当前的管理口令校验运行在前端，仅适用于 Demo 阶段；正式对外发布前建议接入学校统一身份认证或平台侧权限控制。
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 通用表格
// ---------------------------------------------------------------------------

interface Row {
  key: string;
  cells: ReactNode[];
  actions: ReactNode;
}

function DataTable({
  head,
  rows,
  empty,
}: {
  head: string[];
  rows: Row[];
  empty: string;
}) {
  if (!rows.length) {
    return (
      <div className='rounded-lg border border-dashed border-gray-200 px-6 py-10 text-center text-xs text-gray-400'>
        {empty}
      </div>
    );
  }
  return (
    <div className='overflow-x-auto'>
      <table className='w-full min-w-[640px] border-collapse text-sm'>
        <thead>
          <tr className='border-b border-gray-100 text-left text-xs text-gray-400'>
            {head.map((h) => (
              <th key={h} className='pb-2 pr-4 font-medium'>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className='border-b border-gray-50 last:border-0'>
              {row.cells.map((cell, i) => (
                <td key={i} className='py-3 pr-4 align-middle text-gray-700'>
                  {cell}
                </td>
              ))}
              <td className='py-3'>
                <div className='flex items-center gap-2'>{row.actions}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default Admin;
