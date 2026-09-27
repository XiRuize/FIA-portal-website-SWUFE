/**
 * 财经时事「信源定位 + 条目择优 + 时效」测试。
 *
 * 这里锁住的是四次真实事故（全部在 2026-09-26 逐条实测中发现）：
 *
 * 1. **信源名字像 ≠ 内容是金融新闻**：新浪 lid=1686 标称财经，实为综合资讯
 *    （铁路客流、景区活动、人事任免）。
 * 2. **聚合平台不能当财经媒体背书**：东方财富快讯把来源统一标成「东方财富快讯」，
 *    而 `FINANCE_MEDIA` 里含「东方财富」，于是每一条快讯都被放行 ——
 *    「中秋档电影总票房破2亿」也成了财经时事。
 * 3. **相关性要在选择阶段当主键**：旧实现按时间倒序取前 N，无关条目时间最新就占据榜首。
 * 4. **内容质量与新鲜度是两个正交维度**：新浪 lid=1687 条条相关却停更 138 天，
 *    相关性闸门拦不住它，需要独立的时效闸门。
 *
 * 测试数据取自线上实际抓取结果，不是编造的标题。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isMarketRelevant,
  NEWS_SOURCES,
  pickRelevant,
  assertFresh,
} from '../src/lib/news.js';

// ---------------------------------------------------------------------------
// 信源定位
// ---------------------------------------------------------------------------

test('信源顺序：东方财富为首选（金融相关优先于接口易用性）', () => {
  assert.ok(NEWS_SOURCES.length >= 3, '至少应配置主/次/备三个信源');
  assert.equal(NEWS_SOURCES[0].id, 'eastmoney-column', '首选信源应为东方财富财经导读');

  const ids = NEWS_SOURCES.map((s) => s.id);
  assert.ok(ids.includes('eastmoney-flash'), '应有东方财富快讯作为次信源');
  assert.ok(ids.includes('sina-macro'), '应有新浪宏观作为备信源');

  // 已弃用的综合资讯栏目不得回归
  assert.ok(
    !ids.some((id) => /1686|sina-roll/.test(id)),
    '已实测退化为综合资讯的信源不得重新启用'
  );
});

test('每个信源都声明直链能力（无直链的必须写明补齐规则）', () => {
  for (const s of NEWS_SOURCES) {
    assert.equal(typeof s.id, 'string');
    assert.equal(typeof s.label, 'string');
    assert.equal(typeof s.fetch, 'function');
    assert.equal(typeof s.hasDirectUrl, 'boolean', `${s.id} 未声明 hasDirectUrl`);
    // 没有直链的源必须解释 URL 从哪来，否则前端点进去是死链
    if (!s.hasDirectUrl) {
      assert.ok(s.urlNote, `${s.id} 无直链时必须写明 URL 补齐规则`);
    }
  }
});

// ---------------------------------------------------------------------------
// 相关性判定（第 1、2 次事故）
// ---------------------------------------------------------------------------

test('市场向标题一律通过（含未预置词汇的常见写法）', () => {
  const market = [
    ['逾百家机构调研这只股！还有这些业绩暴增股被盯上', '证券时报'],
    ['国庆假期临近 持股还是持币过节？机构研判来了', '中国证券报'],
    ['算力赛道 多家A股公司密集宣布大单 产业链景气度上行', '证券时报'],
    ['罕见！上市第6日跌停 原因揭秘！潜力低估值次新股出炉 仅10只', '数据宝'],
    ['美股全线拉升！国际油价大幅跳水 美国、伊朗传出大消息', '券商中国'],
    ['国际油价暗盘飙涨超3%', '21世纪经济报道'],
    ['9月25日港股收盘：恒指跌1.01% 潍柴动力领跌成分股', '证券时报'],
    ['中际旭创：完成50亿元股份回购', '数据宝'],
    ['上交所向5连板新华文轩下发监管工作函', '证券时报'],
  ];
  for (const [title, source] of market) {
    assert.equal(isMarketRelevant(title, source), true, `应判为市场向：${title}`);
  }
});

test('券商与财经媒体供稿默认视为市场向（标题用词超出词表也不误杀）', () => {
  // 标题里没有任何关键词，但来源是券商/财经媒体 → 放行。
  assert.equal(isMarketRelevant('重磅发布', '券商中国'), true);
  assert.equal(isMarketRelevant('最新消息', '证券时报'), true);
  assert.equal(isMarketRelevant('今日要闻速览', '财联社'), true);
});

test('聚合平台的来源标签不构成市场向背书（第 2 次事故的直接回归）', () => {
  // 快讯信源把来源统一写成「东方财富快讯」。若把它当财经媒体，
  // 这一整池内容就全部放行了 —— 包括下面这条中秋档票房。
  const platformLabels = ['东方财富快讯', '东方财富', '东方财富Choice数据', '新浪财经', '滚动播报'];

  const offTopic = '2026年中秋档电影总票房破2亿';
  for (const src of platformLabels) {
    assert.equal(
      isMarketRelevant(offTopic, src),
      false,
      `平台来源「${src}」不应为无关条目背书：${offTopic}`
    );
  }

  // 但同一条若真来自财经媒体，仍应放行（不能把兜底规则一起废掉）
  assert.equal(isMarketRelevant(offTopic, '证券时报'), true);
});

test('快讯池里实测的无关条目全部被拦下', () => {
  const noise = [
    '解码世界技能大赛溢出效应：上海以世赛标准赋能人才培育与产业升级',
    '俄罗斯总统普京与塞尔维亚总统武契奇通电话 双方讨论了乌克兰局势及能源合作问题',
    '泰国多地强降雨致交通受阻 政府启动24小时游客援助机制',
    '外交部发言人就人工智能问题答记者问',
    '自然资源部与中国气象局联合发布橙色地质灾害气象风险预警',
    '2026年中秋档电影总票房破2亿',
    '启元机器人开放机器人生态底座',
    '水利部和中国气象局联合发布橙色山洪灾害气象预警',
    '联播一瞬丨三秒画面 圆四代寻亲梦',
  ];
  for (const t of noise) {
    assert.equal(isMarketRelevant(t, '东方财富快讯'), false, `应拦下：${t}`);
  }
});

test('空输入不抛异常（标题与来源都缺时返回 false）', () => {
  assert.equal(isMarketRelevant(''), false);
  assert.equal(isMarketRelevant('', ''), false);
  assert.equal(isMarketRelevant(undefined, undefined), false);
  assert.equal(isMarketRelevant(null, null), false);
});

test('宏观与大宗商品标题被覆盖（口径不能只盯股市）', () => {
  const macro = [
    '8月CPI同比上涨0.6% PPI降幅收窄',
    '央行开展5000亿元MLF操作 利率维持不变',
    '人民币对美元中间价上调32个基点',
    'LME铜库存降至历史低位 铜价创新高',
    '前8个月我国进出口总值同比增长6%',
  ];
  for (const title of macro) {
    assert.equal(isMarketRelevant(title), true, `宏观/商品标题应通过：${title}`);
  }
});

// ---------------------------------------------------------------------------
// 条目择优（第 3 次事故）
// ---------------------------------------------------------------------------

/** 造一条测试用新闻；时间用相对秒数，避免依赖真实时钟 */
function mk(title, secondsAgo, source = '') {
  const base = Date.now();
  return {
    title,
    url: 'https://example.com/' + encodeURIComponent('n' + secondsAgo),
    publishedAt: new Date(base - secondsAgo * 1000).toISOString(),
    source,
  };
}

test('整体命中率过低时整源拒用（守住信源定位）', () => {
  // 5 条里只有 1 条沾金融 → 20% < 30%，判定该源已退化为综合资讯
  const degraded = [
    mk('中秋假期全国铁路发送旅客创新高', 10, '综合'),
    mk('某地开展街道环境整治专项行动', 20, '综合'),
    mk('景区推出多项活动迎客流高峰', 30, '综合'),
    mk('人事任免公告发布', 40, '综合'),
    mk('A股三大指数集体收涨', 50, '综合'),
  ];
  assert.throws(
    () => pickRelevant(degraded, 10, '测试源'),
    /疑似退化为综合资讯/,
    '命中率 20% 应整源拒用'
  );
});

test('全员无关时同样拒用（而不是「取不到就返回空」）', () => {
  const allNoise = [
    mk('某地开展街道环境整治专项行动', 10, '综合'),
    mk('景区推出多项活动迎客流高峰', 20, '综合'),
  ];
  assert.throws(() => pickRelevant(allNoise, 10, '测试源'), /疑似退化为综合资讯/);
});

test('命中率达标时不做逐条剔除（宽口径，避免自造噪声）', () => {
  // 3 条里 2 条市场向 = 67% ≥ 30% → 源整体放行。
  // limit 给足时，那 1 条无关条目仍应保留 —— 闸门是守源，不是逐条筛。
  const mixed = [
    mk('A股三大指数集体收涨', 10, '证券时报'),
    mk('AI安全漏洞潮蔓延', 20, '科技媒体'),
    mk('央行开展MLF操作', 30, '证券时报'),
  ];
  const out = pickRelevant(mixed, 10, '测试源');
  assert.equal(out.length, 3, 'limit 未满时不应因无关而丢弃条目');
});

test('名额不足时市场向条目优先占位（相关性在选择阶段当主键）', () => {
  // 第 3 次事故的回归：无关条目时间最新，旧实现会让它占据榜首。
  const items = [
    mk('A股三大指数集体收涨', 300, '证券时报'),
    mk('央行开展5000亿元MLF操作', 200, '证券时报'),
    mk('国际油价大幅跳水', 100, '券商中国'),
    mk('AI安全漏洞潮蔓延：Meta拟加强风险提示', 10, '科技媒体'),
    mk('某景区迎客流高峰', 5, '综合'),
  ];
  const out = pickRelevant(items, 3, '测试源');

  assert.equal(out.length, 3);
  assert.ok(
    !out.some((it) => /AI安全漏洞|景区/.test(it.title)),
    `名额不足时应优先市场向条目，实际取到：${out.map((i) => i.title).join(' / ')}`
  );
});

test('选中条目内部仍按时间倒序（时间线不被相关度打乱）', () => {
  const items = [
    mk('A股三大指数集体收涨', 300, '证券时报'),
    mk('央行开展5000亿元MLF操作', 200, '证券时报'),
    mk('国际油价大幅跳水', 100, '券商中国'),
    mk('沪指涨0.5%', 400, '证券时报'),
  ];
  const out = pickRelevant(items, 4, '测试源');
  const times = out.map((it) => Date.parse(it.publishedAt));
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i] <= times[i - 1], `第 ${i} 条比上一条更新，时间线被打乱`);
  }
  assert.equal(out[0].title, '国际油价大幅跳水', '最新的一条应排在最前');
});

test('publishedAt 不可解析时不抛异常且次序确定', () => {
  const items = [
    { title: 'A股三大指数集体收涨', url: 'https://e.com/1', publishedAt: 'not-a-date', source: '证券时报' },
    { title: '央行开展MLF操作', url: 'https://e.com/2', publishedAt: '', source: '证券时报' },
    { title: '沪指涨0.5%', url: 'https://e.com/3', publishedAt: null, source: '证券时报' },
  ];
  const a = pickRelevant(items, 3, '测试源').map((i) => i.url);
  const b = pickRelevant(items, 3, '测试源').map((i) => i.url);
  assert.deepEqual(a, b, '相同输入应得到稳定次序');
  assert.equal(a.length, 3);
});

test('limit 大于候选数时全部返回，不补空位', () => {
  const items = [mk('A股三大指数集体收涨', 10, '证券时报')];
  assert.equal(pickRelevant(items, 10, '测试源').length, 1);
});

// ---------------------------------------------------------------------------
// 栏目配平（第 5 次事故：快栏目淹没慢栏目）
// ---------------------------------------------------------------------------

/** 造一条带栏目归属的新闻 */
function mkCol(title, secondsAgo, columnId) {
  return { ...mk(title, secondsAgo, '证券时报'), columnId };
}

test('多栏目合并时每栏不超过名额上限（避免首页变成单一栏目专版）', () => {
  // 第 5 次事故的回归：能源栏目发稿快，实测独占 8/10，
  // 股票与宏观内容被挤光，首页成了「油市专版」。
  const items = [
    // 能源栏目：12 条，且时间都最新
    ...Array.from({ length: 12 }, (_, i) => mkCol(`能源新闻${i}`, i * 10, 356)),
    // 股市栏目：6 条，时间较旧
    ...Array.from({ length: 6 }, (_, i) => mkCol(`股市新闻${i}`, 1000 + i * 10, 347)),
    // A股策略：4 条
    ...Array.from({ length: 4 }, (_, i) => mkCol(`策略新闻${i}`, 1500 + i * 10, 353)),
    // 全球市场：4 条
    ...Array.from({ length: 4 }, (_, i) => mkCol(`全球市场新闻${i}`, 2000 + i * 10, 366)),
  ];
  const quotas = new Map([[347, 4], [353, 3], [366, 2], [356, 2]]);
  const out = pickRelevant(items, 10, '测试源', quotas);

  const count = (col) => out.filter((it) => it.columnId === col).length;
  assert.ok(count(356) <= 2, `能源栏目应被限制在 2 条内，实际 ${count(356)} 条`);
  assert.ok(count(347) >= 1, '股市栏目必须有机会露出');
  assert.ok(count(366) >= 1, '全球市场栏目必须有机会露出');
  assert.equal(out.length, 10, '应补满 10 条，不留空位');
});

test('其他栏目全部无稿时，快栏目可以突破名额占满（名额不是硬上限）', () => {
  // 这是上一条的边界：名额上限的作用是「保证多样性」，
  // 而不是「宁可留空也不给快栏目」。只有能源有稿时，就该让能源占满。
  const items = Array.from({ length: 15 }, (_, i) => mkCol(`能源${i}`, i * 10, 356));
  const quotas = new Map([[347, 4], [353, 3], [366, 2], [356, 2]]);
  const out = pickRelevant(items, 10, '测试源', quotas);
  assert.equal(out.length, 10, '其他栏目无稿时仍应补满 10 条，而不是留下空位');
  assert.equal(out.filter((it) => it.columnId === 356).length, 10);
});

test('某栏目当日无稿时，名额让给其他栏目补满（不出现空位）', () => {
  const items = [
    ...Array.from({ length: 8 }, (_, i) => mkCol(`能源${i}`, i * 10, 356)),
    ...Array.from({ length: 6 }, (_, i) => mkCol(`股市${i}`, 500 + i * 10, 347)),
  ];
  // 353 与 366 完全没有稿件
  const quotas = new Map([[347, 4], [353, 3], [366, 2], [356, 2]]);
  const out = pickRelevant(items, 10, '测试源', quotas);
  assert.equal(out.length, 10, '缺稿栏目的名额应由其他栏目补满');
});

test('不传 quotas 时退化为纯相关性与时间排序（向后兼容）', () => {
  const items = [
    mkCol('能源新闻', 10, 356),
    mkCol('股市新闻', 20, 347),
  ];
  const out = pickRelevant(items, 10, '测试源');
  assert.equal(out.length, 2, '不传 quotas 时不应因栏目而丢条目');
});

test('配平后仍按时间倒序输出（配平不破坏时间线）', () => {
  const items = [
    ...Array.from({ length: 5 }, (_, i) => mkCol(`能源${i}`, 100 + i * 10, 356)),
    ...Array.from({ length: 5 }, (_, i) => mkCol(`股市${i}`, 200 + i * 10, 347)),
  ];
  const quotas = new Map([[347, 3], [356, 2]]);
  const out = pickRelevant(items, 5, '测试源', quotas);
  const times = out.map((it) => Date.parse(it.publishedAt));
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i] <= times[i - 1], `第 ${i} 条比上一条更新，配平破坏了时间线`);
  }
});

// ---------------------------------------------------------------------------
// 时效闸门（第 4 次事故）
// ---------------------------------------------------------------------------

test('停更的信源被拒绝采用（内容相关 ≠ 内容新鲜）', () => {
  // 新浪 lid=1687 的真实状态：条条相关，但最新一条停在 138 天前
  const stale = [
    { title: '东海期货宏观数据观察：4月CPI温和小幅上升', publishedAt: '2026-05-11T05:47:22.000Z' },
    { title: '全年煤炭市场供需预计总体平衡', publishedAt: '2026-05-02T23:21:14.000Z' },
  ];
  assert.throws(
    () => assertFresh(stale, '新浪财经·宏观'),
    /已停更 \d+ 天/,
    '停更 138 天的源必须被拒用'
  );
});

test('新鲜的信源通过时效闸门', () => {
  const fresh = [
    { title: '某条市场新闻', publishedAt: new Date(Date.now() - 3600_000).toISOString() },
    { title: '另一条市场新闻', publishedAt: new Date(Date.now() - 6 * 3600_000).toISOString() },
  ];
  assert.doesNotThrow(() => assertFresh(fresh, '测试源'));
});

test('长假期间 1–3 天无更新不算停更（容忍窗口不能卡到当天）', () => {
  const holiday = [
    { title: '节前最后一条', publishedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() },
  ];
  assert.doesNotThrow(
    () => assertFresh(holiday, '测试源'),
    '3 天无更新应被容忍，否则长假期间会误判为停更'
  );
});

test('时间戳全部不可解析时报错而非静默放行', () => {
  const broken = [{ title: 'x', publishedAt: 'not-a-date' }, { title: 'y', publishedAt: '' }];
  assert.throws(() => assertFresh(broken, '测试源'), /不可解析/);
});

// ---------------------------------------------------------------------------
// force 语义（第 6 次事故：force 被缓存短路架空）
// ---------------------------------------------------------------------------

test('force 必须能绕过「已有缓存就跳过抓取」（否则改了信源也看不出效果）', async () => {
  // 第 6 次事故的回归：旧实现写 `shouldFetch = cachedCount === 0 && !throttled`，
  // 当天一旦抓过，后续带 force 的请求仍被判为「无需抓取」，直接返回旧缓存。
  // 排查信源切换时被这个坑误导很久 —— 明明换了信源，接口却纹丝不动。
  const { createApp } = await import('../src/app.js');
  const { createEnv, buildConfig } = await import('../src/lib/env.js');
  const { openDatabase } = await import('../src/lib/db.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const nodePath = await import('node:path');

  // 独立临时库，避免污染真实数据
  const workDir = mkdtempSync(nodePath.join(tmpdir(), 'fia-force-'));
  const dbPath = nodePath.join(workDir, 'force.db');
  const db = openDatabase(dbPath);

  try {
    const config = buildConfig(
      createEnv({
        envFile: nodePath.join(workDir, '__no_such_env__'),
        processEnv: { DB_PATH: dbPath, PORT: '0', HOST: '127.0.0.1' },
      })
    );

    let fetchCount = 0;
    const fakeSource = {
      id: 'fake',
      label: '测试源',
      hasDirectUrl: true,
      fetch: async () => {
        fetchCount += 1;
        return [
          {
            title: `A股三大指数集体收涨 第 ${fetchCount} 次抓取`,
            url: `https://example.com/f${fetchCount}`,
            publishedAt: new Date().toISOString(),
            source: '证券时报',
          },
        ];
      },
    };

    const app = createApp({ config, db, newsSources: [fakeSource] });

    // 第一次：正常抓取
    await app.news.getToday({});
    // 第二次：不带 force，应命中缓存、不再抓取
    await app.news.getToday({});
    const afterCached = fetchCount;

    // 第三次：带 force，必须重新抓取
    const forced = await app.news.getToday({ force: true });

    assert.equal(afterCached, 1, '不带 force 时应命中缓存，不应重复抓取');
    assert.equal(fetchCount, 2, '带 force 时必须真的重新抓取一次');
    assert.ok(
      String(forced.items[0]?.title ?? '').includes('第 2 次抓取'),
      `force 后应拿到新内容，实际「${forced.items[0]?.title}」`
    );
  } finally {
    // Windows 上必须先关库句柄，否则 unlink 会 EBUSY
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(workDir, { recursive: true, force: true });
  }
});
