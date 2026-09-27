/**
 * 「作品 / 资料」的通用操作：点赞、下载、分享。
 *
 * 为什么抽成独立模块：这些操作在**作品卡片**（列表页）与**作品详情页**上都要有，
 * 而且每一处都有各自容易踩的坑（乐观更新的回滚、分享的三层降级、
 * 下载不能新开空白页）。两处各写一遍必然漂移，其中一处迟早会漏掉回滚逻辑，
 * 表现为「点赞数字偶发对不上」——这类 bug 定位成本远高于抽象成本。
 */
import { useCallback, useState } from 'react';
import { resourcesApi, type ResourceItem } from './backendApi';

/** 下载：用隐藏的 `<a download>` 触发，避免新开一个空白标签页 */
export function downloadResource(item: ResourceItem): void {
  const a = document.createElement('a');
  a.href = resourcesApi.downloadUrl(item.id);
  a.download = item.fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/** 分享结果的去向，供界面给出对应提示 */
export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

/**
 * 分享：系统分享面板 → 剪贴板 → 手动复制，三层逐级降级。
 *
 * 为什么顺序如此：移动端的系统分享面板能直达微信/飞书，体验最好；
 * 桌面浏览器多数不支持 `navigator.share`，退回复制链接；
 * 而 `navigator.clipboard` 在**非 HTTPS** 环境下不可用（本地开发就常遇到），
 * 最后一层用 `prompt` 兜底，保证任何环境都有可用路径。
 *
 * @param item 要分享的作品
 * @param url 分享目标地址；省略则指向该作品的在线预览
 */
export async function shareResource(item: ResourceItem, url?: string): Promise<ShareOutcome> {
  const target = url ?? new URL(resourcesApi.previewUrl(item.id), window.location.origin).href;
  const shareData = {
    title: item.name,
    text: `${item.name}（${item.displayCategory || item.category}）`,
    url: target,
  };

  try {
    if (navigator.share && navigator.canShare?.(shareData)) {
      await navigator.share(shareData);
      return 'shared';
    }
  } catch (err) {
    // 用户主动取消不算失败，不要弹「复制成功」打扰
    if (err instanceof Error && err.name === 'AbortError') return 'cancelled';
  }

  try {
    await navigator.clipboard.writeText(target);
    return 'copied';
  } catch {
    // 非 HTTPS 或权限被拒：退回手动复制
    try {
      window.prompt('请手动复制以下链接：', target);
      return 'copied';
    } catch {
      return 'failed';
    }
  }
}

/** 点赞状态：乐观更新 + 失败回滚 + 以服务端返回为准 */
export interface LikeState {
  likes: number;
  liked: boolean;
  busy: boolean;
  toggle: () => Promise<void>;
}

/**
 * 点赞 / 取消点赞。
 *
 * 三条不可省的处理：
 * 1. **乐观更新**：点击后立刻改数字，否则弱网下会有明显的「点了没反应」；
 * 2. **失败回滚**：回滚到操作前的值，而不是简单地取反 —— 并发点击时取反会算错；
 * 3. **以服务端为准**：后端按客户端指纹去重，返回的计数可能与本地推测不同。
 *
 * @param item 目标作品
 * @param onChanged 计数变化后的回调，用于让父级列表同步，避免切排序后数字回退
 */
export function useResourceLike(
  item: ResourceItem,
  onChanged?: (id: number, likes: number, liked: boolean) => void
): LikeState {
  const [likes, setLikes] = useState(item.likes);
  const [liked, setLiked] = useState(item.liked);
  const [busy, setBusy] = useState(false);

  const toggle = useCallback(async () => {
    if (busy) return;
    const before = { likes, liked };
    const nextLiked = !liked;

    setLiked(nextLiked);
    setLikes(Math.max(0, likes + (nextLiked ? 1 : -1)));
    setBusy(true);

    try {
      const res = nextLiked
        ? await resourcesApi.like(item.id)
        : await resourcesApi.unlike(item.id);
      setLikes(res.likes);
      setLiked(res.liked);
      onChanged?.(item.id, res.likes, res.liked);
    } catch {
      // 回滚到操作前的快照
      setLikes(before.likes);
      setLiked(before.liked);
    } finally {
      setBusy(false);
    }
  }, [busy, liked, likes, item.id, onChanged]);

  return { likes, liked, busy, toggle };
}

/** 把 ISO 时间说成人话（与资料列表口径一致） */
export function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 0) return iso.slice(0, 10);
  const day = 86_400_000;
  if (diff < 3_600_000) return '刚刚';
  if (diff < day) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return iso.slice(0, 10);
}
