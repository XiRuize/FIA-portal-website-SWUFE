/**
 * 鉴权闸门（路由层复用的前置校验）。
 *
 * ## 为什么要抽出来
 *
 * 「检查会话 → 检查能力 → 拒绝时发响应」这三步此前在每个路由文件里各写一份。
 * 副本一多的后果是**闸门强度会悄悄漂移** —— 某天有人在新路由里少写了一项判断，
 * 表面上只是「这个端点能进去了」，实际是管理边界被开了一个口子，
 * 而它不会让任何测试变红。
 *
 * 因此统一到这里，并且**返回 null 表示「已拒绝且响应已发出」**：
 * 调用方只需 `const admin = guard.admin(req, res); if (!admin) return;`，
 * 不可能忘记发响应，也不可能忘记检查能力。
 *
 * ⚠️ 401 与 403 的区别是刻意的，前端据此分流到「去登录」还是「无权访问」：
 * - **401 UNAUTHENTICATED**：没有有效会话；
 * - **403 FORBIDDEN**：有会话但能力不足。
 */

/**
 * @param {object} ctx 应用上下文
 */
export function createGuards(ctx) {
  const { http } = ctx;

  /** 只要有一个有效会话即可（临时浏览账号也算） */
  function requireSession(req, res, message = '该内容仅对已登录成员开放') {
    const identity = ctx.identityOf(req);
    if (!identity.authenticated) {
      http.sendError(res, 401, 'UNAUTHENTICATED', message, ctx.cors);
      return null;
    }
    return identity;
  }

  /**
   * 要求具备某项能力。
   * @param {string} capability 如 `canManageAccounts`
   * @param {string} label 给用户看的中文说明，出现在 403 文案里
   */
  function requireCapability(capability, label) {
    return (req, res) => {
      const identity = ctx.identityOf(req);
      if (!identity.authenticated) {
        // 文案要与需求一致：访客点「栏目与网站管理」时看到的正是这句
        http.sendError(res, 401, 'UNAUTHENTICATED', '没有权限，请登录管理员账号', ctx.cors);
        return null;
      }
      if (!identity.account.capabilities.includes(capability)) {
        http.sendError(
          res,
          403,
          'FORBIDDEN',
          `当前账号没有${label}权限，请使用管理员账号登录`,
          ctx.cors
        );
        return null;
      }
      return identity;
    };
  }

  return {
    requireSession,
    requireCapability,
    /** 后台总闸门：能进「栏目与网站管理」 */
    admin: requireCapability('canManageContent', '管理后台'),
    /** 账号管理（批准申请、延长、重置、吊销） */
    accounts: requireCapability('canManageAccounts', '账号管理'),
    /** 内容管理（上传资料、改分类） */
    resources: requireCapability('canManageResources', '内容管理'),
  };
}
