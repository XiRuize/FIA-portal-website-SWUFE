import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface MarqueeProps {
  children: ReactNode;
  className?: string;
  /** 一轮动画时长（秒） */
  duration?: number;
  /** 是否反向滚动 */
  reverse?: boolean;
  /** 两侧渐隐遮罩 */
  fade?: boolean;
}

/**
 * 无限跑马灯：内容渲染两份（两个并列 track），轨道左移**一个完整周期**后无缝衔接。
 *
 * ⚠️ 无缝的关键在关键帧的位移量，见 **`src/index.css`** 的 `@keyframes marquee`：
 * 必须是 `translateX(-100%)`。写成 -50% 时位移只有半个周期，
 * 每轮循环会硬跳半屏（这个坑已踩过，别改回去）。
 *
 * ⚠️ 关键帧**必须定义在 `src/index.css` 的原始 CSS 里**，不能放回
 * `tailwind.config.js` 的 `theme.extend.keyframes` —— Tailwind 只为**被
 * `animate-*` 工具类引用**的关键帧产出 `@keyframes`，而本组件因时长要按内容长度
 * 动态计算，用的是**内联** `animation`，全程没有 `animate-marquee` 类，
 * 于是产物里根本不会有 `@keyframes marquee`，表现为**全站跑马灯静止且无报错**。
 *
 * 悬停暂停（`.marquee-track:hover`），鼠标移开继续滚动。
 */
export function Marquee({
  children,
  className,
  duration = 42,
  reverse = false,
  fade = true,
}: MarqueeProps) {
  // 只建一次动画字符串：两份内容必须严格同速同相，否则接缝处会错位
  const animation = `${reverse ? 'marquee2' : 'marquee'} ${duration}s linear infinite`;

  return (
    <div
      className={cn('relative flex overflow-hidden', fade && 'mask-fade-x', className)}
    >
      <div
        className='marquee-track flex min-w-full shrink-0 items-center gap-8 pr-8'
        style={{ animation }}
      >
        {children}
        <span className='sr-only'>（内容循环滚动）</span>
      </div>
      <div
        aria-hidden
        className='marquee-track flex min-w-full shrink-0 items-center gap-8 pr-8'
        style={{ animation }}
      >
        {children}
      </div>
    </div>
  );
}

export default Marquee;
