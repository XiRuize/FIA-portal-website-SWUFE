import { useRef, useState } from 'react';
import { ImagePlus, Link2, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';

const MAX_FILE_MB = 6;
const MAX_WIDTH = 1600;

interface ImageFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}

/** 把图片文件压缩为 dataURL，避免把过大的图片写进数据库 */
async function fileToDataUrl(file: File): Promise<string> {
  const rawUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });

  // 非图片或无需压缩时直接返回
  if (!file.type.startsWith('image/')) return rawUrl;

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('图片解析失败'));
    el.src = rawUrl;
  });

  if (img.width <= MAX_WIDTH) return rawUrl;

  const scale = MAX_WIDTH / img.width;
  const canvas = document.createElement('canvas');
  canvas.width = MAX_WIDTH;
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return rawUrl;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

/** 图片字段：支持填写 URL 或上传本地图片（压缩后转 base64 存储） */
export function ImageField({ label, value, onChange, hint }: ImageFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      setError(`文件超过 ${MAX_FILE_MB}MB，请先压缩后再上传。`);
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await fileToDataUrl(file);
      onChange(dataUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div>
      <label className='mb-1.5 block text-xs font-medium text-gray-600'>
        {label}
      </label>
      <div className='flex gap-3'>
        <div className='relative h-24 w-32 shrink-0 overflow-hidden rounded-lg border border-gray-200 bg-gray-50'>
          {value ? (
            <>
              <img
                src={value}
                alt='预览'
                className='h-full w-full object-cover'
              />
              <button
                type='button'
                onClick={() => onChange('')}
                className='absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white transition-colors hover:bg-black/80'
                aria-label='移除图片'
              >
                <X className='h-3 w-3' />
              </button>
            </>
          ) : (
            <span className='flex h-full items-center justify-center text-xs text-gray-300'>
              无图片
            </span>
          )}
        </div>

        <div className='min-w-0 flex-1 space-y-2'>
          <div className='relative'>
            <Link2 className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400' />
            <input
              value={value.startsWith('data:') ? '' : value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={
                value.startsWith('data:')
                  ? '已上传本地图片'
                  : '粘贴图片 URL（https://…）'
              }
              disabled={value.startsWith('data:')}
              className='h-9 w-full rounded-md border border-gray-200 pl-8 pr-2 text-xs outline-none transition-colors focus:border-brand-400 disabled:bg-gray-50'
            />
          </div>

          <div className='flex items-center gap-2'>
            <button
              type='button'
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className='inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 transition-colors hover:border-brand-300 hover:text-brand-700 disabled:opacity-50'
            >
              {busy ? (
                <Loader2 className='h-3.5 w-3.5 animate-spin' />
              ) : (
                <ImagePlus className='h-3.5 w-3.5' />
              )}
              上传本地图片
            </button>
            {value.startsWith('data:') ? (
              <span className={cn('text-xs', 'text-emerald-600')}>
                已转为内嵌图片
              </span>
            ) : null}
          </div>

          <input
            ref={inputRef}
            type='file'
            accept='image/*'
            className='hidden'
            onChange={(e) => void handleFile(e.target.files?.[0])}
          />
          {hint ? <p className='text-xs text-gray-400'>{hint}</p> : null}
          {error ? <p className='text-xs text-red-500'>{error}</p> : null}
        </div>
      </div>
    </div>
  );
}

export default ImageField;
