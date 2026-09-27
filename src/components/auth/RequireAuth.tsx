/**
 * 路由守卫。
 *
 * 职责边界（很重要）：
 * - 前端守卫**不是安全边界**。它只决定「要不要给用户看这个界面的入口」，
 *   真正的数据隔离由后端按会话判定。绕过守卫最多看到一个空壳页面，
 *   拿不到任何受限数据。
 * - 守卫必须能区分三种非登录态：**未登录**、**权限不足**、**后端不可达**。
 *   把三者都渲染成「请登录」会让人误判问题所在（明明网络断了却去查账号）。
 */
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AlertTriangle, Lock, ShieldX, Loader2, Mail } from 'lucide-react';
import {
  useAuth,
  roleLabel,
  satisfies,
  ACCESS_REQUEST_EMAIL,
  PRODUCTIONS_ACCESS_NOTICE,
  type Capability,
} from '@/lib/auth';

interface RequireAuthProps {
  children: ReactNode;
  /** 需要的全部能力；不传则只要求「已登录」 */
  required?: Capability[];
  /** 权限不足时的兜底展示，默认走内置的「无权访问」页 */
  fallback?: ReactNode;
}

/** 加载中 */
function Checking() {
  return (
    <div className='mx-auto flex min-h-[52vh] max-w-md flex-col items-center justify-center px-4 text-center'>
      <Loader2 className='h-6 w-6 animate-spin text-brand-500' />
      <p className='mt-4 text-sm text-ink-500'>正在确认访问权限…</p>
    </div>
  );
}

/** 未登录 */
function NeedLogin({ from }: { from: string }) {
  const next = encodeURIComponent(from);
  /**
   * 「社团成员产出」是被访客主动点击进来的 —— 它需要明确指出「这个功能为什么进不去、
   * 想进去该找谁」，而不是丢一句通用的「请登录」。其它受保护页仍走通用文案。
   */
  const isProductions = from.startsWith('/productions');
  return (
    <div className='mx-auto flex min-h-[52vh] max-w-md flex-col items-center justify-center px-4 text-center'>
      <div className='flex h-12 w-12 items-center justify-center rounded-full bg-brand-50'>
        <Lock className='h-5 w-5 text-brand-600' />
      </div>
      <h2 className='mt-5 text-lg font-semibold text-ink-900'>该页面需要登录</h2>
      <p className='mt-2 text-sm leading-relaxed text-ink-500'>
        {isProductions
          ? '此页面仅对持有权限账号的协会成员开放。'
          : '此页面仅对协会成员开放。请使用协会提供的账号登录后访问。'}
      </p>

      {isProductions ? (
        <div className='mt-5 flex w-full items-start gap-2.5 rounded-xl border border-flare-200 bg-flare-50 p-3.5 text-left'>
          <Mail className='mt-0.5 h-4 w-4 shrink-0 text-flare-600' />
          <p className='text-xs leading-relaxed text-flare-700'>{PRODUCTIONS_ACCESS_NOTICE}</p>
        </div>
      ) : null}

      <Link
        to={`/login?next=${next}`}
        className='mt-6 rounded-lg bg-brand-700 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-800'
      >
        前往登录
      </Link>

      {isProductions ? (
        <p className='mt-4 text-xs leading-relaxed text-ink-400'>
          申请权限请联系
          <a
            href={`mailto:${ACCESS_REQUEST_EMAIL}`}
            className='num ml-1 text-brand-600 hover:underline'
          >
            {ACCESS_REQUEST_EMAIL}
          </a>
        </p>
      ) : null}
    </div>
  );
}

/** 已登录但权限不足 */
function NeedPermission({ capabilities }: { capabilities: Capability[] }) {
  return (
    <div className='mx-auto flex min-h-[52vh] max-w-md flex-col items-center justify-center px-4 text-center'>
      <div className='flex h-12 w-12 items-center justify-center rounded-full bg-flare-50'>
        <ShieldX className='h-5 w-5 text-flare-600' />
      </div>
      <h2 className='mt-5 text-lg font-semibold text-ink-900'>当前账号无权访问</h2>
      <p className='mt-2 text-sm leading-relaxed text-ink-500'>
        你的账号已登录，但不具备访问此页面所需的权限。如需开通，请联系协会负责人。
      </p>
      <p className='num mt-3 rounded-md bg-ink-50 px-3 py-1.5 text-xs text-ink-500'>
        需要权限：{capabilities.join(' / ') || '（未指定）'}
      </p>
      <Link
        to='/'
        className='mt-6 rounded-lg border border-ink-900/12 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50'
      >
        返回首页
      </Link>
    </div>
  );
}

/** 后端不可达 —— 与「未登录」区分开 */
function BackendOffline({ message }: { message: string | null }) {
  return (
    <div className='mx-auto flex min-h-[52vh] max-w-lg flex-col items-center justify-center px-4 text-center'>
      <div className='flex h-12 w-12 items-center justify-center rounded-full bg-gold-50'>
        <AlertTriangle className='h-5 w-5 text-gold-600' />
      </div>
      <h2 className='mt-5 text-lg font-semibold text-ink-900'>无法连接后端服务</h2>
      <p className='mt-2 text-sm leading-relaxed text-ink-500'>
        权限校验需要后端配合，当前无法访问。这不代表你的账号有问题。
      </p>
      {message ? (
        <p className='mt-3 rounded-lg bg-ink-50 px-3 py-2 text-xs leading-relaxed text-ink-500'>
          {message}
        </p>
      ) : null}
      <p className='mt-4 text-xs text-ink-400'>
        本地开发时请在 <code className='rounded bg-ink-100 px-1.5 py-0.5'>server/</code> 目录执行{' '}
        <code className='rounded bg-ink-100 px-1.5 py-0.5'>npm start</code>
      </p>
    </div>
  );
}

/** 已登录，但临时账号已过期 */
function Expired() {
  return (
    <div className='mx-auto flex min-h-[52vh] max-w-md flex-col items-center justify-center px-4 text-center'>
      <div className='flex h-12 w-12 items-center justify-center rounded-full bg-gold-50'>
        <AlertTriangle className='h-5 w-5 text-gold-600' />
      </div>
      <h2 className='mt-5 text-lg font-semibold text-ink-900'>临时浏览权限已到期</h2>
      <p className='mt-2 text-sm leading-relaxed text-ink-500'>
        你的临时浏览权限已失效。如需继续访问，请联系协会负责人重新开通。
      </p>
      <Link
        to='/'
        className='mt-6 rounded-lg border border-ink-900/12 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50'
      >
        返回首页
      </Link>
    </div>
  );
}

/**
 * 守卫组件。用法：
 *   <RequireAuth required={[CAP_MANAGE_CONTENT]}><Admin /></RequireAuth>
 */
export function RequireAuth({ children, required = [], fallback }: RequireAuthProps) {
  const { status, capabilities, account, error } = useAuth();
  const location = useLocation();

  if (status === 'checking') return <Checking />;
  if (status === 'offline') return <BackendOffline message={error} />;

  if (status !== 'authenticated') {
    if (fallback) return <>{fallback}</>;
    return <NeedLogin from={location.pathname} />;
  }

  // 临时账号过期的兜底：后端已在登录与每次鉴权时拦截，
  // 这里再挡一层，避免「页面开着但权限已失效」的窗口期。
  if (account?.expired) return <Expired />;

  if (!satisfies(capabilities, required)) {
    if (fallback) return <>{fallback}</>;
    return <NeedPermission capabilities={required} />;
  }

  return <>{children}</>;
}

/** 把当前角色渲染成一个小徽标，供导航/页面头部显示 */
export function RoleBadge() {
  const { status, role, account } = useAuth();
  if (status !== 'authenticated') return null;

  const tone =
    role === 'admin'
      ? 'border-brand-200 bg-brand-50 text-brand-700'
      : 'border-gold-200 bg-gold-50 text-gold-700';

  return (
    <span className={`num rounded-md border px-2 py-1 text-[11px] ${tone}`}>
      {roleLabel(role)}
      {account?.displayName ? ` · ${account.displayName}` : ''}
    </span>
  );
}

export default RequireAuth;
