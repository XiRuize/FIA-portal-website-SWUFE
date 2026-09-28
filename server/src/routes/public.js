/**
 * 公开接口（无需登录 + 带限流）。
 *
 * 本文件只有两个端点，共同点是**匿名可写** —— 因此每一个都必须限流，
 * 且必须把「谁在写」记下来（指纹/IP），否则出事时没有任何追溯线索。
 *
 * 1. `POST /api/access-requests` —— 登录页的「申请临时权限与账号」
 * 2. `POST /api/stats/pageview`   —— 前端路由切换时上报一次浏览
 */

/**
 * @param {object} ctx
 */
export function createPublicRoutes(ctx) {
  const { http, access, stats, throttles } = ctx;

  return {
    /**
     * POST /api/access-requests
     * body: { phone, name?, org?, reason? }
     *
     * 公开接口，仅收集手机号（必填）与选填的背景信息。
     *
     * 两道限流同时生效：
     * - **按指纹** 3 次/小时：挡住同一浏览器的反复提交；
     * - **全局** 30 次/小时：挡住「换指纹轮刷」，保证申请表不会被灌爆。
     * 全局闸门放在建单之前，所以即使有人绕过了指纹维度也写不进库。
     */
    async requestAccess(req, res) {
      const fingerprint = ctx.fingerprintOf(req) || ctx.clientIp(req);

      const globalGate = throttles.accessRequestGlobal.hit('global');
      if (!globalGate.allowed) {
        return http.sendError(
          res,
          429,
          'TOO_MANY_REQUESTS',
          '当前申请量较大，请稍后再试或直接联系协会负责人',
          ctx.cors
        );
      }

      const gate = throttles.accessRequest.hit(fingerprint);
      if (!gate.allowed) {
        return http.sendError(
          res,
          429,
          'TOO_MANY_REQUESTS',
          `提交过于频繁，请 ${gate.retryAfterSec} 秒后再试`,
          ctx.cors
        );
      }

      const body = await http.readJsonBody(req);
      const result = access.requestAccess({
        phone: body?.phone,
        name: body?.name,
        org: body?.org,
        reason: body?.reason,
        ip: ctx.clientIp(req),
        fingerprint,
      });

      if (!result.ok) {
        return http.sendError(res, 400, result.code, result.message, ctx.cors);
      }

      return http.sendOk(
        res,
        {
          /**
           * ⚠️ 只回**打码后**的手机号。
           * 这是公开端点，回显完整号码等于把「这个号码已提交过」变成可探测的
           * 信息泄露（拿号码列表去撞，就能确认谁申请过）。
           */
          request: {
            id: result.request.id,
            phoneMasked: result.request.phoneMasked,
            status: result.request.status,
            createdAt: result.request.createdAt,
          },
          duplicate: result.duplicate,
          message: result.duplicate
            ? '该手机号已有一条待处理申请，请耐心等待管理员审批，无需重复提交。'
            : '申请已提交，管理员审批后会把账号与随机密码发送到该手机号。',
        },
        201,
        ctx.cors
      );
    },

    /**
     * POST /api/stats/pageview
     * body: { path }
     *
     * 记录一次页面访问。使用 `POST` 而不是 `GET`/Beacon：
     * 前者语义正确（写操作），且不会被浏览器预取或缓存命中而误计。
     *
     * 用 204 而非 200 + body：这个请求发生在每次路由切换时，
     * 减少一点响应体就是减少一点无谓流量。
     */
    async pageView(req, res) {
      const fingerprint = ctx.fingerprintOf(req) || ctx.clientIp(req);
      const gate = throttles.pageView.hit(fingerprint);
      if (!gate.allowed) {
        // 上报失败不该影响用户浏览，静默接受但不再计数
        res.writeHead(204, ctx.cors);
        res.end();
        return;
      }

      // 请求体解析失败（例如前端用 sendBeacon 发了表单编码）不应报错，
      // 浏览上报是「尽力而为」的行为，不值得为它给用户抛错。
      let path = '';
      try {
        const body = await http.readJsonBody(req);
        path = String(body?.path ?? '');
      } catch {
        path = '';
      }

      // 记录结果不需要回传：这是「尽力而为」的上报。
      // 204 响应**不能带 body**，所以只 end() 不带参数 —— 传对象会直接抛错。
      stats.recordPageView({ path, fingerprint });
      res.writeHead(204, ctx.cors);
      res.end();
    },
  };
}
