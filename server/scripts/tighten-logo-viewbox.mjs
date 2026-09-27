/**
 * 把 logo SVG 的 viewBox 收紧到**真实图形包围盒**。
 *
 * ## 这个脚本解决什么问题
 *
 * icongo 那批 svg 一律 `viewBox="0 0 1024 1024"`（正方形画布），图形本体只占其中
 * 一部分（中国银行的图元集中在左侧、右侧大量留白）。logo 墙的图片盒是
 * 「**统一高度 + 宽度自适应**」，正方形资产就渲染成正方形，留白照样占位 ——
 * 结果是 logo 本体被压小、观感「又小又淡」，**看起来像分辨率不够，实际是画布没裁**。
 *
 * 实测收益（2026-09-27）：13 个 svg 全部收紧后，中国证监会从 1:1 变成 8.22:1，
 * 同样高度下显示宽度涨了约 8 倍，从「几乎看不清」变成「一眼可读」。
 * 只换图（去官网挖更大的位图）完全解决不了这一类问题。
 *
 * ## 为什么用无头浏览器算包围盒
 *
 * 任意 SVG 的 path/transform 包围盒用文本解析很容易算错（弧线、transform 嵌套、
 * `<text>`……）。浏览器的 `SVGGraphicsElement.getBBox()` 直接给出用户坐标系下的
 * 精确并集，最省事也最准。代价是需要本机有 Edge 或 Chrome。
 *
 * ## 幂等性
 *
 * 重复运行是安全的：已经把 viewBox 收紧了再跑一次，得到的是同一个值。
 * 原文件只在**首次**处理时备份为 `*.bak.<时间戳>`，且备份写在
 * `.workbuddy/logo-svg-backup/` 而**不是素材目录内** —— 放素材目录里会被
 * `scan-resources.mjs` 当成素材扫进库（踩过：多出 13 条假记录）。
 *
 * 用法：
 *   node server/scripts/tighten-logo-viewbox.mjs
 *   EDGE=/path/to/msedge node server/scripts/tighten-logo-viewbox.mjs
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.env.LOGO_DIR ?? '资料分享模块素材/logo';
const BACKUP = process.env.LOGO_BACKUP_DIR ?? '.workbuddy/logo-svg-backup';
const PORT = Number(process.env.CDP_PORT ?? 9366);

/** 常见安装位置；可用 EDGE 环境变量覆盖 */
const EDGE_CANDIDATES = [
  process.env.EDGE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const EDGE = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!EDGE) {
  console.error('找不到 Edge / Chrome，请用 EDGE 环境变量指定可执行文件路径。');
  process.exit(1);
}

const svgFiles = readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.svg'));
if (!svgFiles.length) {
  console.log(`${DIR} 下没有 svg，无需处理。`);
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--disable-extensions',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + join(process.cwd(), '.workbuddy/tmp/edge-viewbox'),
    'about:blank',
  ],
  { stdio: 'ignore' }
);

try {
  let list = null;
  for (let i = 0; i < 60; i++) {
    try {
      list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (list?.some((t) => t.type === 'page')) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  const page = list?.find((t) => t.type === 'page');
  if (!page) throw new Error('无法连接到无头浏览器的调试端口');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));

  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', async (ev) => {
    const txt = typeof ev.data === 'string' ? ev.data : await ev.data.text();
    const m = JSON.parse(txt);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pend.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let changed = 0;

  console.log('文件'.padEnd(34) + '旧 viewBox'.padEnd(24) + '新 viewBox（贴合图形）');
  console.log('-'.repeat(96));

  for (const f of svgFiles) {
    const path = join(DIR, f);
    const text = readFileSync(path, 'utf8');
    // 去掉 XML 声明与 BOM，方便塞进 innerHTML
    const cleaned = text.replace(/^\uFEFF/, '').replace(/<\?xml[^>]*\?>/, '').trim();

    await send('Runtime.evaluate', {
      expression: `(() => { let b = document.getElementById('__bbox_host');
        if (!b) { b = document.createElement('div'); b.id = '__bbox_host'; document.body.appendChild(b); }
        return true; })()`,
      returnByValue: true,
    });

    const injected = await send('Runtime.evaluate', {
      expression: `(() => {
        const host = document.getElementById('__bbox_host');
        host.innerHTML = ${JSON.stringify(cleaned)};
        const svg = host.querySelector('svg');
        if (!svg) return 'NO_SVG';
        svg.setAttribute('width', '800');
        svg.removeAttribute('height');
        try { const b = svg.getBBox(); return JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height }); }
        catch (e) { return 'ERR ' + e.message; }
      })()`,
      returnByValue: true,
    });

    const raw = injected?.result?.result?.value;
    if (typeof raw !== 'string' || !raw.startsWith('{')) {
      console.log(f.padEnd(34) + String(raw).slice(0, 60));
      continue;
    }
    const b = JSON.parse(raw);
    if (!(b.w > 0 && b.h > 0)) {
      console.log(f.padEnd(34) + `包围盒无效 ${JSON.stringify(b)}`);
      continue;
    }

    const oldVB = (text.match(/viewBox\s*=\s*["']([^"']+)["']/i) || [, '(无)'])[1];
    const pad = 0.02; // 2% 呼吸位，免得笔画贴边被裁
    const r = (n) => Number(n.toFixed(3));
    const newVB = `${r(b.x - b.w * pad)} ${r(b.y - b.h * pad)} ${r(b.w * (1 + pad * 2))} ${r(
      b.h * (1 + pad * 2)
    )}`;
    if (newVB === oldVB) {
      console.log(f.padEnd(34) + oldVB.slice(0, 22).padEnd(24) + newVB.padEnd(28) + '（已是贴合值）');
      continue;
    }

    mkdirSync(BACKUP, { recursive: true });
    const bak = join(BACKUP, `${f}.${ts}.bak`);
    if (!existsSync(bak)) copyFileSync(path, bak);

    let out = text;
    if (/viewBox\s*=\s*["'][^"']+["']/i.test(out)) {
      out = out.replace(/viewBox\s*=\s*["'][^"']+["']/i, `viewBox="${newVB}"`);
    } else {
      out = out.replace(/<svg/i, `<svg viewBox="${newVB}"`);
    }
    // 去掉固定 width/height，尺寸交给外层 CSS
    out = out.replace(/(<svg[^>]*?)\swidth\s*=\s*["'][^"']*["']/i, '$1');
    out = out.replace(/(<svg[^>]*?)\sheight\s*=\s*["'][^"']*["']/i, '$1');
    writeFileSync(path, out, 'utf8');
    changed += 1;

    console.log(
      f.padEnd(34) +
        oldVB.slice(0, 22).padEnd(24) +
        newVB.padEnd(28) +
        `宽高比 ${(b.w / b.h).toFixed(2)}`
    );
  }

  console.log(`\n收紧 ${changed} / ${svgFiles.length} 个 svg（原文件备份在 ${BACKUP}/）`);
  if (changed) {
    console.log('记得复跑：node server/scripts/scan-resources.mjs && node server/scripts/audit-logos.mjs');
  }
  ws.close();
} finally {
  proc.kill();
}
