import { createHashRouter } from 'react-router-dom';
import SiteLayout from '@/layouts/SiteLayout';
import Home from '@/pages/Home';
import History from '@/pages/History';
import Resources from '@/pages/Resources';
import Productions from '@/pages/Productions';
import News from '@/pages/News';
import ArticleDetail from '@/pages/ArticleDetail';
import Admin from '@/pages/Admin';
import Login from '@/pages/Login';
import ProductionDetail from '@/pages/ProductionDetail';
import NotFound from '@/pages/NotFound';
import RequireAuth from '@/components/auth/RequireAuth';
import { ADMIN_REQUIRED_CAPS, PRODUCTIONS_REQUIRED_CAPS } from '@/lib/auth';

/**
 * Hash 路由（createHashRouter）。
 * URL 形如 `/#/news`，无需服务端重写规则，静态托管即可。
 *
 * 根路径 `/#/` 即协会官网首页（真实业务页面）。
 *
 * 权限说明：
 * - `/admin` 需要 `canManageContent` —— 仅管理权限账号可用。
 * - `/productions` 需要 `canViewRestricted` —— 临时浏览权限与管理权限均可用。
 *   ⚠️ 导航栏的「社团成员产出」**对访客可见**（不做隐藏），访客点击后由本守卫
 *   渲染「需要登录」页并引导到 `/login?next=/productions`，在登录页读到申请邮箱。
 * - 其余页面公开。
 *
 * 注意：这里的守卫只负责前端展示层的准入。真正的数据隔离在后端按会话判定，
 * 绕过守卫也拿不到受限数据。
 */
export const router = createHashRouter([
  {
    path: '/',
    element: <SiteLayout />,
    children: [
      { index: true, element: <Home /> },
      { path: 'history', element: <History /> },
      { path: 'resources', element: <Resources /> },
      { path: 'news', element: <News /> },
      { path: 'article/:id', element: <ArticleDetail /> },
      { path: 'login', element: <Login /> },

      {
        path: 'productions',
        element: (
          <RequireAuth required={PRODUCTIONS_REQUIRED_CAPS}>
            <Productions />
          </RequireAuth>
        ),
      },
      {
        /**
         * 作品详情页。
         * 与 `/productions` 用**同一道守卫**：详情页会暴露文件信息与预览入口，
         * 若只守列表不守详情，等于把门开着 —— 直接敲 URL 就能看到受限作品。
         * （真正的数据隔离仍由后端按会话判定，这里只是别让用户白跑一趟。）
         */
        path: 'production/:id',
        element: (
          <RequireAuth required={PRODUCTIONS_REQUIRED_CAPS}>
            <ProductionDetail />
          </RequireAuth>
        ),
      },
      {
        /**
         * 「栏目与网站管理」。
         *
         * ⚠️ 这是**门禁入口**而不是隐藏入口：导航栏里对所有访客可见，
         * 权限判定发生在点击之后。因此这里的 `denied` 文案是产品指定的原话
         * （「没有权限，请登录管理员账号」），不是通用说法 ——
         * 访客必须一眼看懂「这不是 404，是我需要管理员账号」。
         */
        path: 'admin',
        element: (
          <RequireAuth
            required={ADMIN_REQUIRED_CAPS}
            denied={{
              title: '没有权限，请登录管理员账号',
              message:
                '「栏目与网站管理」仅对管理员账号开放，用于维护资料、审核临时权限申请与查看站点数据。',
              actionLabel: '前往登录管理员账号',
            }}
          >
            <Admin />
          </RequireAuth>
        ),
      },

      { path: '*', element: <NotFound /> },
    ],
  },
]);
