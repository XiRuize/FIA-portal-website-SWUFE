/**
 * 资料展示类目（`lib/categorize.js`）的单元测试。
 *
 * 背景：老板提的两条要求 ——
 *   1. 「不要把公司 logo 放到资料与数据中」；
 *   2. 「资料与数据按全部/电子书籍/数据/研报/课程资源整理分类」。
 *
 * 这里的用例全部取自 `资料分享模块素材/` 里的**真实文件名**。
 * 为什么坚持用真实样本：分类器的难点从来不是「显然的书是书」，
 * 而是 `3.5上午 - Ai应用论坛.pdf` 这种既是课程记录又像研报的边界样本。
 * 用编造的干净样例测出来的绿灯没有意义。
 *
 * 运行：node --test "test/**\/*.test.js"
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_CATEGORY,
  ALL_DISPLAY_CATEGORIES,
  CATEGORY_ORDER,
  LIBRARY_CATEGORIES,
  NON_LIBRARY_DIRS,
  PRODUCTION_CATEGORY,
  classifyItem,
  isLibraryItem,
  moduleOfCategory,
} from '../src/lib/categorize.js';

/** 构造 walkSync 产出的文件对象 */
const f = (fileName, categoryDir) => {
  const dot = fileName.lastIndexOf('.');
  return {
    fileName,
    name: dot > 0 ? fileName.slice(0, dot) : fileName,
    ext: dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '',
    categoryDir,
  };
};

test('类目常量：五个标签的顺序与内容固定', () => {
  assert.equal(ALL_CATEGORY, '全部');
  assert.deepEqual(LIBRARY_CATEGORIES, ['电子书籍', '数据', '研报', '课程资源']);
  // 「全部」是聚合项，不能混进实体类目列表
  assert.ok(!CATEGORY_ORDER.includes(ALL_CATEGORY));
  assert.deepEqual(CATEGORY_ORDER, LIBRARY_CATEGORIES);
});

test('logo 目录被排除，不属于「资料与数据」', () => {
  assert.ok(NON_LIBRARY_DIRS.has('logo'));
  assert.equal(isLibraryItem('logo'), false);
  // 素材目录里真实存在的三个归档目录都应保留
  assert.equal(isLibraryItem('培训部分享资料'), true);
  assert.equal(isLibraryItem('研发部内部资料'), true);
  assert.equal(isLibraryItem('未分类'), true);
});

test('logo 目录里的图片即使扩展名像书籍也不进类目（先判目录再判内容）', () => {
  // 关键顺序：isLibraryItem 是前置闸门。若先跑 classifyItem，
  // 一个叫「招商银行.epub」的 logo 会被分到电子书籍，泄露到资料页。
  assert.equal(isLibraryItem('logo'), false);
  assert.equal(classifyItem(f('招商银行.pdf', 'logo')), '研报'); // 分类器本身有兜底
});

test('电子书籍：按扩展名识别 epub/mobi/azw3/djvu', () => {
  assert.equal(
    classifyItem(
      f(
        '财务报表分析与股票估值（第2版）（源自上海国家会计学院内部培训讲义，估值方法经过市场检验并获得超额投资收益） (郭永清) .epub',
        '研发部内部资料'
      )
    ),
    '电子书籍'
  );
  assert.equal(classifyItem(f('漫步华尔街.mobi', '培训部分享资料')), '电子书籍');
});

test('电子书籍：PDF 但书名是「手册/入门」体裁的，归电子书籍而非研报', () => {
  assert.equal(
    classifyItem(f('从ChatGPT到个人主页_AI编程入门手册.pdf', '研发部内部资料')),
    '电子书籍'
  );
});

test('数据：表格类扩展名优先，不因目录是「研发部」就归研报', () => {
  assert.equal(
    classifyItem(
      f('东方证券-行业主题基金定量跟踪月报（截至2026年7月底）-20260803.xlsx', '研发部内部资料')
    ),
    '数据'
  );
});

test('数据：电话会议纪要是「原始记录」而非分析，归数据', () => {
  assert.equal(
    classifyItem(f('智谱 AI（Zhipu AI）2026 年中报电话会议全文.docx', '研发部内部资料')),
    '数据'
  );
  assert.equal(classifyItem(f('某公司调研纪要.docx', '研发部内部资料')), '数据');
});

test('研报：机构名 + 日期前缀的个股报告', () => {
  assert.equal(classifyItem(f('2026-08-21 汇川技术(A).pdf', '培训部分享资料')), '研报');
  assert.equal(classifyItem(f('20260830-华源证券-深度学习因子周报.pdf', '研发部内部资料')), '研报');
});

test('研报：外资行英文名与中文别称都识别', () => {
  assert.equal(
    classifyItem(f('Morgan Stanley - 全球与中国AI半导体行业前景.pdf', '培训部分享资料')),
    '研报'
  );
  assert.equal(
    classifyItem(f('大摩—— 拆解闭源与开源大模型应用对产业链的差异化影响.pdf', '研发部内部资料')),
    '研报'
  );
  assert.equal(
    classifyItem(f('高盛 - 全球半导体芯片系列：中国半导体自给自足能力建设.pdf', '培训部分享资料')),
    '研报'
  );
});

test('研报：英文通用大词不再把课程拉进研报（回归：Report_GENRE_EN 曾过宽）', () => {
  // 早期把 AI / Model / Global / China 纳入英文关键词，导致
  // 「3.5上午 - Ai应用论坛」被判成研报，课程资源一度塌成 0。
  assert.equal(classifyItem(f('3.5上午 - Ai应用论坛：破局与重构.pdf', '培训部分享资料')), '课程资源');
  // 但真正的研报词汇仍要命中
  assert.equal(
    classifyItem(f('The Model Race Gets More Complicated_ Chinese Model Pricing & Open-Weights Adoption.pdf', '培训部分享资料')),
    '研报'
  );
});

test('课程资源：分享会 / 培训 / 论坛等体裁', () => {
  assert.equal(classifyItem(f('金投暑期分享8.15.pdf', '培训部分享资料')), '课程资源');
  assert.equal(classifyItem(f('我们应该如何去看待当下的金融市场.pdf', '培训部分享资料')), '课程资源');
  assert.equal(classifyItem(f('投行四百问.pdf', '培训部分享资料')), '课程资源');
  assert.equal(classifyItem(f('26金投介绍.pdf', '未分类')), '课程资源');
});

test('课程资源：压缩包一律按课件/资料包处理', () => {
  // ⚠️ 2026-09-27 调整口径：尽调资料包（DataRoom / 尽调）改判「社团成员产出」。
  //    原因是它属于**协会自产作品**（有作者、有简介、要按作品展示），
  //    而不是外部课件。断言随之从「课程资源」变为「社团成员产出」。
  assert.equal(
    classifyItem(f('DeepSeek_DataRoom.rar', '研发部内部资料')),
    PRODUCTION_CATEGORY
  );
  // 但「资料包」是通用词，不能被这条规则捞走 —— 它显然是课件
  assert.equal(classifyItem(f('培训资料包.zip', '培训部分享资料')), '课程资源');
  assert.equal(classifyItem(f('资料包.zip', '培训部分享资料')), '课程资源');
});

test('社团成员产出：尽调资料包按 DataRoom / 尽调 关键词识别（含中英文写法）', () => {
  const cases = [
    'Kimi_DataRoom_DOCX.rar',
    'Xiaohongshu_DataRoom_DOCX.zip',
    '灵心巧手_DataRoom_Word版.rar',
    '某公司尽职调查资料汇编.pdf',
    '尽调材料.zip',
  ];
  for (const fileName of cases) {
    assert.equal(
      classifyItem(f(fileName, '研发部内部资料')),
      PRODUCTION_CATEGORY,
      `${fileName} 应归「社团成员产出」`
    );
  }
});

test('社团成员产出：每日新闻整理稿归产出，而非研报/数据', () => {
  assert.equal(
    classifyItem(f('8.29每日新闻.pdf', '培训部分享资料')),
    PRODUCTION_CATEGORY
  );
});

test('电子书籍：工具书命名法（手把手/读财报）不再落到兜底的研报', () => {
  // 回归：`手把手教你读财报-2.pdf` 里既无「第 N 版」也无机构名，
  // 早期一路走到兜底规则被判成研报，读者在「电子书籍」里找不到它。
  assert.equal(
    classifyItem(f('手把手教你读财报-2.pdf', '研发部内部资料')),
    '电子书籍'
  );
  assert.equal(
    classifyItem(f('手把手教你读财报-1.pdf', '研发部内部资料')),
    '电子书籍'
  );
  // 但课程体裁优先：含「分享/讲座」等同名工具书讲义仍归课程资源
  assert.equal(
    classifyItem(f('手把手教你读财报-读书分享会.pdf', '培训部分享资料')),
    '课程资源'
  );
});

test('电子书籍：「书名号 + 作者署名」的电子书命名法', () => {
  // 回归：`《涛动周期论：经济周期决定人生财富命运》周金涛(1).pdf` 没有「第 N 版」
  // 也没有机构名，早期一路走到兜底规则被判成研报，读者在「电子书籍」里找不到。
  assert.equal(
    classifyItem(
      f('《涛动周期论：经济周期决定人生财富命运》周金涛(1).pdf', '研发部内部资料')
    ),
    '电子书籍'
  );
  assert.equal(classifyItem(f('《穷查理宝典》查理·芒格.pdf', '研发部内部资料')), '电子书籍');
});

test('电子书籍：书名号本身不构成书籍证据，行业报告仍归研报', () => {
  // 关键反例：`《中国供电发展报告（2026）》` 也带书名号，但年份写在书名号**内部**，
  // 闭合符号后没有作者署名 —— 它是行业报告，不是书。判据必须落在「号后有没有署名」。
  assert.equal(
    classifyItem(f('《中国供电发展报告（2026）》.pdf', '研发部内部资料')),
    '研报'
  );
});

test('模块归属：产出类目属于 productions，其余属于 library', () => {
  assert.equal(moduleOfCategory(PRODUCTION_CATEGORY), 'productions');
  for (const name of LIBRARY_CATEGORIES) {
    assert.equal(moduleOfCategory(name), 'library', `${name} 应归资料库模块`);
  }
  // 「社团成员产出」不得混进资料库的四个实体类目
  assert.ok(!LIBRARY_CATEGORIES.includes(PRODUCTION_CATEGORY));
});

test('课程资源：校内公文（管理办法/推荐免试）不当作研报', () => {
  assert.equal(
    classifyItem(
      f(
        '西财大办〔2026〕27号附件：西南财经大学推荐免试研究生管理办法（2026年修订）.pdf',
        '研发部内部资料'
      )
    ),
    '课程资源'
  );
});

test('日期前缀规则优先级高于课程体裁（回归：曾把 2026-08-21 汇川技术判成课程）', () => {
  // DATED_TITLE 必须在 COURSE_GENRE 之前判定，否则日期前缀的研报会被
  // 目录名里的「分享」二字带偏。
  assert.equal(classifyItem(f('2026-08-28 中国中车(A).pdf', '培训部分享资料')), '研报');
  assert.equal(classifyItem(f('2026-08-28 华虹宏力(H).pdf', '培训部分享资料')), '研报');
});

test('兜底：无法判断的 PDF 归研报（默认类目），且绝不产出「其他」', () => {
  const result = classifyItem(f('425453630132f68bb43d9fb53c9db706.pdf', '培训部分享资料'));
  assert.ok(LIBRARY_CATEGORIES.includes(result), `兜底结果 ${result} 必须是四个实体类目之一`);
  assert.equal(result, '研报');
});

test('classifyItem 对每个类目的返回值都在白名单内', () => {
  const samples = [
    f('a.epub', 'x'),
    f('a.xlsx', 'x'),
    f('2026-08-21 汇川技术(A).pdf', 'x'),
    f('金投暑期分享8.15.pdf', 'x'),
    f('随便什么名字.pdf', 'x'),
    f('没有扩展名', 'x'),
    f('Kimi_DataRoom_DOCX.rar', 'x'),
  ];
  for (const s of samples) {
    const r = classifyItem(s);
    // 白名单 = 两个模块的实体类目并集（资料库四类 + 社团成员产出）
    assert.ok(
      ALL_DISPLAY_CATEGORIES.includes(r),
      `${s.fileName} 归类得到 ${r}，不在展示类目白名单内`
    );
  }
});
