import { useCallback, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface SpotlightCardProps {
  children: ReactNode;
  className?: string;
  /** 光斑颜色（rgba 字符串） */
  color?: string;
  /** 光斑半径（px） */
  radius?: number;
}

/**
 * 光斑跟随卡片：鼠标在卡片上移动时，径向渐变光晕跟随光标。
 *
 * 通过写 CSS 变量（--mx / --my）避免每帧触发 React 重渲染，
 * 光斑层 `pointer-events-none` 且不参与布局，纯装饰。
 */
export function SpotlightCard({
  children,
  className,
  color = 'rgba(248, 87, 74, 0.13)',
  radius = 320,
}: SpotlightCardProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  const onMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    node.style.setProperty('--mx', `${event.clientX - rect.left}px`);
    node.style.setProperty('--my', `${event.clientY - rect.top}px`);
  }, []);

  return (
    <div
      ref={ref}
      onMouseMove={onMove}
      className={cn('group/spot relative overflow-hidden', className)}
    >
      <span
        aria-hidden
        className='pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover/spot:opacity-100'
        style={{
          background: `radial-gradient(${radius}px circle at var(--mx, 50%) var(--my, 0%), ${color}, transparent 68%)`,
        }}
      />
      {children}
    </div>
  );
}

export default SpotlightCard;
