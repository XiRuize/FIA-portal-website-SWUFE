/**
 * 资料条目行：**左侧名称，右侧四个按钮**（点赞 / 预览 / 下载 / 分享）。
 *
 * 交互细节上刻意处理的几件事：
 * 1. **点赞是乐观更新**：点击后立刻改数字，失败再回滚。若等接口返回再变，
 *    在弱网下会有明显的「点了没反应」。后端按客户端指纹去重，重复点击不会刷量。
 * 2. **分享降级**：优先用系统分享面板（移动端体验好），不支持时退回复制链接，
 *    复制失败再用 prompt 兜底。三层降级保证任何环境都有可用路径。
 * 3. **受限资料有明确标识**：需要登录才可见的条目带锁形标记，
 *    避免成员误以为可以外发。
 */
import { useState } from 'react';
import {
  AlertTriangle,
  Check,
  Download,
  Eye,
  Heart,
  Link2,
  Lock,
  Share2,
} from 'lucide-react';
import { resourcesApi, type ResourceItem } from '@/lib/backendApi';
import { relativeTime } from '@/lib/resourceActions';
import { cn } from '@/lib/utils';
import ResourceGlyph from './ResourceGlyph';

interface Props {
  item: ResourceItem;
  /** 点赞成功后把最新计数回传父级，保持列表与卡片一致 */
  onLiked?: (id: number, likes: number, liked: boolean) => void;
}

export function ResourceRow({ item, onLiked }: Props) {
  const [likes, setLikes] = useState(item.likes);
  const [liked, setLiked] = useState(item.liked);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);

  const restricted = item.accessLevel === 'member';

  const flash = (text: string, ok = true) => {
    setToast({ text, ok });
    setTimeout(() => setToast(null), 2200);
  };

  /** 点赞 / 取消：乐观更新，失败回滚 */
  const toggleLike = async () => {
    if (busy) return;
    const nextLiked = !liked;
    const nextLikes = Math.max(0, likes + (nextLiked ? 1 : -1));

    // 先改界面，让点击立即有反馈
    setLiked(nextLiked);
    setLikes(nextLikes);
    setBusy(true);

    try {
      const res = nextLiked ? await resourcesApi.like(item.id) : await resourcesApi.unlike(item.id);
      // 以服务端返回为准（可能因为去重而与本地推测不同）
      setLikes(res.likes);
      setLiked(res.liked);
      onLiked?.(item.id, res.likes, res.liked);
    } catch (err) {
      // 回滚
      setLiked(liked);
      setLikes(likes);
      flash(err instanceof Error ? err.message : '操作失败', false);
    } finally {
      setBusy(false);
    }
  };

  /** 预览：新标签页打开，浏览器内置 PDF 阅读器可直接翻页 */
  const preview = () => {
    window.open(resourcesApi.previewUrl(item.id), '_blank', 'noopener,noreferrer');
  };

  /** 下载：用隐藏的 <a download> 触发，避免新开空白页 */
  const download = () => {
    const a = document.createElement('a');
    a.href = resourcesApi.downloadUrl(item.id);
    a.download = item.fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  /** 分享：系统分享面板 → 复制链接 → 手动复制，逐级降级 */
  const share = async () => {
    const url = new URL(resourcesApi.previewUrl(item.id), window.location.origin).href;
    const shareData = {
      title: item.name,
      text: `${item.name}（${item.category}）`,
      url,
    };

    try {
      if (navigator.share && navigator.canShare?.(shareData)) {
        await navigator.share(shareData);
        return;
      }
    } catch (err) {
      // 用户主动取消分享不算失败，直接返回，不要弹「复制成功」打扰
      if (err instanceof Error && err.name === 'AbortError') return;
    }

    try {
      await navigator.clipboard.writeText(url);
      flash('链接已复制，可粘贴分享');
    } catch {
      // clipboard 在非 HTTPS 环境不可用，退回手动复制
      window.prompt('请手动复制以下链接：', url);
    }
  };

  return (
    <div className='group relative flex flex-col gap-3 rounded-xl border border-ink-900/10 bg-white p-4 shadow-card transition-all duration-300 ease-smooth hover:border-flare-200 hover:shadow-glow-flare sm:flex-row sm:items-center sm:gap-4'>
      {/* 左侧：图标 + 名称 */}
      <div className='flex min-w-0 flex-1 items-start gap-3'>
        <ResourceGlyph ext={item.ext} />

        <div className='min-w-0 flex-1'>
          <div className='flex flex-wrap items-center gap-2'>
            <h3 className='truncate text-sm font-medium text-ink-900' title={item.name}>
              {item.name}
            </h3>
            {restricted ? (
              <span className='inline-flex shrink-0 items-center gap-1 rounded-md border border-gold-200 bg-gold-50 px-1.5 py-0.5 text-[10px] text-gold-700'>
                <Lock className='h-2.5 w-2.5' />
                仅成员
              </span>
            ) : null}
          </div>

          <div className='mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-400'>
            <span className='num uppercase'>{item.ext || 'file'}</span>
            <span className='num'>{item.sizeText}</span>
            <span>{relativeTime(item.uploadedAt)}</span>
            <span className='text-ink-300'>{item.category}</span>
          </div>
        </div>
      </div>

      {/* 右侧：四个按钮 */}
      <div className='flex shrink-0 items-center gap-1.5 sm:gap-2'>
        {/* 点赞 */}
        <button
          type='button'
          onClick={() => void toggleLike()}
          disabled={busy}
          title={liked ? '取消点赞' : '点赞'}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-medium transition-all duration-200',
            liked
              ? 'border-flare-200 bg-flare-50 text-flare-600'
              : 'border-ink-900/10 bg-white text-ink-500 hover:border-flare-200 hover:text-flare-600',
            busy && 'opacity-60'
          )}
        >
          <Heart className={cn('h-3.5 w-3.5', liked && 'fill-current')} />
          <span className='num tabular-nums'>{likes}</span>
        </button>

        {/* 预览 */}
        <button
          type='button'
          onClick={preview}
          title='在线预览'
          className='inline-flex items-center gap-1.5 rounded-lg border border-ink-900/10 bg-white px-3 py-2 text-xs font-medium text-ink-600 transition-all duration-200 hover:border-brand-300 hover:text-brand-700'
        >
          <Eye className='h-3.5 w-3.5' />
          <span className='hidden sm:inline'>预览</span>
        </button>

        {/* 下载 */}
        <button
          type='button'
          onClick={download}
          title='下载文件'
          className='inline-flex items-center gap-1.5 rounded-lg border border-ink-900/10 bg-white px-3 py-2 text-xs font-medium text-ink-600 transition-all duration-200 hover:border-brand-300 hover:text-brand-700'
        >
          <Download className='h-3.5 w-3.5' />
          <span className='hidden sm:inline'>下载</span>
        </button>

        {/* 分享 */}
        <button
          type='button'
          onClick={() => void share()}
          title='分享链接'
          className='inline-flex items-center gap-1.5 rounded-lg border border-ink-900/10 bg-white px-3 py-2 text-xs font-medium text-ink-600 transition-all duration-200 hover:border-brand-300 hover:text-brand-700'
        >
          <Share2 className='h-3.5 w-3.5' />
          <span className='hidden sm:inline'>分享</span>
        </button>
      </div>

      {/* 轻提示 */}
      {toast ? (
        <div
          className={cn(
            'absolute -top-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] shadow-card',
            toast.ok
              ? 'border-brand-200 bg-brand-50 text-brand-700'
              : 'border-flare-200 bg-flare-50 text-flare-700'
          )}
        >
          {toast.ok ? <Check className='h-3 w-3' /> : <AlertTriangle className='h-3 w-3' />}
          {toast.text}
        </div>
      ) : null}

      {/* 分享时的链接图标提示（视觉呼应，无交互） */}
      <Link2 className='pointer-events-none absolute right-2 top-2 h-3 w-3 text-ink-200 opacity-0 transition-opacity group-hover:opacity-100' />
    </div>
  );
}

export default ResourceRow;
