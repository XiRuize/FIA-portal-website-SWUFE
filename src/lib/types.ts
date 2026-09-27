/**
 * 站点业务模型（前端统一类型）。
 * 组件层只消费这里定义的模型，不直接使用后端原始行。
 */

/** 内容分类标识 */
export type ArticleCategory =
  | 'banner'
  | 'activity'
  | 'news'
  | 'finance'
  | 'course'
  | 'data'
  | 'ebook'
  | 'report'
  | 'production';

/** 发布状态 */
export type PublishStatus = 'published' | 'draft';

/** 通用内容条目（对应表 site_article / custom_table_5749） */
export interface Article {
  id: string;
  category: ArticleCategory;
  title: string;
  subtitle: string;
  summary: string;
  content: string;
  cover: string;
  author: string;
  source: string;
  /** 展示用日期 YYYY-MM-DD */
  eventDate: string;
  /** 标签，逗号分隔 */
  tags: string;
  /** 附件 / 下载链接 */
  fileUrl: string;
  /** 外部链接 */
  linkUrl: string;
  sortIndex: number;
  /** 1 = 置顶 */
  pinned: number;
  status: PublishStatus;
  createdAt: string;
  updatedAt: string;
}

/** 历史沿革事件（对应表 site_timeline / custom_table_5750） */
export interface TimelineEvent {
  id: string;
  year: string;
  title: string;
  description: string;
  image: string;
  sortIndex: number;
  status: PublishStatus;
  createdAt: string;
  updatedAt: string;
}

/** 组织架构成员（对应表 site_org_member / custom_table_5751） */
export interface OrgMember {
  id: string;
  dept: string;
  role: string;
  name: string;
  avatar: string;
  grade: string;
  intro: string;
  sortIndex: number;
  status: PublishStatus;
  createdAt: string;
  updatedAt: string;
}

/** 站点配置项（对应表 site_settings / custom_table_5752） */
export interface SettingRow {
  id: string;
  key: string;
  value: string;
  description: string;
}

/** 键值映射形式的站点配置 */
export type SettingsMap = Record<string, string>;

/** 数据来源模式 */
export type DataMode = 'cloud' | 'local' | 'loading';

/** 分类展示元数据 */
export const CATEGORY_META: Record<
  ArticleCategory,
  { label: string; hint: string }
> = {
  banner: { label: '首页轮播', hint: '建议尺寸 1920×720，标题不超过 20 字' },
  activity: { label: '活动回顾', hint: '往期活动图文回顾' },
  news: { label: '社团记事', hint: '社团日常动态、会议与公告' },
  finance: { label: '财经时事', hint: '财经要闻与市场观察' },
  course: { label: '课程分享', hint: '内部培训课程、讲义与录播' },
  data: { label: '数据分享', hint: '数据库、数据源与整理好的数据集' },
  ebook: { label: '电子书籍', hint: '金融投资类电子书资源' },
  report: { label: '投行研报 Excel', hint: '研报与 Excel 模型模板' },
  production: { label: '社团产出', hint: '研究成果、比赛作品、刊物' },
};

/** 资料与数据栏目下使用的分类 */
export const RESOURCE_CATEGORIES: ArticleCategory[] = [
  'course',
  'data',
  'ebook',
  'report',
];
