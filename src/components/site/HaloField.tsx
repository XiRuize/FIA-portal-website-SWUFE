import { cn } from '@/lib/utils';

interface HaloFieldProps {
  className?: string;
  /** 是否叠加工程网格底纹 */
  grid?: boolean;
  /** 网格疏密 */
  gridSize?: 'sm' | 'lg';
  /** 整体强度，0–1 */
  intensity?: number;
  /**
   * 光斑是否漂移。
   * 首屏 Hero 用 `true` 制造动感；铺满整页的全局底噪用 `false`，
   * 避免长页面滚动时持续重绘大面积模糊层。
   */
  animated?: boolean;
}

/**
 * 浅红晕圈背景场：几团缓慢漂移的柔光 + 可选网格底纹。
 *
 * 纯装饰层，固定 `pointer-events-none`，由父级负责定位（通常 `absolute inset-0`）。
 * 模糊用 CSS `blur()`，不用 SVG filter，移动端性能更稳。
 */
export function HaloField({
  className,
  grid = true,
  gridSize = 'lg',
  intensity = 1,
  animated = true,
}: HaloFieldProps) {
  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 overflow-hidden',
        className
      )}
    >
      <div className='absolute inset-0' style={{ opacity: intensity }}>
        {/* 浅红主光 */}
        <span
          className={cn(
            'absolute -left-[12%] -top-[18%] h-[42rem] w-[42rem] rounded-full bg-flare-300/30 blur-[110px]',
            animated && 'animate-halo-a'
          )}
        />
        {/* 暖金辅光，保留协会的学院气质 */}
        <span
          className={cn(
            'absolute -right-[10%] top-[6%] h-[34rem] w-[34rem] rounded-full bg-gold-200/40 blur-[120px]',
            animated && 'animate-halo-b'
          )}
        />
        {/* 浅粉点缀光 */}
        <span
          className={cn(
            'absolute bottom-[-24%] left-[28%] h-[30rem] w-[30rem] rounded-full bg-flare-200/45 blur-[130px]',
            animated && 'animate-halo-c'
          )}
        />
      </div>

      {grid ? (
        <div
          className={cn(
            'absolute inset-0 bg-grid',
            gridSize === 'sm' ? 'bg-grid-sm' : 'bg-grid'
          )}
        />
      ) : null}

      {/* 底部渐隐，避免与下一区块生硬衔接 */}
      <div className='absolute inset-x-0 bottom-0 h-32 bg-gradient-to-b from-transparent to-white' />
    </div>
  );
}

export default HaloField;
