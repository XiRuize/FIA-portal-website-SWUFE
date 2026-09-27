/**
 * 「合作单位与会员去向」——多行 logo 轮动网格。
 *
 * ## 版式沿革
 *
 * 1. 最初是两个相邻版块：「合作单位与历任会员去向」= 机构级合作关系，
 *    按 银行/证券/期货/媒体/其它 **五分类静态栅格**；「会友去向」= 会员个人去向，**双行滚动**。
 * 2. 2026-09-27 上午合并为**单行**匀速轮动墙（去掉分类、只留图标）。
 * 3. 2026-09-27 下午按需求改为**多行网格 + 逐行轮动**（参考复旦证券投资协会的陈列方式）：
 *    - 分行陈列，不再是一条传送带；
 *    - **每格一个 logo + 单位名称**（只有图标认不出机构，名称是必需品）；
 *    - 每一行独立轮动，**相邻行方向相反**（一行向左、一行向右），
 *      避免三行同向造成「整块平移」的呆板观感。
 *
 * 顺序仍刻意把银行、证券、基金、期货、媒体、互联网、监管机构**打散交织**，
 * 使同一行里相邻的两家不总是同类机构（分类已取消，再按类聚拢就白取消了）。
 *
 * ## 数据来源
 *
 * 全部来自素材目录的 `logo/` 子目录（非资料目录，**必须点名 `category: 'logo'`**
 * 才会被后端放行）。因此这里按**文件名**匹配，而不是硬编码 URL
 * —— 素材增删后无需改代码，新增的 logo 会自动出现在墙上。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { resourcesApi } from '@/lib/backendApi';
import Marquee from './Marquee';
import Reveal from './Reveal';
import { SectionHeading } from './SectionHeading';

/** 一行放多少格由这里决定：行数越多、每行越短，轮动越快 */
const ROW_COUNT = 3;

/**
 * 展示顺序与名称——**与后端 `server/scripts/fetch-logos.mjs` 的 `ORGS` 对应**。
 *
 * `file` 是素材目录里去扩展名的文件名；`label` 是格子下方显示的名称
 * （同时用作 `alt`）；`full` 仅在机构全称比品牌名更有信息量时才给（鼠标悬停可见）。
 *
 * ⚠️ 未列出的文件不会丢：排序时排到末尾照常展示，方便先丢素材后补登记。
 */
const LOGO_ORDER: ReadonlyArray<{ file: string; label: string; full?: string }> = [
  { file: '腾讯', label: '腾讯' },
  { file: '中信证券', label: '中信证券' },
  { file: '中国银行', label: '中国银行' },
  { file: '东吴证券', label: '东吴证券' },
  { file: '中国工商银行', label: '中国工商银行' },
  { file: '易方达基金', label: '易方达基金' },
  { file: '京东', label: '京东' },
  { file: '广发证券', label: '广发证券' },
  { file: '兴业银行', label: '兴业银行' },
  { file: '万得集团', label: '万得 Wind', full: '万得信息技术股份有限公司（Wind）' },
  { file: '中国农业银行', label: '中国农业银行' },
  { file: '国金证券', label: '国金证券' },
  { file: '招商证券', label: '招商证券' },
  { file: '成都银行', label: '成都银行' },
  { file: '中信银行', label: '中信银行' },
  { file: '西南证券', label: '西南证券' },
  { file: '华泰证券', label: '华泰证券' },
  { file: '建设银行', label: '建设银行' },
  { file: '重庆银行', label: '重庆银行' },
  { file: '申银万国证券', label: '申银万国证券' },
  { file: '中信期货', label: '中信期货' },
  { file: '旦恩资本', label: '旦恩资本', full: '深圳市旦恩先锋私募股权基金管理有限公司' },
  { file: '荷兰银行', label: '荷兰银行' },
  { file: '华西期货', label: '华西期货' },
  { file: '海通期货', label: '海通期货' },
  { file: '哈尔滨银行', label: '哈尔滨银行' },
  { file: '联合证券', label: '联合证券' },
  { file: '四川农业银行', label: '四川农业银行' },
  { file: '南华期货', label: '南华期货' },
  { file: '瑞银', label: '瑞银 UBS', full: '瑞银集团（UBS）' },
  { file: '和讯网', label: '和讯网' },
  { file: '华泰长城期货', label: '华泰长城期货' },
  { file: '经济观察报', label: '经济观察报' },
  {
    file: '淡水泉投资',
    label: '淡水泉投资',
    full: '淡水泉（香港）投资管理有限公司 Springs Capital (Hong Kong) Limited',
  },
  { file: '四川日报', label: '四川日报' },
  { file: '同花顺公司', label: '同花顺' },
  { file: '成都商报', label: '成都商报' },
  {
    file: '中国证监会西南区分部成都证管委',
    label: '中国证监会',
    full: '中国证监会西南区分部成都证管委',
  },
  // ⚠️ 天麟财富：登记的入口保留，但**当前目录里没有对应素材**。
  //    曾抓到的那张 `天麟财富.jpeg` 实为另一家机构（FUMI）的标识，已删除。
  //    等拿到正确素材丢进 `资料分享模块素材/logo/` 即会自动带名上墙，无需改代码。
  { file: '天麟财富', label: '天麟财富' },
  { file: '银帆私募', label: '银帆私募' },
];

/** 脚注：与「精品活动」的 [1] 共用同一页，编号不重复 */
export const PARTNER_FOOTNOTES: Record<number, string> = {
  2: '媒体类机构为协会接受采访或提供内容合作的媒体单位，非商业合作关系。',
};

/**
 * 素材格式优先级。
 *
 * ⚠️ 同一机构可能存在**多份不同格式**的文件，实测 `中国银行.jpeg` 与
 * `中国银行.svg` 并存，而后端返回顺序不稳定。直接 `new Map()` 逐条覆盖会让
 * 「谁最后遍历到谁赢」，观感在两次构建间漂移。故按格式显式裁定：
 * 矢量（清晰度无损）> png/webp > jpeg/jpg > gif > ico。
 */
const EXT_RANK: Record<string, number> = {
  svg: 0,
  png: 1,
  webp: 1,
  jpeg: 2,
  jpg: 2,
  gif: 3,
  ico: 4,
};

function extRank(fileName: string): number {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return EXT_RANK[ext] ?? 9;
}

/**
 * 网格里的一格：**图 + 名**。
 *
 * ⚠️ 图片盒固定高度、宽度自适应（`h-12 w-auto max-w-full`）而不是固定宽高：
 * 素材的宽高比跨度很大（方形徽标 ≈1:1，Wind 这类字标可达 3:1）。
 * 若用固定宽高盒 + `object-contain`，宽字标会被宽度卡住、只占中间一小条，
 * 上墙后明显比方形徽标矮一截。改为**统一高度**后，所有标识的视觉重量一致，
 * 宽字标只是多占一点横向空间。
 *
 * `object-contain` + `max-w-full` 保证**不裁切**（需求里的「截取完整」）。
 */
function LogoTile({
  label,
  full,
  url,
  phase,
}: {
  label: string;
  full: string;
  url: string;
  /** 呼吸动画相位（秒），用来错开明暗节奏 */
  phase: number;
}) {
  const [broken, setBroken] = useState(false);
  // 取图失败就整块撤掉：一排格子里留个空盒比少一格更扎眼
  if (broken) return null;

  return (
    <figure
      className='logo-chip flex w-36 shrink-0 flex-col items-center justify-start gap-3 sm:w-44'
      style={{ animationDelay: `${phase}s` }}
      title={full}
    >
      <span className='flex h-12 w-full items-center justify-center sm:h-14'>
        <img
          src={url}
          alt={label}
          loading='lazy'
          decoding='async'
          draggable={false}
          onError={() => setBroken(true)}
          className='h-full w-auto max-w-full object-contain'
        />
      </span>
      <figcaption className='w-full truncate text-center text-xs text-ink-500 sm:text-[13px]'>
        {label}
      </figcaption>
    </figure>
  );
}

export function PartnerLogos() {
  const [items, setItems] = useState<Array<{ label: string; full: string; url: string }>>([]);
  const [loading, setLoading] = useState(true);
  /** logo 不常变动，首次挂载取一次即可，避免每次回首页都请求 */
  const fetched = useRef(false);

  const load = useCallback(async () => {
    if (fetched.current) return;
    fetched.current = true;
    try {
      // 点名 category=logo：logo 属于非资料目录，不点名会被服务端排除
      const res = await resourcesApi.list({ category: 'logo', pageSize: 200 });

      // 按 basename 归并多格式文件，只留格式最优的一份
      const picked = new Map<string, { rank: number; url: string; fileName: string }>();
      for (const it of res.items) {
        const fileName = it.fileName ?? it.name;
        const rank = extRank(fileName);
        const prev = picked.get(it.name);
        if (!prev || rank < prev.rank) {
          picked.set(it.name, { rank, url: resourcesApi.previewUrl(it.id), fileName });
        }
      }

      const metaOf = (base: string) =>
        LOGO_ORDER.find((o) => o.file === base) ?? LOGO_ORDER.find((o) => base.includes(o.file));

      const rankOf = (base: string) => {
        const i = LOGO_ORDER.findIndex((o) => o.file === base || base.includes(o.file));
        return i === -1 ? LOGO_ORDER.length : i;
      };

      setItems(
        [...picked.entries()]
          .sort(([a], [b]) => {
            const d = rankOf(a) - rankOf(b);
            // 同序号（含都未登记）时按名称稳定排序，避免每次构建顺序抖动
            return d !== 0 ? d : a.localeCompare(b, 'zh-Hans-CN');
          })
          .map(([base, v]) => {
            const meta = metaOf(base);
            return {
              label: meta?.label ?? base,
              full: meta?.full ?? meta?.label ?? base,
              url: v.url,
            };
          })
      );
    } catch {
      // 后端不可达时不渲染整个版块 —— 空版块比没有版块更难看
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!loading && items.length === 0) return null;

  // 轮询分配到各行：第 i 个进第 i % ROW_COUNT 行
  // —— 用取模而不是切片，保证各行数量接近、且同一行里机构类型是混的
  const rows: (typeof items)[] = Array.from({ length: ROW_COUNT }, () => []);
  items.forEach((it, i) => rows[i % ROW_COUNT].push(it));

  return (
    <section className='relative overflow-hidden border-y border-ink-900/[0.06] bg-white py-16 sm:py-20'>
      <div className='mx-auto max-w-7xl px-4 sm:px-6'>
        <Reveal>
          <SectionHeading
            kicker='partners & alumni'
            title='合作单位与会员去向'
            subtitle='协会与银行、证券、基金、期货、媒体等机构保持交流合作；会员亦广泛就职于互联网、金融与投资管理等行业的头部机构。'
          />
        </Reveal>
      </div>

      {/* logo 网格：整体满幅铺开，左右两侧由 mask-fade-x 渐隐 */}
      <div className='mt-8 space-y-8 sm:mt-10 sm:space-y-10'>
        {loading ? (
          // 骨架屏：行数与列宽与真实网格一致，加载完成时不会跳动
          <div className='space-y-10'>
            {Array.from({ length: ROW_COUNT }).map((_, r) => (
              <div key={r} className='flex justify-center gap-10 overflow-hidden px-4'>
                {Array.from({ length: 6 }).map((__, i) => (
                  <div
                    key={i}
                    className='h-12 w-36 shrink-0 animate-pulse rounded-lg bg-ink-100/60 sm:h-14 sm:w-44'
                  />
                ))}
              </div>
            ))}
          </div>
        ) : (
          rows.map((row, r) => (
            <Reveal key={r} delay={r * 80}>
              <Marquee
                // 时长随该行格数走，保证各行的**线速度**接近（否则长行明显更快）
                duration={Math.max(34, row.length * 4.2)}
                reverse={r % 2 === 1}
              >
                {row.map((it, i) => (
                  <LogoTile
                    key={it.label}
                    label={it.label}
                    full={it.full}
                    url={it.url}
                    // 相位错开 0.5s，相邻格子不同步明暗
                    phase={(i * 0.5 + r * 1.3) % 4}
                  />
                ))}
              </Marquee>
            </Reveal>
          ))
        )}
      </div>

      <div className='mx-auto max-w-7xl px-4 sm:px-6'>
        <Reveal>
          <div className='mt-12 space-y-2 border-t border-ink-900/[0.06] pt-6'>
            {Object.entries(PARTNER_FOOTNOTES).map(([n, text]) => (
              <p key={n} className='text-[11px] leading-relaxed text-ink-400'>
                <span className='num mr-1 text-flare-500'>[{n}]</span>
                {text}
              </p>
            ))}
            <p className='flex items-start gap-2 text-[11px] leading-relaxed text-ink-400'>
              <ScrollText className='mt-0.5 h-3.5 w-3.5 shrink-0' />
              以上机构名称与标识为各机构注册商标，仅用于陈述协会历史交流合作情况与会员去向，不构成任何形式的背书、授权或现存合作关系声明。
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export default PartnerLogos;
