/**
 * 登录页。
 *
 * 与旧版「管理口令」弹窗的本质区别：
 * - 旧版把口令写在公开配置里，前端比对字符串，`sessionStorage` 一个标记就算登录了。
 *   任何人打开开发者工具就能拿到口令，也能手动写标记绕过。
 * - 新版走真实的后端会话：口令永不下发，会话是 httpOnly Cookie，
 *   JS 既读不到也改不了。登录成功与否只由后端判定。
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  KeyRound,
  Loader2,
  LogOut,
  Mail,
  User,
} from 'lucide-react';
import {
  useAuth,
  roleLabel,
  CAP_VIEW_RESTRICTED,
  ACCESS_REQUEST_EMAIL,
  PRODUCTIONS_ACCESS_NOTICE,
} from '@/lib/auth';
import { ApiError } from '@/lib/backendApi';
import PageHero from '@/components/site/PageHero';

/** 把后端错误码翻译成对用户有意义的说明 */
function explain(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'INVALID_CREDENTIALS':
        // 后端刻意不区分「账号不存在」与「口令错误」，此处保持一致，避免撞库探测
        return '账号或口令不正确，请重新输入。';
      case 'ACCOUNT_EXPIRED':
        return '该临时浏览账号已到期。请联系协会负责人重新开通。';
      case 'ACCOUNT_REVOKED':
        return '该账号已被吊销，请联系协会负责人。';
      case 'TOO_MANY_ATTEMPTS':
        return '尝试次数过多，账号已被临时锁定，请稍后再试。';
      case 'NETWORK_ERROR':
        return '无法连接后端服务。请确认后端已启动（server/ 目录执行 npm start）。';
      case 'TIMEOUT':
        return '请求超时，请检查网络后重试。';
      default:
        return err.message || '登录失败，请稍后重试。';
    }
  }
  return err instanceof Error ? err.message : '登录失败，请稍后重试。';
}

export function Login() {
  const { login, logout, authenticated, account, role, capabilities, refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  /** 登录后回到原本想去的页面 */
  const next = params.get('next') || '/';

  /**
   * 是否从「社团成员产出」入口过来的。
   * 该入口对访客可见，点击后落到这里，必须显式说明「仅限有权限账号 + 如何申请」，
   * 而不是让访客面对一个没有上下文的登录框。
   */
  const fromProductions = next.startsWith('/productions');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const usernameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    usernameRef.current?.focus();
  }, []);

  // 已登录时不展示表单，直接给出「继续前往」的入口，避免重复登录的困惑
  if (authenticated) {
    return (
      <div>
        <PageHero
          kicker='signed in'
          title='你已登录'
          description='当前账号可以继续访问受保护页面，或切换其他账号。'
        />
        <section className='mx-auto max-w-md px-4 py-14 sm:px-6'>
          <div className='rounded-2xl border border-ink-900/10 bg-white p-6 shadow-card'>
            <div className='flex items-center gap-3'>
              <div className='flex h-10 w-10 items-center justify-center rounded-full bg-brand-50'>
                <User className='h-4 w-4 text-brand-600' />
              </div>
              <div className='min-w-0'>
                <p className='truncate text-sm font-medium text-ink-900'>
                  {account?.displayName || account?.username}
                </p>
                <p className='num text-[11px] text-ink-400'>
                  {roleLabel(role)}
                  {account?.expiresAt ? ` · 有效期至 ${account.expiresAt.slice(0, 10)}` : ''}
                </p>
              </div>
            </div>

            <div className='mt-6 flex flex-col gap-2.5'>
              <button
                onClick={() => navigate(next)}
                className='flex items-center justify-center gap-2 rounded-lg bg-brand-700 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-800'
              >
                {fromProductions ? '进入社团成员产出' : '继续前往'}
                <ArrowRight className='h-4 w-4' />
              </button>
              <button
                onClick={() => {
                  void logout().then(() => {
                    setUsername('');
                    setPassword('');
                  });
                }}
                className='flex items-center justify-center gap-2 rounded-lg border border-ink-900/12 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50'
              >
                <LogOut className='h-4 w-4' />
                切换其他账号
              </button>
            </div>

            {/*
              已登录但当前账号不具备受限浏览权限时，「继续前往」会把人送进守卫的
              「无权访问」页 —— 提前在这里说明，比让对方撞一次墙更好。
            */}
            {fromProductions && !capabilities.includes(CAP_VIEW_RESTRICTED) ? (
              <div className='mt-5 flex items-start gap-2.5 rounded-xl border border-flare-200 bg-flare-50 p-3.5'>
                <Mail className='mt-0.5 h-4 w-4 shrink-0 text-flare-600' />
                <p className='text-xs leading-relaxed text-flare-700'>{PRODUCTIONS_ACCESS_NOTICE}</p>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await login(username.trim(), password);
      // 登录后重新确认一次身份，再跳转，避免守卫读到旧的访客态
      await refresh();
      navigate(next, { replace: true });
    } catch (err) {
      setError(explain(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHero
        kicker='member access'
        title='社团成员产出 · 成员登录'
        description='协会内部资料与社团成员产出仅对持有权限账号的成员开放，请使用协会发放的账号登录。'
      />

      <section className='mx-auto max-w-md px-4 py-12 sm:px-6 sm:py-16'>
        {/*
          准入提示：只有当访客是从「社团成员产出」入口点进来时才出现。
          放在表单**之前**——申请权限这件事必须在看到输入框之前就交代清楚，
          否则访客会先尝试乱猜账号，再看到提示时已经浪费了一次失败计数。
        */}
        {fromProductions ? (
          <div className='mb-5 rounded-2xl border border-flare-200 bg-flare-50 p-4 sm:p-5'>
            <div className='flex items-start gap-3'>
              <div className='flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white'>
                <Mail className='h-4 w-4 text-flare-600' />
              </div>
              <div className='min-w-0'>
                <h2 className='text-sm font-semibold text-flare-800'>访问受限</h2>
                <p className='mt-1.5 text-xs leading-relaxed text-flare-700'>
                  {PRODUCTIONS_ACCESS_NOTICE}
                </p>
                <a
                  href={`mailto:${ACCESS_REQUEST_EMAIL}`}
                  className='num mt-3 inline-flex items-center gap-1.5 rounded-lg border border-flare-300 bg-white px-3 py-1.5 text-[11px] font-medium text-flare-700 transition-colors hover:bg-flare-100'
                >
                  <Mail className='h-3 w-3' />
                  {ACCESS_REQUEST_EMAIL}
                </a>
              </div>
            </div>
          </div>
        ) : null}

        <form
          onSubmit={submit}
          className='rounded-2xl border border-ink-900/10 bg-white p-6 shadow-card sm:p-8'
        >
          <div className='flex items-center gap-3'>
            <div className='flex h-10 w-10 items-center justify-center rounded-full bg-brand-50'>
              <KeyRound className='h-4 w-4 text-brand-600' />
            </div>
            <div>
              <h2 className='text-base font-semibold text-ink-900'>账号登录</h2>
              <p className='text-xs text-ink-400'>会话由服务端签发，口令不会保存在浏览器</p>
            </div>
          </div>

          <div className='mt-7 space-y-4'>
            <label className='block'>
              <span className='mb-1.5 block text-xs font-medium text-ink-600'>账号</span>
              <input
                ref={usernameRef}
                type='text'
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete='username'
                autoCapitalize='off'
                spellCheck={false}
                placeholder='请输入账号'
                className='h-10 w-full rounded-lg border border-ink-900/12 bg-white px-3 text-sm text-ink-900 outline-none transition-colors placeholder:text-ink-300 focus:border-brand-400'
              />
            </label>

            <label className='block'>
              <span className='mb-1.5 block text-xs font-medium text-ink-600'>口令</span>
              <input
                type='password'
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete='current-password'
                placeholder='请输入口令'
                className='h-10 w-full rounded-lg border border-ink-900/12 bg-white px-3 text-sm text-ink-900 outline-none transition-colors placeholder:text-ink-300 focus:border-brand-400'
              />
            </label>
          </div>

          {error ? (
            <div className='mt-5 flex items-start gap-2 rounded-lg border border-flare-200 bg-flare-50 p-3'>
              <AlertTriangle className='mt-0.5 h-4 w-4 shrink-0 text-flare-600' />
              <p className='text-xs leading-relaxed text-flare-700'>{error}</p>
            </div>
          ) : null}

          <button
            type='submit'
            disabled={busy || !username.trim() || !password}
            className='mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-700 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-50'
          >
            {busy ? <Loader2 className='h-4 w-4 animate-spin' /> : null}
            {busy ? '正在验证…' : '登录'}
          </button>

          <p className='mt-5 text-center text-xs leading-relaxed text-ink-400'>
            忘记口令或需要开通/申请权限？请联系协会负责人
            <a
              href={`mailto:${ACCESS_REQUEST_EMAIL}`}
              className='num ml-1 text-brand-600 hover:underline'
            >
              {ACCESS_REQUEST_EMAIL}
            </a>
            <br />
            <Link to='/' className='text-brand-600 hover:underline'>
              返回首页
            </Link>
          </p>
        </form>
      </section>
    </div>
  );
}

export default Login;
