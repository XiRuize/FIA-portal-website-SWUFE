/**
 * 「内容上传与管理」子栏目下的**文件上传**面板。
 *
 * 一键上传资料 → 勾选分类 → 落盘 → 重扫入库 → 前台立刻可见。
 *
 * ## 联动创建内容
 *
 * 需求里的「联动在新闻、资料与数据、社团成员产出创建相关的框与新内容」分两种：
 * - **资料与数据 / 社团成员产出**：勾选展示类目即完成归类，上传后条目直接出现在对应模块；
 * - **新闻与资讯**：资料条目本身不是文章。勾选「同时创建财经时事」后，
 *   前端会在内容仓库里建一篇对应文章，并把该文件的下载地址写进 `fileUrl`，
 *   读者在新闻页点开即可下载原件。
 *
 * 后者是前端编排（两次调用），不是后端的原子操作 —— 所以顺序上**先传文件再建文章**：
 * 文章要有下载地址，地址来自上传结果。若第二步失败，文件已经入库不会丢，
 * 界面会明确提示「资料已入库，但资讯创建失败，可重试」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileUp,
  FolderOpen,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  adminResourcesApi,
  resourcesApi,
  type ResourceItem,
  type UploadMetaPatch,
  type UploadOptions,
} from '@/lib/backendApi';
import { useContent } from '@/lib/store';
import {
  AdminButton,
  Field,
  Panel,
  SelectInput,
  TextArea,
  TextInput,
} from '@/components/admin/AdminUI';
import { cn } from '@/lib/utils';

/** 单文件上传状态 */
interface QueueItem {
  id: string;
  file: File;
  percent: number;
  status: 'pending' | 'uploading' | 'done' | 'failed';
  message?: string;
  result?: ResourceItem;
}

/** 是否把资料归类为「社团成员产出」（决定是否显示作品属性字段） */
const PRODUCTION_CATEGORY = '社团成员产出';
/** 资料库的常规展示类目（用于区分「这是作品」还是「这是外部资料」） */
const LIBRARY_HINTS = ['电子书籍', '数据', '研报', '课程资源'];

export default function UploadPanel() {
  const [options, setOptions] = useState<UploadOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);

  // 表单
  const [categoryDir, setCategoryDir] = useState('');
  const [displayCategory, setDisplayCategory] = useState('');
  const [accessLevel, setAccessLevel] = useState<'public' | 'member'>('public');
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [authorTitle, setAuthorTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [tags, setTags] = useState('');
  /** 联动：同时在前台创建一篇财经时事 */
  const [alsoCreateArticle, setAlsoCreateArticle] = useState(false);

  const loadOptions = useCallback(async () => {
    try {
      const res = await adminResourcesApi.uploadOptions();
      setOptions(res);
      setCategoryDir((prev) => prev || res.directories[0] || '');
      setDisplayCategory((prev) => prev || res.displayCategories[0] || '');
      setOptionsError(null);
    } catch (e) {
      setOptionsError(e instanceof Error ? e.message : '加载上传选项失败');
    }
  }, []);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  const isProduction = displayCategory === PRODUCTION_CATEGORY;

  /** 选定目录若在受限名单里，自动把访问级别切到 member（但仍可手动改回） */
  useEffect(() => {
    if (!options || !categoryDir) return;
    if (options.restrictedDirs.includes(categoryDir)) setAccessLevel('member');
  }, [categoryDir, options]);

  const uploading = queue.some((q) => q.status === 'uploading');
  const pending = useMemo(() => queue.filter((q) => q.status === 'pending'), [queue]);

  const addFiles = useCallback((files: FileList | null) => {
    if (!files?.length) return;
    const items: QueueItem[] = Array.from(files).map((file) => ({
      id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      percent: 0,
      status: 'pending',
    }));
    setQueue((prev) => [...prev, ...items]);
  }, []);

  const patchQueue = useCallback((id: string, patch: Partial<QueueItem>) => {
    setQueue((prev) => prev.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  }, []);

  /** 执行上传：逐文件顺序进行，避免并发写同一张覆写表 */
  const startUpload = useCallback(async () => {
    if (!options || pending.length === 0) return;

    const meta: UploadMetaPatch = {
      displayCategory: displayCategory || undefined,
      accessLevel,
      title: title.trim() || undefined,
      author: author.trim() || undefined,
      authorTitle: authorTitle.trim() || undefined,
      summary: summary.trim() || undefined,
      tags: tags
        .split(/[,，\s]+/)
        .map((t) => t.trim())
        .filter(Boolean),
    };

    const succeeded: Array<{ file: File; item: ResourceItem }> = [];

    for (const item of pending) {
      patchQueue(item.id, { status: 'uploading', percent: 0, message: undefined });
      try {
        const res = await adminResourcesApi.upload(
          item.file,
          { categoryDir, meta },
          (percent) => patchQueue(item.id, { percent })
        );
        patchQueue(item.id, { status: 'done', percent: 100, result: res.item });
        succeeded.push({ file: item.file, item: res.item });
      } catch (e) {
        patchQueue(item.id, {
          status: 'failed',
          message: e instanceof Error ? e.message : '上传失败',
        });
      }
    }

    // 上传结果里的条目是同一批分类，勾选联动时逐条建文章
    if (alsoCreateArticle && succeeded.length > 0) {
      await createArticles(succeeded);
    }
  }, [
    options,
    pending,
    displayCategory,
    accessLevel,
    title,
    author,
    authorTitle,
    summary,
    tags,
    categoryDir,
    alsoCreateArticle,
    patchQueue,
  ]);

  /**
   * 内容仓库引用。
   *
   * 用 ref 而不是把 `useContent()` 塞进 `startUpload` 的依赖：
   * `useContent()` 的返回值每次渲染都是新对象，会让回调连环重建，
   * 而上传中途重建回调会把「进行中的队列」与其闭包状态割裂。
   */
  const content = useContent();
  const contentRef = useRef(content);
  contentRef.current = content;

  /** 把上传结果镜像成前台财经时事文章（在内容仓库里建，带下载地址） */
  const createArticles = useCallback(
    async (items: Array<{ file: File; item: ResourceItem }>) => {
      const content = contentRef.current;
      if (!content) return;
      for (const { file, item } of items) {
        try {
          await content.createArticle({
            category: 'news',
            title: title.trim() || file.name.replace(/\.[^.]+$/, ''),
            subtitle: '',
            summary: summary.trim() || `已上传资料：${file.name}`,
            content: summary.trim() || `${file.name} 已在「资料与数据」栏目上线。`,
            cover: '',
            author: author.trim(),
            source: '资料上传',
            eventDate: new Date().toISOString().slice(0, 10),
            tags: tags
              .split(/[,，\s]+/)
              .map((t) => t.trim())
              .filter(Boolean)
              .join(','),
            /** 关键：把资料下载地址写进附件字段，读者点开即下载原件 */
            fileUrl: resourcesApi.downloadUrl(item.id),
            linkUrl: '',
            sortIndex: 100,
            pinned: 0,
            status: 'published',
          });
        } catch (e) {
          window.alert(
            `资料「${file.name}」已成功入库，但创建对应资讯失败：${
              e instanceof Error ? e.message : '未知错误'
            }\n\n可稍后在「内容条目」里手工创建，或重新上传时勾选联动。`
          );
        }
      }
    },
    [title, summary, author, tags]
  );

  const clearDone = useCallback(() => {
    setQueue((prev) => prev.filter((q) => q.status !== 'done'));
  }, []);

  return (
    <div className='space-y-6'>
      <Panel
        title='一键上传资料'
        description='选择文件 → 勾选分类与访问级别 → 上传后自动入库，前台立即生效。'
        action={
          <AdminButton variant='outline' onClick={() => void loadOptions()}>
            <RefreshCw className='h-3.5 w-3.5' />
            刷新选项
          </AdminButton>
        }
      >
        {optionsError ? (
          <ErrorBox message={optionsError} />
        ) : !options ? (
          <p className='py-6 text-center text-sm text-gray-400'>正在加载上传选项…</p>
        ) : (
          <div className='space-y-5'>
            {/* 拖放区 */}
            <label
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed py-8 transition-colors',
                uploading
                  ? 'border-gray-200 bg-gray-50'
                  : 'border-brand-200 bg-brand-50/40 hover:border-brand-300 hover:bg-brand-50'
              )}
            >
              <FileUp className='h-7 w-7 text-brand-500' />
              <span className='text-sm font-medium text-brand-800'>
                点击选择文件，或把文件拖到这里
              </span>
              <span className='text-xs text-gray-400'>
                可多选 · 单文件上限 {options.maxSizeText} · 支持 PDF / 图片 / 表格 / 文档
              </span>
              <input
                type='file'
                multiple
                className='hidden'
                disabled={uploading}
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>

            {/* 分类与属性 */}
            <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
              <Field label='归档目录' hint='文件实际存放的位置（面向整理者）'>
                <SelectInput
                  value={categoryDir}
                  onChange={(e) => setCategoryDir(e.target.value)}
                >
                  {options.directories.map((d) => (
                    <option key={d} value={d}>
                      {d}
                      {options.restrictedDirs.includes(d) ? '（受限）' : ''}
                    </option>
                  ))}
                </SelectInput>
              </Field>

              <Field label='展示类目' hint='读者按这个类目找资料（面向读者）'>
                <SelectInput
                  value={displayCategory}
                  onChange={(e) => setDisplayCategory(e.target.value)}
                >
                  {options.displayCategories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                      {LIBRARY_HINTS.includes(c) ? '' : ' · 独立模块'}
                    </option>
                  ))}
                </SelectInput>
              </Field>

              <Field label='访问级别'>
                <SelectInput
                  value={accessLevel}
                  onChange={(e) => setAccessLevel(e.target.value as 'public' | 'member')}
                >
                  {options.accessLevels.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </SelectInput>
              </Field>
            </div>

            <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
              <Field label='标题（可选）' hint='留空则用文件名'>
                <TextInput
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder='如：2026 年三季度宏观研报'
                />
              </Field>
              <Field label={isProduction ? '作者 / 团队署名' : '来源 / 作者（可选）'}>
                <TextInput
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  placeholder={isProduction ? '如：研发部 张三' : '如：中金公司'}
                />
              </Field>
              <Field label='标签（可选）' hint='逗号或空格分隔'>
                <TextInput
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder='如：宏观, 债市'
                />
              </Field>
            </div>

            {isProduction ? (
              <Field label='作者身份' hint='部门、年级、指导教师等（仅「社团成员产出」使用）'>
                <TextInput
                  value={authorTitle}
                  onChange={(e) => setAuthorTitle(e.target.value)}
                  placeholder='如：研发部 2024 级'
                />
              </Field>
            ) : null}

            <Field label='简介（可选）'>
              <TextArea
                rows={2}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder='一句话说明这份资料的内容与用途'
              />
            </Field>

            {/* 联动创建资讯 */}
            <label className='flex items-start gap-3 rounded-lg border border-gray-100 bg-gray-50/60 p-3'>
              <input
                type='checkbox'
                checked={alsoCreateArticle}
                onChange={(e) => setAlsoCreateArticle(e.target.checked)}
                className='mt-0.5 h-4 w-4 rounded border-gray-300'
              />
              <span className='text-xs text-gray-600'>
                <span className='font-medium text-gray-800'>
                  同时在「财经时事」创建一篇资讯
                </span>
                <span className='mt-0.5 block text-gray-400'>
                  会把该资料的下载地址写入文章附件字段，读者在新闻页点开即可下载原件。
                </span>
              </span>
            </label>

            {/* 队列 */}
            {queue.length > 0 ? (
              <div className='space-y-2'>
                <div className='flex items-center justify-between'>
                  <p className='text-xs font-medium text-gray-600'>
                    待上传 {pending.length} 个 · 已完成{' '}
                    {queue.filter((q) => q.status === 'done').length} 个
                  </p>
                  <div className='flex items-center gap-2'>
                    <AdminButton variant='ghost' onClick={clearDone}>
                      清除已完成
                    </AdminButton>
                    <AdminButton variant='ghost' onClick={() => setQueue([])} disabled={uploading}>
                      <X className='h-3.5 w-3.5' />
                      清空列表
                    </AdminButton>
                  </div>
                </div>
                <ul className='divide-y divide-gray-50 rounded-lg border border-gray-100'>
                  {queue.map((q) => (
                    <QueueRow
                      key={q.id}
                      item={q}
                      onRemove={() =>
                        setQueue((prev) => prev.filter((x) => x.id !== q.id))
                      }
                      disabled={uploading}
                    />
                  ))}
                </ul>
              </div>
            ) : null}

            <div className='flex flex-wrap items-center gap-3'>
              <AdminButton
                onClick={() => void startUpload()}
                disabled={pending.length === 0 || uploading}
              >
                {uploading ? (
                  <Loader2 className='h-3.5 w-3.5 animate-spin' />
                ) : (
                  <Upload className='h-3.5 w-3.5' />
                )}
                {uploading ? '上传中…' : `开始上传（${pending.length}）`}
              </AdminButton>
              <p className='text-xs text-gray-400'>
                上传后自动重扫入库；分类写入覆写表，下次扫描不会被翻回去。
              </p>
            </div>
          </div>
        )}
      </Panel>

      <RescanPanel />
      <RecentUploads />
    </div>
  );
}

/* ───────────────────────── 队列行 ───────────────────────── */

function QueueRow({
  item,
  onRemove,
  disabled,
}: {
  item: QueueItem;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <li className='flex items-center gap-3 px-3 py-2.5 text-xs'>
      <span className='shrink-0'>
        {item.status === 'done' ? (
          <CheckCircle2 className='h-4 w-4 text-emerald-600' />
        ) : item.status === 'failed' ? (
          <AlertTriangle className='h-4 w-4 text-red-500' />
        ) : item.status === 'uploading' ? (
          <Loader2 className='h-4 w-4 animate-spin text-brand-500' />
        ) : (
          <FolderOpen className='h-4 w-4 text-gray-300' />
        )}
      </span>
      <span className='min-w-0 flex-1'>
        <span className='block truncate text-gray-700'>{item.file.name}</span>
        {item.status === 'failed' && item.message ? (
          <span className='mt-0.5 block truncate text-red-500'>{item.message}</span>
        ) : null}
        {item.status === 'done' && item.result ? (
          <span className='mt-0.5 block truncate text-emerald-700'>
            已入库 · {item.result.displayCategory}
          </span>
        ) : null}
      </span>
      <span className='num w-14 shrink-0 text-right text-gray-400'>
        {item.status === 'uploading' ? `${item.percent}%` : humanSize(item.file.size)}
      </span>
      {item.status === 'uploading' ? (
        <span className='h-1 w-16 shrink-0 overflow-hidden rounded-full bg-gray-100'>
          <span
            className='block h-full bg-brand-500 transition-[width] duration-200'
            style={{ width: `${item.percent}%` }}
          />
        </span>
      ) : null}
      <button
        type='button'
        onClick={onRemove}
        disabled={disabled}
        className='shrink-0 rounded p-1 text-gray-300 transition-colors hover:bg-gray-100 hover:text-gray-500 disabled:opacity-40'
        aria-label='移除'
      >
        <Trash2 className='h-3.5 w-3.5' />
      </button>
    </li>
  );
}

/* ───────────────────────── 重扫 ───────────────────────── */

function RescanPanel() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    try {
      const res = await adminResourcesApi.rescan();
      setResult(
        `入库 ${res.inserted} 条 · 更新 ${res.updated} 条 · 移除 ${res.removed} 条（库中共 ${res.total} 条）`
      );
    } catch (e) {
      setResult(e instanceof Error ? `失败：${e.message}` : '失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title='同步素材目录'
      description='若你直接往素材目录里放了文件（或删了文件），点这里让数据库与磁盘对齐。'
      action={
        <AdminButton variant='outline' onClick={() => void run()} disabled={busy}>
          <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
          {busy ? '扫描中…' : '重新扫描'}
        </AdminButton>
      }
    >
      {result ? (
        <p className='text-xs text-gray-600'>{result}</p>
      ) : (
        <p className='text-xs text-gray-400'>
          通常不需要手动执行 —— 通过本页上传的资料已自动入库。
        </p>
      )}
    </Panel>
  );
}

/* ───────────────────────── 最近入库 ───────────────────────── */

function RecentUploads() {
  const [items, setItems] = useState<ResourceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [options, setOptions] = useState<UploadOptions | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await resourcesApi.list({ sort: 'time', pageSize: 20 });
      setItems(res.items.slice(0, 20));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void adminResourcesApi
      .uploadOptions()
      .then(setOptions)
      .catch(() => setOptions(null));
  }, [load]);

  /** 改分类：写覆写表 + 重扫，改完不会被下次扫描翻回去 */
  const changeCategory = useCallback(
    async (item: ResourceItem, value: string) => {
      setBusyId(item.id);
      try {
        await adminResourcesApi.updateMeta(item.id, { displayCategory: value });
        await load();
      } catch (e) {
        window.alert(e instanceof Error ? e.message : '修改分类失败');
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const toggleAccess = useCallback(
    async (item: ResourceItem) => {
      setBusyId(item.id);
      try {
        await adminResourcesApi.updateMeta(item.id, {
          accessLevel: item.accessLevel === 'public' ? 'member' : 'public',
        });
        await load();
      } catch (e) {
        window.alert(e instanceof Error ? e.message : '修改访问级别失败');
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  return (
    <Panel
      title='最近入库'
      description='按入库时间倒序。可直接改展示类目与访问级别，改动会写入覆写表。'
      action={
        <AdminButton variant='outline' onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          刷新
        </AdminButton>
      }
    >
      {error ? (
        <ErrorBox message={error} />
      ) : items.length === 0 ? (
        <p className='py-6 text-center text-sm text-gray-400'>暂无资料。</p>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full min-w-[860px] text-sm'>
            <thead>
              <tr className='border-b border-gray-100 text-left text-xs text-gray-400'>
                <th className='pb-2 pr-4 font-medium'>名称</th>
                <th className='pb-2 pr-4 font-medium'>展示类目</th>
                <th className='pb-2 pr-4 font-medium'>访问级别</th>
                <th className='pb-2 pr-4 font-medium'>体积</th>
                <th className='pb-2 pr-4 font-medium'>入库时间</th>
                <th className='pb-2 font-medium'>链接</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className='border-b border-gray-50 last:border-0'>
                  <td className='max-w-[280px] py-3 pr-4'>
                    <span className='block truncate text-gray-800' title={it.name}>
                      {it.name}
                    </span>
                    <span className='mt-0.5 block truncate text-xs text-gray-400' title={it.category}>
                      归档于 {it.category}
                    </span>
                  </td>
                  <td className='py-3 pr-4'>
                    {options ? (
                      <SelectInput
                        value={it.displayCategory}
                        disabled={busyId === it.id}
                        onChange={(e) => void changeCategory(it, e.target.value)}
                        className='h-8 w-32 text-xs'
                      >
                        {options.displayCategories.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                        {options.displayCategories.includes(it.displayCategory) ? null : (
                          <option value={it.displayCategory}>{it.displayCategory}</option>
                        )}
                      </SelectInput>
                    ) : (
                      <span className='text-xs text-gray-600'>{it.displayCategory}</span>
                    )}
                  </td>
                  <td className='py-3 pr-4'>
                    <button
                      type='button'
                      onClick={() => void toggleAccess(it)}
                      disabled={busyId === it.id}
                      title='点击切换公开 / 仅成员'
                      className={cn(
                        'rounded px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50',
                        it.accessLevel === 'public'
                          ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                          : 'bg-amber-50 text-amber-800 hover:bg-amber-100'
                      )}
                    >
                      {it.accessLevel === 'public' ? '公开' : '仅成员'}
                    </button>
                  </td>
                  <td className='num py-3 pr-4 text-xs text-gray-400'>{it.sizeText}</td>
                  <td className='num py-3 pr-4 text-xs text-gray-400'>
                    {it.uploadedAt ? it.uploadedAt.slice(0, 10) : '—'}
                  </td>
                  <td className='py-3'>
                    <a
                      href={resourcesApi.previewUrl(it.id)}
                      target='_blank'
                      rel='noreferrer'
                      className='text-xs text-brand-700 hover:underline'
                    >
                      预览
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* ───────────────────────── 小组件 ───────────────────────── */

function ErrorBox({ message }: { message: string }) {
  return (
    <div className='flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700'>
      <AlertTriangle className='mt-0.5 h-4 w-4 shrink-0' />
      <div>
        <p className='font-medium'>加载失败</p>
        <p className='mt-1 text-xs'>{message}</p>
      </div>
    </div>
  );
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
