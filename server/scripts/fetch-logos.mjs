#!/usr/bin/env node
/**
 * 抓取「合作单位」徽标素材。
 *
 * ## 为什么要有这个脚本
 *
 * 首页需要展示数十家合作单位与会员去向机构的徽标，但素材目录里只有 5 家。与其手工逐张下载
 * （无法复现、无法审计、换机器就丢），不如把「要哪几家、从哪来」写成声明式清单，
 * 让脚本去取。这样：
 * - 素材来源**可审计**：每一项都写明出处，不是来源不明的图片；
 * - 过程**可复现**：删掉文件重跑即可，结果一致；
 * - 失败**显式**：取不到的明确报告，不会静默留空。
 *
 * ⚠️ 2026-09-27 起，首页把「合作单位」与「会友去向」合并为一个 logo 轮动墙，
 * `category` 字段**不再影响前台呈现**（只用于 `--only=` 过滤与日志分组）。
 *
 * ## 版权与用法声明
 *
 * 徽标是各机构**注册商标**，此处仅用于「合作单位与会员去向」陈列这一**指称性使用**
 * （nominative use），不代表背书或授权。前端须同时展示免责声明。
 * SVG 取自开源图标库 icongo/bank-logos（MIT）；其余类别取机构官网 favicon / 官方 CDN，
 * 均为公开可获取的标识文件。
 *
 * 用法：
 *   node scripts/fetch-logos.mjs                  # 抓取全部
 *   node scripts/fetch-logos.mjs --only=银行       # 只抓某一类
 *   node scripts/fetch-logos.mjs --only=会员去向   # 只抓新增的会员去向机构
 *   node scripts/fetch-logos.mjs --dry-run        # 只打印计划，不下载
 *
 * ## 配套脚本（抓取只是一半，另外两半必须跑）
 *
 *   node server/scripts/audit-logos.mjs            # 审计：谁分辨率不够 / 谁是未裁切的画布
 *   node server/scripts/tighten-logo-viewbox.mjs   # 收紧 SVG viewBox 到图形实际边界（幂等）
 *
 * 顺序：fetch → audit（看结论）→ 修 → tighten → **再 audit 复核**。
 *
 * ## 素材裁定的四条经验（都是踩过的）
 *
 * 1. **favicon 只能当兜底，不能当 logo。** 官网 favicon 常是 16×16，
 *    放大到上墙尺寸（40~48px 盒）是 2.5~3 倍插值，必糊。优先找 `apple-touch-icon`
 *    （多为 180/256/512）或官网品牌资源页；App 类机构可退而取 **iTunes Search API**
 *    的 `artworkUrl512`（`entity=software&country=cn`），512px 且为官方图。
 * 2. **「尺寸最大」≠「正确的 logo」。** 按体积/尺寸排序取第一张会拿到举报中心徽章、
 *    二维码、合作伙伴墙。`rank-mined.py` 类筛选必须叠加**语义正则**（URL 含 `logo`/`brand`/`ci`，
 *    排除 `qr`/`code`/`ad`/`skeleton`），且落盘前用**源 URL 反查**而不是猜序号。
 * 3. **官网取不到不等于没有。** 实测可用通道：CSS 内联的 `url(../images/*-logo.png)`；
 *    年报/债券募集说明书 PDF 内嵌图（注意 **SMask**，只取 color 图层会得到黑底）。
 * 4. **改完必须重扫 + 换新浏览器 profile 复核。** 素材文件的扩展名不可信
 *    （`腾讯.png` 实为 JPEG），且旧 profile 的磁盘缓存会让你以为改动没生效。
 *    验收用 CDP 截图时配合一次性 `--user-data-dir`。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 素材目录：仓库根的 `资料分享模块素材/logo/` */
const ASSET_DIR = path.resolve(__dirname, '../../资料分享模块素材/logo');

/**
 * 合作单位清单。
 *
 * `slug` 是**品牌级**标识（去分/去地域），因为同一集团的不同分支机构共用同一徽标
 * ——例如「四川农业银行」用的就是中国农业银行徽标，「哈尔滨银行」另有自己的。
 * `source` 记录确切出处，便于日后复核。
 *
 * 期货公司与媒体没有现成的开源图标库，改用机构官网的 favicon / apple-touch-icon。
 */
export const ORGS = [
  // ---------------- 银行 ----------------
  { category: '银行', label: '中信银行', slug: 'citicbank', source: 'icongo/bl:logos/citicbank.svg' },
  { category: '银行', label: '荷兰银行', slug: 'abnamro', source: 'icongo/bl:logos/abnamro.svg' },
  { category: '银行', label: '中国银行', slug: 'boc', source: 'icongo/bl:logos/boc.svg' },
  { category: '银行', label: '建设银行', slug: 'ccb', source: 'icongo/bl:logos/ccb.svg' },
  {
    category: '银行',
    label: '四川农业银行',
    slug: 'abchina',
    source: 'icongo/bl:logos/abchina.svg',
    note: '四川分行沿用中国农业银行集团品牌徽标',
  },
  { category: '银行', label: '哈尔滨银行', slug: 'hrbb', source: 'icongo/bl:logos/hrbb.svg' },

  // ---------------- 证券公司 ----------------
  {
    category: '证券公司',
    label: '瑞达证券',
    slug: 'ruida-sec',
    source: '官网 favicon',
    fallbackDomain: 'www.rdqh.com',
    note: '未取到可用徽标；瑞达证券与瑞达期货同属瑞达集团',
  },
  {
    category: '证券公司',
    label: '国泰君安证券',
    slug: 'gtja',
    source: '官网 favicon',
    fallbackDomain: 'www.gtja.com',
  },
  {
    category: '证券公司',
    label: '华西证券',
    slug: 'hx168',
    source: '官网 favicon',
    fallbackDomain: 'www.hx168.com.cn',
  },
  {
    category: '证券公司',
    label: '联合证券',
    slug: 'lianhe-sec',
    source: '官网 favicon',
    fallbackDomain: 'www.lhzq.com',
    note: '联合证券已并入华泰证券，徽标取现存品牌站点',
  },
  {
    category: '证券公司',
    label: '亚洲证券',
    slug: 'asia-sec',
    source: '官网 favicon',
    fallbackDomain: 'www.asiastock.com',
    note: '机构已注销，官网不可达',
  },
  { category: '证券公司', label: '中信证券', slug: 'citicsec', source: '素材目录已有', existing: true },
  {
    category: '证券公司',
    label: '招商证券',
    slug: 'cmschina',
    source: '官网 favicon',
    fallbackDomain: 'www.cmschina.com',
  },
  {
    category: '证券公司',
    label: '华泰证券',
    slug: 'htsc',
    source: '官网 favicon',
    fallbackDomain: 'www.htsc.com.cn',
  },
  {
    category: '证券公司',
    label: '中金证券',
    slug: 'cicc',
    source: '官网 favicon',
    fallbackDomain: 'www.cicc.com',
    note: '官网对无头请求返回 521，需人工补图',
  },

  // ---------------- 期货公司 ----------------
  {
    category: '期货公司',
    label: '海通期货',
    slug: 'htfutures',
    source: '官网 favicon',
    fallbackDomain: 'www.htfutures.com',
  },
  {
    category: '期货公司',
    label: '瑞达期货',
    slug: 'rdqh',
    source: '官网 favicon',
    fallbackDomain: 'www.rdqh.com',
    note: 'favicon.ico 返回 HTML 错误页，非图片',
  },
  {
    category: '期货公司',
    label: '中信期货',
    slug: 'citicsf',
    source: '官网 favicon',
    fallbackDomain: 'www.citicsf.com',
  },
  {
    category: '期货公司',
    label: '华泰长城期货',
    slug: 'htgw',
    source: '官网 favicon',
    fallbackDomain: 'www.htfutures.com',
    note: '沿用华泰期货（原华泰长城期货）官网徽标',
  },
  {
    category: '期货公司',
    label: '南华期货',
    slug: 'nanhua',
    source: '官网 favicon',
    fallbackDomain: 'www.nanhua.net',
  },

  // ---------------- 媒体 ----------------
  {
    category: '媒体',
    label: '四川日报',
    slug: 'scdaily',
    source: '官网 favicon',
    fallbackDomain: 'www.scdaily.cn',
  },
  {
    category: '媒体',
    label: '华西都市报',
    slug: 'huaxi',
    source: '官网 favicon',
    fallbackDomain: 'www.wccdaily.com.cn',
    note: '官网 favicon 返回 HTML，需人工补图',
  },
  {
    category: '媒体',
    label: '经济观察报',
    slug: 'eeo',
    source: '官网 favicon',
    fallbackDomain: 'www.eeo.com.cn',
  },
  {
    category: '媒体',
    label: '成都商报',
    slug: 'cdsb',
    source: '官网 favicon',
    fallbackDomain: 'www.cdsb.com',
  },
  {
    category: '媒体',
    label: '和讯网',
    slug: 'hexun',
    source: '官网 favicon',
    fallbackDomain: 'www.hexun.com',
  },

  // ---------------- 其它 ----------------
  {
    category: '其它',
    label: '中信基金',
    slug: 'citic-fund',
    source: '官网 favicon',
    fallbackDomain: 'www.citicfunds.com',
    note: '官网不可达，需人工补图',
  },
  {
    category: '其它',
    label: '同花顺公司',
    slug: '10jqka',
    source: '官网 favicon',
    fallbackDomain: 'www.10jqka.com.cn',
  },
  { category: '其它', label: '东方财富', slug: 'eastmoney', source: '素材目录已有', existing: true },
  {
    category: '其它',
    label: '汉和理财',
    slug: 'hanhe',
    source: '官网 favicon',
    fallbackDomain: 'www.hanhecapital.com',
    note: '官网 favicon 返回 HTML，需人工补图',
  },
  {
    category: '其它',
    label: '银帆私募',
    slug: 'yinfan',
    source: '官网 favicon',
    fallbackDomain: 'www.yinfanfund.com',
    note: '官网不可达，需人工补图',
  },
  {
    category: '其它',
    label: '天麟财富',
    slug: 'tianlin',
    source: '官网 favicon',
    fallbackDomain: 'www.tianlin.com',
    note: '官网返回 HTML，需人工补图',
  },
  {
    category: '其它',
    label: '中国证监会西南区分部成都证管委',
    slug: 'csrc',
    source: '官网 favicon',
    fallbackDomain: 'www.csrc.gov.cn',
  },

  // ---------------- 会员去向（2026-09-27 新增） ----------------
  // 说明：首页「合作单位与会员去向」已合并为一个 logo 轮动墙，不再按机构类型分组。
  // 这里保留 category 只是为了 `--only=` 过滤与日志分组，不影响前台呈现。
  {
    category: '会员去向',
    label: '淡水泉投资',
    slug: 'springscapital',
    source: '官网 CDN 打包资源',
    // 官网是 JS 单页应用，页面里没有 <img>，logo 只能从打包产物中定位：
    // cdn.springs-capital.com/static/img/logo.82bf4713.svg（彩色版，供浅色底使用）。
    // ⚠️ 同目录下还有 logo-zh.svg / logo-en.svg，二者**通体纯白**（供深色底使用），
    // 放到本站白底版式上会完全看不见 —— 不要误用。
    directUrl: 'https://cdn.springs-capital.com/static/img/logo.82bf4713.svg',
    note: 'Springs Capital (Hong Kong) Limited 淡水泉（香港）投资管理有限公司',
  },
  {
    category: '会员去向',
    label: '瑞银',
    slug: 'ubs',
    source: 'icongo/bl:logos/ubs.svg',
    note: 'UBS 瑞银集团；三把钥匙徽标 + UBS 字标',
  },

  // ---------------- 第二批新增与替换（2026-09-27 下午） ----------------
  //
  // 背景：首页 logo 墙改为「多行网格 + 单位名称」，对素材清晰度提出了硬要求
  // ——显示盒约 176×56 px，所以**源图宽度不足 ~180px 就会明显发虚**。
  // 下面这批的目标就是把 16/32px 的 favicon 换成官网或开源矢量库的正规素材。
  //
  // ⚠️ 银行类一律优先走 icongo（矢量、无损），不要退回官网 PNG：
  // 官网 PNG 多为 200px 以下的截图，而 icongo 是 SVG，缩放不糊。
  {
    category: '第二批',
    label: '兴业银行',
    slug: 'cib',
    source: 'icongo/bl:logos/cib.svg',
  },
  {
    category: '第二批',
    label: '成都银行',
    slug: 'bocd',
    source: 'icongo/bl:logos/bocd.svg',
  },
  {
    category: '第二批',
    label: '重庆银行',
    slug: 'cqcbank',
    source: 'icongo/bl:logos/cqcbank.svg',
  },
  {
    category: '第二批',
    label: '万得集团',
    slug: 'wind',
    source: '官网 og:image',
    // 官网 head 里把品牌图同时挂在 og:image 上，是站内最大的一张正规徽标
    directUrl: 'https://www.wind.com.cn/portal/common/img/logo-red.png',
    note: '万得信息技术股份有限公司（Wind）；红色字标',
  },
  {
    category: '第二批',
    label: '西南证券',
    slug: 'swsc',
    source: '官网 CMS 资源',
    directUrl: 'https://www.swsc.com.cn/r/cms/www/default/images/logo.png',
  },
  {
    category: '第二批',
    label: '国金证券',
    slug: 'gjzq',
    source: '官网静态资源',
    directUrl: 'https://www.gjzq.com.cn/static/main/img/footer/logo.png',
  },
  {
    category: '第二批',
    label: '旦恩资本',
    slug: 'danencap',
    source: '官网 CSS 目录资源',
    // www 域名只有 http 可达（https 拿不到证书），且 logo 挂在 CSS 目录下
    directUrl: 'http://www.danencap.com/static/danencap/zh-cn/css/img/logo.png?v=18',
    note: '深圳市旦恩先锋私募股权基金管理有限公司',
  },
  {
    category: '第二批',
    label: '易方达基金',
    slug: 'efunds',
    source: '官网静态资源',
    directUrl: 'https://www.efunds.com.cn/assets/images/logo.png',
    note: '中文横版字标；同目录下 logo_en.png 为英文版，不用',
  },

  // —— 用官网大图替换既有低清 favicon ——
  {
    category: '第二批',
    label: '南华期货',
    slug: 'nanhua',
    source: '官网资源（替换 32px favicon）',
    directUrl: 'https://www.nanhua.net/img/nh_logo_with_code.png',
    note: '730×172；原先只是 32×32 的 favicon',
  },
  {
    category: '第二批',
    label: '中信期货',
    slug: 'citicsf',
    source: '官网资源（替换 48px favicon）',
    directUrl: 'https://www.citicsf.com/e-futures/resources/images/web/logo.png',
  },
  {
    category: '第二批',
    label: '同花顺公司',
    slug: '10jqka',
    source: '官网 Next.js 静态资源（替换 16px favicon）',
    directUrl:
      'https://s.thsi.cn/cd/news-p-fe-app-news-flow-home/home/_next/static/media/logo.1c8fc73f.png',
  },
  {
    category: '第二批',
    label: '中国农业银行',
    slug: 'abchina',
    source: 'icongo/bl:logos/abchina.svg（替换带大量白边的 JPEG）',
    note: '原 JPEG 画布 3720×1862、内容只占高度 31%，上墙后明显偏小；换矢量版',
  },
  {
    category: '第二批',
    label: '中国证监会西南区分部成都证管委',
    slug: 'csrc',
    source: 'icongo/bl:logos/csrc.svg（替换 32px favicon）',
  },
  {
    category: '第二批',
    label: '华泰长城期货',
    slug: 'htfc',
    source: '官网 CSS 引用的品牌图（替换错图）',
    // ⚠️ 原先这一项把 fallbackDomain 写成了 www.htfutures.com —— 那是**海通期货**的域名，
    // 于是脚本给「华泰长城期货」和「海通期货」存下了**同一张图**（md5 相同）。
    // 华泰长城期货（现名华泰期货）的官网是 www.htfc.com，品牌图在 /front/images/logo.png。
    directUrl: 'https://www.htfc.com/front/images/logo.png',
    note: '华泰长城期货已更名为华泰期货，此处用其现行品牌徽标',
  },

  // ---------------- 第三批：补三个常规通道拿不到的机构（2026-09-27 晚） ----------------
  //
  // 这三家都**不走 favicon 通道**，原因是各自踩了不同的墙，故把可用入口在此固化，
  // 免得日后重跑脚本又退回 32px 糊图或直接抓不到。
  {
    category: '第三批',
    label: '东吴证券',
    slug: 'dwzq',
    source: '官网页头品牌图（深色版）',
    // ⚠️ 两个坑：
    // 1. 站点的 favicon 只有 32×32，放大到墙上的格子会明显发虚 —— 不要退回 favicon；
    // 2. `www.dwzq.com.cn` 的 TLS 握手在 Node 原生 https 下会 ECONNRESET，
    //    但 curl / PowerShell 正常。抓不到时先怀疑通道，别怀疑 URL。
    // 路径来自 /ws/css/style.css 里的 `url(../images/f-logo.png)`：
    //   f-logo = 深蓝字标（浅色底用），t-logo = 白色字标（深色头部用）——本项目是浅色主题，取 f-logo。
    directUrl: 'https://www.dwzq.com.cn/ws/images/f-logo.png',
    note: '320×70 透明 PNG，字标完整，分辨率足够 2x',
  },
  {
    category: '第三批',
    label: '华西期货',
    slug: 'hxqh',
    source: 'App Store 官方应用图标（512×512）',
    // ⚠️ 官网 www.hxqh168.com 被 WAF 挡在 JS 挑战页外，且其 /favicon.ico 是**0 字节空文件**
    // （响应头 Content-Length: 0），所以官网两条通道都不可用。
    // 曲线：iTunes 搜索接口 → 官方 APP 的 artworkUrl512 → 512×512 图标，再裁掉白边。
    //   curl -G https://itunes.apple.com/search \
    //        --data-urlencode 'term=华西期货' --data 'country=cn&entity=software&limit=5'
    // 这条通道对**有官方 APP 的机构**普遍有效，可作为官网不可达时的通用兜底。
    directUrl:
      'https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/63/ce/5a/63ce5a54-9f4a-eeb3-2347-bed7ab3b6e65/AppIcon-0-0-1x_U007emarketing-0-4-85-220.png/512x512bb.jpg',
    note: '方形字母徽标（H），已裁去外围白边；墙上有机构名做 caption，不依赖图标自解释',
    trim: true,
  },
  {
    category: '第三批',
    label: '申银万国证券',
    slug: 'sywg',
    source: '素材目录已有（2014 年官方债券募集说明书首页内嵌图）',
    // ⚠️ 申银万国证券 2015 年已并入申万宏源，**没有在运营的官网**，
    //    www.swyg.com / www.shygh.com 一类域名全是 404 或空壳，favicon 通道必然失败。
    // 可复现路径：取其在交易所披露的 2014 年度第十期短期融资券募集说明书 PDF，
    // 用 PyMuPDF 抽第 1 页 xref 21 的内嵌图：
    //   curl -o sywg.pdf 'http://file.finance.sina.com.cn/211.154.219.97:9494/MRGG/BOND/2014/2014-8/2014-08-28/1375152.PDF'
    //   python -c "import pymupdf;d=pymupdf.open('sywg.pdf');print(d.xref_get_key(21,'SMask'))"
    //
    // ⚠️ **不能直接用 `doc.extract_image(21)`**：那张图在不透明黑底上，
    //    真正的透明信息存在**另一个 xref 的 SMask**（这里是 22 0 R）里。
    //    只用 extract_image 会得到一块黑底图，上墙就是一个深色方块
    //    （踩过：看起来像「logo 自带深色底」，实际是漏了软掩码）。
    //    正确做法是取 color pixmap 与 mask pixmap 自行合成 alpha，并对彩色层做
    //    un-premultiply（PDF 的彩色层是预乘的）。
    //    这是**已不存在主体**的合法存档来源；不要在存活官网里找它。
    existing: true,
    note: '历史机构（现申万宏源），使用其解散前公开披露文件中的原始标识；已合成 SMask 得到透明底',
  },

  // ------------- 第四批：按「体检 → 换源」流程逐个升级（2026-09-27 晚） -------------
  //
  // 这一批的出发点是 `server/scripts/audit-logos.mjs` 的体检报告。
  // favicon 通道虽然命中率高，但**质量下限很低**：不少站点只给 16×16 / 32×32，
  // 放到墙上（统一高 56px、2 倍屏需 112px）必然发虚。以下都是「体检挑出来 → 单独找源」的结果。
  //
  // 通道优先级（实测有效，按可靠性降序）：
  //   1. **官网 HTML 里的显式 logo 图**（`<img src=...logo...>`）
  //   2. **官网 CSS 的 `background: url(...)`** —— 东吴证券的高清字标只在 CSS 里，
  //      只在 HTML 里翻会漏（教训：翻不到就以为「官网只给了 favicon」）
  //   3. **App Store 官方应用图标**（见下，对「有官方 APP 的机构」普遍有效）
  //   4. 已摘牌 / 已合并主体的**历史披露文件**（见申银万国证券那条）
  //   5. 兜底才是 favicon
  {
    category: '第四批',
    label: '成都商报',
    slug: 'cdsb',
    source: '官网品牌字标 869×180（替换 32px favicon）',
    directUrl: 'https://www.cdsb.com/www/images/logo_cdsb_2026-06-24_171517_770.png',
    // ⚠️ 同一站上最大的图是 `appstatic.cdsb.com/.../doctor-plus-logo.png`（4505×4504），
    //    那是**合作方徽标**不是成都商报；`idx_logo.png`（1840×460）也是
    //    「成都市互联网不良与违法信息举报中心」的备案徽标。**「尺寸最大」≠「正确的 logo」**，
    //    必须要按 URL 语义（含 logo/brand）过滤，并逐张目视确认。
    note: '蓝红「cd」标 + 成都商报书法字，宽高比 4.8:1',
  },
  {
    category: '第四批',
    label: '经济观察报',
    slug: 'eeo',
    source: '官网 2024 版品牌图 431×71（替换 16px favicon）',
    directUrl: 'https://img.eeo.com.cn/2024/images/logo.jpg',
    // 注：该图实为「经济观察网 eeo.com.cn」的标识（同集团网络版），与纸质《经济观察报》
    // 同属一家；作为「该机构」的标识可接受，但严格说是其网络版品牌。
    note: '提升 4.4 倍（16px → 71px）',
  },
  {
    category: '第四批',
    label: '银帆私募',
    slug: 'yinfanfund',
    source: '官网品牌图 244×71（替换 16px favicon）',
    directUrl: 'http://www.yinfanfund.com/images/logo.jpg',
    note: '提升 4.4 倍。注意同目录下 `top_phone.jpg`（341×29）虽宽但只有 29px 有效高',
  },
  {
    category: '第四批',
    label: '四川日报',
    slug: 'scdaily',
    source: '官网 favicon64.ico 64×64（替换 16px favicon）',
    directUrl: 'https://www.scdaily.cn/favicon64.ico',
    note: '站点同时提供 favicon.ico(16) 与 favicon64.ico(64)，取后者。方形徽标，靠墙上的名称 caption 说明',
  },
  {
    category: '第四批',
    label: '华泰证券',
    slug: 'htsc',
    source: 'App Store 官方应用图标（涨乐财富通）底部字标带 512×144',
    directUrl:
      'https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/08/ed/e5/08ede565-e439-1026-b710-25e13fb61a87/AppIcon-0-0-1x_U007emarketing-0-8-0-85-220.png/512x512bb.jpg',
    // ⚠️ 官网 www.htsc.com.cn 的 favicon 只有 16×16，且首页是 JS 壳（抓不到 logo 引用），
    //    官网两条通道都不可用。改用官方 APP 图标：把上半部的应用副品牌「涨」
    //    连同白底一起裁掉，**只保留底部红底白字「华泰证券」字标带**（512×144，宽高比 3.56:1）。
    //    这样才是机构字标，而不是「涨乐」这个产品名。
    note: '裁自官方应用图标；直接整张用会把应用副品牌「涨」带上墙',
  },
  {
    category: '第四批',
    label: '海通期货',
    slug: 'htfutures',
    source: 'App Store 官方应用图标（海通期货）512×512',
    directUrl:
      'https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/3c/14/0a/3c140aaf-bfc3-e99a-fc32-557b3d4378c7/AppIcon-1x_U007emarketing-0-6-0-sRGB-85-220-0.png/512x512bb.jpg',
    note: '官网 favicon 仅 16×16；图标内含「海通」圆形标 + 海通期货 字样，是干净的机构标识',
  },
  {
    category: '第四批',
    label: '招商证券',
    slug: 'cmschina',
    source: 'App Store 官方应用图标（招商证券）512×512',
    directUrl:
      'https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/ce/98/93/ce989337-000c-2119-b175-1a7454c95e13/AppIcon-1x_U007emarketing-0-9-0-85-220-0.png/512x512bb.jpg',
    // 官网 www.cmschina.com 只有 32×32 favicon 与一张 188×27 的过小字标（有效高 27px，
    // 比 favicon 还差）。APP 图标是「招商证券 / CMS」的方形锁标，可用。
    note: '官网两条通道都劣于 32px favicon，改用应用图标',
  },
  {
    category: '第四批',
    label: '易方达基金',
    slug: 'efunds',
    source: 'App Store 官方应用图标（易方达 e 钱包）512×512',
    directUrl:
      'https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/dc/4e/0b/dc4e0b44-b4ec-070e-a939-615ebb0c091e/AppIcon-1x_U007emarketing-0-8-0-85-220-0.png/512x512bb.jpg',
    // 官网 www.efunds.com.cn 抓不到（超时）。图标内含「易方达」白字标识。
    note: '官网不可达，改用官方应用图标；含机构名「易方达」',
  },
  {
    category: '第四批',
    label: '中信期货',
    slug: 'citicsf',
    source: 'App Store 官方应用图标（信e禄）裁掉副品牌带 512×372',
    directUrl:
      'https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/f1/9d/94/f19d94bb-8fe9-25cc-57ad-fd3ba6245d92/AppIcon-0-0-1x_U007emarketing-0-0-85-220.png/512x512bb.jpg',
    // ⚠️ 官网 `logo.png`（172×47，有效高 47px）与 `logo-1.png`（430×278）都不合适：
    //    后者是**中信系品牌家族图谱**（一张图里排了中信证券/中信期货国际/中信中证资本/
    //    中信寰球/中信信期证券 五个标识），不是单个 logo。**不要用「最大的那张」**。
    // ⚠️ APP 图标底部有一条「信e禄」红带（应用副品牌），按行剖面找到色带起点后裁掉，
    //    只留上半部的「中信」圆形标 + 中信期货 / CITIC Futures 字样。
    note: '裁自官方应用图标并去掉应用副品牌带',
  },
];

/** icongo 开源图标库（MIT）——银行类走这条，矢量质量最好 */
const ICONGO_BASE = 'https://cdn.jsdelivr.net/gh/icongo/bank-logos@main/logos';

/**
 * 取 favicon。
 *
 * 依次尝试若干常见路径。站点各异，没有万能入口，所以做成候选列表逐个试，
 * 命中即止——比猜单一 URL 的成功率高得多。
 *
 * ⚠️ 顺序有讲究：**机构自己的 favicon 优先于第三方图标服务**。
 * 第三方（google/duckduckgo）在没有收录时会返回一个「默认地球」占位图，
 * 而不是 404 —— 一旦排在前面，会把一堆不是品牌标识的图当成素材存下来，
 * 这比取不到更糟（取不到会降级成文字卡，取错了却是**错误信息**）。
 *
 * @returns {Promise<{buf: Buffer, ext: string, from: string} | null>}
 */
async function fetchFavicon(domain) {
  const paths = ['/favicon.ico', '/favicon.png', '/apple-touch-icon.png'];
  // 先 https 再 http —— ★有站点**只在 http 上**提供图标
  // （实测 yinfanfund.com / hanhecapital.com：https 直接连接失败，http 正常返回）。
  // 不试 http 会白丢一批素材。
  for (const scheme of ['https', 'http']) {
    for (const p of paths) {
      const got = await fetchBinary(`${scheme}://${domain}${p}`);
      // favicon.ico 常被服务器以 HTML 错误页顶包（如 rdqh.com 返回 BOM+<html>），
      // sniffImageExt 会返回 null 把这类挡掉；size 过小的也判废。
      if (got && got.buf.length > 400) return { ...got, from: `${scheme}://${domain}${p}` };
    }
  }
  return null;
}

/** 下载二进制内容，失败返回 null（不抛异常，让调用方决定是继续还是报错） */
async function fetchBinary(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        // 部分站点对无 UA 的请求直接 403
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: 'image/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    // 内容嗅探：确认真的是图片，避免把 HTML 错误页当成 favicon 存下来
    const ext = sniffImageExt(buf.subarray(0, 16));
    if (!ext) return null;
    return { buf, ext, from: url };
  } catch {
    return null;
  }
}

/**
 * 探测并关闭代理环境变量。
 *
 * ⚠️ 这是本脚本**最容易踩的坑**，必须显式处理：
 * Node 的 `fetch`（undici）**不读 `--noproxy`**，只认 `HTTP_PROXY` /
 * `HTTPS_PROXY` / `NO_PROXY` 这几个环境变量。本机上设了 HTTP 代理但
 * `NO_PROXY` 未覆盖国内站点，导致大量 `.ico` 请求被代理吞掉
 * ——表现为「curl 拿得到、node fetch 拿不到」，极难排查。
 *
 * 这里在主流程开头就把代理清空：徽标站点全是国内域名，直连反而更稳。
 */
function disableProxy() {
  const removed = [];
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    if (process.env[key]) {
      removed.push(`${key}=${process.env[key]}`);
      delete process.env[key];
    }
  }
  // NO_PROXY 设为通配，双保险
  process.env.NO_PROXY = '*';
  process.env.no_proxy = '*';
  if (removed.length) {
    console.log(`（已忽略代理设置：${removed.join(', ')}）\n`);
  }
}

/** 按魔数判断图片类型——扩展名不可信，内容才可信 */
function sniffImageExt(head) {
  const hex = head.toString('hex');
  if (hex.startsWith('89504e47')) return 'png';
  if (hex.startsWith('47494638')) return 'gif';
  if (hex.startsWith('ffd8ff')) return 'jpeg';
  // SVG 是文本，检查开头片段
  const text = head.toString('utf8').trim().toLowerCase();
  if (text.startsWith('<svg') || text.startsWith('<?xml')) return 'svg';
  // ICO：00 00 01 00
  if (hex.startsWith('00000100')) return 'ico';
  if (text.includes('<html')) return null;
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice('--only='.length) : null;

  if (!dryRun) disableProxy();

  const targets = only ? ORGS.filter((o) => o.category === only) : ORGS;

  await fsp.mkdir(ASSET_DIR, { recursive: true });

  const ok = [];
  const skipped = [];
  const failed = [];

  for (const org of targets) {
    if (org.existing) {
      skipped.push({ ...org, reason: '素材目录已有同名文件，保留原图' });
      continue;
    }

    const outName = `${org.label}.${
      org.source.startsWith('icongo') || (org.directUrl ?? '').toLowerCase().endsWith('.svg')
        ? 'svg'
        : 'auto'
    }`;
    process.stdout.write(`  ${org.category} / ${org.label} … `);

    if (dryRun) {
      console.log('[dry-run]');
      ok.push(org);
      continue;
    }

    let got = null;
    if (org.directUrl) {
      // 已知确切资源地址（如 SPA 打包产物里的 logo），直接取
      const raw = await fetchBinary(org.directUrl);
      if (raw) got = raw;
    } else if (org.source.startsWith('icongo')) {
      const raw = await fetchBinary(`${ICONGO_BASE}/${org.slug}.svg`);
      // icongo 的 SVG 是纯 <svg> 文本，sniffImageExt 能识别
      if (raw) got = raw;
    } else {
      got = await fetchFavicon(org.fallbackDomain);
    }

    if (!got) {
      console.log('✗ 取不到');
      failed.push(org);
      continue;
    }

    const finalName = `${org.label}.${got.ext}`;
    await fsp.writeFile(path.join(ASSET_DIR, finalName), got.buf);
    console.log(`✓ ${finalName} (${(got.buf.length / 1024).toFixed(1)} KB)`);
    ok.push({ ...org, file: finalName });
  }

  console.log('\n' + '─'.repeat(64));
  console.log(`成功 ${ok.length} · 沿用原图 ${skipped.length} · 失败 ${failed.length}`);
  if (failed.length) {
    console.log('\n未取到（需要手工补图，前端会降级为文字卡片）：');
    for (const f of failed) console.log(`  - ${f.category} / ${f.label}（${f.fallbackDomain}）`);
  }
  console.log(`\n素材目录：${ASSET_DIR}`);
}

// 仅当直接执行时才跑 main —— 被 import 时（如单测）只导出 ORGS
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error('抓取失败：', err);
    process.exitCode = 1;
  });
}
