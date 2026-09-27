import { Link } from 'react-router-dom';
import { Mail, MapPin, MessageSquare, Phone } from 'lucide-react';
import { useContent } from '@/lib/store';
import { getSetting, getRawSetting } from '@/lib/siteConfig';
import { NAV_ITEMS } from './SiteHeader';

/** 占位文案：信息尚未收集时统一展示，便于后续替换 */
const PENDING = '信息待补充';

interface ContactRowProps {
  icon: typeof Mail;
  label: string;
  value: string;
}

function ContactRow({ icon: Icon, label, value }: ContactRowProps) {
  const empty = !value.trim();
  return (
    <li className='flex items-start gap-3 text-sm'>
      <Icon className='mt-0.5 h-4 w-4 shrink-0 text-flare-400' />
      <span className='min-w-0'>
        <span className='text-ink-400'>{label}：</span>
        <span className={empty ? 'text-ink-300' : 'break-all text-ink-700'}>
          {empty ? PENDING : value}
        </span>
      </span>
    </li>
  );
}

/** 站点页脚：联系方式集中在此，未收集到的信息展示为占位 */
export function SiteFooter() {
  const { settings } = useContent();
  const siteName = getSetting(settings, 'site_name');
  const shortName = getSetting(settings, 'site_short_name');
  const slogan = getSetting(settings, 'site_slogan');
  const copyright = getSetting(settings, 'copyright');
  const joinUs = getSetting(settings, 'join_us');

  return (
    <footer className='relative mt-24 overflow-hidden border-t border-ink-900/[0.07] bg-flare-50/50'>
      {/* 顶部渐变光带 */}
      <div
        aria-hidden
        className='absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-flare-400/50 to-transparent'
      />
      <div
        aria-hidden
        className='pointer-events-none absolute -top-40 left-1/2 h-80 w-[42rem] -translate-x-1/2 rounded-full bg-flare-200/30 blur-[110px]'
      />

      <div className='relative mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-3'>
        <div>
          <div className='flex items-center gap-3'>
            <span className='flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-flare-500 to-flare-600 text-sm font-bold text-white shadow-card'>
              {shortName.slice(0, 1)}
            </span>
            <h3 className='text-lg font-bold text-ink-900'>{shortName}</h3>
          </div>
          <p className='num mt-2 text-[10px] uppercase tracking-[0.16em] text-ink-400'>
            {siteName}
          </p>
          <p className='text-gradient-flare mt-4 text-sm font-medium leading-relaxed'>
            {slogan}
          </p>
          <p className='mt-4 text-xs leading-relaxed text-ink-500'>{joinUs}</p>
        </div>

        <div>
          <h4 className='flex items-center gap-2 text-sm font-semibold tracking-wide text-ink-800'>
            <span className='h-3 w-0.5 rounded-full bg-flare-500' />
            联系方式
          </h4>
          <ul className='mt-4 space-y-3'>
            <ContactRow
              icon={MapPin}
              label='地址'
              value={getRawSetting(settings, 'contact_address')}
            />
            <ContactRow
              icon={Mail}
              label='邮箱'
              value={getRawSetting(settings, 'contact_email')}
            />
            <ContactRow
              icon={Phone}
              label='电话'
              value={getRawSetting(settings, 'contact_phone')}
            />
            <ContactRow
              icon={MessageSquare}
              label='公众号'
              value={getRawSetting(settings, 'contact_wechat')}
            />
            <ContactRow
              icon={MessageSquare}
              label='其他'
              value={getRawSetting(settings, 'contact_extra')}
            />
          </ul>
          <p className='mt-4 text-xs text-ink-400'>
            联系方式待社团确认后补充，可在内容管理中直接编辑。
          </p>
        </div>

        <div>
          <h4 className='flex items-center gap-2 text-sm font-semibold tracking-wide text-ink-800'>
            <span className='h-3 w-0.5 rounded-full bg-gold-500' />
            快速导航
          </h4>
          <ul className='mt-4 grid grid-cols-2 gap-2 text-sm'>
            {[...NAV_ITEMS, { to: '/admin', label: '内容管理', end: false }].map(
              (item) => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    className='group inline-flex items-center gap-1 text-ink-600 transition-colors hover:text-flare-600'
                  >
                    <span className='h-px w-0 bg-flare-400 transition-all duration-300 ease-smooth group-hover:w-3' />
                    {item.label}
                  </Link>
                </li>
              )
            )}
          </ul>
        </div>
      </div>

      <div className='relative border-t border-ink-900/[0.07]'>
        <div className='mx-auto flex max-w-7xl flex-col gap-2 px-4 py-5 text-xs text-ink-400 sm:flex-row sm:items-center sm:justify-between sm:px-6'>
          <span>{copyright}</span>
          <span className='num text-[11px] tracking-wide text-ink-400'>
            本站为协会官网 Demo 版本，内容持续完善中。
          </span>
        </div>
      </div>
    </footer>
  );
}

export default SiteFooter;
