import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen, LineChart, Sparkles, Target, Users } from 'lucide-react';
import { useContent } from '@/lib/store';
import { getSetting, parseStats } from '@/lib/siteConfig';
import HeroCarousel from '@/components/site/HeroCarousel';
import MarketStrip from '@/components/site/MarketStrip';
import ScrollManifesto from '@/components/site/ScrollManifesto';
import SectionHeading from '@/components/site/SectionHeading';
import SpotlightCard from '@/components/site/SpotlightCard';
import Reveal from '@/components/site/Reveal';
import CountUp from '@/components/site/CountUp';
import BorderBeam from '@/components/site/BorderBeam';
import FeaturedActivities from '@/components/site/FeaturedActivities';
import ExchangeCooperation from '@/components/site/ExchangeCooperation';
import PartnerLogos from '@/components/site/PartnerLogos';

const HIGHLIGHTS = [
  {
    icon: LineChart,
    title: '行业与公司研究',
    text: '研究部定期产出行业深度与公司研究，覆盖消费、医药、新能源等方向。',
  },
  {
    icon: BookOpen,
    title: '资料与数据共享',
    text: '课程讲义、数据集、电子书与研报 Excel 模板统一整理，成员可随时取用。',
  },
  {
    icon: Target,
    title: '模拟投资赛事',
    text: '年度校园模拟投资大赛，用实盘模拟检验策略，由业界校友评审。',
  },
  {
    icon: Users,
    title: '同伴学习社区',
    text: '读书会、组会与内训常态化，和一群同样对市场好奇的人一起成长。',
  },
];

/**
 * 首页。
 *
 * ## 版块顺序（2026-09-27 调整）
 *
 * 主视觉 → 行情条 → **滚动蒙版章节** → 协会介绍 → 精品活动 →
 * 校内外交流与合作 → 新闻与资讯 → 合作单位与会员去向 → 加入我们
 *
 * 本次删除了「活动回顾」与「组织架构」两个版块。删完后要留意**底色节奏**：
 * 邻接关系变成了「精品活动（白）→ 交流与合作（白）→ 新闻与资讯（浅红）」，
 * 因此 `ExchangeCooperation` 必须保持白色，否则会与新闻版块**双红相贴**。
 */
export function Home() {
  const { articles, settings } = useContent();

  const banners = useMemo(
    () => articles.filter((a) => a.category === 'banner'),
    [articles]
  );
  const news = useMemo(
    () => articles.filter((a) => a.category === 'news').slice(0, 4),
    [articles]
  );
  const stats = useMemo(
    () => parseStats(settings.about_stats ?? ''),
    [settings.about_stats]
  );

  return (
    <div>
      <HeroCarousel items={banners} />
      <MarketStrip />

      {/* 滚动蒙版章节：协会精神「领先、卓越、先进」→ 社团荣誉「全国百佳社团」 */}
      <ScrollManifesto />

      {/* 协会介绍 */}
      <section className='relative py-20 sm:py-28'>
        <div className='mx-auto max-w-7xl px-4 sm:px-6'>
          <div className='grid gap-14 lg:grid-cols-[1.1fr_1fr] lg:items-start lg:gap-16'>
            <Reveal>
              <SectionHeading
                kicker='about us'
                title={getSetting(settings, 'about_title', '关于协会')}
                subtitle={getSetting(settings, 'site_slogan')}
              />
              <div className='space-y-4 text-sm leading-7 text-ink-600 sm:text-base sm:leading-8'>
                {getSetting(settings, 'about_content')
                  .split('\n')
                  .map((p) => p.trim())
                  .filter(Boolean)
                  .map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
              </div>

              <Link
                to='/history'
                className='group mt-9 inline-flex items-center gap-2 rounded-lg border border-ink-900/12 bg-white px-5 py-3 text-sm font-medium text-ink-700 shadow-card transition-all duration-300 ease-smooth hover:border-flare-300 hover:text-flare-600'
              >
                查看协会历史沿革
                <ArrowRight className='h-4 w-4 transition-transform duration-300 group-hover:translate-x-1' />
              </Link>
            </Reveal>

            {/* 特色板块 */}
            <div className='grid gap-4 sm:grid-cols-2'>
              {HIGHLIGHTS.map((item, i) => (
                <Reveal key={item.title} delay={i * 90} from='right'>
                  <SpotlightCard className='h-full rounded-2xl'>
                    <div className='h-full rounded-2xl border border-ink-900/[0.07] bg-white p-5 shadow-card transition-all duration-500 ease-smooth hover:-translate-y-1 hover:border-flare-200 hover:shadow-card-hover'>
                      <span className='inline-flex h-10 w-10 items-center justify-center rounded-xl border border-flare-100 bg-flare-50 text-flare-600'>
                        <item.icon className='h-5 w-5' />
                      </span>
                      <h3 className='mt-4 text-sm font-semibold text-ink-900 sm:text-base'>
                        {item.title}
                      </h3>
                      <p className='mt-2 text-xs leading-relaxed text-ink-500 sm:text-sm'>
                        {item.text}
                      </p>
                    </div>
                  </SpotlightCard>
                </Reveal>
              ))}
            </div>
          </div>

          {/*
            数据条：**通栏**，不再挤在左栏里。
            原先它跟在左栏正文之后，左栏明显高于右栏的卡片组，
            于是右栏下方空出一大块。提到通栏后由它收尾整节，
            高度与字号也一并放大，读数更清楚。
          */}
          {stats.length ? (
            <Reveal delay={120}>
              <div className='mt-14 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-ink-900/[0.07] bg-ink-900/[0.06] sm:mt-16 sm:grid-cols-4'>
                {stats.map((s) => (
                  <div key={s.label} className='bg-white px-5 py-8 text-center sm:py-10'>
                    <CountUp
                      value={s.value}
                      className='text-gradient-flare block text-3xl font-bold sm:text-4xl lg:text-5xl'
                    />
                    <p className='mt-2.5 text-xs text-ink-500 sm:text-sm'>{s.label}</p>
                  </div>
                ))}
              </div>
            </Reveal>
          ) : null}
        </div>
      </section>

      {/* 精品活动：五大赛事与常设活动（静态内容，无需请求后端） */}
      <FeaturedActivities />

      {/* 校内外交流与合作 */}
      <ExchangeCooperation />

      {/* 新闻与资讯 */}
      <section className='relative border-y border-ink-900/[0.06] bg-flare-50/40 py-20 sm:py-28'>
        <div className='mx-auto max-w-7xl px-4 sm:px-6'>
          <Reveal>
            <SectionHeading
              kicker='news & insights'
              title='新闻与资讯'
              subtitle='社团记事与财经时事，了解协会动态与市场观察。'
              action={
                <Link
                  to='/news'
                  className='group inline-flex items-center gap-1 text-sm font-medium text-flare-600 transition-colors hover:text-flare-700'
                >
                  进入资讯中心
                  <ArrowRight className='h-4 w-4 transition-transform duration-300 group-hover:translate-x-1' />
                </Link>
              }
            />
          </Reveal>

          {news.length ? (
            <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
              {news.map((n, i) => (
                <Reveal key={n.id} delay={i * 90}>
                  <SpotlightCard className='h-full rounded-2xl'>
                    <Link
                      to={`/article/${n.id}`}
                      className='group flex h-full flex-col rounded-2xl border border-ink-900/[0.07] bg-white p-5 shadow-card transition-all duration-500 ease-smooth hover:-translate-y-1.5 hover:border-flare-200 hover:shadow-card-hover'
                    >
                      <p className='num text-xs text-flare-500'>
                        {n.eventDate || '—'}
                      </p>
                      <h3 className='mt-3 line-clamp-2 text-sm font-semibold leading-snug text-ink-900 transition-colors group-hover:text-flare-600'>
                        {n.title}
                      </h3>
                      <p className='mt-2 line-clamp-3 text-xs leading-relaxed text-ink-500'>
                        {n.summary}
                      </p>
                      <span className='mt-4 inline-flex items-center gap-1 text-xs text-ink-400 transition-colors group-hover:text-flare-600'>
                        阅读全文
                        <ArrowRight className='h-3 w-3 transition-transform duration-300 group-hover:translate-x-1' />
                      </span>
                    </Link>
                  </SpotlightCard>
                </Reveal>
              ))}
            </div>
          ) : (
            <p className='text-sm text-ink-400'>资讯内容待补充。</p>
          )}
        </div>
      </section>

      {/* 合作单位与会员去向：多行 logo 网格 + 逐行轮动 */}
      <PartnerLogos />

      {/* 加入我们 */}
      <section className='relative py-20 sm:py-28'>
        <div className='mx-auto max-w-7xl px-4 sm:px-6'>
          <Reveal>
            <SpotlightCard
              className='rounded-3xl'
              color='rgba(248, 87, 74, 0.10)'
              radius={520}
            >
              <div className='ring-gradient relative overflow-hidden rounded-3xl border border-ink-900/[0.07] bg-gradient-to-br from-flare-50 to-white px-6 py-14 text-center shadow-card sm:px-12 sm:py-20'>
                <BorderBeam duration={6} />
                <div
                  aria-hidden
                  className='pointer-events-none absolute -top-24 left-1/2 h-56 w-[36rem] -translate-x-1/2 animate-halo-b rounded-full bg-flare-200/50 blur-[100px]'
                />
                <div className='relative'>
                  <span className='inline-flex items-center gap-2 rounded-full border border-flare-200 bg-white px-3.5 py-1.5 text-xs font-medium text-flare-700'>
                    <Sparkles className='h-3.5 w-3.5' />
                    Join us
                  </span>
                  <h2 className='text-gradient-ink mt-6 text-2xl font-bold sm:text-4xl'>
                    加入我们
                  </h2>
                  <p className='mx-auto mt-5 max-w-2xl text-sm leading-relaxed text-ink-600 sm:text-base sm:leading-8'>
                    {getSetting(settings, 'join_us')}
                  </p>
                  <div className='mt-9 flex flex-wrap items-center justify-center gap-3'>
                    <Link
                      to='/news'
                      className='group inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-flare-500 to-flare-600 px-6 py-3 text-sm font-semibold text-white shadow-glow-flare transition-all duration-300 ease-smooth hover:brightness-110'
                    >
                      了解协会动态
                      <ArrowRight className='h-4 w-4 transition-transform duration-300 group-hover:translate-x-1' />
                    </Link>
                    <Link
                      to='/resources'
                      className='inline-flex items-center gap-2 rounded-lg border border-ink-900/12 bg-white px-6 py-3 text-sm font-medium text-ink-700 shadow-card transition-all duration-300 ease-smooth hover:border-flare-300 hover:text-flare-600'
                    >
                      浏览学习资料
                    </Link>
                  </div>
                  <p className='mt-7 text-xs text-ink-400'>
                    招新信息与联系方式待社团确认后发布，也可先在页脚查看联系方式占位。
                  </p>
                </div>
              </div>
            </SpotlightCard>
          </Reveal>
        </div>
      </section>
    </div>
  );
}

export default Home;
