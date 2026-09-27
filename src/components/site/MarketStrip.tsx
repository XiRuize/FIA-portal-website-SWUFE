import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowUpRight } from 'lucide-react';
import { useContent } from '@/lib/store';
import { getSetting, parseWatchlist } from '@/lib/siteConfig';
import { DEFAULT_STOCK_BASE } from '@/lib/stockApi';
import { useQuotes } from '@/lib/useQuotes';
import { cn } from '@/lib/utils';
import Marquee from './Marquee';

const fmt = (n: number) =>
  n.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/**
 * 首页行情条：紧贴主视觉下方的细长跑马灯。
 *
 * 与行情终端共用 `useQuotes`，服务不可达时回退演示数据并如实标注来源，
 * 不做「假装是实时行情」的包装。
 */
export function MarketStrip() {
  const { settings } = useContent();
  const base = getSetting(settings, 'stock_api_base', DEFAULT_STOCK_BASE);
  const watchlist = useMemo(
    () => parseWatchlist(settings.stock_watchlist ?? ''),
    [settings.stock_watchlist]
  );
  const { quotes } = useQuotes(base, watchlist);

  if (!quotes.length) return null;

  return (
    <div className='relative border-y border-ink-900/[0.07] bg-flare-50/50'>
      <div className='mx-auto flex max-w-7xl items-center gap-4 px-4 sm:px-6'>
        <Link
          to='/news?tab=finance'
          className='group flex shrink-0 items-center gap-2 py-2.5 text-[11px] font-medium text-flare-600 transition-colors hover:text-flare-700'
        >
          <Activity className='h-3.5 w-3.5' />
          <span className='hidden sm:inline'>行情</span>
          <ArrowUpRight className='h-3 w-3 transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5' />
        </Link>

        <span aria-hidden className='h-5 w-px shrink-0 bg-ink-900/10' />

        <div className='min-w-0 flex-1'>
          <Marquee duration={Math.max(26, quotes.length * 6)}>
            {quotes.map((q) => {
              const up = q.changePct >= 0;
              return (
                <Link
                  key={`strip-${q.code}`}
                  to='/news?tab=finance'
                  className='flex shrink-0 items-center gap-2 py-2.5 text-[11px] transition-opacity hover:opacity-75'
                >
                  <span className='font-medium text-ink-700'>{q.name}</span>
                  <span className='num text-ink-400'>{q.code}</span>
                  <span className='num font-semibold text-ink-900'>
                    {fmt(q.price)}
                  </span>
                  <span
                    className={cn(
                      'num font-semibold',
                      up ? 'text-bull' : 'text-bear'
                    )}
                  >
                    {up ? '▲' : '▼'} {Math.abs(q.changePct).toFixed(2)}%
                  </span>
                </Link>
              );
            })}
          </Marquee>
        </div>
      </div>
    </div>
  );
}

export default MarketStrip;
