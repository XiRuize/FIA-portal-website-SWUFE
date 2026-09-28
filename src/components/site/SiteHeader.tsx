import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Activity, ArrowUpRight, LogIn, LogOut, Menu, Settings, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useContent } from '@/lib/store';
import { useAuth, roleLabel } from '@/lib/auth';
import { getSetting } from '@/lib/siteConfig';

/**
 * 导航项。
 *
 * `requires` 字段声明进入该项需要的权限：
 * - 无 `requires`：公开；
 * - 有 `requires`：仅在满足时渲染。
 *
 * ⚠️「社团成员产出」**刻意不加 `requires`**，两种做法要分清：
 * - 隐藏入口（`requires`）＝ 访客根本看不到，也就无从知道该功能存在、该找谁申请；
 * - 门禁入口（当前做法）＝ 访客看得到、点得动，被 `RequireAuth` 引导到登录页，
 *   在登录页读到「仅限有权限账号浏览 + 申请邮箱」。
 * 需求要的是后者：入口必须存在，权限判定发生在点击之后。
 *
 * 隐藏入口只是体验优化，不是安全措施 —— 真正的隔离在后端。
 */
export const NAV_ITEMS: Array<{
  to: string;
  label: string;
  end?: boolean;
  requires?: string[];
}> = [
  { to: '/', label: '首页', end: true },
  { to: '/history', label: '历史沿革' },
  { to: '/resources', label: '资料与数据' },
  // 门禁入口：可见 + 点击后由路由守卫引导登录，而非直接隐藏
  { to: '/productions', label: '社团成员产出' },
  { to: '/news', label: '新闻与资讯' },
];

/**
 * 「栏目与网站管理」入口的路径与标签。
 *
 * 单独导出是因为**页脚（`SiteFooter`）也要用同一个入口** ——
 * 早先页脚自己硬编码了 `{ to: '/admin', label: '内容管理' }`，
 * 于是同一个入口在页头和页脚有两个名字。把标签收敛到一处。
 */
export const ADMIN_ENTRY = { to: '/admin', label: '栏目与网站管理' } as const;

/** 协会徽标：浅红→金渐变 + 呼吸柔光 + 简称首字 */
function Badge({ short }: { short: string }) {
  return (
    <span className='relative flex h-10 w-10 shrink-0 items-center justify-center'>
      <span
        aria-hidden
        className='absolute inset-0 animate-breathe rounded-xl bg-gradient-to-br from-flare-300 to-gold-300 blur-[8px]'
      />
      <span className='relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-flare-500 to-flare-600 text-base font-bold text-white shadow-card'>
        {short.slice(0, 1)}
      </span>
    </span>
  );
}

/**
 * 主导航末尾的「栏目与网站管理 与 登录」。
 *
 * ## 为什么它不隐藏
 *
 * 这一项**对所有访客可见**，包括未登录的人。理由与「社团成员产出」相同：
 * 一个看不见的入口等于不存在 —— 申请人无从知道该功能，也就不会去申请权限。
 * 因此这里刻意不做 `canAdmin` 判断，把「有没有权限」的判定留给 `/admin`
 * 页面本身（无权限时由 `RequireAuth` 渲染「没有权限，请登录管理员账号」）。
 *
 * ## 三种登录态下的呈现
 *
 * - 未登录：`栏目与网站管理` 与 `登录` 两个入口，中间以「与」相连；
 * - 已登录：`栏目与网站管理` + 角色徽标 + `退出`（此时不再需要「登录」）；
 * - 已登录但无管理权限：入口仍在，点进去看到的是「权限不足」页而不是报错。
 *
 * @param variant `desktop` 走横向导航样式，`mobile` 走抽屉的整行卡片样式
 */
function AdminEntryNav({ variant }: { variant: 'desktop' | 'mobile' }) {
  const { status, role, account, logout } = useAuth();
  const navigate = useNavigate();
  const signedIn = status === 'authenticated';
  const isMobile = variant === 'mobile';

  const itemClass = ({ isActive }: { isActive: boolean }) =>
    isMobile
      ? cn(
          'flex items-center justify-between rounded-xl border px-4 py-3 text-sm font-medium transition-all duration-500 ease-smooth',
          isActive
            ? 'border-flare-200 bg-flare-50 text-flare-700'
            : 'border-ink-900/[0.07] bg-white text-ink-700'
        )
      : cn(
          'group relative rounded-lg px-3.5 py-2 text-sm font-medium transition-colors',
          isActive ? 'text-flare-600' : 'text-ink-600 hover:bg-flare-50 hover:text-ink-900'
        );

  if (isMobile) {
    return (
      <div className='space-y-1'>
        <NavLink to={ADMIN_ENTRY.to} end className={itemClass}>
          <span className='inline-flex items-center gap-2'>
            <Settings className='h-4 w-4 opacity-60' />
            {ADMIN_ENTRY.label}
          </span>
          <ArrowUpRight className='h-4 w-4 opacity-40' />
        </NavLink>

        {signedIn ? (
          <div className='flex items-center justify-between rounded-xl border border-ink-900/[0.07] bg-ink-50/60 px-4 py-3'>
            <span className='num text-xs text-ink-600'>
              {roleLabel(role)}
              {account?.displayName ? ` · ${account.displayName}` : ''}
            </span>
            <button
              type='button'
              onClick={() => {
                void logout().then(() => navigate('/', { replace: true }));
              }}
              className='inline-flex items-center gap-1 text-xs text-ink-500 transition-colors hover:text-flare-600'
            >
              <LogOut className='h-3.5 w-3.5' />
              退出
            </button>
          </div>
        ) : (
          <NavLink to='/login' className={itemClass}>
            <span className='inline-flex items-center gap-2'>
              <LogIn className='h-4 w-4 opacity-60' />
              登录
            </span>
            <ArrowUpRight className='h-4 w-4 opacity-40' />
          </NavLink>
        )}
      </div>
    );
  }

  return (
    <div className='flex items-center'>
      <NavLink to={ADMIN_ENTRY.to} end className={itemClass}>
        {({ isActive }) => (
          <>
            {ADMIN_ENTRY.label}
            <span
              aria-hidden
              className={cn(
                'absolute inset-x-3 -bottom-0.5 h-px origin-left bg-gradient-to-r from-flare-500 to-gold-500 transition-transform duration-300 ease-smooth',
                isActive ? 'scale-x-100' : 'scale-x-0 group-hover:scale-x-100'
              )}
            />
            {isActive ? (
              <span
                aria-hidden
                className='absolute inset-x-3 -bottom-1 h-2 bg-flare-400/25 blur-[6px]'
              />
            ) : null}
          </>
        )}
      </NavLink>

      {/* 「与」：把「栏目与网站管理」和「登录」连成需求里写的那一句 */}
      <span className='px-1 text-sm text-ink-300'>与</span>

      {signedIn ? (
        <div className='flex items-center gap-2 pl-1'>
          <span className='num max-w-[14rem] truncate text-xs text-ink-500'>
            {roleLabel(role)}
            {account?.displayName ? ` · ${account.displayName}` : ''}
          </span>
          <button
            type='button'
            onClick={() => {
              void logout().then(() => navigate('/', { replace: true }));
            }}
            className='inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm font-medium text-ink-500 transition-colors hover:bg-ink-50 hover:text-flare-600'
          >
            <LogOut className='h-3.5 w-3.5' />
            退出
          </button>
        </div>
      ) : (
        <NavLink
          to='/login'
          className={({ isActive }) =>
            cn(
              'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
              isActive ? 'text-flare-600' : 'text-ink-600 hover:bg-flare-50 hover:text-ink-900'
            )
          }
        >
          <LogIn className='h-3.5 w-3.5' />
          登录
        </NavLink>
      )}
    </div>
  );
}

/** 站点页头：品牌区 + 主导航 + 移动端全屏抽屉 */
export function SiteHeader() {
  const { settings } = useContent();
  const { status: authStatus, capabilities } = useAuth();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const location = useLocation();

  const siteName = getSetting(settings, 'site_name');
  const shortName = getSetting(settings, 'site_short_name');
  const slogan = getSetting(settings, 'site_slogan');

  /** 访问者是否能看见受保护入口（仅 `内容管理` 这类纯后台入口仍走隐藏策略） */
  const canSee = (requires?: string[]) =>
    !requires || requires.every((c) => capabilities.includes(c));

  const visibleNav = NAV_ITEMS.filter((item) => canSee(item.requires));
  const signedIn = authStatus === 'authenticated';

  // 路由切换后自动收起移动端菜单
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // 滚动后收紧页头并加强玻璃背景
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // 抽屉打开时锁定页面滚动
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <header
      className={cn(
        'sticky top-0 z-50 transition-all duration-500 ease-smooth',
        scrolled
          ? 'glass shadow-[0_1px_0_rgba(20,20,20,0.04),0_8px_24px_-20px_rgba(20,20,20,0.25)]'
          : 'border-b border-transparent bg-white/80 backdrop-blur-sm'
      )}
    >
      {/*
        顶部细条。**只保留环境信息**（协会口号、行情入口、学校署名）。
        成员登录/退出原本也在这里，现已按需求移到主导航栏末尾的
        「栏目与网站管理 与 登录」——同一件事只应有一个入口，
        两处并存会让「到底哪个才是登录」变得含糊。
      */}
      <div className='hidden border-b border-ink-900/[0.06] lg:block'>
        <div className='mx-auto flex max-w-7xl items-center justify-between px-6 py-1.5 text-xs'>
          <span className='truncate text-ink-500'>
            <span className='num mr-2 text-flare-400'>//</span>
            {slogan}
          </span>
          <div className='flex items-center gap-5'>
            <Link
              to='/news?tab=finance'
              className='inline-flex items-center gap-1.5 text-ink-500 transition-colors hover:text-flare-600'
            >
              <Activity className='h-3 w-3' />
              行情看板
            </Link>
            <span className='h-3 w-px bg-ink-900/10' />
            <span className='text-ink-400'>西南财经大学</span>
            {signedIn ? (
              <>
                <span className='h-3 w-px bg-ink-900/10' />
                <span className='num text-ink-400'>已登录</span>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <div
        className={cn(
          'mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 transition-all duration-500 ease-smooth sm:px-6',
          scrolled ? 'py-2.5' : 'py-4'
        )}
      >
        <Link to='/' className='group flex min-w-0 items-center gap-3'>
          <Badge short={shortName} />
          <span className='min-w-0'>
            <span className='block truncate text-base font-bold leading-tight text-ink-900 transition-colors group-hover:text-flare-600 sm:text-lg'>
              {shortName}
            </span>
            <span className='num hidden truncate text-[10px] uppercase tracking-[0.14em] text-ink-400 sm:block'>
              {siteName}
            </span>
          </span>
        </Link>

        <nav className='hidden items-center gap-1 lg:flex'>
          {visibleNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'group relative rounded-lg px-3.5 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'text-flare-600'
                    : 'text-ink-600 hover:bg-flare-50 hover:text-ink-900'
                )
              }
            >
              {({ isActive }) => (
                <>
                  {item.label}
                  {/* 激活态：浅红→金渐变指示条 */}
                  <span
                    aria-hidden
                    className={cn(
                      'absolute inset-x-3 -bottom-0.5 h-px origin-left bg-gradient-to-r from-flare-500 to-gold-500 transition-transform duration-300 ease-smooth',
                      isActive
                        ? 'scale-x-100'
                        : 'scale-x-0 group-hover:scale-x-100'
                    )}
                  />
                  {isActive ? (
                    <span
                      aria-hidden
                      className='absolute inset-x-3 -bottom-1 h-2 bg-flare-400/25 blur-[6px]'
                    />
                  ) : null}
                </>
              )}
            </NavLink>
          ))}

          {/*
            竖线分隔 + 「栏目与网站管理 与 登录」。
            分隔线的作用是把它从「内容导航」里划出来 —— 它是**工具入口**，
            与首页/历史沿革/资料这些「读内容」的入口不是一类东西。
          */}
          <span aria-hidden className='mx-1.5 h-4 w-px shrink-0 bg-ink-900/15' />
          <AdminEntryNav variant='desktop' />
        </nav>

        <div className='flex items-center gap-2'>
          <Link
            to='/news?tab=finance'
            className='hidden items-center gap-1.5 rounded-lg border border-flare-200 bg-flare-50 px-3.5 py-2 text-xs font-medium text-flare-700 transition-all duration-300 hover:border-flare-300 hover:bg-flare-100 hover:shadow-glow-flare lg:inline-flex'
          >
            <Activity className='h-3.5 w-3.5' />
            打开行情终端
            <ArrowUpRight className='h-3.5 w-3.5' />
          </Link>

          <button
            type='button'
            onClick={() => setOpen((v) => !v)}
            className='inline-flex h-10 w-10 items-center justify-center rounded-lg border border-ink-900/10 bg-white text-ink-700 transition-colors hover:bg-ink-50 lg:hidden'
            aria-label={open ? '关闭菜单' : '打开菜单'}
            aria-expanded={open}
          >
            {open ? <X className='h-5 w-5' /> : <Menu className='h-5 w-5' />}
          </button>
        </div>
      </div>

      {/* 移动端全屏抽屉 */}
      <div
        className={cn(
          'fixed inset-x-0 top-[57px] z-40 origin-top overflow-hidden border-b border-ink-900/[0.07] bg-white/95 backdrop-blur-2xl transition-all duration-300 ease-smooth lg:hidden',
          open
            ? 'pointer-events-auto max-h-[80vh] opacity-100'
            : 'pointer-events-none max-h-0 opacity-0'
        )}
      >
        <nav className='space-y-1 px-4 py-4'>
          {visibleNav.map((item, i) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              style={{ transitionDelay: open ? `${i * 45}ms` : '0ms' }}
              className={({ isActive }) =>
                cn(
                  'flex items-center justify-between rounded-xl border px-4 py-3 text-sm font-medium transition-all duration-500 ease-smooth',
                  open ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0',
                  isActive
                    ? 'border-flare-200 bg-flare-50 text-flare-700'
                    : 'border-ink-900/[0.07] bg-white text-ink-700'
                )
              }
            >
              {item.label}
              <ArrowUpRight className='h-4 w-4 opacity-40' />
            </NavLink>
          ))}

          {/* 抽屉里同样以分隔线划出工具入口，与桌面端保持一致的心智模型 */}
          <div className='pt-2'>
            <div className='mb-2 h-px bg-ink-900/[0.07]' />
            <AdminEntryNav variant='mobile' />
          </div>
        </nav>
      </div>
    </header>
  );
}

export default SiteHeader;
