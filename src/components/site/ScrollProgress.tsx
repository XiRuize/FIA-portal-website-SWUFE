import { useEffect, useState } from 'react';

/**
 * 顶部阅读进度条：青色→金色渐变，随页面滚动从左向右生长。
 *
 * 用 rAF 节流读取 `scrollY`，避免高频 scroll 事件造成的布局抖动。
 */
export function ScrollProgress() {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let raf = 0;

    const update = () => {
      raf = 0;
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      setProgress(max > 0 ? Math.min(1, doc.scrollTop / max) : 0);
    };

    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      aria-hidden
      className='fixed inset-x-0 top-0 z-[70] h-0.5 bg-transparent'
    >
      <div
        className='h-full origin-left bg-gradient-to-r from-flare-400 via-flare-500 to-gold-500 shadow-[0_0_12px_rgba(248,87,74,0.55)] transition-[transform] duration-150 ease-out'
        style={{ transform: `scaleX(${progress})` }}
      />
    </div>
  );
}

export default ScrollProgress;
