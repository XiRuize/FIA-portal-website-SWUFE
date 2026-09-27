import { useCallback, useEffect, useRef, useState } from 'react';

/** 一次点击/拖动产生的扩散晕圈 */
interface Ripple {
  id: number;
  x: number;
  y: number;
  /** 拖动轨迹上的晕圈更小 */
  small: boolean;
}

/** 指针静止多久后收起跟随光斑（毫秒） */
const IDLE_HIDE_MS = 1800;
/** 按住拖动时，轨迹晕圈的最小间隔（毫秒） */
const TRAIL_INTERVAL_MS = 140;
/** 同时存在的晕圈上限，防止快速拖动时堆积 */
const MAX_RIPPLES = 6;
/** 晕圈生命周期，与 haloRipple 动画时长保持一致 */
const RIPPLE_LIFE_MS = 900;

/**
 * 指针晕圈层：白底上的浅红柔光。
 *
 * - **移动**：一团柔光跟随指针；
 * - **点击**：从落点扩散出一圈晕圈；
 * - **按住拖动**：晕圈收紧变亮，并沿轨迹留下渐隐的晕圈。
 *
 * 实现要点：
 * - 跟随光斑直接写 `transform`（不走 React 状态），避免每次移动都触发重渲染；
 * - 整层 `pointer-events-none`，不拦截任何点击；
 * - 触屏设备没有光标，只保留点击/拖动晕圈；
 * - 尊重 `prefers-reduced-motion`（该偏好下 CSS 会直接隐藏晕圈层）。
 */
export function PointerHalo() {
  const followRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef(0);
  const pointRef = useRef({ x: 0, y: 0 });
  const idleRef = useRef<number | null>(null);
  const pressedRef = useRef(false);
  const lastTrailRef = useRef(0);
  const seqRef = useRef(0);
  const timersRef = useRef<Set<number>>(new Set());

  const [ripples, setRipples] = useState<Ripple[]>([]);

  const addRipple = useCallback((x: number, y: number, small: boolean) => {
    seqRef.current += 1;
    const id = seqRef.current;
    setRipples((prev) => [...prev, { id, x, y, small }].slice(-MAX_RIPPLES));

    const timer = window.setTimeout(() => {
      timersRef.current.delete(timer);
      setRipples((prev) => prev.filter((r) => r.id !== id));
    }, RIPPLE_LIFE_MS);
    timersRef.current.add(timer);
  }, []);

  // 卸载时清掉所有在途定时器，避免泄漏
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      timers.clear();
    };
  }, []);

  useEffect(() => {
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;

    // 触屏设备没有光标，跟随光斑没有意义，只保留点击/拖动晕圈
    const hasFinePointer =
      typeof window.matchMedia !== 'function' ||
      window.matchMedia('(pointer: fine)').matches;

    const follow = followRef.current;

    const hideFollow = () => {
      if (follow) {
        follow.dataset.active = 'false';
        follow.dataset.pressed = 'false';
      }
    };

    /** 显示跟随光斑并重置收起计时器 */
    const showFollow = () => {
      if (!follow || !hasFinePointer) return;
      follow.dataset.active = 'true';
      if (idleRef.current !== null) window.clearTimeout(idleRef.current);
      idleRef.current = window.setTimeout(() => {
        // 按住拖动期间不收起
        if (!pressedRef.current) hideFollow();
      }, IDLE_HIDE_MS);
    };

    const moveFollowTo = (x: number, y: number) => {
      if (!follow || !hasFinePointer) return;
      follow.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    };

    const onMove = (e: PointerEvent) => {
      pointRef.current = { x: e.clientX, y: e.clientY };

      // 用 rAF 合并同一帧内的多次移动，只写一次 style
      if (!rafRef.current) {
        rafRef.current = window.requestAnimationFrame(() => {
          rafRef.current = 0;
          moveFollowTo(pointRef.current.x, pointRef.current.y);
        });
      }

      showFollow();

      // 按住拖动时沿轨迹留下晕圈
      if (pressedRef.current) {
        const now = performance.now();
        if (now - lastTrailRef.current > TRAIL_INTERVAL_MS) {
          lastTrailRef.current = now;
          addRipple(e.clientX, e.clientY, true);
        }
      }
    };

    const onDown = (e: PointerEvent) => {
      pressedRef.current = true;
      // 触屏下 showFollow / moveFollowTo 自身会 no-op，这里只需保证计时器不残留
      moveFollowTo(e.clientX, e.clientY);
      showFollow();
      if (follow) follow.dataset.pressed = 'true';
      addRipple(e.clientX, e.clientY, false);
    };

    const onUp = () => {
      pressedRef.current = false;
      if (follow) follow.dataset.pressed = 'false';
    };

    // 指针离开视口时收起光斑
    const onLeave = () => {
      pressedRef.current = false;
      hideFollow();
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown, { passive: true });
    window.addEventListener('pointerup', onUp, { passive: true });
    window.addEventListener('pointercancel', onUp, { passive: true });
    document.addEventListener('pointerleave', onLeave);

    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.removeEventListener('pointerleave', onLeave);
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
      if (idleRef.current !== null) window.clearTimeout(idleRef.current);
    };
  }, [addRipple]);

  return (
    <div
      aria-hidden
      className='pointer-events-none fixed inset-0 z-[45] overflow-hidden mix-blend-multiply'
    >
      <div ref={followRef} className='halo-follow' data-active='false' />
      {/* 定位交给外层、缩放动画交给内层：CSS 动画的优先级高于内联 transform，
          两者写在同一元素上会互相覆盖，因此必须拆开 */}
      {ripples.map((r) => (
        <span
          key={r.id}
          className='absolute left-0 top-0'
          style={{ transform: `translate3d(${r.x}px, ${r.y}px, 0)` }}
        >
          <span
            className='halo-ripple animate-halo-ripple'
            style={r.small ? { width: '10rem', height: '10rem' } : undefined}
          />
        </span>
      ))}
    </div>
  );
}

export default PointerHalo;
