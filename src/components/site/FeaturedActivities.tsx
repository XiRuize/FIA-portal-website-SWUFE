/**
 * 「精品活动」——协会五项品牌赛事与常设活动。
 *
 * ## 为什么单独抽成组件
 *
 * 这五项的文本是**史实陈述**（创办年份、届数、参赛规模、主办方），
 * 与首页其它版块（会友去向、合作单位）的呈现逻辑完全不同：
 * 它是纯静态、有序、带编号的列表，不请求后端、不需要图片。
 * 数据在 `featuredActivities.data.ts`，视图在这里——复用时只取数据即可。
 *
 * ## 版式：行式排版而不是卡片阵列
 *
 * 五项用「编号 + 名称/定位 + 详述」的行式排版，而非五张卡片。
 * 原因：活动名长短悬殊（「模拟股票期货交易大赛」10 字 vs「名家讲座与财经沙龙」9 字），
 * 卡片阵列会让每张卡高度不一、留白参差；行式排版让文本自然流动，
 * 窄屏折行也不会破版。左列编号用等宽数字并补零，五行左边界严格对齐。
 *
 * ## 底色为什么是白的
 *
 * 首页各版块靠「白 / 浅红」交替来划分节奏。本版块紧跟在同样有色的
 * 「活动回顾」之后，若也用浅红，两块有色区域会连成一大片，
 * 读者会误以为它们属于同一节。故此处保持白色，让节奏继续交替。
 * 但紧接着的「交流与合作」也是白色，两块白相邻会失去分界，
 * 因此本版块顶部加一条 `border-t` 发丝线作为视觉断点。
 *
 * ## 脚注
 *
 * 原稿在「模拟股票期货交易大赛」后带 [1] 角标，保留为**上标**，
 * 脚注正文集中在版块底部——而不是塞进卡片里，这样读者能一眼看到注在哪。
 */
import { Reveal } from './Reveal';
import { SectionHeading } from './SectionHeading';
import { FEATURED_ACTIVITIES, FEATURED_FOOTNOTES } from './featuredActivities.data';

export function FeaturedActivities() {
  return (
    <section className='relative py-20 sm:py-28'>
      {/* 顶部分界：本版块与下方「交流与合作」同为白底，靠这条发丝线断开 */}
      <span aria-hidden className='hairline-x absolute inset-x-0 top-0 h-px' />
      <div className='mx-auto max-w-7xl px-4 sm:px-6'>
        <Reveal>
          <SectionHeading
            kicker='signature events'
            title='精品活动'
            subtitle='从赛事到日常，协会形成了五项延续多年的品牌活动。'
          />
        </Reveal>
        <div className='mt-12 space-y-3'>
          {FEATURED_ACTIVITIES.map((act, i) => (
            <Reveal key={act.title} delay={i * 60}>
              <div className='group grid gap-3 rounded-2xl border border-ink-900/[0.07] bg-white p-5 shadow-card transition-all duration-500 ease-smooth hover:border-flare-200 hover:shadow-glow-flare sm:grid-cols-[auto_1fr] sm:gap-6 sm:p-6'>
                {/* 编号：等宽数字，两位数补零，让五行左边界对齐 */}
                <span className='num select-none text-sm font-medium text-flare-400 sm:text-base'>
                  {String(i + 1).padStart(2, '0')}
                </span>

                <div className='min-w-0'>
                  <h3 className='text-sm font-semibold text-ink-900 sm:text-base'>
                    {act.title}
                    {act.footnote ? (
                      <sup className='num ml-0.5 text-[10px] font-normal text-flare-500'>
                        [{act.footnote}]
                      </sup>
                    ) : null}
                  </h3>
                  <p className='mt-1 text-xs text-flare-600'>{act.tagline}</p>
                  <p className='mt-2.5 text-xs leading-relaxed text-ink-500 sm:text-sm sm:leading-7'>
                    {act.detail}
                  </p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>

        {Object.keys(FEATURED_FOOTNOTES).length ? (
          <Reveal>
            <div className='mt-8 space-y-1.5'>
              {Object.entries(FEATURED_FOOTNOTES).map(([n, text]) => (
                <p key={n} className='text-[11px] leading-relaxed text-ink-400'>
                  <span className='num mr-1 text-flare-500'>[{n}]</span>
                  {text}
                </p>
              ))}
            </div>
          </Reveal>
        ) : null}
      </div>
    </section>
  );
}

export default FeaturedActivities;
