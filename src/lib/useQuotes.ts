import { useEffect, useState } from 'react';
import type { WatchItem } from './siteConfig';
import { fetchKlines, sparkOf } from './stockApi';

/** 股票池中一只标的的即时快照 */
export interface Quote {
  code: string;
  name: string;
  /** 最新收盘价 */
  price: number;
  /** 相对前一交易日的涨跌幅（%） */
  changePct: number;
  /** 迷你走势采样点 */
  spark: number[];
}

/** 与主图共用同一取数区间，才能命中同一份缓存 */
const FETCH_LIMIT = 120;

/**
 * 拉取整个股票池的行情快照。
 *
 * 行情终端看板与首页行情条共用此 Hook，请求走 `stockApi` 的缓存层：
 * 服务不可达时每个交易日只有第一次会真正等待超时，其余直接回退演示数据。
 *
 * @param base free-stockdb 服务地址
 * @param watchlist 股票池
 * @param reloadToken 自增令牌，变化时强制重新拉取
 */
export function useQuotes(
  base: string,
  watchlist: WatchItem[],
  reloadToken = 0
): { quotes: Quote[]; loading: boolean } {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!watchlist.length) {
      setQuotes([]);
      return;
    }

    let cancelled = false;
    setLoading(true);

    void Promise.all(
      watchlist.map(async (item): Promise<Quote> => {
        const res = await fetchKlines(base, item.code, item.name, FETCH_LIMIT);
        const ks = res.klines;
        const last = ks[ks.length - 1];
        const prev = ks.length > 1 ? ks[ks.length - 2] : last;
        return {
          code: item.code,
          name: item.name,
          price: last?.close ?? 0,
          changePct:
            prev && prev.close
              ? ((last.close - prev.close) / prev.close) * 100
              : 0,
          spark: sparkOf(ks, 24),
        };
      })
    )
      .then((list) => {
        if (!cancelled) {
          setQuotes(list);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQuotes([]);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [base, watchlist, reloadToken]);

  return { quotes, loading };
}

export default useQuotes;
