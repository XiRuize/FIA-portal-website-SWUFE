import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { NAV_ITEMS } from '@/components/site/SiteHeader';
import HaloField from '@/components/site/HaloField';

/** 404 页面 */
function NotFound() {
  return (
    <div className='relative flex min-h-[70vh] items-center justify-center overflow-hidden px-4 py-20'>
      <HaloField intensity={0.9} />
      <div className='relative max-w-md text-center'>
        <p className='num text-gradient-flare text-7xl font-bold sm:text-8xl'>
          404
        </p>
        <p className='mt-5 text-lg font-medium text-ink-900'>页面不存在</p>
        <p className='mt-2 text-sm leading-relaxed text-ink-500'>
          您访问的页面可能已被移动或删除，试试从下面的栏目重新进入。
        </p>
        <div className='mt-7 flex flex-wrap items-center justify-center gap-2'>
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className='rounded-lg border border-ink-900/10 bg-white px-3 py-1.5 text-sm text-ink-600 shadow-card transition-colors hover:border-flare-200 hover:text-flare-600'
            >
              {item.label}
            </Link>
          ))}
        </div>
        <Link
          to='/'
          className='group mt-9 inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-flare-500 to-flare-600 px-6 py-3 text-sm font-semibold text-white shadow-glow-flare transition-all duration-300 ease-smooth hover:brightness-110'
        >
          <ArrowLeft className='h-4 w-4 transition-transform duration-300 group-hover:-translate-x-1' />
          返回首页
        </Link>
      </div>
    </div>
  );
}

export default NotFound;
