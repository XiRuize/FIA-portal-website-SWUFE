/**
 * 轻量内存限流器。
 *
 * ## 为什么需要它
 *
 * `clientIp()` 收紧之后，伪造 `X-Forwarded-For` 已经无法再换掉
 * 点赞指纹与限流 IP 维度 —— 指纹去重本身恢复了。但去重只保证
 * 「同一指纹对同一条资料只计一次」，**不限制请求频次**：
 * 一个脚本仍可在 1 秒内对上万条资料各点一次赞。
 * 点赞接口对匿名访客开放，必须再加一道频次闸门。
 *
 * 同一套机制还服务于两个新增的公开写接口：
 * `POST /api/access-requests`（防刷申请）与 `POST /api/stats/pageview`（防刷浏览数）。
 *
 * ## 为什么是内存而不是数据库
 *
 * 这些是**短窗口、允许丢**的计数：窗口只有几十秒，进程重启后归零无实质影响；
 * 而每个请求都写一次 SQLite 会给公开接口带来不必要的写放大（WAL 也没必要为此忙）。
 *
 * ⚠️ **适用边界**：内存实现只在「单进程部署」下正确。若将来横向扩成多实例，
 * 每个实例各有一份计数，实际额度会变成 `max × 实例数`。
 * 那种规模下应换成 Redis 或数据库计数表 —— 但在那之前，这里够用且没有额外依赖。
 */

/** 桶数量上限：超过就触发一次清理，避免长期运行后被长尾 key 撑爆内存 */
const MAX_BUCKETS = 10_000;

/**
 * 创建一个限流器。
 *
 * @param {{
 *   windowMs: number,   // 统计窗口长度
 *   max: number,        // 窗口内允许的次数
 *   name?: string       // 仅用于日志/调试标识
 * }} options
 */
export function createThrottle({ windowMs, max, name = 'throttle' }) {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map();

  /** 惰性清理：只在桶数超限或访问命中过期桶时做，避免额外定时器 */
  function sweep(now) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  return {
    name,

    /**
     * 记一次命中。
     *
     * @param {string} key 维度键（指纹 / IP / 手机号等）
     * @returns {{ allowed: boolean, remaining: number, retryAfterSec: number }}
     */
    hit(key) {
      const now = Date.now();
      if (buckets.size > MAX_BUCKETS) sweep(now);

      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, remaining: max - 1, retryAfterSec: 0 };
      }

      bucket.count += 1;
      const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
      if (bucket.count > max) {
        return { allowed: false, remaining: 0, retryAfterSec };
      }
      return { allowed: true, remaining: max - bucket.count, retryAfterSec };
    },

    /** 不计数，只查当前是否已被限流（用于「先检查后执行」的流程） */
    check(key) {
      const now = Date.now();
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        return { allowed: true, remaining: max, retryAfterSec: 0 };
      }
      return {
        allowed: bucket.count < max,
        remaining: Math.max(0, max - bucket.count),
        retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000),
      };
    },

    /** 手动清空某个维度（例如登录成功后解除锁定） */
    reset(key) {
      buckets.delete(key);
    },

    /** 当前桶数量（测试用） */
    get size() {
      return buckets.size;
    },
  };
}

/**
 * 一次性构建应用所需的全部限流器。
 *
 * 额度取值说明：
 * - `like`：**60 次 / 分钟**。正常读者翻一页最多点赞十余条；
 *   60 给足余量，而脚本式批量刷赞会在几十秒内撞墙。
 * - `pageView`：**120 次 / 分钟 / 指纹**。前端每次路由切换上报一次，
 *   快速切换页面时也不会误伤；同时挡住「刷新页面刷浏览量」。
 * - `accessRequest`：**3 次 / 小时 / 指纹**，另加全局 **30 次 / 小时**。
 *   申请是低频人工行为，配额压到最低；全局上限防的是「换指纹轮刷」。
 *   全局额度刻意放在建表之前校验，保证刷请求不会把申请表写爆。
 *
 * @param {{ like?: object, pageView?: object, accessRequest?: object }} [overrides]
 */
export function createThrottles(overrides = {}) {
  return {
    like: createThrottle({ windowMs: 60_000, max: 60, name: 'like', ...overrides.like }),
    pageView: createThrottle({
      windowMs: 60_000,
      max: 120,
      name: 'pageView',
      ...overrides.pageView,
    }),
    accessRequest: createThrottle({
      windowMs: 3_600_000,
      max: 3,
      name: 'accessRequest',
      ...overrides.accessRequest,
    }),
    /**
     * 申请的**全局**小时额度。key 恒为 `'global'`，
     * 与按指纹的 `accessRequest` 形成两道互补的闸门。
     *
     * 同样接受 overrides —— 曾经漏传，后果是这条分支**测试够不着**：
     * 想验证「全局超限回 429」就得真发 30 次请求，于是没人写这个用例，
     * 全局闸门成了全项目唯一没有被测过的限流。可测性也是接口的一部分。
     */
    accessRequestGlobal: createThrottle({
      windowMs: 3_600_000,
      max: 30,
      name: 'accessRequestGlobal',
      ...overrides.accessRequestGlobal,
    }),
  };
}
