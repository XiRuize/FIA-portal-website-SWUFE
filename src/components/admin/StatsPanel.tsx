import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  Clock,
  Eye,
  RefreshCw,
  ShieldCheck,
  Users,
} from 'lucide-react';
import {
  adminStatsApi,
  accountsApi,
  type Account,
  type AdminStats,
} from '@/lib/backendApi';
import { AdminButton, AdminButton as Btn, Panel } from '@/components/admin/AdminUI';
import { cn } from '@/lib/utils';

/**
 * 「数据」子栏目。
 *
 * 一屏给站长四个问题的答案：
 * 1. 站点被看了多少（累计 / 今日 / 近 7 日 / 独立访客）
 * 2. 谁在看（当前存活的临时账号 + 剩余时长倒计时）
 * 3. 权限快到期的是谁（红字提示，一键延长）
 * 4. 申请与通知的处理积压（待批几条、待发几条）
 */
export default function StatsPanel() {
  const [data, setData] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  /** 服务端时间与本机时间的偏移（毫秒）。本机时钟不准时倒计时才不会说错话 */
  const [skewMs, setSkewMs] = useState(0);
  /** 每秒自增，只为驱动倒计时重算 */
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminStatsApi.get();
      setData(res);
      setSkewMs(new Date(res.serverTime).getTime() - Date.now());
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

  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  /** 一键延长权限 */
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

  const views = data?.views;
  const viewers = data?.accounts.viewers ?? [];

  /**
   * 存活访客账号：`active` 为真即未过期、未被吊销。
   * 排序交给后端（快过期的在前），前端不再排一次——两处排序是漂移源头。
   */
  const alive = useMemo(() => viewers.filter((a) => a.active), [viewers]);
  const dead = useMemo(
    () => viewers.filter((a) => !a.active && !a.revokedAt),
    [viewers]
  );

  return (
    <div className='space-y-6'>
      <div className='flex items-center justify-between'>
        <div>
          <h2 className='text-base font-semibold text-brand-900'>数据</h2>
          <p className='mt-1 text-xs text-gray-400'>
            站点浏览量与访客账号权限状态
            {views?.since ? ` · 数据自 ${views.since} 起累计` : ''}
          </p>
        </div>
        <AdminButton variant='outline' onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          刷新
        </AdminButton>
      </div>

      {error ? (
        <div className='flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700'>
          <AlertTriangle className='mt-0.5 h-5 w-5 shrink-0' />
          <div>
            <p className='font-medium'>数据加载失败</p>
            <p className='mt-1 text-xs'>{error}</p>
          </div>
        </div>
      ) : null}

      {/* ───────── 浏览量卡片组 ───────── */}
      <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
        <StatCard
          icon={<Eye className='h-4 w-4' />}
          label='网站累计浏览量'
          value={loading && !views ? '—' : fmt(views?.totalViews)}
          sub='人 × 页面 × 天'
          tone='brand'
        />
        <StatCard
          icon={<Activity className='h-4 w-4' />}
          label='今日浏览量'
          value={loading && !views ? '—' : fmt(views?.todayViews)}
          sub={`今日独立访客 ${fmt(views?.todayVisitors)}`}
          tone='flare'
        />
        <StatCard
          icon={<Users className='h-4 w-4' />}
          label='累计独立访客'
          value={loading && !views ? '—' : fmt(views?.uniqueVisitors)}
          sub={`近 7 日 ${fmt(views?.last7dVisitors)}（跨天去重）`}
          tone='gold'
        />
        <StatCard
          icon={<ShieldCheck className='h-4 w-4' />}
          label='存活访客账号'
          value={loading && !data ? '—' : String(alive.length)}
          sub={
            dead.length > 0 ? `另有 ${dead.length} 个已过期` : `累计开通 ${viewers.length} 个`
          }
          tone={dead.length > 0 ? 'danger' : 'brand'}
        />
      </div>

      {/* ───────── 近 14 日趋势 ───────── */}
      <Panel
        title='近 14 日访问趋势'
        description='柱高为当日浏览量，圆点为当日独立访客数。'
      >
        <TrendChart points={views?.daily ?? []} />
      </Panel>

      {/* ───────── 存活访客账号 ───────── */}
      <Panel
        title='存活访客账号'
        description='按到期时间升序排列，剩余时间每秒刷新；已过期的可用「延长权限」直接续期。'
      >
        {alive.length === 0 && dead.length === 0 ? (
          <p className='py-6 text-center text-sm text-gray-400'>
            还没有临时访客账号。可在「账号管理」批准手机号申请，或手工创建。
          </p>
        ) : (
          <div className='overflow-x-auto'>
            <table className='w-full min-w-[720px] text-sm'>
              <thead>
                <tr className='border-b border-gray-100 text-left text-xs text-gray-400'>
                  <th className='pb-2 pr-4 font-medium'>账号</th>
                  <th className='pb-2 pr-4 font-medium'>姓名 / 备注</th>
                  <th className='pb-2 pr-4 font-medium'>剩余权限时长</th>
                  <th className='pb-2 pr-4 font-medium'>到期时间</th>
                  <th className='pb-2 font-medium'>操作</th>
                </tr>
              </thead>
              <tbody>
                {[...alive, ...dead].map((a) => (
                  <AccountRow
                    key={a.id}
                    account={a}
                    skewMs={skewMs}
                    tick={tick}
                    busy={busyId === a.id}
                    onExtend={extend}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* ───────── 热门页面 ───────── */}
      <Panel
        title='热门页面'
        description='按累计浏览量排序，反映访客最常停留的栏目。'
      >
        {(views?.topPaths?.length ?? 0) === 0 ? (
          <p className='py-6 text-center text-sm text-gray-400'>暂无访问记录。</p>
        ) : (
          <ul className='divide-y divide-gray-50'>
            {views?.topPaths.map((p) => (
              <li key={p.path} className='flex items-center gap-3 py-2.5 text-sm'>
                <span className='flex-1 truncate font-mono text-xs text-gray-600'>
                  {p.path}
                </span>
                <span className='num shrink-0 text-xs text-gray-400'>
                  {fmt(p.visitors)} 人
                </span>
                <span className='num w-16 shrink-0 text-right font-medium text-brand-800'>
                  {fmt(p.views)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* ───────── 处理积压 ───────── */}
      <div className='grid gap-4 sm:grid-cols-2'>
        <Panel title='待处理申请' description='在「账号管理」中批准或驳回。'>
          <BigNumber
            value={data?.requests.pending ?? 0}
            label='条待审批'
            tone={data?.requests.pending ? 'warn' : 'calm'}
            footer={`累计收到 ${fmt(data?.requests.total)} 条申请 · 已批准 ${fmt(
              data?.requests.approved
            )} · 已驳回 ${fmt(data?.requests.rejected)}`}
          />
        </Panel>
        <Panel title='通知发件箱' description='短信文案已生成，转发后标记为已发送。'>
          <BigNumber
            value={data?.notifications.pending ?? 0}
            label='条待发送'
            tone={data?.notifications.pending ? 'warn' : 'calm'}
            footer={`累计 ${fmt(data?.notifications.total)} 条 · 已发送 ${fmt(
              data?.notifications.sent
            )} · 失败 ${fmt(data?.notifications.failed)}`}
          />
        </Panel>
      </div>
    </div>
  );
}

/* ───────────────────────── 展示组件 ───────────────────────── */

type Tone = 'brand' | 'flare' | 'gold' | 'danger' | 'warn' | 'calm';

const TONE_RING: Record<Tone, string> = {
  brand: 'border-brand-100 bg-brand-50/60 text-brand-800',
  flare: 'border-flare-100 bg-flare-50/60 text-flare-700',
  gold: 'border-gold-200 bg-gold-50/60 text-gold-700',
  danger: 'border-red-200 bg-red-50/60 text-red-700',
  warn: 'border-amber-200 bg-amber-50/60 text-amber-800',
  calm: 'border-gray-100 bg-gray-50/60 text-gray-600',
};

function StatCard({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone: Tone;
}) {
  return (
    <div className={cn('rounded-xl border p-4', TONE_RING[tone])}>
      <div className='flex items-center gap-2 text-xs font-medium opacity-80'>
        {icon}
        {label}
      </div>
      <p className='num mt-2 text-2xl font-semibold tracking-tight'>{value}</p>
      {sub ? <p className='mt-1 text-xs opacity-70'>{sub}</p> : null}
    </div>
  );
}

function BigNumber({
  value,
  label,
  tone,
  footer,
}: {
  value: number;
  label: string;
  tone: Tone;
  footer: string;
}) {
  return (
    <div className={cn('rounded-lg border p-4', TONE_RING[tone])}>
      <p className='num text-3xl font-semibold tracking-tight'>
        {value}
        <span className='ml-1.5 text-sm font-normal opacity-70'>{label}</span>
      </p>
      <p className='mt-2 text-xs opacity-70'>{footer}</p>
    </div>
  );
}

/**
 * 倒计时文案。
 *
 * 用「服务端时间 + 偏移」而不是本机 `Date.now()`：站长在别的机器上打开后台时，
 * 本机时钟可能差几分钟，倒计时会说「还剩 1 天」而实际已过期，或反之。
 */
function remainText(expiresAt: string | null, skewMs: number, _tick: number): string {
  if (!expiresAt) return '长期有效';
  const ms = new Date(expiresAt).getTime() - (Date.now() + skewMs);
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

function AccountRow({
  account,
  skewMs,
  tick,
  busy,
  onExtend,
}: {
  account: Account;
  skewMs: number;
  tick: number;
  busy: boolean;
  onExtend: (a: Account, days: number) => Promise<void>;
}) {
  const expired = !account.active;
  return (
    <tr className='border-b border-gray-50 last:border-0'>
      <td className='py-3 pr-4'>
        <span className='num font-medium text-gray-800'>{account.username}</span>
        <span className='ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500'>
          viewer
        </span>
      </td>
      <td className='py-3 pr-4 text-xs text-gray-500'>
        {account.displayName || account.note || '—'}
      </td>
      <td className='py-3 pr-4'>
        <span
          className={cn(
            'num inline-flex items-center gap-1 text-xs font-medium',
            expired ? 'text-red-600' : 'text-emerald-700'
          )}
        >
          <Clock className='h-3.5 w-3.5' />
          {expired ? (
            <span className='font-semibold'>已过期</span>
          ) : (
            remainText(account.expiresAt, skewMs, tick)
          )}
        </span>
      </td>
      <td className='num py-3 pr-4 text-xs text-gray-400'>
        {formatDateTime(account.expiresAt)}
      </td>
      <td className='py-3'>
        <div className='flex items-center gap-1.5'>
          <Btn
            variant='outline'
            onClick={() => void onExtend(account, 30)}
            disabled={busy}
            title='在当前到期时间基础上追加 30 天'
          >
            <CalendarClock className='h-3.5 w-3.5' />
            {busy ? '处理中' : '延长 30 天'}
          </Btn>
          <Btn
            variant='ghost'
            onClick={() => void onExtend(account, 90)}
            disabled={busy}
            title='追加 90 天'
          >
            +90 天
          </Btn>
        </div>
      </td>
    </tr>
  );
}

/** 近 14 日趋势：纯 SVG，不引图表库（后端零依赖、前端也不额外加重） */
function TrendChart({
  points,
}: {
  points: Array<{ day: string; views: number; visitors: number }>;
}) {
  if (points.length === 0) {
    return <p className='py-6 text-center text-sm text-gray-400'>暂无访问数据。</p>;
  }
  const W = 640;
  const H = 160;
  const pad = { top: 12, right: 8, bottom: 24, left: 32 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const max = Math.max(1, ...points.map((p) => p.views));
  const slot = innerW / points.length;
  const barW = Math.max(6, Math.min(28, slot * 0.55));

  const x = (i: number) => pad.left + slot * i + slot / 2;
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;

  return (
    <div className='w-full overflow-x-auto'>
      <svg viewBox={`0 0 ${W} ${H}`} className='h-40 w-full min-w-[520px]'>
        {/* 基线 */}
        <line
          x1={pad.left}
          y1={pad.top + innerH}
          x2={W - pad.right}
          y2={pad.top + innerH}
          stroke='#e5e7eb'
          strokeWidth='1'
        />
        {/* 左侧刻度（0 与最大值） */}
        <text x={4} y={pad.top + 4} fontSize='9' fill='#9ca3af'>
          {max}
        </text>
        <text x={4} y={pad.top + innerH + 3} fontSize='9' fill='#9ca3af'>
          0
        </text>

        {points.map((p, i) => {
          const h = (p.views / max) * innerH;
          return (
            <g key={p.day}>
              <rect
                x={x(i) - barW / 2}
                y={pad.top + innerH - h}
                width={barW}
                height={Math.max(h, p.views > 0 ? 2 : 0)}
                rx='2'
                fill='#2f5d8a'
                opacity='0.85'
              />
              <circle
                cx={x(i)}
                cy={y(p.visitors)}
                r='2.5'
                fill='#c2410c'
              />
              {/* 只显示日期的「日」部分，14 个标签放得下 */}
              <text
                x={x(i)}
                y={H - 8}
                fontSize='9'
                fill='#9ca3af'
                textAnchor='middle'
              >
                {p.day.slice(5)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className='mt-2 flex items-center gap-4 text-xs text-gray-400'>
        <span className='inline-flex items-center gap-1.5'>
          <span className='inline-block h-2.5 w-2.5 rounded-sm bg-brand-700/85' />
          浏览量
        </span>
        <span className='inline-flex items-center gap-1.5'>
          <span className='inline-block h-2 w-2 rounded-full bg-flare-700' />
          独立访客
        </span>
      </div>
    </div>
  );
}

/* ───────────────────────── 工具 ───────────────────────── */

function fmt(n: number | undefined): string {
  if (n === undefined || n === null) return '0';
  return n.toLocaleString('zh-CN');
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
