import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

/** 轻量弹窗（无额外依赖，样式与站点一致） */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: ModalProps) {
  if (!open) return null;
  return (
    <div className='fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/40 p-4 py-10 backdrop-blur-sm'>
      <div
        className={cn(
          'w-full rounded-xl bg-white shadow-2xl',
          wide ? 'max-w-3xl' : 'max-w-xl'
        )}
        role='dialog'
        aria-modal='true'
      >
        <div className='flex items-center justify-between border-b border-gray-100 px-5 py-3.5'>
          <h3 className='text-sm font-semibold text-brand-900'>{title}</h3>
          <button
            type='button'
            onClick={onClose}
            className='rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600'
            aria-label='关闭'
          >
            <X className='h-4 w-4' />
          </button>
        </div>
        <div className='max-h-[70vh] overflow-y-auto px-5 py-4'>{children}</div>
        {footer ? (
          <div className='flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3.5'>
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}

/** 表单字段容器 */
export function Field({ label, hint, children, className }: FieldProps) {
  return (
    <div className={className}>
      <label className='mb-1.5 block text-xs font-medium text-gray-600'>
        {label}
      </label>
      {children}
      {hint ? <p className='mt-1 text-xs text-gray-400'>{hint}</p> : null}
    </div>
  );
}

const inputClass =
  'h-9 w-full rounded-md border border-gray-200 px-2.5 text-sm outline-none transition-colors focus:border-brand-400';

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(inputClass, props.className)} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(
        'w-full rounded-md border border-gray-200 px-2.5 py-2 text-sm leading-relaxed outline-none transition-colors focus:border-brand-400',
        props.className
      )}
    />
  );
}

export function SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(inputClass, 'bg-white', props.className)}
    />
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'outline' | 'danger' | 'ghost';
}

/** 管理页按钮 */
export function AdminButton({
  variant = 'primary',
  className,
  ...rest
}: ButtonProps) {
  const styles: Record<string, string> = {
    primary: 'bg-brand-800 text-white hover:bg-brand-900',
    outline:
      'border border-gray-200 bg-white text-gray-600 hover:border-brand-300 hover:text-brand-700',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    ghost: 'text-gray-500 hover:bg-gray-100 hover:text-gray-700',
  };
  return (
    <button
      {...rest}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-3.5 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        styles[variant],
        className
      )}
    />
  );
}

/** 管理页卡片区块 */
export function Panel({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className='rounded-xl border border-gray-100 bg-white shadow-sm'>
      <div className='flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-4'>
        <div>
          <h3 className='text-sm font-semibold text-brand-900'>{title}</h3>
          {description ? (
            <p className='mt-1 text-xs text-gray-400'>{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      <div className='px-5 py-4'>{children}</div>
    </section>
  );
}
