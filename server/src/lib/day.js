/**
 * 「东八区自然日」工具。
 *
 * ## 为什么要单独一个模块
 *
 * 站点按国内读者的日历划分「今天」：财经时事按天缓存、浏览量按天聚合。
 * 若用 UTC 日期，**每天 0:00–8:00 的数据会被算到前一天**，
 * 表现为「刚过零点访问，浏览量却没涨」这类很难复现的问题。
 *
 * 这 6 行逻辑原先只写在 `news.js` 里。浏览量统计也需要同一个口径，
 * 直接从 `news.js` 导入会把整个新闻抓取模块（近 900 行）拖进依赖链，
 * 且掩盖了「这是通用日期工具」的事实。故提到本模块，
 * `news.js` 原样再导出以保持既有导入路径可用。
 */

/** 东八区相对 UTC 的偏移毫秒数 */
const SHANGHAI_OFFSET_MS = 8 * 3600_000;

/**
 * 取「东八区自然日」字符串 `YYYY-MM-DD`。
 * @param {Date} [date]
 * @returns {string}
 */
export function bucketDate(date = new Date()) {
  const shanghai = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return shanghai.toISOString().slice(0, 10);
}

/**
 * 取 N 天前的东八区自然日。
 * @param {number} daysAgo
 * @param {Date} [from]
 * @returns {string}
 */
export function bucketDateBefore(daysAgo, from = new Date()) {
  return bucketDate(new Date(from.getTime() - daysAgo * 86_400_000));
}

/**
 * 生成「最近 N 天（含今天）」的日期序列，升序。
 * 用于把稀疏的按天聚合补齐成连续的折线数据点 ——
 * 否则前端折线图会把「没人访问的那天」直接跳过，看起来像访问量断崖。
 *
 * @param {number} days
 * @returns {string[]}
 */
export function recentDays(days) {
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(bucketDateBefore(i));
  }
  return out;
}
