import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import SiteHeader from '@/components/site/SiteHeader';
import SiteFooter from '@/components/site/SiteFooter';
import ScrollProgress from '@/components/site/ScrollProgress';
import HaloField from '@/components/site/HaloField';
import PointerHalo from '@/components/site/PointerHalo';
import { cn } from '@/lib/utils';

/** 切换路由后回到页面顶部（hash 路由默认不会重置滚动位置） */
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [pathname]);
  return null;
}

/**
 * 站点整体骨架：页头 + 内容区 + 页脚。
 *
 * 公开站点为白底黑字 + 浅红晕圈：全局铺一层静态晕圈底噪（`animated={false}`，
 * 长页面滚动时不持续重绘模糊层），并挂载 `PointerHalo` 提供指针光斑与点击晕圈。
 * 内容管理后台（`/admin`）不挂这两层，保持干净的表单环境。
 */
export function SiteLayout() {
  const { pathname } = useLocation();
  const isAdmin = pathname.startsWith('/admin');

  return (
    <div
      className={cn(
        'relative flex min-h-screen flex-col text-ink-900',
        // 后台用极浅灰底，与白色面板拉开层次；公开站点保持纯白
        isAdmin ? 'bg-ink-50' : 'bg-white'
      )}
    >
      {!isAdmin ? (
        <>
          <ScrollProgress />
          <div className='pointer-events-none fixed inset-0 -z-10'>
            <HaloField intensity={0.7} animated={false} />
          </div>
          <PointerHalo />
        </>
      ) : null}

      <ScrollToTop />
      <SiteHeader />
      <main className='relative flex-1'>
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}

export default SiteLayout;
