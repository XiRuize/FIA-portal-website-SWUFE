/**
 * 作品详情页（`/#/production/:id`）。
 *
 * 页面结构按「读者先关心什么」排序：
 * 作品是什么（标题/类型/简介）→ 谁做的（作者卡）→ 长什么样（截图与内嵌预览）
 * → 拿去用（下载/分享/点赞）。
 *
 * 权限说明：本页整体在 `RequireAuth` 之内，但**真正的准入判定仍在后端**
 * ——受限作品的文件流只对有效会话开放，绕过前端守卫也拿不到内容。
 * 这里对 401/403 的处理只是「把话说清楚」，不是安全边界。
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  Download,
  ExternalLink,
  FileText,
  Heart,
  Loader2,
  Lock,
  Share2,
  UserRound,
} from 'lucide-react';
import PageHero from '@/components/site/PageHero';
import Reveal from '@/components/site/Reveal';
import ResourceGlyph, { isImageExt, isInlinePreviewable, labelForExt } from '@/components/site/ResourceGlyph';
import { ApiError, resourcesApi, type ResourceItem } from '@/lib/backendApi';
import { downloadResource, relativeTime, shareResource, useResourceLike } from '@/lib/resourceActions';
import { cn } from '@/lib/utils';

/** 详情页里作品为空时的兜底文案 */
const EMPTY = '待补充。';

/**
 * 归一化后端返回的条目。
 *
 * 详情页有好几处直接读 `tags.length` / `screenshots.length`，只要这两个字段
 * 因为任何原因（历史数据、接口形状变动、序列化丢字段）不是数组，整个页面就会
 * 抛 `Cannot read properties of undefined (reading 'length')` 白屏。
 * 与其在每个使用点都写 `?? []`，不如在入口处一次性收口。
 */
function normalize(item: ResourceItem): ResourceItem {
  return {
    ...item,
    tags: Array.isArray(item.tags) ? item.tags : [],
    screenshots: Array.isArray(item.screenshots) ? item.screenshots : [],
  };
}

export function ProductionDetail() {
  const { id } = useParams<{ id: string }>();
  const numericId = Number(id);

  const [item, setItem] = useState<ResourceItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    if (!Number.isInteger(numericId) || numericId <= 0) {
      setError('作品编号非法');
      setErrorCode('INVALID_ID');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    setErrorCode('');
    try {
      const data = await resourcesApi.detail(numericId);
      setItem(normalize(data));
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorCode(err.code);
        setError(
          err.status === 401
            ? '该作品仅对已登录成员开放，请先登录后查看。'
            : err.status === 403
              ? '当前账号没有查看该作品的权限，可在「登录」页找到申请方式。'
              : err.message
        );
      } else {
        setError(String(err));
      }
      setItem(null);
    } finally {
      setLoading(false);
    }
  }, [numericId]);

  useEffect(() => {
    void load();
  }, [load]);

  const flash = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(''), 2200);
  };

  const share = async () => {
    if (!item) return;
    const outcome = await shareResource(item, `${window.location.origin}/#/production/${item.id}`);
    if (outcome === 'copied') flash('作品链接已复制，可粘贴分享');
    else if (outcome === 'failed') flash('分享失败，请手动复制地址栏链接');
  };

  if (loading) {
    return (
      <div className='mx-auto flex max-w-4xl items-center gap-2 px-4 py-24 text-sm text-ink-400'>
        <Loader2 className='h-4 w-4 animate-spin' />
        正在载入作品…
      </div>
    );
  }

  if (!item) {
    return (
      <div className='mx-auto max-w-3xl px-4 py-24'>
        <div className='flex items-start gap-3 rounded-2xl border border-flare-200 bg-flare-50 p-5'>
          <AlertTriangle className='mt-0.5 h-5 w-5 shrink-0 text-flare-600' />
          <div>
            <p className='text-sm font-medium text-flare-800'>
              {errorCode === 'NOT_FOUND' ? '作品不存在' : '无法打开作品'}
            </p>
            <p className='mt-1 text-xs leading-relaxed text-flare-700'>
              {errorCode === 'UNAUTHENTICATED' || errorCode === 'FORBIDDEN' ? (
                <>
                  {error}
                  <Link
                    to={`/login?next=/production/${numericId}`}
                    className='ml-1 font-medium underline underline-offset-2'
                  >
                    前往登录
                  </Link>
                </>
              ) : (
                error
              )}
            </p>
            <Link
              to='/productions'
              className='mt-3 inline-flex items-center gap-1 text-xs font-medium text-flare-700 underline underline-offset-2'
            >
              <ArrowLeft className='h-3.5 w-3.5' />
              返回社团成员产出
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return <WorkDetailBody item={item} toast={toast} onShare={() => void share()} />;
}

/** 详情正文（拆出来是为了让上面那段加载/错误分支保持扁平） */
function WorkDetailBody({
  item,
  toast,
  onShare,
}: {
  item: ResourceItem;
  toast: string;
  onShare: () => void;
}) {
  const { likes, liked, busy, toggle } = useResourceLike(item);
  const restricted = item.accessLevel === 'member';
  const canPreview = isInlinePreviewable(item.ext);
  const isPdf = String(item.ext).toLowerCase() === 'pdf';
  const isImage = isImageExt(item.ext);

  return (
    <div>
      <PageHero
        kicker={`${labelForExt(item.ext)} · 社团成员产出`}
        title={item.name}
        aside={
          <Link
            to='/productions'
            className='inline-flex items-center gap-1.5 rounded-lg border border-ink-900/10 bg-white px-3 py-1.5 text-xs text-ink-500 shadow-card transition-colors hover:text-ink-800'
          >
            <ArrowLeft className='h-3.5 w-3.5' />
            返回列表
          </Link>
        }
      >
        <div className='mt-6 flex flex-wrap items-center gap-3'>
          <span className='inline-flex items-center gap-1.5 rounded-full border border-flare-200 bg-flare-50 px-3 py-1 text-xs font-medium text-flare-700'>
            <UserRound className='h-3.5 w-3.5' />
            {item.author || '作者待补充'}
            {item.authorTitle ? <span className='text-flare-600'>· {item.authorTitle}</span> : null}
          </span>
          <span className='num inline-flex items-center gap-1.5 text-xs text-ink-400'>
            <CalendarDays className='h-3.5 w-3.5' />
            {relativeTime(item.uploadedAt)}
          </span>
          <span className='num text-xs text-ink-400'>{item.sizeText}</span>
          {restricted ? (
            <span className='inline-flex items-center gap-1 rounded-full border border-gold-200 bg-gold-50 px-2.5 py-1 text-[11px] text-gold-700'>
              <Lock className='h-2.5 w-2.5' />
              仅成员
            </span>
          ) : null}
        </div>
      </PageHero>

      <section className='mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-14'>
        {/* 操作条 */}
        <div className='flex flex-wrap items-center gap-2.5'>
          <button
            type='button'
            onClick={() => void toggle()}
            disabled={busy}
            className={cn(
              'inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-xs font-medium transition-all duration-200',
              liked
                ? 'border-flare-200 bg-flare-50 text-flare-600'
                : 'border-ink-900/10 bg-white text-ink-600 hover:border-flare-200 hover:text-flare-600',
              busy && 'opacity-60'
            )}
          >
            <Heart className={cn('h-4 w-4', liked && 'fill-current')} />
            {liked ? '已点赞' : '点赞'}
            <span className='num tabular-nums'>{likes}</span>
          </button>

          <button
            type='button'
            onClick={() => downloadResource(item)}
            className='inline-flex items-center gap-2 rounded-lg border border-flare-200 bg-flare-50 px-3.5 py-2 text-xs font-medium text-flare-700 transition-colors hover:bg-flare-100'
          >
            <Download className='h-4 w-4' />
            下载作品
          </button>

          <button
            type='button'
            onClick={onShare}
            className='inline-flex items-center gap-2 rounded-lg border border-ink-900/10 bg-white px-3.5 py-2 text-xs font-medium text-ink-600 transition-colors hover:border-brand-300 hover:text-brand-700'
          >
            <Share2 className='h-4 w-4' />
            分享
          </button>

          {canPreview ? (
            <a
              href={resourcesApi.previewUrl(item.id)}
              target='_blank'
              rel='noreferrer'
              className='inline-flex items-center gap-2 rounded-lg border border-ink-900/10 bg-white px-3.5 py-2 text-xs font-medium text-ink-600 transition-colors hover:border-brand-300 hover:text-brand-700'
            >
              <ExternalLink className='h-4 w-4' />
              新窗口打开
            </a>
          ) : null}

          {toast ? (
            <span className='rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5 text-[11px] text-brand-700'>
              {toast}
            </span>
          ) : null}
        </div>

        <div className='mt-8 grid gap-8 lg:grid-cols-[1fr_320px]'>
          {/* 左：简介 + 截图 + 预览 */}
          <div className='min-w-0 space-y-8'>
            <Reveal>
              <div className='rounded-2xl border border-ink-900/[0.07] bg-white p-6 shadow-card'>
                <h2 className='text-sm font-semibold text-ink-900'>作品简介</h2>
                <p className='mt-3 whitespace-pre-line text-sm leading-7 text-ink-600'>
                  {item.summary || EMPTY}
                </p>

                {item.tags.length ? (
                  <div className='mt-5 flex flex-wrap gap-1.5'>
                    {item.tags.map((tag) => (
                      <span
                        key={tag}
                        className='rounded-full border border-ink-900/[0.07] bg-ink-50 px-2.5 py-1 text-xs text-ink-500'
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </Reveal>

            {/* 截图与报表 */}
            {item.screenshots.length ? (
              <Reveal>
                <div>
                  <h2 className='text-sm font-semibold text-ink-900'>作品截图与报表</h2>
                  <div className='mt-4 grid gap-4 sm:grid-cols-2'>
                    {item.screenshots.map((shot, i) => (
                      <figure
                        key={`${shot.url}-${i}`}
                        className='overflow-hidden rounded-xl border border-ink-900/[0.07] bg-white shadow-card'
                      >
                        <img
                          src={shot.url}
                          alt={shot.caption || `${item.name} 截图 ${i + 1}`}
                          loading='lazy'
                          className='w-full bg-ink-50 object-contain'
                        />
                        {shot.caption ? (
                          <figcaption className='border-t border-ink-900/[0.07] px-3 py-2 text-[11px] text-ink-500'>
                            {shot.caption}
                          </figcaption>
                        ) : null}
                      </figure>
                    ))}
                  </div>
                </div>
              </Reveal>
            ) : null}

            {/* 内嵌预览 */}
            <Reveal>
              <div>
                <h2 className='text-sm font-semibold text-ink-900'>在线预览</h2>
                <div className='mt-4 overflow-hidden rounded-2xl border border-ink-900/[0.07] bg-white shadow-card'>
                  {isPdf ? (
                    <iframe
                      src={`${resourcesApi.previewUrl(item.id)}#page=1&view=FitH`}
                      title={`${item.name} 在线预览`}
                      className='h-[560px] w-full'
                    />
                  ) : isImage ? (
                    <img
                      src={resourcesApi.previewUrl(item.id)}
                      alt={item.name}
                      className='max-h-[560px] w-full bg-ink-50 object-contain'
                    />
                  ) : (
                    <div className='flex flex-col items-center gap-3 px-6 py-14 text-center'>
                      <ResourceGlyph ext={item.ext} className='h-14 w-14 rounded-xl' iconClassName='h-7 w-7' />
                      <p className='text-sm text-ink-600'>
                        {labelForExt(item.ext)} 文件不支持浏览器内联预览
                      </p>
                      <p className='max-w-md text-xs leading-relaxed text-ink-400'>
                        请下载后用本地应用打开。压缩包内通常包含多个文档，建议解压后按目录阅读。
                      </p>
                      <button
                        type='button'
                        onClick={() => downloadResource(item)}
                        className='mt-1 inline-flex items-center gap-2 rounded-lg border border-flare-200 bg-flare-50 px-3.5 py-2 text-xs font-medium text-flare-700 transition-colors hover:bg-flare-100'
                      >
                        <Download className='h-4 w-4' />
                        下载文件
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </Reveal>
          </div>

          {/* 右：作者卡 + 文件信息 */}
          <aside className='space-y-6'>
            <Reveal from='right'>
              <div className='rounded-2xl border border-ink-900/[0.07] bg-white p-5 shadow-card'>
                <h2 className='text-sm font-semibold text-ink-900'>关于作者</h2>
                <div className='mt-4 flex items-center gap-3'>
                  <span className='flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-flare-200 bg-flare-50 text-sm font-semibold text-flare-700'>
                    {(item.author || '待').slice(0, 1)}
                  </span>
                  <div className='min-w-0'>
                    <p className='truncate text-sm font-medium text-ink-900'>
                      {item.author || '作者待补充'}
                    </p>
                    <p className='truncate text-xs text-ink-400'>
                      {item.authorTitle || '协会成员'}
                    </p>
                  </div>
                </div>
                <p className='mt-4 text-xs leading-6 text-ink-500'>{item.authorNote || EMPTY}</p>
              </div>
            </Reveal>

            <Reveal from='right' delay={80}>
              <div className='rounded-2xl border border-ink-900/[0.07] bg-white p-5 shadow-card'>
                <h2 className='text-sm font-semibold text-ink-900'>文件信息</h2>
                <dl className='mt-4 space-y-3 text-xs'>
                  <Row label='文件名' value={item.fileName} mono />
                  <Row label='类型' value={`${labelForExt(item.ext)}（.${item.ext}）`} />
                  <Row label='体积' value={item.sizeText} />
                  <Row label='更新时间' value={item.uploadedAt.slice(0, 10)} />
                  <Row label='浏览权限' value={restricted ? '仅成员' : '公开'} />
                  <Row label='所属目录' value={item.category} />
                </dl>
              </div>
            </Reveal>

            <Reveal from='right' delay={140}>
              <div className='flex items-start gap-2.5 rounded-2xl border border-gold-200 bg-gold-50 p-4'>
                <FileText className='mt-0.5 h-4 w-4 shrink-0 text-gold-600' />
                <p className='text-[11px] leading-6 text-gold-800'>
                  作品版权归协会与作者所有，仅供校内学习交流，请勿外传或用于商业用途。
                  引用时请注明作者与来源。
                </p>
              </div>
            </Reveal>
          </aside>
        </div>
      </section>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className='flex items-start justify-between gap-3'>
      <dt className='shrink-0 text-ink-400'>{label}</dt>
      <dd className={cn('min-w-0 break-all text-right text-ink-800', mono && 'num')}>{value}</dd>
    </div>
  );
}

export default ProductionDetail;
