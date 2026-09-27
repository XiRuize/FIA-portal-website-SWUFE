import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

interface SmartImageProps {
  src?: string;
  alt: string;
  className?: string;
  /** 兜底区域展示的文字（通常传标题） */
  fallbackText?: string;
  /** 兜底图案的色调种子 */
  seed?: string;
}

/** 由字符串派生一组稳定的兜底渐变色 */
function gradientOf(seed: string): string {
  const palettes = [
    'from-brand-800 via-brand-700 to-brand-500',
    'from-brand-900 via-brand-700 to-gold-600',
    'from-slate-800 via-brand-800 to-brand-600',
    'from-brand-700 via-brand-600 to-gold-500',
    'from-gold-700 via-brand-800 to-brand-900',
  ];
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 997;
  return palettes[h % palettes.length];
}

/**
 * 图片组件：加载失败或未配置图片时，降级为品牌渐变 + 文字兜底，
 * 避免出现破图，同时让「待补充配图」的条目依然美观。
 */
export function SmartImage({
  src,
  alt,
  className,
  fallbackText,
  seed = '',
}: SmartImageProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  const showFallback = !src || failed;

  if (showFallback) {
    return (
      <div
        className={cn(
          'flex items-center justify-center bg-gradient-to-br text-center',
          gradientOf(seed || fallbackText || alt),
          className
        )}
        aria-label={alt}
      >
        <span className='px-4 text-sm font-medium leading-relaxed text-white/90 sm:text-base'>
          {fallbackText || alt}
        </span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading='lazy'
      className={cn('object-cover', className)}
      onError={() => setFailed(true)}
    />
  );
}

export default SmartImage;
