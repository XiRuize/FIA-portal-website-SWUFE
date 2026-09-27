/**
 * 滚动蒙版章节：「领先、卓越、先进」→「全国百佳社团」。
 *
 * ## 为什么单独做一个版块
 *
 * 主视觉之后直接进「关于协会」，节奏是「大标题 → 正文」，中间缺一个**气口**。
 * 这里用一个由滚动驱动的整屏章节把节奏压一下：先让协会精神独立成句地砸出来，
 * 再换一句社团荣誉，读者带着这两句话进入「关于协会」。
 *
 * ## 实现：一段「跑道」+ 一个 sticky 舞台
 *
 * 外层 section 给足高度（跑道），内层用 `position: sticky` 钉在视口上。
 * 滚动进度取自**跑道在视口中被消耗的比例**：
 *
 *     p = clamp01(-跑道.top / (跑道高 - 视口高))
 *
 * 这样 p 严格落在 [0,1]，且与「滚到多少」线性对应 —— 比用
 * IntersectionObserver 的 entry.ratio 稳（后者在元素高于视口时会提前饱和）。
 *
 * ## 蒙版是「滑动」的，不是淡入
 *
 * 两句话都用 `mask-image` 做**斜向扫过**：遮罩由「不透明段 + 渐变段 + 透明段」
 * 组成，随进度把分界点从画面外推进到画面内，字就沿斜线被「刷」出来。
 * 第二句反向扫（从右往左），避免两句的动势重复。
 * 光靠 opacity 淡入出不来这个效果。
 *
 * ⚠️ 两处必须同时设：`maskImage` 与 `WebkitMaskImage`（Safari 仍只认前缀版）。
 *
 * ## 顺滑与降级
 *
 * - 滚动回调用 rAF 节流，且**只在进度变化超过 1/500 时才 setState**，
 *   避免每像素都触发一次 React 重渲染；
 * - 进入视口附近才挂监听（IntersectionObserver 开关），离开即摘掉；
 * - `prefers-reduced-motion: reduce` 时退化成静态两行，且不再给跑道高度，
 *   避免「滚半天没内容」。
 */
import { useEffect, useRef, useState } from 'react';

/** 把值夹到 [0,1] */
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 线性映射后再夹紧：把 [a,b] 区间映射到 [0,1] */
const span = (p: number, a: number, b: number) => clamp01((p - a) / (b - a));

export function ScrollManifesto() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [p, setP] = useState(0);
  /** 是否处于「该跑动画」的区间，用来避免整页滚动都触发计算 */
  const [armed, setArmed] = useState(false);
  const [reduced, setReduced] = useState(false);

  // 尊重系统的「减少动态效果」
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // 仅在跑道接近视口时挂滚动监听
  useEffect(() => {
    if (reduced) return;
    const el = sectionRef.current;
    if (!el) return;

    const io = new IntersectionObserver(
      (entries) => setArmed(entries.some((e) => e.isIntersecting)),
      // 提前一屏开始计算，进入时不至于「跳过第一帧」；离开后再多留一屏
      { rootMargin: '100% 0px 100% 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduced]);

  useEffect(() => {
    if (reduced || !armed) return;
    let raf = 0;
    let last = -1;

    const compute = () => {
      raf = 0;
      const el = sectionRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // 可消耗的距离：跑道高度 - 视口高度
      const runway = el.offsetHeight - window.innerHeight;
      if (runway <= 0) {
        setP(rect.top <= 0 ? 1 : 0);
        return;
      }
      const next = clamp01(-rect.top / runway);
      // 量化到 1/500，避免每像素都重渲染
      if (last < 0 || Math.abs(next - last) > 0.002) {
        last = next;
        setP(next);
      }
    };

    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(compute);
    };

    compute();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [reduced, armed]);

  // ——— 由进度导出的样式 ———
  //
  // ⚠️ 节奏上有一条硬约束：**任意进度都必须至少有一句是看得清的**。
  //
  // 初版把「A 退场 p∈[0.46,0.62]」与「B 入场 p∈[0.58,0.92]」首尾相接，
  // 于是在 p≈0.58–0.66 这段里 A 已淡到 0.07、B 才 0.09 ——
  // 连着滚约 160px 看到的是一块**近乎空白的屏**，最容易被当成「页面坏了」。
  // 这个窗口是逐帧探针抓出来的（`.workbuddy/tmp/probe-manifesto.mjs` 会打印
  // 每一档的 opacity 与 mask 断点；只截一张图看不出这种区间性缺陷）。
  //
  // 现行做法：让 **B 的入场与 A 的退场重叠**，并给两句**垂直错位**，
  // 于是交叉的那一小段里两句分处上下、不叠字，屏幕始终有内容。
  const sweepA = span(p, 0.04, 0.34); // A 斜向刷出
  const exitA = span(p, 0.5, 0.63); // A 上浮退场
  const sweepB = span(p, 0.47, 0.8); // B 反向刷出（起点早于 A 退场完成，形成重叠）
  const enterB = span(p, 0.5, 0.63); // B 的透明度，与 A 的退场严格互补

  const startA = -30 + sweepA * 140;
  const startB = 140 - sweepB * 170;

  /** 交叉段的垂直错位量（px）。要大于单句块的一半高度，才不会叠字。 */
  const SHIFT = 160;

  const phraseA = {
    opacity: 1 - exitA,
    transform: `translateY(${-exitA * SHIFT}px) scale(${1 - exitA * 0.04})`,
    maskImage: `linear-gradient(100deg, #000 0%, #000 ${startA}%, transparent ${startA + 34}%, transparent 100%)`,
    WebkitMaskImage: `linear-gradient(100deg, #000 0%, #000 ${startA}%, transparent ${startA + 34}%, transparent 100%)`,
  } as const;

  const phraseB = {
    opacity: enterB,
    transform: `translateY(${(1 - enterB) * SHIFT}px) scale(${0.96 + enterB * 0.04})`,
    maskImage: `linear-gradient(100deg, transparent 0%, transparent ${startB}%, #000 ${startB + 34}%, #000 100%)`,
    WebkitMaskImage: `linear-gradient(100deg, transparent 0%, transparent ${startB}%, #000 ${startB + 34}%, #000 100%)`,
  } as const;

  /** 扫光描线：跟着第一句的刷出位置走，纯装饰 */
  const lineStyle = {
    opacity: sweepA > 0 && sweepA < 1 ? 0.9 : 0,
    left: `${startA}%`,
  } as const;

  return (
    <section
      ref={sectionRef}
      aria-label='协会精神与社团荣誉'
      className={`relative bg-white ${reduced ? '' : 'h-[230vh]'}`}
    >
      <div
        className={`${
          reduced ? 'relative py-24' : 'sticky top-0'
        } flex min-h-[88vh] items-center justify-center overflow-hidden sm:min-h-screen`}
      >
        {/* 背景：栅格 + 两团柔光，保持与上下白色版块连续 */}
        <div aria-hidden className='absolute inset-0 bg-grid opacity-50' />
        <div
          aria-hidden
          className='pointer-events-none absolute -left-32 top-1/4 h-[30rem] w-[30rem] animate-halo-a rounded-full bg-flare-300/25 blur-[120px]'
        />
        <div
          aria-hidden
          className='pointer-events-none absolute -right-32 bottom-1/4 h-[30rem] w-[30rem] animate-halo-b rounded-full bg-gold-200/30 blur-[120px]'
        />

        <div className='relative w-full max-w-5xl px-6 text-center'>
          {/* 动画版：两句叠在同一舞台中央，各自带扫过式蒙版。
              ⚠️ 必须与下面的静态降级版二选一渲染 —— 两者同时存在会重叠。 */}
          {!reduced ? (
            <>
              {/* 第一句：协会精神 */}
              <div className='absolute inset-x-0 top-1/2 -translate-y-1/2' style={phraseA}>
                <p className='text-[11px] font-medium uppercase tracking-[0.32em] text-flare-500'>
                  spirit of fia
                </p>
                <h2 className='text-gradient-flare mt-5 text-[2.6rem] font-bold leading-[1.08] tracking-tight sm:text-7xl lg:text-8xl'>
                  领先、卓越、先进
                </h2>
                <p className='mt-6 text-sm text-ink-500 sm:text-base'>
                  协会自创立之初便确立的社团精神，也是此后一切研究与赛事的价值基调。
                </p>
              </div>

              {/* 第二句：社团荣誉 */}
              <div className='absolute inset-x-0 top-1/2 -translate-y-1/2' style={phraseB}>
                <p className='text-[11px] font-medium uppercase tracking-[0.32em] text-flare-500'>
                  honours
                </p>
                <h2 className='text-gradient-ink mt-5 text-[2.6rem] font-bold leading-[1.08] tracking-tight sm:text-7xl lg:text-8xl'>
                  全国百佳社团
                </h2>
                <p className='mt-6 text-sm text-ink-500 sm:text-base'>
                  社团影响力获得全国层面认可，是西南财经大学唯一入选的社团。
                </p>
              </div>

              {/* 扫光描线（装饰）：随第一句刷出位置移动 */}
              <span
                aria-hidden
                className='pointer-events-none absolute inset-y-8 w-px bg-gradient-to-b from-transparent via-flare-400 to-transparent transition-opacity duration-300'
                style={lineStyle}
              />
            </>
          ) : (
            /* 静态降级版：尊重「减少动态效果」，两句纵向排列 */
            <div className='space-y-20 py-6'>
              <div>
                <p className='text-[11px] font-medium uppercase tracking-[0.32em] text-flare-500'>
                  spirit of fia
                </p>
                <h2 className='text-gradient-flare mt-5 text-4xl font-bold leading-[1.1] tracking-tight sm:text-6xl'>
                  领先、卓越、先进
                </h2>
                <p className='mt-6 text-sm text-ink-500 sm:text-base'>
                  协会自创立之初便确立的社团精神，也是此后一切研究与赛事的价值基调。
                </p>
              </div>
              <div>
                <p className='text-[11px] font-medium uppercase tracking-[0.32em] text-flare-500'>
                  honours
                </p>
                <h2 className='text-gradient-ink mt-5 text-4xl font-bold leading-[1.1] tracking-tight sm:text-6xl'>
                  全国百佳社团
                </h2>
                <p className='mt-6 text-sm text-ink-500 sm:text-base'>
                  社团影响力获得全国层面认可，是西南财经大学唯一入选的社团。
                </p>
              </div>
            </div>
          )}
        </div>

        {/* 进度轨：贴在右侧，给一点「正在推进」的反馈 */}
        {!reduced ? (
          <div
            aria-hidden
            className='absolute bottom-10 left-1/2 h-px w-40 -translate-x-1/2 overflow-hidden rounded-full bg-ink-900/10'
          >
            <span
              className='block h-full rounded-full bg-gradient-to-r from-flare-400 to-gold-500'
              style={{ width: `${p * 100}%` }}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default ScrollManifesto;
