/**
 * 演示种子数据。
 *
 * 用途有两个：
 * 1. 云端数据表首次接入时，可通过「内容管理 → 一键导入演示数据」写入。
 * 2. 当平台 SQL 操作 API 不可达时，站点以「本地演示模式」运行，保证 Demo 可浏览。
 *
 * ⚠️ 这里的文案均为占位示例，正式上线前需由社团替换为真实信息。
 */
import type {
  Article,
  OrgMember,
  SettingsMap,
  TimelineEvent,
} from '@/lib/types';

/**
 * 种子数据版本号 —— **改动本文件的正文内容后必须 +1**。
 *
 * 为什么需要它：本地演示模式把数据落在 `localStorage`，而 `read()` 一旦读到缓存就直接返回，
 * 于是「改了 seed.ts 却看不到变化」会成为常态 —— 因为这个浏览器早就缓存过老版本了。
 * 把版本号写进缓存结构里，`localDb` 就能识别出「缓存是上一版种子」，自动重播种一次。
 *
 * 版本历史：
 * - 1 → 初版
 * - 2 → 「会友机构」由 100+ 调为 300+；历史沿革追加 2026 年节点
 */
export const SEED_REV = 2;

/** 生成稳定的占位配图（公开图床，加载失败时前端会自动降级为渐变兜底） */
const pic = (seed: string, w = 1200, h = 640) =>
  `https://picsum.photos/seed/${seed}/${w}/${h}`;

let seq = 0;
const nextId = () => `seed-${++seq}`;

const base = {
  subtitle: '',
  eventDate: '',
  tags: '',
  fileUrl: '',
  linkUrl: '',
  sortIndex: 100,
  pinned: 0,
  status: 'published' as const,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

export const SEED_ARTICLES: Article[] = [
  // ---------- 首页轮播 ----------
  {
    ...base,
    id: nextId(),
    category: 'banner',
    title: '以研究立身 · 以投资会友',
    subtitle: '西南财经大学金融投资协会',
    summary: '连接课堂与市场，陪伴每一位对金融投资保持好奇的同学。',
    content: '',
    cover: pic('swufe-banner-1', 1920, 800),
    author: '协会宣传部',
    source: '协会',
    eventDate: '2026-09-01',
    sortIndex: 1,
  },
  {
    ...base,
    id: nextId(),
    category: 'banner',
    title: '2026 校园模拟投资大赛',
    subtitle: '全年最受关注的社团赛事',
    summary: '实盘模拟 · 策略路演 · 导师点评，与全校最懂投资的同学同台。',
    content: '',
    cover: pic('swufe-banner-2', 1920, 800),
    author: '协会赛事组',
    source: '协会',
    eventDate: '2026-09-10',
    sortIndex: 2,
  },
  {
    ...base,
    id: nextId(),
    category: 'banner',
    title: '研究员养成计划',
    subtitle: '从 0 到 1 建立投研框架',
    summary: '课程分享 + 数据分享 + 研报模板，一套完整的入门资料体系。',
    content: '',
    cover: pic('swufe-banner-3', 1920, 800),
    author: '协会研究部',
    source: '协会',
    eventDate: '2026-09-15',
    sortIndex: 3,
  },

  // ---------- 活动回顾 ----------
  {
    ...base,
    id: nextId(),
    category: 'activity',
    title: '2026 校园模拟投资大赛圆满收官',
    subtitle: '历时六周 · 312 名同学参赛',
    summary:
      '本届大赛共吸引 312 名同学报名，最终 10 位选手进入决赛路演。参赛同学在实盘模拟中完整体验了建仓、调仓与风控的全过程。',
    content:
      '本届模拟投资大赛自 4 月启动，历时六周。比赛采用模拟实盘账户，初始资金 100 万元，允许交易 A 股与场内 ETF。\n\n决赛路演环节，选手围绕宏观判断、行业选择、个股逻辑三个层面展开陈述，并接受了来自协会指导老师与业界校友的提问。\n\n最终评审从收益率、最大回撤、策略可解释性三个维度综合打分。',
    cover: pic('swufe-activity-1', 1200, 700),
    author: '协会赛事组',
    source: '协会赛事组',
    eventDate: '2026-05-24',
    sortIndex: 10,
  },
  {
    ...base,
    id: nextId(),
    category: 'activity',
    title: '量化投资入门工作坊',
    subtitle: '从数据获取到策略回测',
    summary:
      '工作坊带同学们完成了一个完整的均线策略回测：数据获取 → 复权处理 → 指标计算 → 回测评估。',
    content:
      '工作坊以本地数据引擎为工具，演示了如何把数据工程与策略逻辑解耦。\n\n内容包括：行情数据的复权处理、技术指标计算、参数敏感性分析，以及如何避免常见的过拟合陷阱。',
    cover: pic('swufe-activity-2', 1200, 700),
    author: '协会研究部',
    source: '协会研究部',
    eventDate: '2026-04-12',
    sortIndex: 11,
  },
  {
    ...base,
    id: nextId(),
    category: 'activity',
    title: '走进券商：行业研究岗位参访',
    subtitle: '了解卖方研究员的一天',
    summary:
      '协会组织 30 名同学参访本地券商研究所，与在职研究员交流行业研究的日常工作、能力要求与职业路径。',
    content: '',
    cover: pic('swufe-activity-3', 1200, 700),
    author: '协会外联部',
    source: '协会外联部',
    eventDate: '2026-03-20',
    sortIndex: 12,
  },

  // ---------- 社团记事 ----------
  {
    ...base,
    id: nextId(),
    category: 'news',
    title: '协会 2026 秋季招新正式启动',
    subtitle: '五个部门同步开放',
    summary:
      '研究部、数据部、宣传部、外联部、赛事组同步招新，欢迎所有对金融投资感兴趣的同学加入。',
    content:
      '招新面向全校本科生与研究生，不设专业限制。\n\n研究部：负责行业与公司研究，产出研究报告；\n数据部：负责数据采集、清洗与数据库维护；\n宣传部：负责公众号运营、视觉设计与活动宣发；\n外联部：负责校企合作、嘉宾邀请与活动统筹；\n赛事组：负责模拟投资大赛等赛事的组织与执行。',
    cover: pic('swufe-news-1', 1200, 700),
    author: '协会宣传部',
    source: '协会',
    eventDate: '2026-09-15',
    sortIndex: 20,
    pinned: 1,
  },
  {
    ...base,
    id: nextId(),
    category: 'news',
    title: '协会完成换届，新一届理事会到任',
    subtitle: '2026 届理事会名单公布',
    summary:
      '经协会成员大会选举，新一届理事会正式产生，负责协会下一年度的整体运营。',
    content: '',
    cover: pic('swufe-news-2', 1200, 700),
    author: '协会宣传部',
    source: '协会',
    eventDate: '2026-06-30',
    sortIndex: 21,
  },
  {
    ...base,
    id: nextId(),
    category: 'news',
    title: '协会资料库上线：课程、数据与研报模板一站获取',
    subtitle: '内部资料统一整理',
    summary:
      '协会历史积累的课程讲义、数据集与研报模板已完成整理，成员可在「资料与数据」栏目按分类下载。',
    content: '',
    cover: pic('swufe-news-3', 1200, 700),
    author: '协会数据部',
    source: '协会',
    eventDate: '2026-08-08',
    sortIndex: 22,
  },

  // ---------- 财经时事 ----------
  {
    ...base,
    id: nextId(),
    category: 'finance',
    title: '本周市场回顾：成交量维持高位，板块轮动加快',
    subtitle: '市场观察 · 第 12 期',
    summary:
      '本周主要宽基指数震荡整理，成交额维持在较高水平，题材板块轮动明显加快。',
    content:
      '本周市场整体呈现震荡格局。\n\n从结构上看，资金在成长与价值之间反复切换，热点持续性偏弱。本周报由协会研究部整理，仅用于内部学习交流，不构成任何投资建议。',
    cover: pic('swufe-finance-1', 1200, 700),
    author: '协会研究部',
    source: '协会研究部',
    eventDate: '2026-09-18',
    sortIndex: 30,
  },
  {
    ...base,
    id: nextId(),
    category: 'finance',
    title: '月度宏观数据速览：如何读懂一组经济指标',
    subtitle: '研究方法 · 入门',
    summary:
      '从社融、PMI、CPI 三个最常见的指标出发，介绍宏观数据阅读的基本框架。',
    content: '',
    cover: pic('swufe-finance-2', 1200, 700),
    author: '协会研究部',
    source: '协会研究部',
    eventDate: '2026-09-05',
    sortIndex: 31,
  },
  {
    ...base,
    id: nextId(),
    category: 'finance',
    title: 'ETF 扩容观察：被动投资正在改变什么',
    subtitle: '市场观察 · 第 11 期',
    summary:
      '被动产品规模持续扩张，对市场结构与个股定价的影响值得持续跟踪。',
    content: '',
    cover: pic('swufe-finance-3', 1200, 700),
    author: '协会研究部',
    source: '协会研究部',
    eventDate: '2026-08-22',
    sortIndex: 32,
  },

  // ---------- 课程分享 ----------
  {
    ...base,
    id: nextId(),
    category: 'course',
    title: '财务报表分析入门（共 6 讲）',
    subtitle: '讲义 + 课后练习',
    summary:
      '从三张报表的勾稽关系讲起，逐讲拆解盈利质量、现金流与资产负债结构。',
    content:
      '第一讲：三张报表的勾稽关系\n第二讲：收入与利润的质量\n第三讲：现金流与利润的背离\n第四讲：资产负债表里的风险信号\n第五讲：财务造假常见手法\n第六讲：搭建自己的财务分析模板',
    cover: pic('swufe-course-1', 1200, 700),
    author: '协会研究部',
    source: '协会内训',
    eventDate: '2026-03-01',
    tags: '财务分析,估值',
    linkUrl: '',
    sortIndex: 40,
  },
  {
    ...base,
    id: nextId(),
    category: 'course',
    title: 'Python 金融数据分析实战',
    subtitle: '讲义 + 示例代码',
    summary:
      '面向零基础成员：从读取行情数据开始，完成指标计算与策略回测。',
    content: '',
    cover: pic('swufe-course-2', 1200, 700),
    author: '协会数据部',
    source: '协会内训',
    eventDate: '2026-04-01',
    tags: 'Python,量化',
    sortIndex: 41,
  },

  // ---------- 数据分享 ----------
  {
    ...base,
    id: nextId(),
    category: 'data',
    title: 'A 股日线行情数据集（前复权）',
    subtitle: '按周更新',
    summary:
      '覆盖全市场个股与 ETF 的日线行情，含价格、成交量、成交额与换手率字段。',
    content:
      '字段说明：代码、交易日、开盘、最高、最低、收盘、成交量、成交额、换手率。\n\n数据仅供协会内部学习研究使用，请勿对外分发。',
    cover: pic('swufe-data-1', 1200, 700),
    author: '协会数据部',
    source: '协会数据部',
    tags: '行情,日线',
    sortIndex: 50,
  },
  {
    ...base,
    id: nextId(),
    category: 'data',
    title: '行业与概念板块映射表',
    subtitle: '申万三级 + 概念板块',
    summary:
      '提供股票与行业 / 概念板块的双向映射，便于做行业轮动与因子研究。',
    content: '',
    cover: pic('swufe-data-2', 1200, 700),
    author: '协会数据部',
    source: '协会数据部',
    tags: '板块,行业',
    sortIndex: 51,
  },

  // ---------- 电子书籍 ----------
  {
    ...base,
    id: nextId(),
    category: 'ebook',
    title: '《聪明的投资者》读书笔记',
    subtitle: '协会内部整理',
    summary:
      '格雷厄姆经典著作的章节要点与讨论题，配套一次线下读书会。',
    content: '',
    cover: pic('swufe-ebook-1', 1200, 700),
    author: '协会研究部',
    source: '协会内部分享',
    tags: '价值投资,读书会',
    sortIndex: 60,
  },
  {
    ...base,
    id: nextId(),
    category: 'ebook',
    title: '《漫步华尔街》要点摘录',
    subtitle: '协会内部整理',
    summary: '有效市场理论与随机漫步思想的通俗梳理。',
    content: '',
    cover: pic('swufe-ebook-2', 1200, 700),
    author: '协会研究部',
    source: '协会内部分享',
    tags: '投资理论',
    sortIndex: 61,
  },

  // ---------- 投行研报 Excel ----------
  {
    ...base,
    id: nextId(),
    category: 'report',
    title: 'DCF 估值模型模板',
    subtitle: 'Excel · 含敏感性分析',
    summary:
      '三张表联动的 DCF 模型，支持 WACC 与永续增长率双变量敏感性分析。',
    content: '',
    cover: pic('swufe-report-1', 1200, 700),
    author: '协会研究部',
    source: '协会研究部',
    tags: '估值,DCF,Excel',
    sortIndex: 70,
  },
  {
    ...base,
    id: nextId(),
    category: 'report',
    title: '可比公司估值表模板',
    subtitle: 'Excel · PE / PB / EV-EBITDA',
    summary:
      '一键拉取可比公司估值倍数并计算分位数，适合快速搭建行业估值框架。',
    content: '',
    cover: pic('swufe-report-2', 1200, 700),
    author: '协会研究部',
    source: '协会研究部',
    tags: '估值,Excel',
    sortIndex: 71,
  },

  // ---------- 社团产出 ----------
  {
    ...base,
    id: nextId(),
    category: 'production',
    title: '《行业研究入门手册》第 2 版',
    subtitle: '协会年度成果',
    summary:
      '由协会研究部牵头编写，系统整理了行业研究的基本框架、常用数据源与写作规范。',
    content: '',
    cover: pic('swufe-prod-1', 1200, 700),
    author: '协会研究部',
    source: '协会',
    eventDate: '2026-06-01',
    sortIndex: 80,
  },
  {
    ...base,
    id: nextId(),
    category: 'production',
    title: '协会年度研究合集（2025—2026）',
    subtitle: '16 篇行业与公司研究',
    summary:
      '收录本年度成员产出的 16 篇研究报告，覆盖消费、医药、新能源等方向。',
    content: '',
    cover: pic('swufe-prod-2', 1200, 700),
    author: '协会研究部',
    source: '协会',
    eventDate: '2026-07-15',
    sortIndex: 81,
  },
  {
    ...base,
    id: nextId(),
    category: 'production',
    title: '校园模拟投资大赛策略汇编',
    subtitle: '往届优秀策略复盘',
    summary:
      '整理往届大赛中表现较好的策略思路与复盘记录，供新成员参考。',
    content: '',
    cover: pic('swufe-prod-3', 1200, 700),
    author: '协会赛事组',
    source: '协会',
    eventDate: '2026-05-30',
    sortIndex: 82,
  },
];

/**
 * 历史沿革节点。
 *
 * 时间粒度按「事件簇」而非逐年铺开 —— 早期（2002–2008）是建会与扩张期、
 * 2011–2017 是品牌化期、2021 是荣誉与赛事延续期、2026 是线上化起步，
 * 这样 10 个节点能覆盖全部事实，又不会把时间轴拉成一条流水账。
 *
 * ⚠️ 每个节点的 description 都必须是该簇内的**独立事实**，不要写成上一节点的复述。
 * ⚠️ 新增节点请**追加在数组末尾**：种子 id 由 `nextId()` 按源码顺序自增，
 *    插在中间会把后续所有节点（以及其后 SEED_MEMBERS）的 id 整体移位。
 *    同时 `sortIndex` 要保持与数组顺序一致。
 */
export const SEED_TIMELINE: TimelineEvent[] = [
  {
    id: nextId(),
    year: '2002',
    title: '协会成立',
    description:
      '西南财经大学金融投资协会（Financial Investment Association, FIA）成立，成为面向全校同学的金融投资类学生社团。',
    image: '',
    sortIndex: 10,
    status: 'published',
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  },
  {
    id: nextId(),
    year: '2004',
    title: '建立金融实验室，首办模拟炒股大赛',
    description:
      '在学校及学院的支持下建立金融实验室，并获准利用实验室的软硬件条件举办「模拟炒股」大赛，把课堂上的投资理论搬进了可实操的模拟市场。',
    image: '',
    sortIndex: 20,
    status: 'published',
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  },
  {
    id: nextId(),
    year: '2005',
    title: '获「全国优秀社团」称号，承办首届学生实验超市股权交易',
    description:
      '社团影响力获得全国层面的认可，获评全国优秀社团；同年承办首届学生实验超市股权交易，在校园内完整演练了一次股权交易流程。',
    image: '',
    sortIndex: 30,
    status: 'published',
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  },
  {
    id: nextId(),
    year: '2005–2008',
    title: '吸纳合并金融保险学会与金融研究生会',
    description:
      '协会积极拓展社团规模，先后吸收并合并金融保险学会和金融研究生会，学科覆盖从投资扩展到保险与研究生群体，组织体量与成员结构同步提升。',
    image: '',
    sortIndex: 40,
    status: 'published',
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  },
  {
    id: nextId(),
    year: '2011',
    title: '提出「领先、卓越、先进」社团精神',
    description:
      '协会首次明确提出「领先、卓越、先进」的社团精神，为后续的研究与赛事方向确立了价值基调。',
    image: '',
    sortIndex: 50,
    status: 'published',
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  },
  {
    id: nextId(),
    year: '2013–2014',
    title: '协办GIC全球投资大奖赛，承办巴黎银行商业竞赛',
    description:
      '协会先后协办及承办 GIC 全球投资大奖赛与巴黎银行商业竞赛，并与 Wind 资讯合作举办万德 Wind 讲座，把国际化赛事与专业数据工具引入校园。',
    image: '',
    sortIndex: 60,
    status: 'published',
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  },
  {
    id: nextId(),
    year: '2016',
    title: '推出「Top Analyst」股票研究报告挑战赛',
    description:
      '由协会打造的精品赛事 Top Analyst 股票研究报告挑战赛正式推出，主打真实标的的研究报告撰写与答辩；该活动获得当年西南财经大学金色之秋社团文化节金奖。',
    image: '',
    sortIndex: 70,
    status: 'published',
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  },
  {
    id: nextId(),
    year: '2017',
    title: '承办 CFA Research Challenge 中西部赛区',
    description:
      'CFA Research Challenge 引入学校，协会作为承办方成功承办其中西部赛区比赛，赛事组织能力从校内活动延伸到区域性专业赛事。',
    image: '',
    sortIndex: 80,
    status: 'published',
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  },
  {
    id: nextId(),
    year: '2021',
    title: '入选「全国高校百强学生社团」，主办首届「朝阳杯」',
    description:
      '协会入选「全国高校百强学生社团」，为西南财经大学唯一入选社团；同年主办第一届「朝阳杯」模拟期货交易比赛，赛事体系从股票研究拓展到期货交易。',
    image: '',
    sortIndex: 90,
    status: 'published',
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  },
  {
    id: nextId(),
    year: '2026',
    title: '协会网站开始运营',
    description:
      '协会官方网站正式上线运营，把历年沉淀的行业研究、数据资料与课程资源整理成可长期检索的线上资料库，并以实时行情看板把「连接课堂与市场」的宗旨延伸到线上。',
    image: '',
    sortIndex: 100,
    status: 'published',
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  },
];

export const SEED_MEMBERS: OrgMember[] = [
  {
    id: nextId(),
    dept: '会长团',
    role: '会长',
    name: '（待补充）',
    avatar: '',
    grade: '2023 级 金融学',
    intro: '负责协会整体统筹与对外联络。',
    sortIndex: 10,
    status: 'published',
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  },
  {
    id: nextId(),
    dept: '会长团',
    role: '副会长',
    name: '（待补充）',
    avatar: '',
    grade: '2023 级 金融工程',
    intro: '分管研究部与数据部。',
    sortIndex: 11,
    status: 'published',
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  },
  {
    id: nextId(),
    dept: '研究部',
    role: '部长',
    name: '（待补充）',
    avatar: '',
    grade: '2024 级 金融学',
    intro: '负责行业与公司研究，组织研究报告撰写与评审。',
    sortIndex: 20,
    status: 'published',
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  },
  {
    id: nextId(),
    dept: '数据部',
    role: '部长',
    name: '（待补充）',
    avatar: '',
    grade: '2024 级 统计学',
    intro: '负责行情数据采集、清洗与资料库维护。',
    sortIndex: 30,
    status: 'published',
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  },
  {
    id: nextId(),
    dept: '宣传部',
    role: '部长',
    name: '（待补充）',
    avatar: '',
    grade: '2024 级 新闻学',
    intro: '负责公众号运营、视觉设计与活动宣发。',
    sortIndex: 40,
    status: 'published',
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  },
  {
    id: nextId(),
    dept: '外联部',
    role: '部长',
    name: '（待补充）',
    avatar: '',
    grade: '2024 级 国际经济与贸易',
    intro: '负责校企合作、嘉宾邀请与赞助对接。',
    sortIndex: 50,
    status: 'published',
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  },
  {
    id: nextId(),
    dept: '赛事组',
    role: '组长',
    name: '（待补充）',
    avatar: '',
    grade: '2024 级 金融学',
    intro: '负责模拟投资大赛等赛事的组织与执行。',
    sortIndex: 60,
    status: 'published',
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  },
];

export const SEED_SETTINGS: SettingsMap = {
  site_name: '西南财经大学金融投资协会',
  site_short_name: '西财金融投资协会',
  site_slogan: '以研究立身 · 以投资会友',
  about_title: '关于协会',
  about_content:
    '西南财经大学金融投资协会（Financial Investment Association, FIA）成立于2002年9月，是由西南财经大学在校学生自发组织、面向全校同学的学术实践类社团。协会以「连接课堂与市场」为宗旨，通过行业研究、数据实践、模拟投资赛事与课程分享，帮助成员建立扎实的投研框架与风险意识。\n\n协会长期举办内部培训、读书会、研究报告评审与模拟投资赛事，并定期组织成员参访证券公司、基金公司与金融科技企业，为成员搭建从课堂知识到市场实践的桥梁。\n\n历经二十余年发展，协会累计发展会员2000余人，成员广泛就职于互联网、证券、银行、基金等领域的头部机构。',
  about_stats: JSON.stringify([
    { label: '成立年份', value: '2002' },
    { label: '累计会员', value: '2000+' },
    // 2026-09-27：由 8+ → 100+ → 300+（原值按旧版 logo 墙的 8 家展示数量取，口径偏窄）
    { label: '会友机构', value: '300+' },
    { label: '年度活动', value: '20+' },
  ]),
  org_note:
    '协会设会长团统筹整体工作，下设研究部、数据部、宣传部、外联部与赛事组。以下名单为 2026 届成员，姓名等信息待补充。',
  join_us:
    '招新面向全校本科生与研究生，不设专业限制。关注协会招新公告，或通过下方联系方式咨询。',
  contact_address: '',
  contact_email: '',
  contact_phone: '',
  contact_wechat: '',
  contact_extra: '',
  copyright: '© 西南财经大学金融投资协会',
  stock_api_base: '/api/stock',
  stock_watchlist: JSON.stringify([
    { code: '600702', name: '舍得酒业' },
    { code: '600519', name: '贵州茅台' },
    { code: '000001', name: '平安银行' },
    { code: '000858', name: '五粮液' },
    { code: '601318', name: '中国平安' },
    { code: '300750', name: '宁德时代' },
  ]),
};
