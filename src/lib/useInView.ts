import { useEffect, useRef, useState } from 'react';

interface UseInViewOptions {
  /** 触发比例，默认 0.15 */
  threshold?: number;
  /** 提前/延后触发的根边距，默认底部内缩 10% 让元素真正进入视野才触发 */
  rootMargin?: string;
  /** 已经进入过视口后是否继续监听（默认 false，只触发一次） */
  repeat?: boolean;
}

/**
 * 判断元素是否进入视口。
 *
 * 统一封装 IntersectionObserver，供 Reveal / CountUp 等动效组件复用；
 * 当环境不支持 IntersectionObserver 时退化为「直接可见」，保证内容不会消失。
 */
export function useInView<T extends HTMLElement = HTMLDivElement>({
  threshold = 0.15,
  rootMargin = '0px 0px -10% 0px',
  repeat = false,
}: UseInViewOptions = {}) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // 兜底：老浏览器直接展示
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setInView(true);
            if (!repeat) observer.unobserve(entry.target);
          } else if (repeat) {
            setInView(false);
          }
        });
      },
      { threshold, rootMargin }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold, rootMargin, repeat]);

  return { ref, inView };
}

/** 是否偏好减少动效（无障碍） */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
