import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

interface BorderBeamProps {
  className?: string;
  /** 一轮扫光时长（秒） */
  duration?: number;
}

/**
 * 边框流光：一道青→金高光沿卡片边缘循环扫过。
 *
 * 放在任意 `relative` + `overflow-hidden rounded-*` 的容器内即可，
 * 圆角与边框色由 `.beam-border` 继承容器样式。纯装饰，不参与交互。
 */
export function BorderBeam({ className, duration = 4 }: BorderBeamProps) {
  return (
    <span
      aria-hidden
      className={cn('beam-border', className)}
      style={{ '--beam-duration': `${duration}s` } as CSSProperties}
    />
  );
}

export default BorderBeam;
