import type { ElementType, ReactNode } from 'react';
import { useInView } from '@/lib/useInView';
import { cn } from '@/lib/utils';

interface RevealProps {
  children: ReactNode;
  className?: string;
  /** 延迟毫秒数，用于列表错峰入场 */
  delay?: number;
  /** 入场方向 */
  from?: 'up' | 'down' | 'left' | 'right' | 'none';
  /** 渲染成什么标签 */
  as?: ElementType;
}

const FROM_STYLE: Record<NonNullable<RevealProps['from']>, string> = {
  up: 'translate3d(0, 26px, 0)',
  down: 'translate3d(0, -26px, 0)',
  left: 'translate3d(-30px, 0, 0)',
  right: 'translate3d(30px, 0, 0)',
  none: 'none',
};

/**
 * 滚动揭示容器：元素进入视口后淡入 + 位移归位。
 *
 * 用内联样式承载位移方向（避免为每个方向生成 Tailwind 类），
 * 过渡本身由 index.css 中的 `.reveal` 提供。
 */
export function Reveal({
  children,
  className,
  delay = 0,
  from = 'up',
  as: Tag = 'div',
}: RevealProps) {
  const { ref, inView } = useInView<HTMLDivElement>();

  return (
    <Tag
      ref={ref}
      data-visible={inView ? 'true' : 'false'}
      className={cn('reveal', className)}
      style={{
        transitionDelay: `${delay}ms`,
        ...(inView ? null : { transform: FROM_STYLE[from] }),
      }}
    >
      {children}
    </Tag>
  );
}

export default Reveal;
