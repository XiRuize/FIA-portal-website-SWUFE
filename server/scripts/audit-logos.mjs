/**
 * logo 素材体检：找出「上墙必然发虚」的那些。
 *
 * ## 判据不是「像素总数」，而是**有效密度**
 *
 * 墙上每个格子的图片盒统一高 56px（`sm:h-14`），2 倍屏需要 112px 的源高度。
 * 所以真正要看的是**去掉白边/透明边之后的图形高度**（有效高度）：
 *
 *   · 有效高度 ≥ 112px  → 够
 *   · 矢量（svg）        → 不受限（但要看 viewBox 宽高比，见下）
 *   · 其余               → 必然被放大，放大倍数 = 112 / 有效高度
 *
 * ⚠️ 只看画布尺寸会被骗。本项目踩过：中国农业银行的原 JPEG 画布 3720×1862、
 * 图形只占高度 31%，画布尺寸看着很大，上墙却明显偏小。
 *
 * ## SVG 单独看宽高比
 *
 * ⚠️ 另一类坑：icongo 那批 svg 一律 `viewBox="0 0 1024 1024"`（正方形画布），
 * 图形本体只占其中一部分。图片盒是「统一高度 + 宽度自适应」，正方形资产
 * 就渲染成正方形，留白照样占位 —— 表现是 logo 本体被压小、观感「又小又淡」，
 * 很容易误判成「分辨率不够」而去换图，其实只要收紧 viewBox 就行
 * （修法见 `tighten-logo-viewbox.mjs`）。
 *
 * 用法：
 *   node server/scripts/audit-logos.mjs
 *   node server/scripts/audit-logos.mjs --dir=其他目录
 */
import { readdirSync, readFileSync } from 'node:fs';

/** 2 倍屏下需要的有效高度 */
const NEED = 112;
const args = process.argv.slice(2);
const DIR =
  (args.find((a) => a.startsWith('--dir=')) ?? '').slice(6) || '资料分享模块素材/logo';

// ---------- 各格式的尺寸解析（够用即可，不做完整解码） ----------

function pngSize(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function jpegSize(buf) {
  let i = 2;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    // SOF0..SOF15（去掉 DHT 0xC4 / JPG 0xC8 / DAC 0xCC）
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  return null;
}

function gifSize(buf) {
  return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
}

function webpSize(buf) {
  const tag = buf.subarray(12, 16).toString('ascii');
  if (tag === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  if (tag === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  if (tag === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
  }
  return null;
}

/** ICO 取**最大的那一帧**（一个 ico 里常有多档：16/32/48/64） */
function icoSize(buf) {
  if (buf[0] !== 0 || buf[1] !== 0 || buf[2] !== 1 || buf[3] !== 0) return null;
  const n = buf.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < n; i++) {
    const off = 6 + i * 16;
    if (off + 16 > buf.length) break;
    const w = buf[off] === 0 ? 256 : buf[off];
    const h = buf[off + 1] === 0 ? 256 : buf[off + 1];
    const bpp = buf.readUInt16LE(off + 6);
    // 同尺寸时优先位深更高的那一帧
    const score = w * h * 1000 + bpp;
    if (!best || score > best.score) best = { w, h, bpp, score, bytes: buf.readUInt32LE(off + 8) };
  }
  return best;
}

/** svg 只看 viewBox / width+height */
function svgSize(text) {
  const vb = text.match(
    /viewBox\s*=\s*["']\s*([-\d.eE]+)[ ,]+([-\d.eE]+)[ ,]+([-\d.eE]+)[ ,]+([-\d.eE]+)/i
  );
  if (vb) {
    const w = parseFloat(vb[3]);
    const h = parseFloat(vb[4]);
    return { w, h, from: 'viewBox' };
  }
  const w = text.match(/\bwidth\s*=\s*["']([\d.]+)/i);
  const h = text.match(/\bheight\s*=\s*["']([\d.]+)/i);
  if (w && h) return { w: parseFloat(w[1]), h: parseFloat(h[1]), from: 'width/height' };
  return null;
}

function detect(buf) {
  if (buf.length < 16) return null;
  if (buf.readUInt32BE(0) === 0x89504e47) return { kind: 'png', size: pngSize(buf) };
  if (buf[0] === 0xff && buf[1] === 0xd8) return { kind: 'jpeg', size: jpegSize(buf) };
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') return { kind: 'gif', size: gifSize(buf) };
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP')
    return { kind: 'webp', size: webpSize(buf) };
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[3] === 0x00) return { kind: 'ico', size: icoSize(buf) };
  return null;
}

// ---------- 主流程 ----------

const files = readdirSync(DIR).filter((f) => !f.startsWith('.'));
const rows = [];

for (const f of files) {
  const p = `${DIR}/${f}`;
  const ext = f.split('.').pop().toLowerCase();
  if (ext === 'svg') {
    const text = readFileSync(p, 'utf8');
    const s = svgSize(text);
    const ar = s && s.h ? +(s.w / s.h).toFixed(2) : null;
    rows.push({
      f,
      vec: true,
      size: s ? `${s.w}×${s.h}` : '—',
      ar,
      // 1:1 画布极可能是「未裁的画布」（见文件头注释）
      suspectSquare: ar !== null && Math.abs(ar - 1) < 0.02,
      note: s ? `矢量（viewBox 宽高比 ${ar}）` : '矢量（无 viewBox）',
    });
    continue;
  }
  const buf = readFileSync(p);
  const d = detect(buf);
  if (!d || !d.size) {
    rows.push({ f, size: '—', note: '无法识别尺寸' });
    continue;
  }
  const h = d.size.h;
  rows.push({
    f,
    size: `${d.size.w}×${h}`,
    h,
    bpp: d.size.bpp,
    frames: d.kind === 'ico' ? `（最大帧${d.size.bpp ? ` ${d.size.bpp}bpp` : ''}）` : '',
    note: h >= NEED ? `够（${h}px）` : `缺 ${(NEED / h).toFixed(2)}×`,
    ok: h >= NEED,
  });
}

rows.sort((a, b) => {
  if (a.vec !== b.vec) return a.vec ? -1 : 1;
  if (a.vec && b.vec) return (a.ar ?? 0) - (b.ar ?? 0);
  return (a.h ?? 0) - (b.h ?? 0);
});

console.log(`目录：${DIR}\n`);
console.log('文件'.padEnd(34) + '尺寸'.padEnd(15) + '判定');
console.log('-'.repeat(92));
for (const r of rows) {
  const flag = r.vec ? '◆' : r.ok ? '✔' : '✘';
  console.log(r.f.padEnd(34) + (r.size + (r.frames ?? '')).padEnd(15) + `${flag} ${r.note}`);
}

const bad = rows.filter((r) => !r.vec && !r.ok);
const squareSvg = rows.filter((r) => r.vec && r.suspectSquare);

/**
 * ⚠️ 必须区分「真的不够」与「被同名的更优格式覆盖」。
 *
 * 前端的取图逻辑（`PartnerLogos.tsx` 的 `EXT_RANK`）在**同名多格式**时按
 * svg > png/webp > jpeg/jpg > gif > ico 裁定，只留最优的一份。
 * 所以 `同花顺公司.ico`（16×16）虽然不达标，但因为存在 `同花顺公司.png`，
 * 它**永远不会上墙** —— 报成「需换源」会让人白做功。
 */
const RANK = { svg: 0, png: 1, webp: 1, jpeg: 2, jpg: 2, gif: 3, ico: 4 };
const byBase = new Map();
for (const r of rows) {
  const base = r.f.replace(/\.[^.]+$/, '');
  const rank = RANK[r.f.split('.').pop().toLowerCase()] ?? 9;
  if (!byBase.has(base)) byBase.set(base, []);
  byBase.get(base).push({ ...r, rank });
}
for (const r of bad) {
  const base = r.f.replace(/\.[^.]+$/, '');
  const group = byBase.get(base) ?? [];
  const winner = group.sort((a, b) => a.rank - b.rank)[0];
  if (winner && winner.f !== r.f && (winner.vec || winner.ok)) {
    r.shadowedBy = winner.f;
  }
}

const realBad = bad.filter((r) => !r.shadowedBy);
const shadowed = bad.filter((r) => r.shadowedBy);

console.log(`\n合计 ${rows.length} 个`);
if (realBad.length) {
  console.log(`\n分辨率不足（位图）${realBad.length} 个 —— 需要换更大的源：`);
  for (const b of realBad) console.log(`  · ${b.f}  ${b.size}  ${b.note}`);
}
if (shadowed.length) {
  console.log(`\n以下 ${shadowed.length} 个虽不达标，但被同名的更优格式覆盖，**不影响展示**，无需处理：`);
  for (const s of shadowed) console.log(`  · ${s.f}（${s.size}）→ 实际取用 ${s.shadowedBy}`);
}
if (squareSvg.length) {
  console.log(
    `\n⚠️ ${squareSvg.length} 个 svg 是 1:1 画布，八成是「画布没裁」而不该换图：\n` +
      squareSvg.map((s) => `  · ${s.f}`).join('\n') +
      `\n  修法：node server/scripts/tighten-logo-viewbox.mjs`
  );
}
console.log('\n◆ 矢量  ✔ 达标  ✘ 需换源');
