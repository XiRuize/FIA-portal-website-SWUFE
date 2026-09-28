/**
 * 财经时事抓取与缓存。
 *
 * ## 信源选择（2026-09-26 重新实测后调整）
 *
 * 信源链按「**与金融市场的相关性**」而非「接口好不好用」排序。
 * 三层闸门依次把关：**内容品类（栏目/信源）→ 相关性 → 时效**。
 *
 * | 信源 | 端点 | 内容性质 | 直链 |
 * | --- | --- | --- | --- |
 * | 东方财富·财经导读（主） | `getNewsByColumns`，4 个市场向栏目并发 | 股市行情/A股策略/全球市场/能源商品 | ✅ `uniqueUrl` 真实直链 |
 * | 东方财富·股市快讯（次） | `getFastNewsList?fastColumn=104` | 机构调研、港股收盘、新股发行、回购减持 | ✅ 由 `code` 拼标准路径（实测 200） |
 * | 新浪财经·宏观（备） | `feed.mix.sina.com.cn/api/roll/get?lid=1687` | 宏观金融，**但已停更**，仅作最后兜底 | ✅ `url` |
 *
 * ## 三次实测踩坑（都是「名字像」但「内容不是」）
 *
 * 1. **新浪 `lid=1686`**：标称「财经」，实为综合资讯 —— 中秋铁路客流、地方街道整治、
 *    景区活动、人事任免。**信源名字里有「财经」不等于内容是金融新闻。**
 * 2. **东方财富 `column=345`**：标称「财经导读」，实为时政要闻混编 —— 中美成果共识、
 *    国事访问、外交部答问、AI 安全漏洞，10 条里 4 条与市场无关。已改用 347/353/366/356。
 * 3. **东方财富 `fastColumn=102`**：7×24 全品类播报，30 条里仅 2 条相关
 *    （技能大赛、台风预警、中秋档票房）。已改用 104（股市专线，相关率 90%）。
 *
 * **判据只有一条：逐条实测内容，不看栏目名。**
 *
 * ## 缓存与降级
 * - 每天（Asia/Shanghai 自然日）至多抓取一次，写入 `news_items` 按 `bucket_date` 分组。
 * - 保留 `keepDays` 天（默认 7），供前端按日期回看。
 * - 外部源全部失败时：返回**最近一次成功缓存**，并在响应里标记 `stale: true` 与失败原因。
 * - 只有「从未成功抓取过且当前也抓不到」时才返回 503，绝不 500。
 */

/**
 * 东八区自然日工具。放在文件顶部而非末尾：ESM 的 import 会被提升，
 * 位置不影响语义，但写在最前面可以避免读者以为这个标识符是局部定义的。
 */
import { bucketDate } from './day.js';

/**
 * 东方财富·文章列表接口**基址**（不含 column）。
 *
 * ⚠️ 实测约束：该接口 `pageSize` 与分页参数（`pageIndex` / `page` / `p` / `offset`）
 * **全部无效**，任何请求都只返回该栏目最新 10 条。想拿更多候选，只能并发多个栏目。
 */
const EASTMONEY_COLUMN_ENDPOINT_BASE =
  'https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&order=1&needInteractData=0&req_trace=1';

/**
 * 采用的市场向栏目。**只选内容本身就是金融市场向的栏目**。
 *
 * ## 为什么不用 column=345
 * 345 是本站最初的「财经导读」，但 2026-09-26 实测它的内容是**时政要闻混编**：
 *   「中美达成八点成果共识」「习近平圆满结束对美国的国事访问」
 *   「外交部发言人就人工智能问题答记者问」「AI安全漏洞潮蔓延」
 * 10 条里 4 条与金融市场无关 —— 这正是「财经时事与金融市场不太相关」的根因。
 * 栏目名叫「财经」不等于内容是金融新闻，必须逐栏实测。
 *
 * ## 为什么每栏要设 `quota`
 * 各栏目发稿频率差异极大：能源/商品类栏目一天能发几十条，股市策略类一天只有几条。
 * 若只按时间倒序合并取前 10，快栏目会**淹没**慢栏目 —— 实测 col356（能源商品）
 * 独占 8/10，首页变成「油市专版」，股票与宏观内容被挤光。
 *
 * 因此给每栏一个名额上限，先各取所长、再按时间排序。`quota` 之和
 * （4+3+2+2 = 11）略大于 `NEWS_PAGE_SIZE`（10），是为了在个别栏目当日无稿时
 * 仍能靠其他栏目补满，而不是留下空位。
 *
 * @type {Array<{ id: number, label: string, quota: number }>}
 */
const EASTMONEY_COLUMN_IDS = [
  { id: 347, label: '股市', quota: 4 },
  { id: 353, label: 'A股策略', quota: 3 },
  { id: 366, label: '全球市场', quota: 2 },
  { id: 356, label: '能源商品', quota: 2 },
];

/**
 * 东方财富·**股市快讯**（次信源）。
 *
 * ⚠️ `fastColumn` 决定内容品类，**102 不能用**：102 是全品类播报
 * （希思罗机场跑道、泰国强降雨、中秋档票房），实测 30 条里只有 2 条
 * 与金融市场相关，会被相关性闸门拒用。
 *
 * **104 才是股市/公司专线**：机构调研、港股收盘、新股发行、私募仓位、
 * 回购减持、上交所监管函……实测 30 条相关率 90%（27/30），最新一条
 * 为当天 12:42，且带 `code` 字段可拼真实文章直链。
 */
const EASTMONEY_FLASH_ENDPOINT =
  'https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=104&sortEnd=&req_trace=1';

/**
 * 新浪财经滚动（备信源，**当前实测劣化，仅作最后兜底**）。
 *
 * ## 为什么它排在最后
 * 2026-09-26 逐 lid 实测：
 * - `lid=1686`（标称财经，实为综合资讯）：内容新鲜但是时政/社会新闻（山洪预警、
 *   县委书记调度会、联播寻亲），与金融市场无关 —— 已弃用。
 * - `lid=1687`（宏观金融）：内容质量好、相关性 100%，但**最新一条停在 2026-05-11**，
 *   已停更 138 天 —— 靠 `assertFresh` 拦住，不会被误采。
 * - `1688`/`1689`/`1690`：分别停更 90 / 211 / 522 天。
 *
 * 保留它是因为「三个信源全挂」时仍需一个候选；正常情况下 `assertFresh`
 * 与相关性闸门会把它挡在外面。**若日后新浪恢复更新，这里无需改代码即可自动启用。**
 */
const SINA_ENDPOINT =
  'https://feed.mix.sina.com.cn/api/roll/get?pageid=155&lid=1687&num=20&page=1';

/** 外部请求超时（含单个栏目；多栏目间是并发，总耗时不会线性累加） */
const FETCH_TIMEOUT_MS = 8000;

/** 每条新闻最多抓取条数 */
export const NEWS_PAGE_SIZE = 10;

/** 通用浏览器 UA，外部源基本都要求 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

/**
 * 判定标题是否属于**金融市场**范畴。
 *
 * ## 这个函数该干什么、不该干什么
 *
 * 它的职责是**守住信源的定位边界**，不是「从大杂烩里挑出金融新闻」。
 * 因此它用**宽口径**（命中任一关键词即通过），并且只在**整体命中率过低**时
 * 才判定该源已退化——而不是逐条剔除。
 *
 * 这条设计来自一次踩坑：初版按「逐条必须命中关键词」实现，结果把
 * 东方财富财经导读（一个本来就由券商与财经媒体供稿的市场向栏目）
 * 里的正常条目也筛掉了一半，包括「美股全线拉升！国际油价大幅跳水」
 * 这种明显的市场新闻——因为标题里没有我预先想到的那些词。
 * **用关键词去审一个已经选对了的源，是在给自己制造噪声。**
 *
 * 判定标准：命中以下任一
 * 1. 标题含金融关键词；或
 * 2. 来源是公认的**财经媒体/券商**（证券时报、券商中国、数据宝、财联社……）。
 *
 * ## ⚠️ 来源兜底必须排除「聚合平台」
 *
 * 不能把「东方财富」「新浪财经」这类**门户/聚合平台**当作财经媒体背书。
 * 它们自己不产内容，是转载池：东方财富快讯里就有新华社、央视、外交部、
 * 自然资源部、气象局的稿子。
 *
 * 踩过的坑（2026-09-26）：`FINANCE_MEDIA` 里含「东方财富」，而快讯信源把来源
 * 统一标成「东方财富快讯」，于是 `FINANCE_MEDIA.test(s)` 对**每一条**快讯都成立
 * ——「中秋档电影总票房破2亿」「泰国多地强降雨」全被放行。相关性闸门形同虚设，
 * 前端首页混进大量与金融市场无关的内容。
 *
 * 根因是把「平台名」误当成了「供稿媒体名」。**聚合平台只能提供渠道，不能提供背书。**
 *
 * @param {string} title
 * @param {string} [source] 媒体名，可显著提高判定准确率
 */
export function isMarketRelevant(title, source = '') {
  const t = String(title);
  const s = String(source);
  if (!t && !s) return false;
  if (MARKET_KEYWORDS.test(t)) return true;
  // 财经媒体供稿的内容默认按市场向处理，避免因标题用词超出词表而误杀。
  // 但聚合平台（东方财富/新浪财经）不算背书，见上方说明。
  if (AGGREGATOR_PLATFORMS.test(s)) return false;
  return FINANCE_MEDIA.test(s);
}

/**
 * 金融市场关键词。宽口径，覆盖市场、机构、宏观、资产四类。
 *
 * ⚠️ 这是「放行」用的白名单，不是「剔除」用的黑名单：
 * 漏词只会让个别条目少一层保险（还有 `FINANCE_MEDIA` 兜底），
 * 而过度收紧会把正常条目挡掉。**有疑问就加词，不要收窄语义。**
 */
const MARKET_KEYWORDS =
  /(A股|港股|美股|欧股|亚太股|股市|股指|大盘|指数|板块|个股|涨停|跌停|新股|IPO|上市|退市|上交所|深交所|北交所|科创板|创业板|证券|券商|基金|ETF|债券|国债|收益率|利率|LPR|MLF|逆回购|央行|人民银行|证监会|金融监管|银保监|银行|保险|信托|期货|期权|外汇|汇率|人民币|美元|欧元|日元|黄金|白银|原油|油价|铜|铝|锂|大宗|商品|通胀|通缩|CPI|PPI|GDP|PMI|非农|经济|财政|货币|政策|宏观|出口|进口|贸易|顺差|逆差|关税|楼市|房价|地产|估值|市值|业绩|财报|营收|净利|盈利|分红|回购|增持|减持|融资|并购|重组|机构|调研|北向|南向|外资|持仓|量化|私募|公募|牛市|熊市|反弹|回调|震荡|风险偏好|景气|产业链|算力|半导体|芯片|新能源|光伏|储能|风电|煤|钢|航运|港口|物流|消费|零售|汽车|医药|军工)/;

/**
 * 门户/聚合平台：**不构成市场向背书**。
 *
 * 它们自己不产内容，只做转载聚合。用平台名当财经媒体名，等于给整个转载池
 * 开绿灯（东方财富快讯里就有新华社、央视、外交部、气象局的稿子）。
 * 命中本表即走「不背书」分支，该条只能靠标题关键词自救。
 */
const AGGREGATOR_PLATFORMS =
  /(东方财富(快讯|Choice数据|网)?$|新浪财经$|新浪$|财经快讯$|快讯$|滚动播报|市场资讯$|同花顺$|雪球$)/;

/** 公认的财经/市场类媒体：其供稿默认视为市场向 */
const FINANCE_MEDIA =
  /(证券时报|券商中国|中国证券报|上海证券报|证券日报|第一财经|财联社|数据宝|华尔街见闻|21世纪经济报道|每日经济新闻|经济观察报|界面新闻|澎湃新闻|中新经纬|中国基金报|中国经营报|财经|东方财富研究所|东方财富证券)/;

/**
 * 取「东八区自然日」字符串 YYYY-MM-DD。
 *
 * 财经时事的「每日 10 条」按国内读者的日历划分，因此不能用 UTC 日期，
 * 否则 0:00–8:00 期间会分到前一天。
 *
 * 实现已移到 `lib/day.js`（浏览量统计也要用同一口径）。这里**先 import 再 export**，
 * 不能写成 `export { bucketDate } from './day.js'` —— 那种写法只做转发，
 * 不会在本模块里建立本地绑定，而本文件内部多处调用 `bucketDate`，
 * 会立刻炸成 ReferenceError。
 *
 * @param {Date} [date]
 */
export { bucketDate };

/** 统一的带超时 fetch（零依赖，用内置 AbortSignal.timeout） */
async function fetchWithTimeout(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

/**
 * 解析新浪返回。
 * @param {any} payload
 * @returns {Array<{ title: string, url: string, publishedAt: string, source: string }>}
 */
export function parseSinaNews(payload) {
  const list = payload?.result?.data;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const title = String(item?.title ?? '').trim();
    const url = String(item?.url ?? item?.wapurl ?? '').trim();
    if (!title || !/^https?:\/\//.test(url)) continue;
    const seconds = Number(item?.ctime ?? item?.intime ?? 0);
    out.push({
      title,
      url,
      publishedAt: seconds
        ? new Date(seconds * 1000).toISOString()
        : new Date().toISOString(),
      source: String(item?.media_name ?? '').trim() || '新浪财经',
    });
  }
  return out;
}

/**
 * 解析东方财富**财经导读**列表（主信源）。
 *
 * 该接口返回 `uniqueUrl`，是**真实的文章直链**，无需拼接。
 * 因此这个源可以标 `hasDirectUrl: true`。
 *
 * @param {any} payload
 */
export function parseEastmoneyColumn(payload) {
  const list = payload?.data?.list;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const title = String(item?.title ?? item?.summary ?? '').trim();
    // uniqueUrl 优先，其次 url；两者都要求是 http(s) 直链
    const url = String(item?.uniqueUrl ?? item?.url ?? '').trim();
    if (!title || !/^https?:\/\//.test(url)) continue;
    const ts = String(item?.showTime ?? '');
    const parsed = Date.parse(ts.replace(' ', 'T') + (ts.length <= 16 ? ':00+08:00' : ''));
    out.push({
      title,
      url,
      publishedAt: Number.isFinite(parsed)
        ? new Date(parsed).toISOString()
        : new Date().toISOString(),
      source: String(item?.mediaName ?? '').trim() || '东方财富',
    });
  }
  return out;
}

/**
 * 解析东方财富 **7×24 快讯**（次信源）。
 *
 * ⚠️ 该接口**不提供文章 URL**，只有 `code`（如 `202609263581234567`）。
 * 东财文章页的标准路径为 `https://finance.eastmoney.com/a/<code>.html`，
 * 这里按此规则补齐，并标 `hasDirectUrl: false`，避免伪装成原文直链。
 *
 * @param {any} payload
 */
export function parseEastmoneyNews(payload) {
  const list = payload?.data?.fastNewsList;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    // 标题优先用 title；快讯的 title 可能为空，则退到 summary 的首句
    const rawTitle = String(item?.title ?? '').trim();
    const summary = String(item?.summary ?? '').trim();
    const title = rawTitle || summary.replace(/^【|】.*$/g, '').slice(0, 60);
    const code = String(item?.code ?? '').trim();
    if (!title || !code) continue;
    const ts = String(item?.showTime ?? item?.time ?? '');
    const parsed = Date.parse(ts.replace(' ', 'T') + (ts.length <= 16 ? ':00+08:00' : ''));
    out.push({
      title,
      url: `https://finance.eastmoney.com/a/${code}.html`,
      publishedAt: Number.isFinite(parsed)
        ? new Date(parsed).toISOString()
        : new Date().toISOString(),
      source: '东方财富快讯',
    });
  }
  return out;
}

/**
 * 从某信源的抓取结果里挑出前 `limit` 条。
 *
 * ## 三步走：先守源 → 再择优 → 后配平
 *
 * **第一步 · 守源（整体命中率闸门）**：命中率低于 30% 时判定该源已退化为综合
 * 资讯，整源拒用（这是 `lid=1686` 的典型特征）。
 *
 * **第二步 · 择优（相关性当选择键）**：闸门只保证「这个源整体是市场向的」，
 * 不保证「每一条都与市场相关」。源里混进个别 AI 安全、时政、社会类条目是正常的
 * ——供稿池本来就杂。
 *
 * ⚠️ 踩过的坑：初版直接用「按时间倒序取前 N」，结果榜首被
 * 「AI安全漏洞潮蔓延」这类与金融市场无关的条目占据；第二版只做了稳定排序
 * （时间为主键、相关性为次键），相关性其实**从未生效**——因为它只有在
 * 两条时间戳完全相同时才被比较，而真实数据里几乎不存在同一秒的两条。
 * 相关性要能起作用，必须在**选择阶段**当主键，在**展示阶段**让位于时间。
 *
 * **第三步 · 配平（栏目名额上限）**：多栏目合并时，发稿快的栏目会淹没慢栏目
 * ——实测能源栏目独占 8/10。因此当条目带 `columnId` 且传入 `quotas` 时，
 * 按栏目先各取上限内的条目，再用其余条目补满，最后统一按时间倒序输出。
 *
 * @param {Array<{ title: string, publishedAt: string, columnId?: number }>} items
 * @param {number} limit
 * @param {string} label 信源名，仅用于报错文案
 * @param {Map<number, number>} [quotas] 栏目 id → 名额上限。不传则仅按相关性与时间排序
 */
export function pickRelevant(items, limit, label, quotas) {
  const scored = items.map((it) => ({
    item: it,
    relevant: isMarketRelevant(it.title, it.source),
  }));

  const relevant = scored.filter((s) => s.relevant);
  const ratio = items.length ? relevant.length / items.length : 0;

  // 命中率过低：该源很可能已退化成综合资讯
  if (relevant.length === 0 || ratio < 0.3) {
    throw new Error(
      `${label} 内容疑似退化为综合资讯（金融相关仅 ${relevant.length}/${items.length}），已拒绝采用`
    );
  }

  const time = (s) => {
    const t = Date.parse(String(s.item.publishedAt ?? ''));
    return Number.isFinite(t) ? t : 0;
  };

  // 选择阶段：相关性优先，其次时间倒序 → 市场向条目先占名额
  const ranked = scored
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      if (a.s.relevant !== b.s.relevant) return a.s.relevant ? -1 : 1;
      const dt = time(b.s) - time(a.s);
      if (dt !== 0) return dt;
      return a.i - b.i;
    });

  // 配平：按栏目名额上限先各取一部分，避免快栏目淹没慢栏目。
  //
  // ⚠️ 关键在**补位顺序**：名额未用满时，若直接按时间倒序补，
  // 发稿快的栏目会从「补位」里重新涌进来 —— 实测能源栏目仍能占到 5/10，
  // 配平等于没做。因此补位时**仍按栏目轮转**：每轮让每个栏目各补一条，
  // 直到凑满 limit。这样只有当某栏目确实没有更多稿件时，它才会让出份额。
  let chosen = ranked;
  if (quotas && quotas.size > 0) {
    const buckets = new Map(); // 栏目 id → 该栏按序排好的条目
    const unassigned = []; // 无 columnId 的条目（自由补位）
    for (const entry of ranked) {
      const col = entry.s.item.columnId;
      if (col === undefined || !quotas.has(col)) {
        unassigned.push(entry);
        continue;
      }
      if (!buckets.has(col)) buckets.set(col, []);
      buckets.get(col).push(entry);
    }

    const taken = new Map(); // 栏目 id → 已取条数
    const picked = [];
    const cursor = new Map(); // 栏目 id → 下一待取下标
    for (const col of buckets.keys()) cursor.set(col, 0);

    // 第一轮：各栏目在名额内取满
    for (const [col, list] of buckets) {
      const cap = quotas.get(col);
      for (let i = 0; i < cap && i < list.length; i += 1) {
        picked.push(list[i]);
      }
      taken.set(col, Math.min(cap, list.length));
      cursor.set(col, Math.min(cap, list.length));
    }

    // 第二轮：轮转补位 —— 每轮每栏至多补一条，缺口由仍有余量的栏目分摊
    let unassignedCursor = 0;
    let progressed = true;
    while (picked.length < limit && progressed) {
      progressed = false;
      for (const [col, list] of buckets) {
        if (picked.length >= limit) break;
        const idx = cursor.get(col);
        if (idx < list.length) {
          picked.push(list[idx]);
          cursor.set(col, idx + 1);
          progressed = true;
        }
      }
      // 所有栏目都取尽后，用无栏目归属的条目兜底
      while (unassignedCursor < unassigned.length && picked.length < limit) {
        picked.push(unassigned[unassignedCursor]);
        unassignedCursor += 1;
        progressed = true;
      }
    }

    chosen = picked;
  }

  chosen = chosen.slice(0, limit);

  // 展示阶段：回到时间倒序。用下标兜底，保证 publishedAt 解析失败时次序确定。
  return chosen
    .sort((a, b) => {
      const dt = time(b.s) - time(a.s);
      if (dt !== 0) return dt;
      return a.i - b.i;
    })
    .map(({ s }) => s.item);
}

/** 抓取东方财富财经导读（主信源） */
async function fetchFromEastmoneyColumn() {
  const all = await fetchEastmoneyColumns(EASTMONEY_COLUMN_IDS, '东方财富财经导读');
  if (!all.length) throw new Error('东方财富财经导读返回数据为空');
  assertFresh(all, '东方财富财经导读');

  const quotas = new Map(EASTMONEY_COLUMN_IDS.map((c) => [c.id, c.quota]));
  const picked = pickRelevant(all, NEWS_PAGE_SIZE, '东方财富财经导读', quotas);
  return picked;
}

/**
 * 并发抓取多个东方财富栏目并按 URL 去重。
 *
 * ## 为什么要多栏
 * 单个栏目实测**硬性只返回 10 条**（`pageSize=30/60` 均无效，`pageIndex`/`page`/`offset`
 * 也都不生效）。只抓一栏，等于每天只有 10 条候选池，且榜首时间戳会显著滞后
 * ——实测某栏目最新一条是当天 08:25，而另一栏目已有当天 14:15 的条目。
 * 合并多栏后再取前 10，既扩大了候选池，也让「最新」名副其实。
 *
 * ## 栏目怎么选
 * 只保留**内容本身就是市场向**的栏目（股市/公司/全球市场/商品），
 * 不选「要闻」「综合」这类会混入时政与社会新闻的栏目。
 *
 * @param {Array<{ id: number, label: string }>} columns
 * @param {string} label 用于报错文案的信源名
 * @returns {Promise<Array<{ title: string, url: string, publishedAt: string, source: string, columnId: number }>>}
 */
async function fetchEastmoneyColumns(columns, label) {
  const results = await Promise.allSettled(
    columns.map(async (col) => {
      const res = await fetchWithTimeout(
        `${EASTMONEY_COLUMN_ENDPOINT_BASE}&column=${col.id}&pageSize=10`,
        {
          headers: {
            Referer: 'https://finance.eastmoney.com/',
            'User-Agent': BROWSER_UA,
            Accept: 'application/json, text/plain, */*',
          },
        }
      );
      const payload = await res.json();
      return parseEastmoneyColumn(payload).map((it) => ({ ...it, columnId: col.id }));
    })
  );

  const ok = results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length === columns.length) {
    const why = failed[0]?.reason;
    throw new Error(`${label} 全部栏目不可达：${why instanceof Error ? why.message : String(why)}`);
  }

  // 按 URL 去重：不同栏目会收录同一篇稿子
  const seen = new Set();
  return ok.filter((it) => {
    if (seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });
}

/**
 * 抓取东方财富快讯（次信源）。
 *
 * ⚠️ 该源是**全品类 7×24 播报**，不是市场专线：实测 30 条里只有 2 条与
 * 金融市场相关（技能大赛、台风预警、中秋档票房、外交部答问……），
 * 相关性闸门会直接拒用。保留它的意义是「极端行情下仍有兜底」——
 * 一旦市场剧烈波动，快讯池会被行情类条目占满，届时闸门会自然放行。
 * 平时它被拒用属于**预期行为**，不代表出错。
 */
async function fetchFromEastmoneyFlash() {
  const res = await fetchWithTimeout(
    `${EASTMONEY_FLASH_ENDPOINT}&pageSize=${NEWS_PAGE_SIZE * 3}`,
    {
      headers: {
        Referer: 'https://kuaixun.eastmoney.com/',
        'User-Agent': BROWSER_UA,
        Accept: 'application/json, text/plain, */*',
      },
    }
  );
  const payload = await res.json();
  const all = parseEastmoneyNews(payload);
  if (!all.length) throw new Error('东方财富快讯返回数据为空');
  return pickRelevant(all, NEWS_PAGE_SIZE, '东方财富快讯');
}

/** 抓取新浪财经·宏观（备信源） */
async function fetchFromSina() {
  const res = await fetchWithTimeout(SINA_ENDPOINT, {
    headers: {
      // 新浪对 Referer 有要求，缺失会返回空数据
      Referer: 'https://finance.sina.com.cn',
      'User-Agent': BROWSER_UA,
      Accept: 'application/json, text/plain, */*',
    },
  });
  const payload = await res.json();
  const all = parseSinaNews(payload);
  if (!all.length) throw new Error('新浪返回数据为空');
  assertFresh(all, '新浪财经·宏观');
  return pickRelevant(all, NEWS_PAGE_SIZE, '新浪财经·宏观');
}

/**
 * 时效闸门：源里**最新一条**都不够新，说明该栏目已停更，整源拒用。
 *
 * ⚠️ 踩过的坑（2026-09-26）：`sina-macro`（lid=1687）能稳定抓到 10 条、
 * 相关性也 100% 通过，但最新一条停在 **2026-05-11** —— 已停更四个多月。
 * 相关性闸门与覆盖率闸门都拦不住它，因为「内容质量」与「内容新鲜度」
 * 是两个正交维度：一个栏目可以条条相关却整年不更新。
 *
 * 若不拦，一旦东方财富不可达就会回退到它，前端会突然显示几个月前的
 * 「财经时事」，且用户无法从时间戳上分辨这是归档还是当前新闻。
 *
 * 容忍度取 `maxAgeDays`：周末与长假期间正常栏目也会有 1–3 天无更新，
 * 因此不能卡到「必须是今天」。
 *
 * @param {Array<{ publishedAt: string }>} items
 * @param {string} label
 * @param {number} [maxAgeDays]
 */
export function assertFresh(items, label, maxAgeDays = 7) {
  const times = items
    .map((it) => Date.parse(String(it.publishedAt ?? '')))
    .filter((t) => Number.isFinite(t));
  if (!times.length) throw new Error(`${label} 全部条目的发布时间不可解析，无法判断时效`);

  const newest = Math.max(...times);
  const ageDays = (Date.now() - newest) / 86_400_000;
  if (ageDays > maxAgeDays) {
    throw new Error(
      `${label} 已停更 ${ageDays.toFixed(0)} 天（最新一条 ${new Date(newest).toISOString().slice(0, 10)}），已拒绝采用`
    );
  }
  return ageDays;
}

/**
 * 信源注册表：**按金融市场相关性排序**，前一个失败自动尝试后一个。
 *
 * 顺序的取舍依据是「内容与金融市场是否相关」，不是「接口是否好抓」：
 * 东方财富的财经导读直接由券商与财经媒体供稿，天然是市场向内容。
 */
export const NEWS_SOURCES = [
  {
    id: 'eastmoney-column',
    label: '东方财富·财经导读',
    fetch: fetchFromEastmoneyColumn,
    hasDirectUrl: true,
  },
  {
    id: 'eastmoney-flash',
    label: '东方财富·7×24快讯',
    fetch: fetchFromEastmoneyFlash,
    hasDirectUrl: false,
    urlNote: '快讯不返回直达链接，URL 由文章 code 按 finance.eastmoney.com/a/<code>.html 规则补齐',
  },
  {
    id: 'sina-macro',
    label: '新浪财经·宏观金融',
    fetch: fetchFromSina,
    hasDirectUrl: true,
  },
];

/**
 * 新闻服务工厂。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ news: { refreshMs: number, keepDays: number }, sources?: typeof NEWS_SOURCES }} config
 */
export function createNewsService(db, config) {
  const sources = config.sources ?? NEWS_SOURCES;

  const stmt = {
    latestBucket: db.prepare(
      'SELECT bucket_date FROM news_items ORDER BY bucket_date DESC LIMIT 1'
    ),
    countBucket: db.prepare(
      'SELECT COUNT(*) AS n FROM news_items WHERE bucket_date = ?'
    ),
    selectBucket: db.prepare(`
      SELECT n.* FROM news_items n
      WHERE n.bucket_date = ?
      ORDER BY n.rank_index ASC
    `),
    insert: db.prepare(`
      INSERT OR REPLACE INTO news_items
        (bucket_date, rank_index, title, url, published_at, source, likes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    clearBucket: db.prepare('DELETE FROM news_items WHERE bucket_date = ?'),
    countLikes: db.prepare('SELECT COUNT(*) AS n FROM news_likes WHERE news_id = ?'),
    hasLike: db.prepare('SELECT 1 AS x FROM news_likes WHERE news_id = ? AND fingerprint = ?'),
    insertLike: db.prepare(
      'INSERT OR IGNORE INTO news_likes (news_id, fingerprint, created_at) VALUES (?, ?, ?)'
    ),
    deleteLike: db.prepare('DELETE FROM news_likes WHERE news_id = ? AND fingerprint = ?'),
    byId: db.prepare('SELECT * FROM news_items WHERE id = ?'),

    stateGet: db.prepare('SELECT * FROM fetch_state WHERE source = ?'),
    stateOk: db.prepare(`
      INSERT INTO fetch_state (source, last_ok_at, last_error, last_error_at)
      VALUES (?, ?, NULL, NULL)
      ON CONFLICT(source) DO UPDATE SET last_ok_at = excluded.last_ok_at, last_error = NULL, last_error_at = NULL
    `),
    stateFail: db.prepare(`
      INSERT INTO fetch_state (source, last_ok_at, last_error, last_error_at)
      VALUES (?, NULL, ?, ?)
      ON CONFLICT(source) DO UPDATE SET last_error = excluded.last_error, last_error_at = excluded.last_error_at
    `),
    stateAll: db.prepare('SELECT * FROM fetch_state'),

    /** 可回看的日期清单（保留窗口内有内容的自然日），倒序 */
    availableDates: db.prepare(`
      SELECT bucket_date, COUNT(*) AS n
      FROM news_items
      GROUP BY bucket_date
      ORDER BY bucket_date DESC
    `),
  };

  /** 内存里的抓取节流时间戳，避免每次请求都查外部源 */
  let lastAttemptAt = 0;
  /** 最近一次抓取失败原因（供 /api/news/status 展示） */
  let lastError = '';
  /** 当前是否正在抓取（防止并发重复抓） */
  let inFlight = null;

  /**
   * 读取某日缓存（含点赞数与「我是否点过」）。
   */
  function readBucket(date, fingerprint) {
    const rows = stmt.selectBucket.all(date);
    return rows.map((row) => {
      const id = Number(row.id);
      return {
        id,
        title: String(row.title),
        url: String(row.url),
        publishedAt: String(row.published_at),
        source: String(row.source),
        likes: Number(plain(stmt.countLikes.get(id))?.n ?? Number(row.likes ?? 0)),
        liked: fingerprint ? Boolean(plain(stmt.hasLike.get(id, fingerprint))) : false,
      };
    });
  }

  /** 抓取并落库。任一信源成功即返回。 */
  async function refresh(date) {
    const errors = [];
    for (const source of sources) {
      try {
        const items = await source.fetch();
        if (!items.length) throw new Error('抓取结果为空');

        const now = new Date().toISOString();
        db.exec('BEGIN');
        try {
          stmt.clearBucket.run(date);
          items.forEach((item, index) => {
            stmt.insert.run(
              date,
              index + 1,
              item.title,
              item.url,
              item.publishedAt,
              item.source || source.label,
              0,
              now
            );
          });
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }

        stmt.stateOk.run(source.id, now);
        lastError = '';
        return { ok: true, source: source.id, sourceLabel: source.label, count: items.length };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${source.label}: ${message}`);
        stmt.stateFail.run(source.id, message, new Date().toISOString());
      }
    }
    lastError = errors.join('；') || '所有信源均不可用';
    return { ok: false, errors };
  }

  return {
    bucketDate,
    readBucket,

    /**
     * 拿「今天」的新闻。命中缓存直接返回；否则按节流策略抓一次。
     *
     * @param {{ fingerprint?: string, force?: boolean }} [options]
     */
    async getToday({ fingerprint, force = false } = {}) {
      const date = bucketDate();
      const cachedCount = Number(plain(stmt.countBucket.get(date))?.n ?? 0);

      if (cachedCount > 0 && !force) {
        return { date, items: readBucket(date, fingerprint), stale: false, fromCache: true };
      }

      const now = Date.now();
      const throttled = now - lastAttemptAt < config.news.refreshMs && !force;
      // ⚠️ `force` 必须能绕过「已有缓存就不抓」的短路，否则它形同虚设：
      // 旧实现写成 `cachedCount === 0 && !throttled`，当天一旦抓过，
      // 后续带 force 的请求也会被判定为「无需抓取」，直接返回旧缓存。
      // 排查信源切换时曾被这个坑误导很久 —— 明明改了信源，接口却纹丝不动。
      const shouldFetch = (cachedCount === 0 || force) && !throttled;

      if (shouldFetch) {
        lastAttemptAt = now;
        if (!inFlight) {
          inFlight = refresh(date).finally(() => {
            inFlight = null;
          });
        }
        await inFlight;
      } else if (cachedCount === 0 && inFlight) {
        // 并发请求共享同一次抓取
        await inFlight;
      }

      const after = Number(plain(stmt.countBucket.get(date))?.n ?? 0);
      if (after > 0) {
        return { date, items: readBucket(date, fingerprint), stale: false, fromCache: false };
      }

      // 降级：返回最近一次成功缓存
      const latest = plain(stmt.latestBucket.get());
      if (latest) {
        const fallbackDate = String(latest.bucket_date);
        return {
          date: fallbackDate,
          requestedDate: date,
          items: readBucket(fallbackDate, fingerprint),
          stale: true,
          fromCache: true,
          message: `今日抓取失败，展示 ${fallbackDate} 的缓存内容。原因：${lastError || '外部信源不可用'}`,
        };
      }

      // 从未成功过
      return {
        date,
        items: [],
        stale: true,
        fromCache: false,
        unavailable: true,
        message: lastError || '外部信源不可用，且本地无缓存',
      };
    },

    /**
     * 取**指定日期**的新闻（供「保存一周、点击切换」使用）。
     *
     * 与 `getToday` 的区别：**不会触发抓取**——历史日期只能读缓存。
     * 已过期的历史日抓不回来，硬抓只会浪费外部请求，还会把「那天没有数据」
     * 这件事掩盖掉。
     *
     * @param {string} date YYYY-MM-DD
     * @param {{ fingerprint?: string }} [options]
     */
    getByDate(date, { fingerprint } = {}) {
      const wanted = String(date ?? '').trim();
      const today = bucketDate();
      const items = readBucket(wanted, fingerprint);
      return {
        date: wanted,
        requestedDate: wanted,
        items,
        total: items.length,
        fromCache: true,
        // 非今天的日期天然是「历史存档」，前端据此显示「存档」而非「实时」
        stale: wanted !== today,
      };
    },

    /**
     * 可回看的日期清单（含每日条数），倒序。
     *
     * **必须自己卡保留窗口**，不能只依赖 `cleanup()`。
     * 原因：`cleanup()` 只在抓取流程末尾调用，若服务停机几天再启动、
     * 或某天抓取连续失败，`news_items` 里就会残留超出窗口的行，
     * 前端日期条会凭空多出几个点不到的旧日期（点进去是空的）。
     *
     * 这里用与 `cleanup()` 完全相同的 cutoff 口径，保证「显示的」与
     * 「会被删的」始终一致。
     */
    availableDates() {
      const cutoff = bucketDate(
        new Date(Date.now() - config.news.keepDays * 86_400_000)
      );
      return stmt.availableDates
        .all()
        .map((r) => ({ date: String(r.bucket_date), count: Number(r.n) }))
        .filter((r) => r.date >= cutoff);
    },

    /** 保留天数（前端据此提示「仅保留最近 N 天」） */
    keepDays() {
      return config.news.keepDays;
    },

    /** 点赞（幂等 + 指纹去重） */
    like(id, fingerprint) {
      const newsId = Number(id);
      if (!plain(stmt.byId.get(newsId))) {
        return { ok: false, code: 'NOT_FOUND', message: '新闻不存在' };
      }
      if (!fingerprint) return { ok: false, code: 'NO_FINGERPRINT', message: '缺少客户端指纹' };
      const before = Boolean(plain(stmt.hasLike.get(newsId, fingerprint)));
      if (!before) stmt.insertLike.run(newsId, fingerprint, new Date().toISOString());
      const likes = Number(plain(stmt.countLikes.get(newsId))?.n ?? 0);
      db.prepare('UPDATE news_items SET likes = ? WHERE id = ?').run(likes, newsId);
      return { ok: true, likes, liked: true, alreadyLiked: before };
    },

    unlike(id, fingerprint) {
      const newsId = Number(id);
      if (!plain(stmt.byId.get(newsId))) {
        return { ok: false, code: 'NOT_FOUND', message: '新闻不存在' };
      }
      if (!fingerprint) return { ok: false, code: 'NO_FINGERPRINT', message: '缺少客户端指纹' };
      stmt.deleteLike.run(newsId, fingerprint);
      const likes = Number(plain(stmt.countLikes.get(newsId))?.n ?? 0);
      db.prepare('UPDATE news_items SET likes = ? WHERE id = ?').run(likes, newsId);
      return { ok: true, likes, liked: false };
    },

    /** 信源健康状态（排查用） */
    status() {
      return {
        sources: sources.map((s) => ({
          id: s.id,
          label: s.label,
          hasDirectUrl: s.hasDirectUrl,
          urlNote: s.urlNote ?? null,
        })),
        states: stmt.stateAll.all().map((r) => ({ ...r })),
        lastError: lastError || null,
        refreshIntervalMs: config.news.refreshMs,
      };
    },

    /** 强制刷新（供 verify 脚本与管理员手动触发） */
    refreshNow() {
      lastAttemptAt = Date.now();
      return refresh(bucketDate());
    },

    /** 清理超过保留天数的历史缓存 */
    cleanup() {
      const cutoff = bucketDate(
        new Date(Date.now() - config.news.keepDays * 86_400_000)
      );
      const info = db.prepare('DELETE FROM news_items WHERE bucket_date < ?').run(cutoff);
      return Number(info.changes);
    },
  };
}

/** 引入纯函数工具（放在文件末尾避免循环引用的可读性问题） */
function plain(row) {
  return row ? { ...row } : row;
}
