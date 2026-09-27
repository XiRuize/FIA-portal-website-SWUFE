/**
 * 「近年来参与的部分校内外交流与合作」。
 *
 * 数据在 `featuredActivities.data.ts`（与精品活动同一份内容文件，
 * 因为两者同属「协会做过什么」这一组史实，未来会一起被复用）。
 *
 * ## 版式变更（2026-09-27）
 *
 * 原先是「左右双栏 × 四个分组」的卡片阵列（媒体传播 / 国际与区域交流 /
 * 学术与课程共建 / 行业与同业协作）。现按需求改为：
 *
 *   1. **不再分类** —— 去掉分组标题与分组说明，12 条平铺；
 *   2. **归入同一个框** —— 整块只用一个带边框的容器，内部用发丝线分隔条目；
 *   3. **字体放大** —— 条目由 `text-xs/sm` 提到 `text-base/lg`；
 *   4. **纵向排布** —— 单列列表，每条独占一行并带序号。
 *
 * 序号用 `num` 字体（等宽数字），保证 01..12 左右对齐；每条前另有一枚
 * **固定尺寸的小红点**而不是 `•` 字符 —— `•` 在不同字体下垂直位置不一，
 * 而一个固定尺寸的圆点在任何字体下都对齐。
 */
import { Reveal } from './Reveal';
import { SectionHeading } from './SectionHeading';
import { EXCHANGE_GROUPS } from './featuredActivities.data';

/**
 * 把四个分组拍平成一维列表。
 *
 * 保留「先媒体、再国际、后学术与行业」的原始组序，只是不再显示分组标签
 * —— 顺序本身仍然承载了「从对外传播到专业协作」的递进，去掉标题不等于打乱。
 */
const EXCHANGE_ITEMS: string[] = EXCHANGE_GROUPS.flatMap((g) => g.items);

/**
 * 底色：**白**。
 *
 * 删掉「活动回顾」与「组织架构」两个版块后，本版的左右邻居变成了
 * 「精品活动（白）」与「新闻与资讯（`bg-flare-50/40` 浅红）」。
 * 若这里也用浅红，就会与新闻版块**双红相贴**，读者会误判成同一节
 * —— 这是本项目已踩过的版式坑。故保持白色，把红色只留给新闻版块。
 */
export function ExchangeCooperation() {
  return (
    <section className='relative py-20 sm:py-28'>
      <div className='mx-auto max-w-5xl px-4 sm:px-6'>
        <Reveal>
          <SectionHeading
            kicker='outreach & cooperation'
            title='近年来参与的部分校内外交流与合作'
            subtitle='从媒体传播、国际交流到学术共建与行业协作，协会持续把校外的资源接进校园。'
          />
        </Reveal>

        <Reveal delay={80}>
          {/* 单框：所有条目共用一个容器，内部发丝线分隔 */}
          <div className='mt-12 overflow-hidden rounded-2xl border border-ink-900/[0.08] bg-white shadow-card'>
            <ul className='divide-y divide-ink-900/[0.06]'>
              {EXCHANGE_ITEMS.map((text, i) => (
                <li
                  key={text}
                  className='flex items-baseline gap-4 px-5 py-5 transition-colors duration-300 hover:bg-flare-50/50 sm:gap-6 sm:px-8 sm:py-6'
                >
                  <span className='num shrink-0 text-lg font-semibold text-flare-500 sm:text-xl'>
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span
                    aria-hidden
                    className='mt-[11px] h-1.5 w-1.5 shrink-0 rounded-full bg-flare-400'
                  />
                  <span className='text-base leading-relaxed text-ink-700 sm:text-lg sm:leading-8'>
                    {text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export default ExchangeCooperation;
