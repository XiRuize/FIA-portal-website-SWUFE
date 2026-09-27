/**
 * 纯逻辑单元测试：不含网络、不起服务。
 *
 * 覆盖：
 *  - 股票代码识别与腾讯符号转换
 *  - 腾讯快照 / K线解析（含 GBK 解码）
 *  - 口令哈希与校验（scrypt，含强度校验）
 *  - 中文文件名 Content-Disposition 编码（RFC 5987）
 *  - Range 请求解析
 *  - 点赞指纹稳定性
 *
 * 运行：node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { detectMarket, toTencentSymbol, parseTencentSnapshot } from '../src/lib/symbols.js';
import { decodeGbk, parseTencentKlines, parseFreeStockdbKlines } from '../src/lib/stock.js';
import { isLibraryItem, NON_LIBRARY_DIRS } from '../src/lib/categorize.js';
import {
  hashPassword,
  verifyPassword,
  checkPasswordStrength,
  MIN_PASSWORD_LENGTH,
} from '../src/lib/password.js';
import { contentDisposition, parseRange, sniffMime } from '../src/lib/resources.js';
import { fingerprintOf } from '../src/lib/fingerprint.js';

/* ─────────────────────────── 股票代码 ─────────────────────────── */

test('detectMarket：按首位数字识别交易所', () => {
  assert.deepEqual(detectMarket('600702'), { market: 'sh', code: '600702' });
  assert.deepEqual(detectMarket('000001'), { market: 'sz', code: '000001' });
  assert.deepEqual(detectMarket('300750'), { market: 'sz', code: '300750' });
  assert.deepEqual(detectMarket('830799'), { market: 'bj', code: '830799' });
  // 非法输入
  assert.equal(detectMarket('60070'), null, '5 位应判非法');
  assert.equal(detectMarket('abcdef'), null, '非数字应判非法');
  assert.equal(detectMarket(''), null, '空串应判非法');
});

test('toTencentSymbol：6 位代码补市场前缀，已带前缀则原样返回', () => {
  assert.equal(toTencentSymbol('600702'), 'sh600702');
  assert.equal(toTencentSymbol('000001'), 'sz000001');
  // 幂等：已是腾讯符号不应被二次加前缀
  assert.equal(toTencentSymbol('sh600702'), 'sh600702');
  assert.equal(toTencentSymbol('SH600702'), 'sh600702', '应大小写不敏感');
  // 非法代码应抛错（由路由层转成 400）
  assert.throws(() => toTencentSymbol('99999'), /无法识别/);
});

test('parseTencentSnapshot：正确解析快照字段与涨跌幅', () => {
  // 形如 v_sh600702="1~舍得酒业~600702~32.48~33.38~33.20~...~20260924150000~-0.90~-2.70~33.48~32.48~"
  const parts = new Array(40).fill('');
  parts[0] = '1';
  parts[1] = '舍得酒业';
  parts[2] = '600702';
  parts[3] = '32.48';
  parts[4] = '33.38';
  parts[5] = '33.20';
  parts[6] = '45322';
  parts[30] = '20260924150000';
  parts[31] = '-0.90';
  parts[32] = '-2.70';
  parts[33] = '33.48';
  parts[34] = '32.48';
  const text = `v_sh600702="${parts.join('~')}";`;

  const snap = parseTencentSnapshot(text, 'sh600702');
  assert.ok(snap, '应解析成功');
  assert.equal(snap.name, '舍得酒业');
  assert.equal(snap.price, 32.48);
  assert.equal(snap.prevClose, 33.38);
  assert.equal(snap.changePct, -2.7);
  assert.equal(snap.low, 32.48);

  // 非法输入不应抛异常，而是返回 null
  assert.equal(parseTencentSnapshot('garbage', 'sh600702'), null);
  assert.equal(parseTencentSnapshot('', 'sh600702'), null);
});

test('parseTencentSnapshot：接口未给涨跌幅时按昨收自算', () => {
  const parts = new Array(40).fill('');
  parts[1] = '某股票';
  parts[3] = '11';
  parts[4] = '10';
  parts[5] = '10';
  const snap = parseTencentSnapshot(`v_sh600000="${parts.join('~')}";`, 'sh600000');
  assert.ok(snap);
  assert.equal(snap.changePct, 10, '涨幅应为 (11-10)/10 = 10%');
});

test('decodeGbk：腾讯快讯为 GBK，应能正确转 UTF-8 中文', () => {
  // "舍得酒业" 的 GBK 字节
  const gbk = Buffer.from([0xc9, 0xe1, 0xb5, 0xc3, 0xbe, 0xc6, 0xd2, 0xb5]);
  const out = decodeGbk(gbk);
  assert.equal(out.text, '舍得酒业');
  assert.equal(out.encoding, 'gbk');
  // 纯 ASCII 应原样通过
  const ascii = decodeGbk(Buffer.from('sh600702'));
  assert.equal(ascii.text, 'sh600702');
});

/* ───────────────────────── 行情 K 线解析 ───────────────────────── */

test('parseTencentKlines：解析腾讯日K（列序 date/open/close/high/low/volume）', () => {
  // 腾讯 qfqday 列序为 [日期, 开, 收, 高, 低, 量]，收盘价在下标 2
  const symbol = 'sh600702';
  const payload = {
    data: {
      [symbol]: {
        qfqday: [
          ['2026-09-23', '33.52', '33.38', '34.34', '33.24', '67108'],
          ['2026-09-24', '33.20', '32.48', '33.48', '32.48', '45322'],
        ],
        qt: { [symbol]: ['1', '舍得酒业'] },
      },
    },
  };
  const out = parseTencentKlines(payload, symbol);
  assert.equal(out.klines.length, 2);
  assert.equal(out.name, '舍得酒业', '应从 qt 快照取到名称');
  const last = out.klines[1];
  assert.equal(last.date, '2026-09-24');
  assert.equal(last.open, 33.2);
  assert.equal(last.close, 32.48, '收盘价应取自下标 2');
  assert.equal(last.high, 33.48);
  assert.equal(last.low, 32.48);
  assert.equal(last.volume, 45322);
});

test('parseTencentSnapshot：成交额从打包串取元值，缺失时回落万元字段', () => {
  // 下标 35 是 `价格/成交量(手)/成交额(元)`；下标 37 是成交额(万元)
  const packed = new Array(45).fill('');
  packed[35] = '32.48/45322/148687799';
  const fromPacked = parseTencentSnapshot(`v_sh600702="${packed.join('~')}";`, 'sh600702');
  assert.equal(fromPacked.amount, 148687799, '应优先取打包串里的元值');

  const wanOnly = new Array(45).fill('');
  wanOnly[37] = '14869';
  const fromWan = parseTencentSnapshot(`v_sh600702="${wanOnly.join('~')}";`, 'sh600702');
  assert.equal(fromWan.amount, 148690000, '打包串缺失时应回落 万元 × 10000');

  const none = new Array(45).fill('');
  const empty = parseTencentSnapshot(`v_sh600702="${none.join('~')}";`, 'sh600702');
  assert.equal(empty.amount, 0, '两处都没有时返回 0，由调用方决定展示');
});

test('parseTencentKlines：用同响应的 qt 快照补齐最后一天成交额（日K本身不含成交额）', () => {
  // 回归：腾讯日 K 只有 开/收/高/低/量 六列，成交额恒为 0，
  // 看板因此一直显示「0」。同一响应体内其实带着 qt 快照，直接借用即可。
  const symbol = 'sh600702';
  const qt = new Array(45).fill('');
  qt[1] = '舍得酒业';
  qt[30] = '20260924161456'; // 14 位时间戳，必须与最后一条 K 线同日
  qt[35] = '32.48/45322/148687799';
  const payload = {
    data: {
      [symbol]: {
        qfqday: [
          ['2026-09-23', '33.52', '33.38', '34.34', '33.24', '67108'],
          ['2026-09-24', '33.20', '32.48', '33.48', '32.48', '45322'],
        ],
        qt: { [symbol]: qt },
      },
    },
  };

  const out = parseTencentKlines(payload, symbol);
  assert.equal(out.klines[1].amount, 148687799, '最后一天应补上真实成交额');
  assert.equal(out.klines[0].amount, 0, '历史成交额该源给不出，保持 0 而不是编一个估值');
});

test('parseTencentKlines：快照与最后一条K线不同日时不得贴错成交额', () => {
  // 快照永远反映最近一个交易日。若最后一条 K 线不是同一天（停牌 / 数据滞后），
  // 把今天的成交额贴到昨天的 K 线上就是错上加错，宁可留空。
  const symbol = 'sh600702';
  const qt = new Array(45).fill('');
  qt[30] = '20260925100000';
  qt[35] = '32.48/45322/148687799';
  const payload = {
    data: {
      [symbol]: {
        qfqday: [['2026-09-24', '33.20', '32.48', '33.48', '32.48', '45322']],
        qt: { [symbol]: qt },
      },
    },
  };
  const out = parseTencentKlines(payload, symbol);
  assert.equal(out.klines[0].amount, 0, '日期不一致时不应补值');
});

test('parseTencentKlines：脏数据应被跳过而不是崩溃', () => {
  const symbol = 'sh600702';
  const payload = { data: { [symbol]: { qfqday: [['bad'], ['2026-09-24', '1', '2', '3', '4', '5'], null] } } };
  const out = parseTencentKlines(payload, symbol);
  assert.equal(out.klines.length, 1, '仅保留合法行');
  // 缺失 symbol 应安全返回空
  assert.deepEqual(parseTencentKlines({}, 'sh000001').klines, []);
  assert.deepEqual(parseTencentKlines(null, 'sh000001').klines, []);
});

test('parseTencentKlines：停牌日高低为 0 时用开收盘兜底', () => {
  const symbol = 'sh600702';
  const payload = { data: { [symbol]: { qfqday: [['2026-09-24', '10', '12', '0', '0', '100']] } } };
  const [k] = parseTencentKlines(payload, symbol).klines;
  assert.equal(k.high, 12, 'high 为 0 时应回退为 max(open, close)');
  assert.equal(k.low, 10, 'low 为 0 时应回退为 min(open, close)');
});

test('parseFreeStockdbKlines：解析 free-stockdb 返回结构', () => {
  const payload = { data: [['2026-09-24', '33.20', '33.48', '32.48', '32.48', '45322']] };
  const out = parseFreeStockdbKlines(payload);
  assert.equal(out.length, 1);
  assert.equal(out[0].date, '2026-09-24');
  assert.equal(out[0].open, 33.2);
  assert.equal(out[0].high, 33.48);
  assert.equal(out[0].low, 32.48);
  assert.equal(out[0].close, 32.48);
});

test('parseFreeStockdbKlines：对象形式（含中文字段）也能解析', () => {
  const payload = { data: [{ 日期: '2026-09-24', 开盘: 33.2, 最高: 33.48, 最低: 32.48, 收盘: 32.48 }] };
  const out = parseFreeStockdbKlines(payload);
  assert.equal(out.length, 1);
  assert.equal(out[0].close, 32.48);
  assert.equal(out[0].date, '2026-09-24');
});

/* ─────────────────────────── 口令安全 ─────────────────────────── */

test('hashPassword / verifyPassword：口令不落明文且校验正确', () => {
  const plain = 'Fia@Admin2026';
  const stored = hashPassword(plain);

  assert.equal(typeof stored, 'string', '应返回可入库的字符串');
  assert.ok(stored.startsWith('scrypt$'), '应带算法前缀，便于日后迁移');
  assert.equal(stored.split('$').length, 6, '应为 scrypt$N$r$p$salt$hash 六段');
  assert.ok(!stored.includes(plain), '哈希串中不得含明文片段');

  assert.equal(verifyPassword(plain, stored), true, '正确口令应通过');
  assert.equal(verifyPassword('wrong-password', stored), false, '错误口令应拒绝');
  assert.equal(verifyPassword('', stored), false, '空口令应拒绝');
});

test('hashPassword：相同口令两次哈希结果不同（加盐）', () => {
  const a = hashPassword('SamePassword123');
  const b = hashPassword('SamePassword123');
  assert.notEqual(a, b, '应为随机盐，两次结果不同');
  // 但都能校验通过
  assert.equal(verifyPassword('SamePassword123', a), true);
  assert.equal(verifyPassword('SamePassword123', b), true);
  // 盐段也应不同
  assert.notEqual(a.split('$')[4], b.split('$')[4], '盐应随机');
});

test('verifyPassword：结构与参数不符的记录应安全返回 false，不抛异常', () => {
  assert.equal(verifyPassword('x', null), false);
  assert.equal(verifyPassword('x', ''), false);
  assert.equal(verifyPassword('x', 'not-a-hash'), false);
  assert.equal(verifyPassword('x', 'scrypt$1$2'), false, '段数不足应拒绝');
  assert.equal(verifyPassword('x', 'bcrypt$16384$8$1$abc$def'), false, '算法不符应拒绝');
  assert.equal(verifyPassword(null, hashedProbe()), false, '非字符串口令应拒绝');
});

/** 生成一个合法哈希供上面用例对比 */
function hashedProbe() {
  return hashPassword('probe-password-123');
}

test('checkPasswordStrength：拒绝弱口令', () => {
  assert.ok(MIN_PASSWORD_LENGTH >= 8, '最小长度不应低于 8');
  assert.equal(checkPasswordStrength('123456').ok, false, '纯数字弱口令应拒绝');
  assert.equal(checkPasswordStrength('password').ok, false, '字典弱口令应拒绝');
  const strong = checkPasswordStrength('Fia@Admin2026');
  assert.equal(strong.ok, true, '足够复杂的口令应通过');
});

test('checkPasswordStrength：演示口令豁免是白名单，不放宽全局下限', () => {
  // 评审账号 <已清除> 只有 7 位，必须能通过 —— 否则新建/改密路径会拒绝它
  assert.equal(checkPasswordStrength('<已清除>').ok, true, '演示口令应被放行');

  // 豁免必须逐条列举，不能顺手把下限降到 7：
  // 下面这些同样是 7 位或更短，但都**不能**因为豁免而混进来
  for (const p of ['1234567', 'password', 'admin12', 'swufe26', 'FIA202']) {
    assert.equal(checkPasswordStrength(p).ok, false, `${p} 不应被豁免`);
  }
  // 8 位仍走常规路径：字典口令继续拒绝
  assert.equal(checkPasswordStrength('admin123').ok, false, '8 位字典口令仍应拒绝');
});

/* ─────────────────── 中文文件名与 Range ─────────────────── */

test('contentDisposition：中文文件名走 RFC 5987，且保留 ASCII 回退', () => {
  const header = contentDisposition('26金投介绍.pdf', 'attachment');

  assert.ok(header.startsWith('attachment;'), '应含 disposition 类型');
  assert.ok(header.includes("filename*=UTF-8''"), '应含 RFC 5987 的 filename*');
  // 中文需被百分号编码
  const encoded = decodeURIComponent(header.split("filename*=UTF-8''")[1]);
  assert.equal(encoded, '26金投介绍.pdf', '解码后应还原原始文件名');
  // ASCII 回退不得含中文
  const ascii = /filename="([^"]*)"/.exec(header)?.[1] ?? '';
  assert.ok(!/[\u4e00-\u9fa5]/.test(ascii), 'ASCII 回退不应含中文');
  // 文件名中的引号必须转义，避免头注入
  const risky = contentDisposition('a"b.pdf', 'attachment');
  const riskyAscii = /filename="([^"]*)"/.exec(risky)?.[1] ?? '';
  assert.ok(!riskyAscii.includes('"'), '引号应被替换，防止头注入');
});

test('contentDisposition：inline 用于预览', () => {
  assert.ok(contentDisposition('x.pdf', 'inline').startsWith('inline;'));
});

test('parseRange：正确解析单段 Range，非法输入返回 null', () => {
  const total = 1000;
  // 返回 { start, end }（闭区间），长度由 end-start+1 得
  assert.deepEqual(parseRange('bytes=0-99', total), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=900-', total), { start: 900, end: 999 });
  // 结束位越界应被夹到文件尾
  assert.deepEqual(parseRange('bytes=0-99999', total), { start: 0, end: 999 });
  // 后缀形式 bytes=-100 → 最后 100 字节
  assert.deepEqual(parseRange('bytes=-100', total), { start: 900, end: 999 });
  // 非法 Range 应返回 null（由调用方回退为整文件 200）
  assert.equal(parseRange('bytes=abc', total), null);
  assert.equal(parseRange('bytes=500-100', total), null, 'start > end 应拒绝');
  assert.equal(parseRange('bytes=1000-', total), null, 'start 超出文件尾应拒绝');
  assert.equal(parseRange('bytes=0-99,200-299', total), null, '多段 Range 不支持应拒绝');
  assert.equal(parseRange('', total), null);
  assert.equal(parseRange(undefined, total), null);
});

/* ─────────────────────────── 指纹 ─────────────────────────── */

test('fingerprintOf：同一来源稳定、不同来源可区分', () => {
  const secret = 'test-secret-fixed';
  const a = fingerprintOf({ ip: '1.2.3.4', userAgent: 'UA-A', secret });
  const aAgain = fingerprintOf({ ip: '1.2.3.4', userAgent: 'UA-A', secret });
  const differentIp = fingerprintOf({ ip: '5.6.7.8', userAgent: 'UA-A', secret });
  const differentUa = fingerprintOf({ ip: '1.2.3.4', userAgent: 'UA-B', secret });

  assert.equal(a, aAgain, '同一来源指纹应稳定（点赞去重依赖此性质）');
  assert.notEqual(a, differentIp, '不同 IP 应产生不同指纹');
  assert.notEqual(a, differentUa, '不同 UA 应产生不同指纹');
  assert.equal(a.length, 32, '应为 32 位十六进制');
  assert.ok(/^[0-9a-f]{32}$/.test(a), '应只含十六进制字符');
});

test('fingerprintOf：不同密钥下同一来源指纹不同（防伪造）', () => {
  const x = fingerprintOf({ ip: '1.2.3.4', userAgent: 'UA-A', secret: 'secret-1' });
  const y = fingerprintOf({ ip: '1.2.3.4', userAgent: 'UA-A', secret: 'secret-2' });
  assert.notEqual(x, y, '密钥变化应改变指纹，避免离线伪造');
});

// ---------------------------------------------------------------------------
// 文件类型嗅探
//
// 背景：素材目录里确实存在「扩展名与真实格式不符」的文件
// （实测 `腾讯.png` 的字节头是 `ff d8 ff e0`，即 JPEG）。
// 若只信扩展名，响应头会回 image/png 而内容是 JPEG，
// 在严格模式与 CDN 缓存协商下会出问题。以下用例锁定这一行为。
// ---------------------------------------------------------------------------

test('sniffMime：按魔数识别常见图片与 PDF', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
  const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

  assert.equal(sniffMime(jpeg), 'image/jpeg', 'JPEG 头应识别为 image/jpeg');
  assert.equal(sniffMime(png), 'image/png', 'PNG 头应识别为 image/png');
  assert.equal(sniffMime(gif), 'image/gif', 'GIF 头应识别为 image/gif');
  assert.equal(sniffMime(pdf), 'application/pdf', 'PDF 头应识别为 application/pdf');
});

// ---------------------------------------------------------------------------
// ICO 魔数：logo/ 素材目录里有 9 个 .ico（16~48px 的 favicon 来源）。
// 早期 sniffMime 没有这一段、MIME_BY_EXT 里也没有 'ico'，于是这些素材
// 一律以 `application/octet-stream` 下发 —— 浏览器靠内容嗅探仍能渲染，
// 但语义错误，且严格模式 / CDN 缓存协商下会出问题。
// ---------------------------------------------------------------------------
test('sniffMime：识别 ICO / CUR', () => {
  // ICO 头：00 00 01 00（保留位 + 类型 1 = 图标）
  const ico = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10]);
  // CUR 头：00 00 02 00（类型 2 = 光标）
  const cur = Buffer.from([0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x20, 0x20]);

  assert.equal(sniffMime(ico), 'image/x-icon', 'ICO 头应识别为 image/x-icon');
  assert.equal(sniffMime(cur), 'image/x-icon', 'CUR 头应识别为 image/x-icon');
  // 字节序陷阱：若把魔数当成 32 位小端 0x00010000 比较，这两个都会被漏掉。
  // 反向用例确保不会把别的格式误判成 ICO。
  assert.equal(sniffMime(Buffer.from([0x01, 0x00, 0x00, 0x00, 0, 0, 0, 0])), null);
});

test('sniffMime：识别压缩包格式', () => {  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  const rar = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
  const sevenZ = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0]);

  assert.equal(sniffMime(zip), 'application/zip');
  assert.equal(sniffMime(rar), 'application/vnd.rar');
  assert.equal(sniffMime(sevenZ), 'application/x-7z-compressed');
});

test('sniffMime：WEBP 需要读到第 12 字节才能确认', () => {
  const riffOnly = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x42, 0x43, 0x44,
  ]);
  const webp = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
  ]);
  assert.equal(sniffMime(riffOnly), null, '仅 RIFF 头不足以判定为 WEBP');
  assert.equal(sniffMime(webp), 'image/webp');
});

test('sniffMime：无法识别与过短的输入返回 null（由调用方回落扩展名）', () => {
  assert.equal(sniffMime(Buffer.from([1, 2, 3])), null, '不足 4 字节应返回 null');
  assert.equal(sniffMime(Buffer.alloc(0)), null, '空输入应返回 null');
  assert.equal(sniffMime(null), null, 'null 输入不应抛异常');
  assert.equal(
    sniffMime(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05])),
    null,
    '未知格式应返回 null'
  );
});

// ---------------------------------------------------------------------------
// 非资料目录（logo）的放行规则
// ---------------------------------------------------------------------------

/**
 * 这一组测试守住一个**曾经真实发生的缺陷**：
 *
 * `resources.list()` 末尾按 `isLibraryItem()` 剔除 logo，但路由层从不转发
 * `includeNonLibrary`，于是 `category=logo` 被无条件滤空 —— 首页「会友去向」
 * 拿到 0 条数据后 `return null`，整个版块静默消失，且**没有任何报错**。
 *
 * 修复方式是：`category` 显式点名某个非资料目录时予以放行（窄授权），
 * 同时保留 `excludeNonLibrary` 作为更高优先级的强制排除（路由层默认走这条）。
 * 下面的断言把这四条规则的优先级钉死。
 */
test('isLibraryItem：logo 属于非资料目录，其余目录是资料条目', () => {
  assert.equal(isLibraryItem('logo'), false, 'logo 不是资料库条目');
  assert.equal(isLibraryItem('研发部内部资料'), true);
  assert.equal(isLibraryItem('培训部分享资料'), true);
  assert.equal(NON_LIBRARY_DIRS.has('logo'), true);
});

test('资源过滤器：默认排除 logo，点名 category=logo 才放行', async () => {
  const { promises: fsp } = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const { openDatabase } = await import('../src/lib/db.js');
  const { createResourceService } = await import('../src/lib/resources.js');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fia-logo-'));
  // ★ 用生产环境的 openDatabase(':memory:') 建库，而不是手写 CREATE TABLE。
  // 手写 schema 会随生产表结构演进漂移（本次首版就漏了 resource_likes 表，
  // 报 'no such table'），复用真实建库函数则永远同步。
  const db = openDatabase(':memory:');

  const ins = db.prepare(
    `INSERT INTO resources
       (id, rel_path, name, file_name, category_dir, display_category, ext, size_bytes, mtime,
        kind, access_level, sort_index, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const MT = '2026-01-01T00:00:00.000Z';
  const row = (id, relPath, name, categoryDir, ext, kind, displayCategory) => [
    id, relPath, name, `${name}.${ext}`, categoryDir, displayCategory, ext, 100, MT,
    kind, 'public', 100, MT, MT,
  ];
  ins.run(...row(1, 'logo/中国银行.svg', '中国银行', 'logo', 'svg', 'image', '研报'));
  ins.run(
    ...row(2, '研发部内部资料/深度报告.pdf', '深度报告', '研发部内部资料', 'pdf', 'pdf', '研报')
  );

  const store = createResourceService(db, { materialsDir: dir });

  const all = store.list({});
  assert.equal(all.length, 1, '默认视图只应有资料条目');
  assert.ok(
    all.every((r) => r.category_dir !== 'logo'),
    '默认视图绝不能出现 logo —— 这是第一轮「公司 logo 不进资料与数据」的硬约束'
  );

  const named = store.list({ category: 'logo' });
  assert.equal(named.length, 1, '点名 category=logo 应放行');
  assert.equal(named[0].name, '中国银行');

  const excluded = store.list({ category: 'logo', excludeNonLibrary: true });
  assert.equal(excluded.length, 0, 'excludeNonLibrary 优先级高于点名放行');

  const global = store.list({ includeNonLibrary: true });
  assert.equal(global.length, 2, 'includeNonLibrary 敞开所有目录（仅调试用）');

  db.close();
  await fsp.rm(dir, { recursive: true, force: true });
});
