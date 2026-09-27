/**
 * 站点配置：`site_settings` 表的键清单、默认值与解析工具。
 * 键名与 `.project.md` §4 保持一致。
 */
import { SEED_SETTINGS } from '@/data/seed';
import type { SettingsMap } from './types';

/** 配置项元数据（用于内容管理页渲染表单） */
export interface SettingFieldMeta {
  key: string;
  label: string;
  hint?: string;
  multiline?: boolean;
  /** 归入哪个分组 */
  group: 'basic' | 'about' | 'contact' | 'stock' | 'admin';
}

export const SETTING_FIELDS: SettingFieldMeta[] = [
  { key: 'site_name', label: '协会全称', group: 'basic' },
  { key: 'site_short_name', label: '站点简称（页头）', group: 'basic' },
  { key: 'site_slogan', label: '站点标语', group: 'basic' },
  { key: 'copyright', label: '页脚版权文字', group: 'basic' },

  { key: 'about_title', label: '首页介绍标题', group: 'about' },
  {
    key: 'about_content',
    label: '首页介绍正文',
    hint: '空行分段',
    multiline: true,
    group: 'about',
  },
  {
    key: 'about_stats',
    label: '首页数据条（JSON）',
    hint: '格式：[{"label":"在册成员","value":"120"}]',
    multiline: true,
    group: 'about',
  },
  {
    key: 'org_note',
    label: '组织架构说明',
    multiline: true,
    group: 'about',
  },
  { key: 'join_us', label: '加入我们说明', multiline: true, group: 'about' },

  { key: 'contact_address', label: '联系地址', group: 'contact' },
  { key: 'contact_email', label: '联系邮箱', group: 'contact' },
  { key: 'contact_phone', label: '联系电话', group: 'contact' },
  { key: 'contact_wechat', label: '微信公众号', group: 'contact' },
  {
    key: 'contact_extra',
    label: '其他联系方式',
    hint: '留空则页脚显示「信息待补充」',
    group: 'contact',
  },

  {
    key: 'stock_api_base',
    label: '行情数据服务地址',
    hint:
      'free-stockdb 默认地址 http://127.0.0.1:7899。注意：本站为 HTTPS 时浏览器会拦截 http 地址，' +
      '需通过同源反向代理（如 /stock）或 https 隧道暴露该服务',
    group: 'stock',
  },
  {
    key: 'stock_watchlist',
    label: '股票看板股票池（JSON）',
    hint: '格式：[{"code":"600702","name":"舍得酒业"}]',
    multiline: true,
    group: 'stock',
  },

  {
    key: 'admin_passcode',
    label: '内容管理口令',
    hint: 'Demo 默认 swufe2026，正式上线前请修改',
    group: 'admin',
  },
];

export const DEFAULT_SETTINGS: SettingsMap = { ...SEED_SETTINGS };

/** 读取配置值，缺失时回落到默认值 */
export function getSetting(
  settings: SettingsMap,
  key: string,
  fallback = ''
): string {
  const value = settings[key];
  if (value === undefined || value === null || value === '') {
    return DEFAULT_SETTINGS[key] ?? fallback;
  }
  return value;
}

/** 允许显式留空的配置项（联系方式等），不做默认值兜底 */
export function getRawSetting(settings: SettingsMap, key: string): string {
  return settings[key] ?? '';
}

export interface StatItem {
  label: string;
  value: string;
}

/** 解析首页数据条 JSON，非法输入回落到默认值 */
export function parseStats(raw: string): StatItem[] {
  const source = raw || DEFAULT_SETTINGS.about_stats;
  try {
    const parsed = JSON.parse(source) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter(
          (item): item is StatItem =>
            !!item &&
            typeof item === 'object' &&
            'label' in item &&
            'value' in item
        )
        .map((item) => ({
          label: String(item.label),
          value: String(item.value),
        }));
    }
  } catch {
    // 忽略非法 JSON
  }
  return [];
}

export interface WatchItem {
  code: string;
  name: string;
}

/** 解析股票池 JSON */
export function parseWatchlist(raw: string): WatchItem[] {
  const source = raw || DEFAULT_SETTINGS.stock_watchlist;
  try {
    const parsed = JSON.parse(source) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter(
          (item): item is WatchItem =>
            !!item &&
            typeof item === 'object' &&
            'code' in item &&
            'name' in item
        )
        .map((item) => ({
          code: String(item.code),
          name: String(item.name),
        }));
    }
  } catch {
    // 忽略非法 JSON
  }
  return [];
}

/** 联系方式是否已填写（未填写时页脚展示占位提示） */
export function hasContactInfo(settings: SettingsMap): boolean {
  return ['contact_address', 'contact_email', 'contact_phone', 'contact_wechat', 'contact_extra'].some(
    (key) => (settings[key] ?? '').trim() !== ''
  );
}
