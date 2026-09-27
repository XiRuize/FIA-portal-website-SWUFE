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
import ExamplesPage from '@/pages/ExamplesPage';
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
        path: 'admin',
        element: (
          <RequireAuth required={ADMIN_REQUIRED_CAPS}>
            <Admin />
          </RequireAuth>
        ),
      },

      // 模板示例页，仅作参考，未在导航中暴露
      { path: 'examples', element: <ExamplesPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
