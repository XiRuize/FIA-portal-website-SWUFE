/**
 * 「账号管理」子栏目。
 *
 * 三块，对应需求里的三条：
 * 1. **临时权限申请**：显示申请人提交的手机号 → 批准后手机号即账号，弹出口令与短信文案
 * 2. **已运行的临时账号**：账号 + 剩余权限时长（过期红字）+ 一键重置权限 / 延长 / 吊销
 * 3. **通知发件箱**：短信文案已生成，转发后标记已发送（零第三方依赖，未接短信网关）
 *
 * 权限：整个面板由路由层的 `RequireAuth` 拦在 `canManageAccounts` 之后，
 * 后端每个端点也重新判定一次 —— 前端守卫只是体验层，真隔离在服务端。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  BellRing,
  Check,
  Clock,
  Copy,
  KeyRound,
  Phone,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserPlus,
  X,
} from 'lucide-react';
import {
  accountsApi,
  adminAccessApi,
  type AccessRequestAdmin,
  type Account,
  type CreateAccountInput,
  type NotificationItem,
  type NotificationSummary,
  type RequestSummary,
} from '@/lib/backendApi';
import {
  AdminButton,
  Field,
  Modal,
  Panel,
  SelectInput,
  TextArea,
  TextInput,
} from '@/components/admin/AdminUI';
import { cn } from '@/lib/utils';

export default function AccountManager() {
  return (
    <div className='space-y-6'>
      <RequestQueue />
      <TempAccounts />
      <NotificationOutbox />
      <CreateAccount />
    </div>
  );
}

/* ───────────────────────── 1. 申请队列 ───────────────────────── */

function RequestQueue() {
  const [requests, setRequests] = useState<AccessRequestAdmin[]>([]);
  const [summary, setSummary] = useState<RequestSummary | null>(null);
  const [defaultDays, setDefaultDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 批准后的凭据回执。口令明文只出现这一次，必须让管理员看到 */
  const [receipt, setReceipt] = useState<{
    username: string;
    password: string;
    reused: boolean;
    body: string;
    phone: string;
  } | null>(null);
  const [approving, setApproving] = useState<AccessRequestAdmin | null>(null);
  const [approveDays, setApproveDays] = useState(30);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminAccessApi.listRequests();
      setRequests(res.requests);
      setSummary(res.summary);
      setDefaultDays(res.defaultDays);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = useMemo(() => requests.filter((r) => r.status === 'pending'), [requests]);

  const doApprove = useCallback(
    async (request: AccessRequestAdmin, days: number) => {
      try {
        const res = await adminAccessApi.approve(request.id, { days });
        setReceipt({
          username: res.account.username,
          password: res.issuedPassword,
          reused: res.reused,
          body: res.notification.body,
          phone: request.phone,
        });
        setApproving(null);
        await load();
      } catch (e) {
        window.alert(e instanceof Error ? e.message : '批准失败');
      }
    },
    [load]
  );

  const doReject = useCallback(
    async (request: AccessRequestAdmin) => {
      const note = window.prompt('驳回理由（可选，申请人看不到，仅供内部记录）：', '');
      if (note === null) return; // 用户取消
      try {
        await adminAccessApi.reject(request.id, note);
        await load();
      } catch (e) {
        window.alert(e instanceof Error ? e.message : '驳回失败');
      }
    },
    [load]
  );

  return (
    <>
      <Panel
        title='临时权限申请'
        description='申请人在登录页提交手机号；批准后该手机号即账号，系统生成 6 位随机口令。'
        action={
          <div className='flex items-center gap-2'>
            <span
              className={cn(
                'num rounded-md px-2.5 py-1.5 text-[11px] font-medium',
                (summary?.pending ?? 0) > 0
                  ? 'bg-amber-50 text-amber-800'
                  : 'bg-gray-50 text-gray-500'
              )}
            >
              待审批 {summary?.pending ?? 0}
            </span>
            <AdminButton variant='outline' onClick={() => void load()} disabled={loading}>
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              刷新
            </AdminButton>
          </div>
        }
      >
        {error ? (
          <ErrorBox message={error} />
        ) : pending.length === 0 ? (
          <p className='py-6 text-center text-sm text-gray-400'>
            暂无待审批的申请。申请人在登录页点「申请临时权限与账号」提交后，会出现在这里。
          </p>
        ) : (
          <div className='overflow-x-auto'>
            <table className='w-full min-w-[760px] text-sm'>
              <thead>
                <tr className='border-b border-gray-100 text-left text-xs text-gray-400'>
                  <th className='pb-2 pr-4 font-medium'>手机号</th>
                  <th className='pb-2 pr-4 font-medium'>姓名 / 单位</th>
                  <th className='pb-2 pr-4 font-medium'>申请用途</th>
                  <th className='pb-2 pr-4 font-medium'>提交时间</th>
                  <th className='pb-2 font-medium'>操作</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((r) => (
                  <tr key={r.id} className='border-b border-gray-50 last:border-0'>
                    <td className='py-3 pr-4'>
                      <span className='num inline-flex items-center gap-1.5 font-medium text-gray-800'>
                        <Phone className='h-3.5 w-3.5 text-gray-400' />
                        {r.phone}
                      </span>
                    </td>
                    <td className='py-3 pr-4 text-xs text-gray-500'>
                      {r.name || '—'}
                      {r.org ? <span className='block text-gray-400'>{r.org}</span> : null}
                    </td>
                    <td className='max-w-[220px] py-3 pr-4 text-xs text-gray-500'>
                      <span className='line-clamp-2'>{r.reason || '—'}</span>
                    </td>
                    <td className='num py-3 pr-4 text-xs text-gray-400'>
                      {formatDateTime(r.createdAt)}
                    </td>
                    <td className='py-3'>
                      <div className='flex items-center gap-1.5'>
                        <AdminButton
                          onClick={() => {
                            setApproving(r);
                            setApproveDays(defaultDays);
                          }}
                        >
                          <Check className='h-3.5 w-3.5' />
                          批准
                        </AdminButton>
                        <AdminButton variant='ghost' onClick={() => void doReject(r)}>
                          <X className='h-3.5 w-3.5' />
                          驳回
                        </AdminButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {summary && summary.total > pending.length ? (
          <p className='mt-3 text-xs text-gray-400'>
            另有 {summary.approved} 条已批准、{summary.rejected} 条已驳回（累计 {summary.total}{' '}
            条）。
          </p>
        ) : null}
      </Panel>

      {/* 批准确认：选有效期 */}
      <Modal
        open={approving !== null}
        title='批准临时权限申请'
        onClose={() => setApproving(null)}
        footer={
          <>
            <AdminButton variant='outline' onClick={() => setApproving(null)}>
              取消
            </AdminButton>
            <AdminButton onClick={() => approving && void doApprove(approving, approveDays)}>
              <Check className='h-3.5 w-3.5' />
              确认批准
            </AdminButton>
          </>
        }
      >
        {approving ? (
          <div className='space-y-4'>
            <div className='rounded-lg border border-brand-100 bg-brand-50/60 p-3 text-sm'>
              <p className='text-xs text-gray-500'>将以以下手机号创建临时账号</p>
              <p className='num mt-1 text-base font-semibold text-brand-800'>
                {approving.phone}
              </p>
              {approving.name ? (
                <p className='mt-1 text-xs text-gray-500'>
                  申请人：{approving.name}
                  {approving.org ? ` · ${approving.org}` : ''}
                </p>
              ) : null}
            </div>

            <Field label='有效期（天）' hint='到期后账号自动失效，可在「数据」面板一键延长。'>
              <TextInput
                type='number'
                min={1}
                max={3650}
                value={approveDays}
                onChange={(e) => setApproveDays(Number(e.target.value) || 1)}
                className='w-40'
              />
            </Field>

            <div className='flex flex-wrap gap-2'>
              {[7, 30, 90, 365].map((d) => (
                <button
                  key={d}
                  type='button'
                  onClick={() => setApproveDays(d)}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-xs transition-colors',
                    approveDays === d
                      ? 'border-brand-300 bg-brand-50 text-brand-800'
                      : 'border-gray-200 text-gray-500 hover:border-brand-200'
                  )}
                >
                  {d} 天
                </button>
              ))}
            </div>

            <p className='text-xs text-gray-400'>
              批准后系统生成 6 位数字口令，并生成一条短信文案放入「通知发件箱」。
              口令只显示一次，请立刻转交申请人。
            </p>
          </div>
        ) : null}
      </Modal>

      {/* 凭据回执：口令只出现这一次 */}
      <Modal
        open={receipt !== null}
        title={receipt?.reused ? '权限已续期（该手机号已有账号）' : '权限已开通'}
        onClose={() => setReceipt(null)}
        footer={<AdminButton onClick={() => setReceipt(null)}>我已记录，关闭</AdminButton>}
        wide
      >
        {receipt ? (
          <div className='space-y-4'>
            <div className='flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800'>
              <AlertTriangle className='mt-0.5 h-4 w-4 shrink-0' />
              <p>
                口令明文<b>只显示这一次</b>，库中只保存哈希，关闭后无法再取回。
                {receipt.reused
                  ? '该手机号此前已有账号，本次走的是续期路径（重置口令 + 延长有效期）。'
                  : ''}
              </p>
            </div>

            <div className='grid gap-3 sm:grid-cols-2'>
              <CopyField label='账号（即手机号）' value={receipt.username} />
              <CopyField label='随机口令' value={receipt.password} mono strong />
            </div>

            <div>
              <p className='mb-1.5 text-xs font-medium text-gray-600'>
                短信文案（已存入通知发件箱，请复制发送给 {receipt.phone}）
              </p>
              <div className='relative'>
                <TextArea readOnly value={receipt.body} rows={3} className='bg-gray-50' />
                <CopyButton
                  text={receipt.body}
                  className='absolute right-2 top-2'
                  label='复制文案'
                />
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

/* ───────────────────────── 2. 临时账号 ───────────────────────── */

function TempAccounts() {
  const [viewers, setViewers] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  /** 重置后的新口令回执 */
  const [resetReceipt, setResetReceipt] = useState<{
    username: string;
    password: string;
    revokedSessions: number;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await accountsApi.list();
      setViewers(res.accounts.filter((a) => a.role === 'viewer'));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 每秒自增，驱动剩余时长倒计时重算
  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const reset = useCallback(
    async (account: Account) => {
      const ok = window.confirm(
        `重置「${account.username}」的权限？\n\n` +
          '· 将生成一个新的 6 位随机口令，旧口令立即失效；\n' +
          '· 该账号的全部已登录会话会被清空（拿到旧 Cookie 的人立刻掉线）。\n\n继续？'
      );
      if (!ok) return;
      setBusyId(account.id);
      try {
        const res = await accountsApi.reset(account.id);
        setResetReceipt({
          username: account.username,
          password: res.issuedPassword,
          revokedSessions: res.revokedSessions,
        });
        await load();
      } catch (e) {
        window.alert(e instanceof Error ? e.message : '重置失败');
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const extend = useCallback(
    async (account: Account, days: number) => {
      setBusyId(account.id);
      try {
        await accountsApi.extend(account.id, days);
        await load();
      } catch (e) {
        window.alert(e instanceof Error ? e.message : '延长失败');
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const revoke = useCallback(
    async (account: Account) => {
      const ok = window.confirm(
        `吊销「${account.username}」？\n\n吊销后该账号立即无法登录，且其会话全部失效。此操作不可撤销。`
      );
      if (!ok) return;
      setBusyId(account.id);
      try {
        await accountsApi.revoke(account.id);
        await load();
      } catch (e) {
        window.alert(e instanceof Error ? e.message : '吊销失败');
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  return (
    <>
      <Panel
        title='已运行的临时权限账号'
        description='按到期时间升序排列；已过期的以红字标示，可一键延长或重置权限。'
        action={
          <AdminButton variant='outline' onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            刷新
          </AdminButton>
        }
      >
        {error ? (
          <ErrorBox message={error} />
        ) : viewers.length === 0 ? (
          <p className='py-6 text-center text-sm text-gray-400'>暂无临时访客账号。</p>
        ) : (
          <div className='overflow-x-auto'>
            <table className='w-full min-w-[860px] text-sm'>
              <thead>
                <tr className='border-b border-gray-100 text-left text-xs text-gray-400'>
                  <th className='pb-2 pr-4 font-medium'>账号</th>
                  <th className='pb-2 pr-4 font-medium'>来源</th>
                  <th className='pb-2 pr-4 font-medium'>剩余权限时长</th>
                  <th className='pb-2 pr-4 font-medium'>到期时间</th>
                  <th className='pb-2 font-medium'>操作</th>
                </tr>
              </thead>
              <tbody>
                {viewers.map((a) => (
                  <tr key={a.id} className='border-b border-gray-50 last:border-0'>
                    <td className='py-3 pr-4'>
                      <span className='num font-medium text-gray-800'>{a.username}</span>
                      {a.displayName ? (
                        <span className='block text-xs text-gray-400'>{a.displayName}</span>
                      ) : null}
                    </td>
                    <td className='py-3 pr-4'>
                      <SourceTag source={a.source} />
                    </td>
                    <td className='py-3 pr-4'>
                      <RemainCell account={a} tick={tick} />
                    </td>
                    <td className='num py-3 pr-4 text-xs text-gray-400'>
                      {formatDateTime(a.expiresAt)}
                    </td>
                    <td className='py-3'>
                      <div className='flex flex-wrap items-center gap-1.5'>
                        <AdminButton
                          variant='outline'
                          onClick={() => void extend(a, 30)}
                          disabled={busyId === a.id}
                          title='在当前到期时间基础上追加 30 天'
                        >
                          <Clock className='h-3.5 w-3.5' />
                          延长权限
                        </AdminButton>
                        <AdminButton
                          variant='outline'
                          onClick={() => void reset(a)}
                          disabled={busyId === a.id}
                          title='生成新口令并清空该账号的全部会话'
                        >
                          <KeyRound className='h-3.5 w-3.5' />
                          重置权限
                        </AdminButton>
                        {!a.revokedAt ? (
                          <AdminButton
                            variant='ghost'
                            onClick={() => void revoke(a)}
                            disabled={busyId === a.id}
                            title='立即吊销（不可撤销）'
                          >
                            <Ban className='h-3.5 w-3.5' />
                            吊销
                          </AdminButton>
                        ) : (
                          <span className='rounded bg-gray-100 px-2 py-1 text-[10px] text-gray-500'>
                            已吊销
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Modal
        open={resetReceipt !== null}
        title='权限已重置'
        onClose={() => setResetReceipt(null)}
        footer={<AdminButton onClick={() => setResetReceipt(null)}>我已记录，关闭</AdminButton>}
      >
        {resetReceipt ? (
          <div className='space-y-4'>
            <div className='flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800'>
              <AlertTriangle className='mt-0.5 h-4 w-4 shrink-0' />
              <p>
                新口令<b>只显示这一次</b>。已清空该账号的 {resetReceipt.revokedSessions}{' '}
                个旧会话 —— 之前拿到 Cookie 的人已立即掉线。
              </p>
            </div>
            <div className='grid gap-3 sm:grid-cols-2'>
              <CopyField label='账号' value={resetReceipt.username} />
              <CopyField label='新口令' value={resetReceipt.password} mono strong />
            </div>
            <p className='text-xs text-gray-400'>
              请把新口令转交访客本人；旧口令立刻失效，无法找回。
            </p>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

/* ───────────────────────── 3. 通知发件箱 ───────────────────────── */

function NotificationOutbox() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [summary, setSummary] = useState<NotificationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminAccessApi.listNotifications();
      setItems(res.notifications);
      setSummary(res.summary);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const markSent = useCallback(
    async (id: number) => {
      setBusyId(id);
      try {
        await adminAccessApi.markNotificationSent(id);
        await load();
      } catch (e) {
        window.alert(e instanceof Error ? e.message : '操作失败');
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  return (
    <Panel
      title='通知发件箱'
      description='站点尚未接入短信网关，通知在此生成；请复制文案发送给申请人后标记为已发送。'
      action={
        <div className='flex items-center gap-2'>
          <span
            className={cn(
              'num rounded-md px-2.5 py-1.5 text-[11px] font-medium',
              (summary?.pending ?? 0) > 0
                ? 'bg-amber-50 text-amber-800'
                : 'bg-gray-50 text-gray-500'
            )}
          >
            待发送 {summary?.pending ?? 0}
          </span>
          <AdminButton variant='outline' onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            刷新
          </AdminButton>
        </div>
      }
    >
      {error ? (
        <ErrorBox message={error} />
      ) : items.length === 0 ? (
        <p className='py-6 text-center text-sm text-gray-400'>
          暂无通知记录。批准权限申请后，短信文案会自动出现在这里。
        </p>
      ) : (
        <ul className='divide-y divide-gray-50'>
          {items.map((n) => (
            <li key={n.id} className='py-3.5'>
              <div className='flex flex-wrap items-start justify-between gap-3'>
                <div className='min-w-0 flex-1'>
                  <div className='flex flex-wrap items-center gap-2'>
                    <span className='num inline-flex items-center gap-1.5 text-sm font-medium text-gray-800'>
                      <Phone className='h-3.5 w-3.5 text-gray-400' />
                      {n.to}
                    </span>
                    <StatusTag status={n.status} />
                    <span className='num text-xs text-gray-400'>
                      {formatDateTime(n.createdAt)}
                    </span>
                  </div>
                  <p className='mt-2 rounded-lg bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-600'>
                    {n.body}
                  </p>
                </div>
                <div className='flex shrink-0 items-center gap-1.5'>
                  <CopyButton text={n.body} label='复制' />
                  {n.status === 'pending' ? (
                    <AdminButton
                      variant='outline'
                      onClick={() => void markSent(n.id)}
                      disabled={busyId === n.id}
                    >
                      <BellRing className='h-3.5 w-3.5' />
                      标记已发送
                    </AdminButton>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ───────────────────────── 4. 手工建号（原有能力，保留） ───────────────────────── */

function suggestPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const all = upper + lower + digits + '!@#$%^&*';
  const pick = (s: string) => s[Math.floor(Math.random() * s.length)];
  let out = pick(upper) + pick(lower) + pick(digits);
  for (let i = 0; i < 9; i += 1) out += pick(all);
  return out;
}

const emptyForm = (): CreateAccountInput => ({
  username: '',
  password: '',
  role: 'viewer',
  displayName: '',
  note: '',
  expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
});

function CreateAccount() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CreateAccountInput>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ username: string; password: string } | null>(null);

  const submit = async () => {
    setBusy(true);
    try {
      const input: CreateAccountInput = { ...form };
      // viewer 必须带到期时间（后端强制），这里把日期转成 ISO 瞬间
      if (input.role === 'viewer' && input.expiresAt) {
        input.expiresAt = new Date(`${input.expiresAt}T23:59:59`).toISOString();
      }
      await accountsApi.create(input);
      setIssued({ username: input.username, password: input.password ?? '' });
      setOpen(false);
      setForm(emptyForm());
    } catch (e) {
      window.alert(e instanceof Error ? e.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Panel
        title='手工创建账号'
        description='适用于线下已知成员的场景；来自手机号申请的账号请用上方「批准」流程。'
        action={
          <AdminButton onClick={() => setOpen(true)}>
            <Plus className='h-3.5 w-3.5' />
            新建账号
          </AdminButton>
        }
      >
        <p className='text-xs text-gray-400'>
          临时浏览账号必须设置到期时间 —— 「过期自动作废」是这套权限体系的关键约束。
        </p>
      </Panel>

      <Modal
        open={open}
        title='新建账号'
        onClose={() => setOpen(false)}
        footer={
          <>
            <AdminButton variant='outline' onClick={() => setOpen(false)}>
              取消
            </AdminButton>
            <AdminButton onClick={() => void submit()} disabled={busy}>
              <UserPlus className='h-3.5 w-3.5' />
              创建
            </AdminButton>
          </>
        }
      >
        <div className='space-y-4'>
          <div className='grid gap-4 sm:grid-cols-2'>
            <Field label='账号' hint='3-32 位字母、数字、点、下划线或连字符'>
              <TextInput
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                placeholder='如 13800138000'
              />
            </Field>
            <Field label='角色'>
              <SelectInput
                value={form.role}
                onChange={(e) =>
                  setForm({ ...form, role: e.target.value as CreateAccountInput['role'] })
                }
              >
                <option value='viewer'>临时浏览权限（到期作废）</option>
                <option value='admin'>管理权限</option>
              </SelectInput>
            </Field>
          </div>

          <Field label='口令' hint='至少 8 位；留空则由浏览器生成一个强口令'>
            <div className='flex gap-2'>
              <TextInput
                value={form.password ?? ''}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder='至少 8 位'
              />
              <AdminButton
                variant='outline'
                onClick={() => setForm({ ...form, password: suggestPassword() })}
              >
                随机生成
              </AdminButton>
            </div>
          </Field>

          <div className='grid gap-4 sm:grid-cols-2'>
            <Field label='姓名 / 称呼'>
              <TextInput
                value={form.displayName ?? ''}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                placeholder='用于后台识别'
              />
            </Field>
            <Field label='到期时间' hint='仅临时浏览权限需要'>
              <TextInput
                type='date'
                value={form.expiresAt ?? ''}
                onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
                disabled={form.role === 'admin'}
              />
            </Field>
          </div>

          <Field label='备注'>
            <TextArea
              rows={2}
              value={form.note ?? ''}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder='如：应 XX 老师要求开通'
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={issued !== null}
        title='账号已创建'
        onClose={() => setIssued(null)}
        footer={<AdminButton onClick={() => setIssued(null)}>我已记录，关闭</AdminButton>}
      >
        {issued ? (
          <div className='space-y-4'>
            <div className='flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800'>
              <AlertTriangle className='mt-0.5 h-4 w-4 shrink-0' />
              <p>口令明文只显示这一次，请立刻转交本人。</p>
            </div>
            <CopyField label='账号' value={issued.username} />
            <CopyField label='口令' value={issued.password} mono strong />
          </div>
        ) : null}
      </Modal>
    </>
  );
}

/* ───────────────────────── 小组件 ───────────────────────── */

function RemainCell({ account, tick }: { account: Account; tick: number }) {
  void tick;
  if (account.revokedAt) {
    return (
      <span className='inline-flex items-center gap-1 text-xs font-medium text-gray-400'>
        <ShieldCheck className='h-3.5 w-3.5' />
        已吊销
      </span>
    );
  }
  if (!account.active) {
    return (
      <span className='inline-flex items-center gap-1 text-xs font-semibold text-red-600'>
        <Clock className='h-3.5 w-3.5' />
        已过期
      </span>
    );
  }
  return (
    <span className='num inline-flex items-center gap-1 text-xs font-medium text-emerald-700'>
      <Clock className='h-3.5 w-3.5' />
      {remainText(account.expiresAt)}
    </span>
  );
}

function SourceTag({ source }: { source?: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    application: { label: '手机号申请', cls: 'bg-brand-50 text-brand-700' },
    manual: { label: '手工创建', cls: 'bg-gray-100 text-gray-600' },
    seed: { label: '内置演示', cls: 'bg-gold-50 text-gold-700' },
  };
  const hit = source ? map[source] : null;
  return (
    <span
      className={cn(
        'rounded px-2 py-0.5 text-[10px] font-medium',
        hit?.cls ?? 'bg-gray-100 text-gray-500'
      )}
    >
      {hit?.label ?? source ?? '未知'}
    </span>
  );
}

function StatusTag({ status }: { status: 'pending' | 'sent' | 'failed' }) {
  const map = {
    pending: { label: '待发送', cls: 'bg-amber-50 text-amber-800' },
    sent: { label: '已发送', cls: 'bg-emerald-50 text-emerald-700' },
    failed: { label: '发送失败', cls: 'bg-red-50 text-red-700' },
  } as const;
  const hit = map[status];
  return (
    <span className={cn('rounded px-2 py-0.5 text-[10px] font-medium', hit.cls)}>
      {hit.label}
    </span>
  );
}

function CopyField({
  label,
  value,
  mono,
  strong,
}: {
  label: string;
  value: string;
  mono?: boolean;
  strong?: boolean;
}) {
  return (
    <div>
      <p className='mb-1 text-xs text-gray-500'>{label}</p>
      <div className='flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2'>
        <span
          className={cn(
            'num flex-1 select-all truncate',
            mono && 'font-mono',
            strong ? 'text-base font-semibold text-brand-800' : 'text-sm text-gray-800'
          )}
        >
          {value}
        </span>
        <CopyButton text={value} label='' />
      </div>
    </div>
  );
}

function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type='button'
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          window.setTimeout(() => setDone(false), 1600);
        } catch {
          // 剪贴板不可用（非安全上下文 / 权限被拒）时退到手工复制
          window.prompt('自动复制失败，请手动复制：', text);
        }
      }}
      className={cn(
        'inline-flex items-center gap-1 rounded border border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-500 transition-colors hover:border-brand-300 hover:text-brand-700',
        className
      )}
    >
      {done ? <Check className='h-3 w-3' /> : <Copy className='h-3 w-3' />}
      {label ? (done ? '已复制' : label) : null}
    </button>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className='flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700'>
      <AlertTriangle className='mt-0.5 h-4 w-4 shrink-0' />
      <div>
        <p className='font-medium'>加载失败</p>
        <p className='mt-1 text-xs'>{message}</p>
      </div>
    </div>
  );
}

/* ───────────────────────── 工具 ───────────────────────── */

function remainText(expiresAt: string | null): string {
  if (!expiresAt) return '长期有效';
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return '已过期';
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}
