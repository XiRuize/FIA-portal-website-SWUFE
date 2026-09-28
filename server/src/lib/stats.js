/**
 * 站点数据统计（供「栏目与网站管理 · 数据」面板）。
 *
 * ## 数据来源与口径
 *
 * 只有一张表 `page_view_events`，粒度是「天 × 路径 × 指纹」。
 * 由此派生出两组**口径不同、不可互相推断**的指标，必须同时给出：
 *
 * | 指标 | SQL | 含义 |
 * | --- | --- | --- |
 * | 浏览量（hits） | `COUNT(*)` | 有多少「人×页面×天」的组合，反映内容热度 |
 * | 独立访客（uniques） | `COUNT(DISTINCT fingerprint)` | 有多少个不同浏览器来过 |
 *
 * 为什么两个都要：只看 hits 时，一个人狂刷 50 次首页会把数字顶上去；
 * 只看 uniques 又看不出「哪篇内容真的被反复查阅」。
 * 站长看板最忌讳的就是给一个含糊的「访问量」——它什么都说明不了。
 *
 * ## 为什么没有「实时在线人数」
 *
 * 那需要会话级心跳，会为每个访客产生持续的写流量。
 * 本面板给的是「今天有多少人来过、来了多少次」，够用且无额外开销。
 */

import { plain, plainAll } from './db.js';
import { bucketDate, bucketDateBefore, recentDays } from './day.js';

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createStatsService(db) {
  const stmt = {
    /**
     * 主键 (day, path, fingerprint) 让这条插入天然幂等：
     * 同一访客当天重复访问同一页面只留一行，无需先查后写。
     */
    insertView: db.prepare(`
      INSERT OR IGNORE INTO page_view_events (day, path, fingerprint, created_at)
      VALUES (?, ?, ?, ?)
    `),
    total: db.prepare('SELECT COUNT(*) AS n FROM page_view_events'),
    totalUnique: db.prepare(
      'SELECT COUNT(DISTINCT fingerprint) AS n FROM page_view_events'
    ),
    pathCount: db.prepare('SELECT COUNT(DISTINCT path) AS n FROM page_view_events'),
    byDay: db.prepare(`
      SELECT day, COUNT(*) AS hits, COUNT(DISTINCT fingerprint) AS uniques
      FROM page_view_events
      WHERE day >= ?
      GROUP BY day
      ORDER BY day ASC
    `),
    topPaths: db.prepare(`
      SELECT path, COUNT(*) AS hits, COUNT(DISTINCT fingerprint) AS uniques
      FROM page_view_events
      GROUP BY path
      ORDER BY hits DESC, path ASC
      LIMIT ?
    `),
    /** 首次有记录的那一天，用于告诉站长「数据从哪天开始积累」 */
    firstDay: db.prepare('SELECT MIN(day) AS d FROM page_view_events'),
  };

  return {
    /**
     * 记录一次页面访问。
     *
     * @param {{ path: string, fingerprint: string }} input
     * @returns {{ recorded: boolean, day: string }}
     *   `recorded` 为 false 表示该访客当天已访问过该路径（重复计数已被主键吞掉）。
     *   前端不需要区分，但 verify 与测试要能断言去重确实生效。
     */
    recordPageView({ path, fingerprint }) {
      const cleanPath = normalizePath(path);
      const fp = String(fingerprint ?? '').trim();
      const day = bucketDate();
      if (!cleanPath || !fp) return { recorded: false, day };

      const info = stmt.insertView.run(day, cleanPath, fp, new Date().toISOString());
      return { recorded: Number(info.changes) > 0, day };
    },

    /**
     * 总览数字。
     *
     * `last7d` 用「7 天前那一日起」而不是「最近 7 条记录」——
     * 后者在流量稀疏时会横跨几个月，看着像周报其实是季报。
     */
    overview() {
      const today = bucketDate();
      const weekAgo = bucketDateBefore(6);
      const rows = plainAll(stmt.byDay.all(weekAgo));
      const todayRow = rows.find((r) => String(r.day) === today);

      // 近 7 日的**跨天**独立访客必须单独查一次 DISTINCT，不能用每日 uniques 相加：
      // 同一个人连着来 5 天会被计 5 次。这是最容易算错的一个数字。
      const weekUniques = Number(
        plain(
          db
            .prepare(
              'SELECT COUNT(DISTINCT fingerprint) AS n FROM page_view_events WHERE day >= ?'
            )
            .get(weekAgo)
        )?.n ?? 0
      );
      const first = plain(stmt.firstDay.get())?.d;

      return {
        /** 累计浏览量（人 × 页面 × 天 的组合数） */
        totalViews: Number(plain(stmt.total.get())?.n ?? 0),
        /** 累计独立访客数（按浏览器指纹跨天去重） */
        uniqueVisitors: Number(plain(stmt.totalUnique.get())?.n ?? 0),
        /** 被访问过的不同路径数 */
        pathCount: Number(plain(stmt.pathCount.get())?.n ?? 0),
        /** 今日浏览量 */
        todayViews: Number(todayRow?.hits ?? 0),
        /** 今日独立访客 */
        todayVisitors: Number(todayRow?.uniques ?? 0),
        /** 近 7 日（含今日）浏览量 */
        last7dViews: rows.reduce((sum, r) => sum + Number(r.hits), 0),
        /** 近 7 日独立访客（跨天去重，**不等于**每日 uniques 之和） */
        last7dVisitors: weekUniques,
        /** 数据起始日；null 表示还没有任何记录 */
        since: first ? String(first) : null,
      };
    },

    /**
     * 最近 N 天的逐日序列，**已补齐空缺日**。
     *
     * 补齐很重要：SQL 的 GROUP BY 只返回有数据的天，前端折线会因此
     * 把「没人来的一天」直接跳过，看起来像断崖下跌。
     *
     * @param {number} days
     */
    dailySeries(days = 14) {
      const safeDays = Math.min(Math.max(Number(days) || 14, 1), 90);
      const from = bucketDateBefore(safeDays - 1);
      const rows = plainAll(stmt.byDay.all(from));
      const byDay = new Map(rows.map((r) => [String(r.day), r]));

      return recentDays(safeDays).map((day) => {
        const hit = byDay.get(day);
        return {
          day,
          views: Number(hit?.hits ?? 0),
          visitors: Number(hit?.uniques ?? 0),
        };
      });
    },

    /** 访问最多的路径 */
    topPaths(limit = 8) {
      const safeLimit = Math.min(Math.max(Number(limit) || 8, 1), 50);
      return plainAll(stmt.topPaths.all(safeLimit)).map((r) => ({
        path: String(r.path),
        views: Number(r.hits),
        visitors: Number(r.uniques),
      }));
    },
  };
}

/**
 * 归一化上报路径。
 *
 * 前端用的是 hash 路由（`/#/news`），上报时只发 hash 里的路由部分，
 * 因此这里要能处理三种输入：`/news`、`#/news`、`/#/news`。
 * 另外顺手去掉查询串 —— `/news?tab=finance` 与 `/news` 是同一个页面，
 * 分开统计会把同一个页面拆成好几条，看板上出现一堆 `/article/12` 这类噪音。
 *
 * @param {string} raw
 * @returns {string} 形如 `/news`；非法返回空串
 */
export function normalizePath(raw) {
  let path = String(raw ?? '').trim();
  if (!path) return '';

  // 去 hash 前缀
  const hashIdx = path.indexOf('#');
  if (hashIdx >= 0) path = path.slice(hashIdx + 1);
  path = path.split('?')[0];

  if (!path.startsWith('/')) path = `/${path}`;
  // 折叠连续的斜杠
  path = path.replace(/\/{2,}/g, '/');
  // 去掉末尾斜杠（根路径除外）
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  // 动态段归并：/article/123 与 /article/456 是同一个版式的不同内容，
  // 但这里**刻意保留 id** —— 站长要看「哪一篇最热」，归并掉就没信息了。
  // 只做长度与字符白名单约束，防止有人往库里灌任意长字符串。
  if (path.length > 200) path = path.slice(0, 200);
  return path;
}
