/**
 * 文件形态的视觉映射：图标 + 配色。
 *
 * 资料列表（ResourceRow）、作品卡片（WorkCard）、作品详情（ProductionDetail）
 * 三处都要「按扩展名给个图标和颜色」。原先各自实现一份，
 * 于是同一个 `.docx` 在列表里是文档图标、在详情页里却成了通用图标 ——
 * 这种不一致用户说不清哪里怪，但一眼就能感到「不是一套东西」。
 */
import {
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  Presentation,
  type LucideIcon,
} from 'lucide-react';

/** 按扩展名挑图标 */
export function iconForExt(ext: string): LucideIcon {
  const e = String(ext ?? '').toLowerCase();
  if (e === 'pdf') return FileText;
  if (e === 'xls' || e === 'xlsx' || e === 'csv' || e === 'tsv') return FileSpreadsheet;
  if (e === 'doc' || e === 'docx') return FileText;
  if (e === 'ppt' || e === 'pptx') return Presentation;
  if (e === 'png' || e === 'jpg' || e === 'jpeg' || e === 'gif' || e === 'webp' || e === 'svg') {
    return FileImage;
  }
  if (e === 'zip' || e === 'rar' || e === '7z' || e === 'tar' || e === 'gz') return FileArchive;
  if (e === 'epub' || e === 'mobi' || e === 'azw3' || e === 'djvu') return FileText;
  return FileText;
}

/** 扩展名对应的色系，便于快速扫读 */
export function toneForExt(ext: string): string {
  const e = String(ext ?? '').toLowerCase();
  if (e === 'pdf') return 'border-flare-200 bg-flare-50 text-flare-600';
  if (e === 'xls' || e === 'xlsx' || e === 'csv' || e === 'tsv') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-600';
  }
  if (e === 'zip' || e === 'rar' || e === '7z') {
    return 'border-gold-200 bg-gold-50 text-gold-600';
  }
  if (e === 'png' || e === 'jpg' || e === 'jpeg' || e === 'webp' || e === 'svg') {
    return 'border-brand-200 bg-brand-50 text-brand-600';
  }
  if (e === 'epub' || e === 'mobi' || e === 'azw3') {
    return 'border-brand-200 bg-brand-50 text-brand-600';
  }
  return 'border-ink-900/10 bg-ink-50 text-ink-500';
}

/** 文件类型的中文简称，用于角标 */
export function labelForExt(ext: string): string {
  const e = String(ext ?? '').toLowerCase();
  const map: Record<string, string> = {
    pdf: 'PDF',
    doc: 'Word',
    docx: 'Word',
    xls: 'Excel',
    xlsx: 'Excel',
    csv: 'CSV',
    ppt: 'PPT',
    pptx: 'PPT',
    epub: 'EPUB',
    mobi: 'MOBI',
    zip: 'ZIP',
    rar: 'RAR',
    '7z': '7Z',
    png: '图片',
    jpg: '图片',
    jpeg: '图片',
    gif: '图片',
    webp: '图片',
    svg: '图片',
  };
  return map[e] ?? (e ? e.toUpperCase() : '文件');
}

/** 能否在浏览器里直接内联预览（与后端 INLINE_EXT 口径一致） */
export function isInlinePreviewable(ext: string): boolean {
  const e = String(ext ?? '').toLowerCase();
  return ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'txt', 'md'].includes(e);
}

/** 是不是可当作封面直接渲染的图片 */
export function isImageExt(ext: string): boolean {
  const e = String(ext ?? '').toLowerCase();
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(e);
}

interface Props {
  ext: string;
  className?: string;
  /** 图标尺寸类，默认 h-5 w-5（注意：本项目 Tailwind 间距表里没有 4.5，别写 h-4.5） */
  iconClassName?: string;
}

/** 图标 + 底色的小方块 */
export function ResourceGlyph({ ext, className, iconClassName }: Props) {
  const Icon = iconForExt(ext);
  return (
    <span
      className={[
        'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border',
        toneForExt(ext),
        className ?? '',
      ].join(' ')}
    >
      <Icon className={iconClassName ?? 'h-5 w-5'} />
    </span>
  );
}

export default ResourceGlyph;
