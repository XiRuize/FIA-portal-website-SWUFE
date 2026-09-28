/**
 * 登录页。
 *
 * 与旧版「管理口令」弹窗的本质区别：
 * - 旧版把口令写在公开配置里，前端比对字符串，`sessionStorage` 一个标记就算登录了。
 *   任何人打开开发者工具就能拿到口令，也能手动写标记绕过。
 * - 新版走真实的后端会话：口令永不下发，会话是 httpOnly Cookie，
 *   JS 既读不到也改不了。登录成功与否只由后端判定。
 *
 * ## 两条路径
 *
 * 1. **已有账号** → 上方的登录表单；
 * 2. **没有账号** → 下方的「申请临时权限与账号」，填手机号提交，
 *    管理员批准后以手机号为账号名、随机 6 位口令建号，并把账号密码发到该手机号。
 *
 * 两条路径刻意放在同一页：访客点进受保护入口后，第一件想确认的事是
 * 「我能不能进去、进不去该找谁」，而不是「账号框要我填什么」。
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  KeyRound,
  Loader2,
  LogOut,
  Mail,
  Send,
  Smartphone,
  User,
} from 'lucide-react';
import {
  useAuth,
  roleLabel,
  CAP_VIEW_RESTRICTED,
  ACCESS_REQUEST_EMAIL,
  PRODUCTIONS_ACCESS_NOTICE,
} from '@/lib/auth';
import { ApiError, accessRequestApi } from '@/lib/backendApi';
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

/** 手机号形态与后端 `isValidPhone` 保持一致：大陆 11 位、`1[3-9]` 开头 */
const PHONE_RE = /^1[3-9]\d{9}$/;

/**
 * 申请临时权限与账号。
 *
 * 折叠在按钮后面而不是直接铺开：访客大多是**已有账号**来登录的，
 * 一上来就摊开四个输入框会让人怀疑自己走错了页面。想申请的人点一下即可展开。
 */
function AccessRequestPanel({ defaultOpen }: { defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [org, setOrg] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ message: string; phoneMasked: string } | null>(null);
  const phoneRef = useRef<HTMLInputElement>(null);

  // 从受保护入口跳过来的人更可能是「没有账号」的那一类，展开后直接聚焦手机号
  useEffect(() => {
    if (open && !done) phoneRef.current?.focus();
  }, [open, done]);

  const phoneOk = PHONE_RE.test(phone.trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!phoneOk) {
      setError('请填写有效的 11 位手机号（例：13800001111）');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await accessRequestApi.submit({
        phone: phone.trim(),
        name: name.trim() || undefined,
        org: org.trim() || undefined,
        reason: reason.trim() || undefined,
      });
      setDone({ message: res.message, phoneMasked: res.request.phoneMasked });
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className='mt-5 rounded-2xl border border-ink-900/10 bg-white p-5 shadow-card sm:p-6'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className='flex w-full items-center justify-between gap-3 text-left'
      >
        <span className='flex items-center gap-3'>
          <span className='flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-flare-50'>
            <Smartphone className='h-4 w-4 text-flare-600' />
          </span>
          <span className='min-w-0'>
            <span className='block text-sm font-semibold text-ink-900'>
              申请临时权限与账号
            </span>
            <span className='mt-0.5 block text-xs text-ink-400'>
              还没有账号？留一个手机号，管理员审批后短信通知账号与随机密码
            </span>
          </span>
        </span>
        <ChevronDown
          aria-hidden
          className={`h-4 w-4 shrink-0 text-ink-400 transition-transform duration-300 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open ? (
        done ? (
          /* 提交成功：不再展示表单，避免同一号码被反复提交（后端虽会去重，但没必要） */
          <div className='mt-5 rounded-xl border border-brand-200 bg-brand-50 p-4'>
            <div className='flex items-start gap-2.5'>
              <CheckCircle2 className='mt-0.5 h-4 w-4 shrink-0 text-brand-600' />
              <div className='min-w-0'>
                <p className='text-sm font-medium text-brand-800'>申请已提交</p>
                <p className='mt-1 text-xs leading-relaxed text-brand-700'>{done.message}</p>
                <p className='num mt-2 text-[11px] text-brand-600'>
                  申请号码：{done.phoneMasked}
                </p>
              </div>
            </div>
            <button
              type='button'
              onClick={() => {
                setDone(null);
                setPhone('');
                setName('');
                setOrg('');
                setReason('');
              }}
              className='mt-3 text-xs text-brand-700 underline underline-offset-2'
            >
              用另一个手机号再申请一次
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className='mt-5 space-y-4'>
            <label className='block'>
              <span className='mb-1.5 block text-xs font-medium text-ink-600'>
                手机号 <span className='text-flare-600'>*</span>
              </span>
              <input
                ref={phoneRef}
                type='tel'
                inputMode='numeric'
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
                autoComplete='tel'
                placeholder='11 位手机号，将作为你的登录账号'
                className='num h-10 w-full rounded-lg border border-ink-900/12 bg-white px-3 text-sm text-ink-900 outline-none transition-colors placeholder:text-ink-300 focus:border-brand-400'
              />
              {phone && !phoneOk ? (
                <span className='mt-1 block text-[11px] text-flare-600'>
                  手机号格式不正确，应为 1 开头的 11 位数字
                </span>
              ) : null}
            </label>

            <div className='grid gap-4 sm:grid-cols-2'>
              <label className='block'>
                <span className='mb-1.5 block text-xs font-medium text-ink-600'>姓名</span>
                <input
                  type='text'
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder='选填'
                  className='h-10 w-full rounded-lg border border-ink-900/12 bg-white px-3 text-sm text-ink-900 outline-none transition-colors placeholder:text-ink-300 focus:border-brand-400'
                />
              </label>
              <label className='block'>
                <span className='mb-1.5 block text-xs font-medium text-ink-600'>
                  学院 / 单位
                </span>
                <input
                  type='text'
                  value={org}
                  onChange={(e) => setOrg(e.target.value)}
                  placeholder='选填'
                  className='h-10 w-full rounded-lg border border-ink-900/12 bg-white px-3 text-sm text-ink-900 outline-none transition-colors placeholder:text-ink-300 focus:border-brand-400'
                />
              </label>
            </div>

            <label className='block'>
              <span className='mb-1.5 block text-xs font-medium text-ink-600'>申请用途</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder='选填。例如：参与协会具身智能专题研究，需要查阅研发部资料'
                className='w-full resize-y rounded-lg border border-ink-900/12 bg-white px-3 py-2 text-sm text-ink-900 outline-none transition-colors placeholder:text-ink-300 focus:border-brand-400'
              />
            </label>

            {error ? (
              <div className='flex items-start gap-2 rounded-lg border border-flare-200 bg-flare-50 p-3'>
                <AlertTriangle className='mt-0.5 h-4 w-4 shrink-0 text-flare-600' />
                <p className='text-xs leading-relaxed text-flare-700'>{error}</p>
              </div>
            ) : null}

            <button
              type='submit'
              disabled={busy || !phoneOk}
              className='flex w-full items-center justify-center gap-2 rounded-lg border border-flare-300 bg-flare-50 px-5 py-2.5 text-sm font-medium text-flare-700 transition-colors hover:bg-flare-100 disabled:cursor-not-allowed disabled:opacity-50'
            >
              {busy ? <Loader2 className='h-4 w-4 animate-spin' /> : <Send className='h-4 w-4' />}
              {busy ? '正在提交…' : '提交申请'}
            </button>

            <p className='text-[11px] leading-relaxed text-ink-400'>
              审批通过后，账号为您的手机号，随机密码由协会通过短信发送。
              提交即表示同意协会为开通权限之目的使用该手机号。
            </p>
          </form>
        )
      ) : null}
    </div>
  );
}

export function Login() {
  const { login, logout, authenticated, account, role, capabilities, refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  /** 登录后回到原本想去的页面 */
  const next = params.get('next') || '/';

  /**
   * 从哪个受保护入口过来的。两者要说的话不同：
   * - 「社团成员产出」是成员权益 → 讲怎么申请浏览权限；
   * - 「栏目与网站管理」是管理入口 → 讲必须用管理员账号，普通申请拿不到。
   *   这一条很重要：不区分的话，申请了临时账号的人会以为能进后台。
   */
  const fromProductions = next.startsWith('/productions');
  const fromAdmin = next.startsWith('/admin');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const usernameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    usernameRef.current?.focus();
  }, []);

  const hero = fromAdmin
    ? {
        kicker: 'site admin',
        title: '栏目与网站管理 · 管理员登录',
        description:
          '该入口仅对管理员账号开放，用于维护资料、审核临时权限申请与查看站点数据。',
      }
    : fromProductions
      ? {
          kicker: 'member access',
          title: '社团成员产出 · 成员登录',
          description:
            '协会内部资料与社团成员产出仅对持有权限账号的成员开放，请使用协会发放的账号登录。',
        }
      : {
          kicker: 'member access',
          title: '成员登录',
          description:
            '使用协会发放的账号登录后可访问受限资料与社团成员产出。没有账号可在下方申请。',
        };

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
                {fromAdmin
                  ? '进入栏目与网站管理'
                  : fromProductions
                    ? '进入社团成员产出'
                    : '继续前往'}
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
              已登录但当前账号不具备所需权限时，「继续前往」会把人送进守卫的
              「无权访问」页 —— 提前在这里说明，比让对方撞一次墙更好。
            */}
            {fromProductions && !capabilities.includes(CAP_VIEW_RESTRICTED) ? (
              <div className='mt-5 flex items-start gap-2.5 rounded-xl border border-flare-200 bg-flare-50 p-3.5'>
                <Mail className='mt-0.5 h-4 w-4 shrink-0 text-flare-600' />
                <p className='text-xs leading-relaxed text-flare-700'>{PRODUCTIONS_ACCESS_NOTICE}</p>
              </div>
            ) : null}

            {fromAdmin && !capabilities.includes('canManageContent') ? (
              <div className='mt-5 flex items-start gap-2.5 rounded-xl border border-flare-200 bg-flare-50 p-3.5'>
                <AlertTriangle className='mt-0.5 h-4 w-4 shrink-0 text-flare-600' />
                <p className='text-xs leading-relaxed text-flare-700'>
                  当前账号没有管理权限。临时浏览账号可以看到受限资料，但不能进入「栏目与网站管理」。
                  如需管理权限，请联系协会负责人开通管理员账号。
                </p>
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
      <PageHero kicker={hero.kicker} title={hero.title} description={hero.description} />

      <section className='mx-auto max-w-md px-4 py-12 sm:px-6 sm:py-16'>
        {/*
          准入提示：只有当访客是从受保护入口点进来时才出现。
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
                placeholder='账号或手机号'
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
        </form>

        {/*
          申请入口放在登录表单**之后**：先给「已有账号」的人一条最短路径，
          再给「没有账号」的人一条出口。顺序反过来会让前者每次都要先划过一段
          与自己无关的表单。
        */}
        <AccessRequestPanel defaultOpen={fromProductions || fromAdmin} />

        <p className='mt-6 text-center text-xs leading-relaxed text-ink-400'>
          忘记口令？请联系协会负责人
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
      </section>
    </div>
  );
}

export default Login;
