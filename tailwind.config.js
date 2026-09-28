/** @type {import('tailwindcss').Config} */

/*
 * 西财金融投资协会官网 · Tailwind 配置
 *
 * 只保留「主题定义」这一件事。早先这里还挂着 12 个 safelist 生成函数，
 * 现已移除 —— 原因见下方 safelist 处的长注释。
 */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  // Merge every generated utility into safelist so dynamic class names are not purged
  // ---------------------------------------------------------------------
// safelist：**刻意留空**，不要往里加东西。
//
// 这里曾经由 12 个生成函数拼出约 5300 条工具类（全色彩 × 全前缀 × 全色阶，
// 再加间距 / 边框 / 字重 / 字号 / 行高 / 字距 / 对齐 / 透明度 / 圆角 / 阴影），
// 理由是「怕动态拼出来的类名被 purge 掉」。对照构建实测的代价是：
//
//     CSS 原始 450,274 B → 74,990 B（−83%）
//     CSS gzip  53,155 B → 13,000 B（−76%）
//
// 而视觉**零变化** —— 因为全站没有任何「运行时拼接」的类名：所有动态类名都
// 来自映射表里的完整字面量（AccountManager 的 TONE_CLASS、RequireAuth 的
// RoleBadge tone、ResourceGlyph 等），Tailwind 的静态扫描本来就能看见它们。
// 置空后抽查 bg-brand-50 / text-brand-700 / border-gold-200 / text-flare-700 等
// 9 个动态类名，全部仍在产物 CSS 中。
//
// 若将来真的要写运行时拼接的类名（例如 `text-${shade}-600`），
// 正确做法是改用**映射表**（把候选值写成完整字面量），而不是恢复 safelist。
// ---------------------------------------------------------------------
  safelist: [],
  theme: {
    extend: {
      colors: {
        // 协会主色调：学院派深蓝 + 典雅金
        brand: {
          50: '#eef4fd',
          100: '#d8e6fb',
          200: '#b3cdf6',
          300: '#85adee',
          400: '#5286e1',
          500: '#2f63cd',
          600: '#1e4bb0',
          700: '#163c8f',
          800: '#112f70',
          900: '#0b2350',
          950: '#071634',
        },
        gold: {
          50: '#fdf9ec',
          100: '#f9efc9',
          200: '#f2dd90',
          300: '#e9c552',
          400: '#e0b02b',
          500: '#c9961a',
          600: '#a87514',
          700: '#855614',
          800: '#6f4518',
          900: '#5e3a19',
        },
        // 墨色：公开站点白底黑字的中性色阶（900 标题、600 正文、400 弱化）
        ink: {
          50: '#fafafa',
          100: '#f2f2f2',
          200: '#e4e4e4',
          300: '#c9c9c9',
          400: '#9c9c9c',
          500: '#6f6f6f',
          600: '#4d4d4d',
          700: '#383838',
          800: '#232323',
          900: '#141414',
          950: '#0a0a0a',
        },
        // 浅红：主强调色。用于晕圈、高亮、激活态与数据强调
        flare: {
          50: '#fff5f4',
          100: '#ffe6e3',
          200: '#ffcdc7',
          300: '#ffa8a0',
          400: '#ff7c71',
          500: '#f8574a',
          600: '#e23b2e',
          700: '#bd2b20',
          800: '#9a251c',
          900: '#7d241d',
        },
        // 涨跌色：遵循 A 股习惯（红涨绿跌）
        bull: {
          DEFAULT: '#f6465d',
          light: '#ff8095',
          dark: '#c22a41',
        },
        bear: {
          DEFAULT: '#0ecb81',
          light: '#4ce0a5',
          dark: '#0a9c64',
        },
        primary: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
        },
        gray: {
          50: '#f9fafb',
          100: '#f3f4f6',
          200: '#e5e7eb',
          300: '#d1d5db',
          400: '#9ca3af',
          500: '#6b7280',
          600: '#4b5563',
          700: '#374151',
          800: '#1f2937',
          900: '#111827',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['Fira Code', 'monospace'],
        // 行情数字专用等宽栈：无需外链字体，直接落到系统等宽字体
        num: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          '"Liberation Mono"',
          '"Courier New"',
          'monospace',
        ],
      },
      spacing: {
        18: '4.5rem',
        88: '22rem',
      },
      borderRadius: {
        '4xl': '2rem',
      },
      boxShadow: {
        soft: '0 2px 15px -3px rgba(0, 0, 0, 0.07), 0 10px 20px -2px rgba(0, 0, 0, 0.04)',
        // 白底卡片：极轻的接触阴影 + 大范围柔扩散，接近 Material 的层次感
        card: '0 1px 2px rgba(20,20,20,0.04), 0 10px 30px -18px rgba(20,20,20,0.18)',
        'card-hover':
          '0 2px 6px rgba(20,20,20,0.05), 0 20px 44px -20px rgba(248,87,74,0.30)',
        // 白底下的「晕圈」：用大范围、负扩散的红色柔光，而不是投影
        halo: '0 0 60px -12px rgba(248,87,74,0.45)',
        'halo-lg': '0 0 110px -24px rgba(248,87,74,0.55)',
        'glow-flare':
          '0 0 0 1px rgba(248,87,74,0.16), 0 0 44px -10px rgba(248,87,74,0.42)',
        'glow-gold':
          '0 0 0 1px rgba(201,150,26,0.16), 0 0 44px -10px rgba(201,150,26,0.38)',
        'glow-bull':
          '0 0 0 1px rgba(226,59,46,0.16), 0 0 44px -10px rgba(226,59,46,0.42)',
        'glow-bear':
          '0 0 0 1px rgba(16,163,110,0.16), 0 0 44px -10px rgba(16,163,110,0.38)',
      },
      backgroundImage: {
        // 工程感网格底纹（配 bg-grid / bg-grid-sm）——白底用极淡的中性灰
        grid: `linear-gradient(to right, rgba(20,20,20,0.045) 1px, transparent 1px),
               linear-gradient(to bottom, rgba(20,20,20,0.045) 1px, transparent 1px)`,
        // 点阵底纹
        dots: 'radial-gradient(rgba(20,20,20,0.10) 1px, transparent 1px)',
      },
      backgroundSize: {
        grid: '56px 56px',
        'grid-sm': '22px 22px',
        dots: '20px 20px',
      },
      transitionTimingFunction: {
        // 有回弹感的缓动，用于入场与悬停
        smooth: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      animation: {
        'fade-in': 'fadeIn 0.5s ease-in-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'bounce-slow': 'bounce 2s infinite',
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        // 浅红晕圈缓慢漂移（背景氛围层）
        'halo-a': 'haloA 22s ease-in-out infinite',
        'halo-b': 'haloB 27s ease-in-out infinite',
        'halo-c': 'haloC 19s ease-in-out infinite',
        // 点击时从光标处扩散的晕圈
        'halo-ripple': 'haloRipple 900ms cubic-bezier(0.22, 1, 0.36, 1) forwards',
        // ⚠️ 跑马灯的 `marquee` / `marquee2` **不在这里注册**。
        // `Marquee` 组件用内联 animation 直接引用关键帧名（时长需按内容长度动态计算），
        // 不会用到 `animate-marquee` 工具类；而 Tailwind 只为「被 animate-* 引用的」
        // keyframes 生成 @keyframes，注册在这里等于永不产出。两份定义都移到了
        // `src/index.css` 的 @keyframes marquee / marquee2。
        // 卡片顶部/边框流光
        shimmer: 'shimmer 2.6s linear infinite',
        // 呼吸光晕
        breathe: 'breathe 4s ease-in-out infinite',
        // 数据刷新时的闪烁
        blink: 'blink 1.1s step-end infinite',
        // 缓慢浮动
        float: 'float 7s ease-in-out infinite',
        // 扫描线（终端氛围）
        scan: 'scan 6s linear infinite',
        // 进度条生长
        grow: 'grow 1.1s cubic-bezier(0.22, 1, 0.36, 1) forwards',
        // 首屏文案：上浮 + 去模糊，逐条错峰出现
        rise: 'rise 0.9s cubic-bezier(0.22, 1, 0.36, 1) both',
        // 轮播图缓慢推近（Ken Burns）
        kenburns: 'kenburns 16s ease-out both',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        haloA: {
          '0%, 100%': { transform: 'translate3d(-8%, -6%, 0) scale(1)' },
          '50%': { transform: 'translate3d(10%, 8%, 0) scale(1.18)' },
        },
        haloB: {
          '0%, 100%': { transform: 'translate3d(6%, 10%, 0) scale(1.12)' },
          '50%': { transform: 'translate3d(-10%, -8%, 0) scale(0.92)' },
        },
        haloC: {
          '0%, 100%': { transform: 'translate3d(0, 0, 0) scale(1)' },
          '50%': { transform: 'translate3d(-6%, 12%, 0) scale(1.22)' },
        },
        haloRipple: {
          '0%': { transform: 'translate(-50%, -50%) scale(0.18)', opacity: '0.5' },
          '70%': { opacity: '0.28' },
          '100%': { transform: 'translate(-50%, -50%) scale(1)', opacity: '0' },
        },
        /*
         * ⚠️ `marquee` / `marquee2` 的关键帧**故意不在此处定义**。
         *
         * 它们原先写在这里，于是 Tailwind 因为「没有 animate-marquee 类引用」
         * 而从未把 @keyframes 输出到产物 —— 全站跑马灯一直是静止的（见 index.css 注释）。
         * 现统一移到 `src/index.css`。
         */
        shimmer: {
          '0%': { backgroundPosition: '-140% 0' },
          '100%': { backgroundPosition: '240% 0' },
        },
        breathe: {
          '0%, 100%': { opacity: '0.45' },
          '50%': { opacity: '0.95' },
        },
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.2' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        scan: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(1200%)' },
        },
        grow: {
          from: { transform: 'scaleX(0)' },
          to: { transform: 'scaleX(1)' },
        },
        rise: {
          from: {
            opacity: '0',
            transform: 'translateY(28px)',
            filter: 'blur(6px)',
          },
          to: { opacity: '1', transform: 'none', filter: 'blur(0)' },
        },
        kenburns: {
          '0%': { transform: 'scale(1.04) translate3d(0, 0, 0)' },
          '100%': { transform: 'scale(1.16) translate3d(-1.5%, -1.5%, 0)' },
        },
      },
    },
  },
  plugins: [
    function ({ addUtilities }) {
      const newUtilities = {
        '.text-balance': {
          'text-wrap': 'balance',
        },
      };
      addUtilities(newUtilities);
    },
  ],
  // 刻意不设 darkMode：全站锁定浅色主题（禁 bg-night-* / text-white 深色面），
  // 源码里没有任何 dark: 变体，写 darkMode: 'class' 只会给后来者错觉。
};

