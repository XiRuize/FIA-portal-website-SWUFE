/**
 * 账号管理面板（仅管理权限账号可见）。
 *
 * 对应需求的两种角色：
 * - **管理权限**：社团成员共用，可进管理后台、管内容、管账号；
 * - **临时浏览权限**：给新进成员与外部合作者，**到期自动作废**。
 *
 * 界面上刻意把「有效期」做成显式字段：临时账号必须带到期时间，
 * 因为「过期作废」是这套权限体系里最容易事后扯皮的一条，写清楚比事后解释便宜。
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Ban,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserPlus,
  X,
} from 'lucide-react';
import {
  accountsApi,
  ApiError,
  type Account,
  type CreateAccountInput,
  type Role,
} from '@/lib/backendApi';
import { useAuth } from '@/lib/auth';
import { AdminButton, Field, Modal, Panel, SelectInput, TextInput } from '@/components/admin/AdminUI';

/** 生成一个足够强的随机口令（前端生成，只显示一次） */
function suggestPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const all = upper + lower + digits + '!@#$%^&*';
  const pick = (set: string) => set[Math.floor(Math.random() * set.length)];
  // 保证四类字符各至少一个，再补足长度，避免生成的口令被强度校验拒绝
  const base = [pick(upper), pick(lower), pick(digits), pick('!@#$%^&*')];
  while (base.length < 14) base.push(pick(all));
  // Fisher-Yates 洗牌，避免「前四位固定字符类别」的可预测模式
  for (let i = base.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [base[i], base[j]] = [base[j], base[i]];
  }
  return base.join('');
}

/** 默认到期时间：30 天后 */
function defaultExpiry(days = 30): string {
  const d = new Date(Date.now() + days * 86_400_000);
  // datetime-local 需要 `YYYY-MM-DDTHH:mm`，且必须是本地时间而非 UTC
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

/** 把剩余时间说成人话 */
function expiryText(acc: Account): { text: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  if (acc.revokedAt) return { text: '已吊销', tone: 'bad' };
  if (acc.role === 'admin') {
    return acc.expiresAt
      ? { text: `至 ${acc.expiresAt.slice(0, 10)}`, tone: 'ok' }
      : { text: '长期有效', tone: 'muted' };
  }
  if (!acc.expiresAt) return { text: '未设到期', tone: 'warn' };
  const ms = new Date(acc.expiresAt).getTime() - Date.now();
  if (ms <= 0) return { text: '已过期', tone: 'bad' };
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days >= 1) {
    return { text: `剩余 ${days} 天`, tone: days <= 7 ? 'warn' : 'ok' };
  }
  return { text: `剩余 ${hours} 小时`, tone: 'warn' };
}

const TONE_CLASS: Record<string, string> = {
  ok: 'border-brand-200 bg-brand-50 text-brand-700',
  warn: 'border-gold-200 bg-gold-50 text-gold-700',
  bad: 'border-flare-200 bg-flare-50 text-flare-700',
  muted: 'border-ink-900/10 bg-ink-50 text-ink-500',
};

export function AccountManager() {
  const { account: me } = useAuth();
  const [list, setList] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await accountsApi.list();
      setList(res.accounts);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (acc: Account) => {
    const ok = window.confirm(
      `确定要吊销账号「${acc.username}」吗？\n\n` +
        '· 吊销后该账号立即无法登录；\n' +
        '· 其所有已登录会话会同时失效；\n' +
        '· 此操作不可撤销（如需恢复请重新创建账号）。'
    );
    if (!ok) return;
    setBusyId(acc.id);
    try {
      await accountsApi.revoke(acc.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const activeCount = list.filter((a) => a.active).length;

  return (
    <Panel
      title='账号管理'
      description='管理权限账号供社团成员共用；临时浏览账号到期自动作废，适合新进成员与外部合作者。'
      action={
        <div className='flex items-center gap-2'>
          <span className='num rounded-md border border-ink-900/10 bg-ink-50 px-2 py-1 text-[11px] text-ink-500'>
            {activeCount} 个有效 / 共 {list.length} 个
          </span>
          <AdminButton variant='outline' onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            刷新
          </AdminButton>
          <AdminButton onClick={() => setCreating(true)}>
            <UserPlus className='h-3.5 w-3.5' />
            新建账号
          </AdminButton>
        </div>
      }
    >
      {error ? (
        <div className='mb-4 flex items-start gap-2 rounded-lg border border-flare-200 bg-flare-50 p-3'>
          <AlertTriangle className='mt-0.5 h-4 w-4 shrink-0 text-flare-600' />
          <p className='text-xs leading-relaxed text-flare-700'>{error}</p>
        </div>
      ) : null}

      {loading && list.length === 0 ? (
        <div className='flex items-center gap-2 py-10 text-sm text-ink-400'>
          <Loader2 className='h-4 w-4 animate-spin' />
          正在加载账号列表…
        </div>
      ) : list.length === 0 ? (
        <p className='rounded-xl border border-dashed border-ink-900/12 px-6 py-10 text-center text-sm text-ink-400'>
          暂无账号。
        </p>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full text-left text-sm'>
            <thead>
              <tr className='border-b border-ink-900/10 text-xs text-ink-400'>
                <th className='pb-2.5 pr-4 font-medium'>账号</th>
                <th className='pb-2.5 pr-4 font-medium'>角色</th>
                <th className='pb-2.5 pr-4 font-medium'>有效期</th>
                <th className='pb-2.5 pr-4 font-medium'>状态</th>
                <th className='pb-2.5 pr-4 font-medium'>备注</th>
                <th className='pb-2.5 text-right font-medium'>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((acc) => {
                const exp = expiryText(acc);
                const isMe = me?.id === acc.id;
                return (
                  <tr key={acc.id} className='border-b border-ink-900/[0.06] last:border-0'>
                    <td className='py-3 pr-4'>
                      <div className='font-medium text-ink-900'>{acc.displayName || acc.username}</div>
                      <div className='num text-[11px] text-ink-400'>@{acc.username}</div>
                    </td>
                    <td className='py-3 pr-4'>
                      <span
                        className={`num inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] ${
                          acc.role === 'admin'
                            ? 'border-brand-200 bg-brand-50 text-brand-700'
                            : 'border-gold-200 bg-gold-50 text-gold-700'
                        }`}
                      >
                        {acc.role === 'admin' ? (
                          <ShieldCheck className='h-3 w-3' />
                        ) : (
                          <KeyRound className='h-3 w-3' />
                        )}
                        {acc.role === 'admin' ? '管理权限' : '临时浏览'}
                      </span>
                    </td>
                    <td className='py-3 pr-4'>
                      <span className={`num rounded-md border px-2 py-1 text-[11px] ${TONE_CLASS[exp.tone]}`}>
                        {exp.text}
                      </span>
                    </td>
                    <td className='py-3 pr-4'>
                      {acc.active ? (
                        <span className='inline-flex items-center gap-1 text-xs text-brand-600'>
                          <Check className='h-3.5 w-3.5' />
                          可用
                        </span>
                      ) : (
                        <span className='inline-flex items-center gap-1 text-xs text-flare-600'>
                          <X className='h-3.5 w-3.5' />
                          {acc.revokedAt ? '已吊销' : '已过期'}
                        </span>
                      )}
                    </td>
                    <td className='max-w-[16rem] py-3 pr-4 text-xs text-ink-500'>
                      {acc.note || '—'}
                    </td>
                    <td className='py-3 text-right'>
                      {acc.active ? (
                        <AdminButton
                          variant='ghost'
                          onClick={() => void revoke(acc)}
                          disabled={busyId === acc.id || isMe}
                          title={isMe ? '不能吊销当前登录的账号' : '吊销该账号'}
                        >
                          {busyId === acc.id ? (
                            <Loader2 className='h-3.5 w-3.5 animate-spin' />
                          ) : (
                            <Ban className='h-3.5 w-3.5' />
                          )}
                          {isMe ? '当前账号' : '吊销'}
                        </AdminButton>
                      ) : (
                        <span className='text-xs text-ink-300'>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <CreateAccountModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          void load();
        }}
      />
    </Panel>
  );
}

/** 新建账号弹窗 */
function CreateAccountModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState<CreateAccountInput>({
    username: '',
    password: suggestPassword(),
    role: 'viewer',
    displayName: '',
    note: '',
    expiresAt: defaultExpiry(30),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 创建成功后的凭据回执，只展示一次 */
  const [issued, setIssued] = useState<{ username: string; password: string; role: Role } | null>(null);
  const [copied, setCopied] = useState(false);

  const isViewer = form.role === 'viewer';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      // datetime-local 给的是本地时间字符串，转成 ISO 再发，
      // 否则后端按 UTC 解析会差几个时区，临时账号的到期时刻就不对了。
      const payload: CreateAccountInput = {
        username: form.username.trim(),
        password: form.password,
        role: form.role,
        displayName: form.displayName?.trim() || undefined,
        note: form.note?.trim() || undefined,
      };
      if (isViewer && form.expiresAt) {
        payload.expiresAt = new Date(form.expiresAt).toISOString();
      }
      await accountsApi.create(payload);
      setIssued({ username: payload.username, password: payload.password, role: payload.role });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // 创建成功后的凭据回执页：口令只在这一刻可见，之后无法再取回
  if (issued) {
    const text = `账号：${issued.username}\n口令：${issued.password}\n角色：${
      issued.role === 'admin' ? '管理权限' : '临时浏览权限'
    }`;
    return (
      <Modal open={open} title='账号创建成功' onClose={onCreated}>
        <div className='rounded-lg border border-gold-200 bg-gold-50 p-3'>
          <p className='text-xs leading-relaxed text-gold-800'>
            <strong>请立即复制并转交给使用者。</strong>
            出于安全考虑，服务端只保存口令的哈希值，此口令<strong>关闭后无法再次查看</strong>，
            遗失只能重新设置。
          </p>
        </div>

        <div className='mt-4 space-y-2 rounded-lg border border-ink-900/10 bg-ink-50 p-4'>
          <div className='flex items-center justify-between gap-3'>
            <span className='text-xs text-ink-500'>账号</span>
            <span className='num text-sm font-medium text-ink-900'>{issued.username}</span>
          </div>
          <div className='flex items-center justify-between gap-3'>
            <span className='text-xs text-ink-500'>口令</span>
            <span className='num select-all text-sm font-medium text-ink-900'>{issued.password}</span>
          </div>
          <div className='flex items-center justify-between gap-3'>
            <span className='text-xs text-ink-500'>角色</span>
            <span className='text-sm font-medium text-ink-900'>
              {issued.role === 'admin' ? '管理权限' : '临时浏览权限'}
            </span>
          </div>
        </div>

        <div className='mt-5 flex items-center gap-2'>
          <AdminButton
            onClick={() => {
              void navigator.clipboard?.writeText(text).then(
                () => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                },
                () => setCopied(false)
              );
            }}
          >
            {copied ? <Check className='h-3.5 w-3.5' /> : <Copy className='h-3.5 w-3.5' />}
            {copied ? '已复制' : '复制凭据'}
          </AdminButton>
          <AdminButton variant='outline' onClick={onCreated}>
            完成
          </AdminButton>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} title='新建账号' onClose={onClose}>
      <form onSubmit={submit} className='space-y-4'>
        <Field label='账号' hint='建议使用英文与数字，长度 3 位以上'>
          <TextInput
            value={form.username}
            onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
            placeholder='例如：member2026'
            autoComplete='off'
            spellCheck={false}
          />
        </Field>

        <Field label='口令' hint='至少 8 位，需包含字母与数字；可点击右侧重新生成'>
          <div className='flex items-center gap-2'>
            <TextInput
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              autoComplete='new-password'
              spellCheck={false}
            />
            <AdminButton
              type='button'
              variant='outline'
              onClick={() => setForm((f) => ({ ...f, password: suggestPassword() }))}
            >
              <RefreshCw className='h-3.5 w-3.5' />
              重新生成
            </AdminButton>
          </div>
        </Field>

        <Field label='角色' hint='管理权限可进入后台并管理账号；临时浏览权限到期自动作废'>
          <SelectInput
            value={form.role}
            onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as Role }))}
          >
            <option value='viewer'>临时浏览权限</option>
            <option value='admin'>管理权限</option>
          </SelectInput>
        </Field>

        {isViewer ? (
          <Field label='到期时间' hint='到期后该账号自动失效，无需手动清理'>
            <input
              type='datetime-local'
              value={form.expiresAt ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))}
              className='h-10 w-full rounded-md border border-ink-900/12 bg-white px-3 text-sm text-ink-900 outline-none transition-colors focus:border-brand-400'
            />
          </Field>
        ) : (
          <div className='flex items-start gap-2 rounded-lg border border-brand-200 bg-brand-50 p-3'>
            <ShieldCheck className='mt-0.5 h-4 w-4 shrink-0 text-brand-600' />
            <p className='text-xs leading-relaxed text-brand-700'>
              管理权限账号默认长期有效。请仅在确有必要时创建，并妥善保管口令。
            </p>
          </div>
        )}

        <Field label='显示名称' hint='选填，用于后台识别使用者'>
          <TextInput
            value={form.displayName ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
            placeholder='例如：外联部 · 张三'
          />
        </Field>

        <Field label='备注' hint='选填，例如开通原因、对接人'>
          <TextInput
            value={form.note ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            placeholder='例如：合作单位数据组，用于查阅公开资料'
          />
        </Field>

        {error ? (
          <div className='flex items-start gap-2 rounded-lg border border-flare-200 bg-flare-50 p-3'>
            <AlertTriangle className='mt-0.5 h-4 w-4 shrink-0 text-flare-600' />
            <p className='text-xs leading-relaxed text-flare-700'>{error}</p>
          </div>
        ) : null}

        <div className='flex items-center gap-2 pt-1'>
          <AdminButton type='submit' disabled={busy || !form.username.trim() || !form.password}>
            {busy ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : <Plus className='h-3.5 w-3.5' />}
            {busy ? '创建中…' : '创建账号'}
          </AdminButton>
          <AdminButton type='button' variant='ghost' onClick={onClose}>
            取消
          </AdminButton>
        </div>
      </form>
    </Modal>
  );
}

export default AccountManager;
