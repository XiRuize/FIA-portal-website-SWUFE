/**
 * 股票代码与市场识别、腾讯符号转换、腾讯快照解析。
 *
 * 拆成独立模块是为了让「纯解析逻辑」可被单元测试直接覆盖（不需要起服务、不需要网络）。
 */

/**
 * 根据 6 位代码判断交易所。
 * - 6 开头 → 上交所（sh）
 * - 0/3 开头 → 深交所（sz）
 * - 8/4 开头 → 北交所（bj）
 * - 5/1 开头 → 上交所基金/债券（sh）
 *
 * @param {string} code
 * @returns {{ market: 'sh'|'sz'|'bj', code: string } | null}
 */
export function detectMarket(code) {
  const c = String(code ?? '').trim();
  if (!/^\d{6}$/.test(c)) return null;
  const head = c[0];
  if (head === '6' || head === '5' || head === '1') return { market: 'sh', code: c };
  if (head === '0' || head === '3' || head === '2') return { market: 'sz', code: c };
  if (head === '8' || head === '4') return { market: 'bj', code: c };
  return null;
}

/**
 * 转成腾讯行情用的符号（sh600702 / sz000001）。
 * 若传入的已经是带前缀的符号则原样返回。
 * @param {string} code
 */
export function toTencentSymbol(code) {
  const c = String(code ?? '').trim().toLowerCase();
  if (/^(sh|sz|bj)\d{6}$/.test(c)) return c;
  const detected = detectMarket(c);
  if (!detected) throw new Error(`无法识别的股票代码：${code}`);
  return `${detected.market}${detected.code}`;
}

/**
 * 解析腾讯实时快照。
 *
 * 返回形如：
 *   v_sh600702="1~舍得酒业~600702~32.48~33.38~33.20~45322~18655~26667~32.48~..."
 *
 * 字段下标（0 基）：
 *   1 名称 | 2 代码 | 3 最新价 | 4 昨收 | 5 今开 | 6 成交量(手) |
 *   30 时间戳(yyyyMMddHHmmss) | 31 涨跌额 | 32 涨跌幅% | 33 最高 | 34 最低 |
 *   35 `价格/成交量(手)/成交额(元)` 打包串 | 37 成交额(万元) |
 *   38 换手率% | 43 振幅% | 44 流通市值(亿) | 45 总市值(亿)
 *
 * ⚠️ **成交量单位是「手」不是「股」**。实测校验：45322 手 × 100 股 × 32.48 元
 * ≈ 1.47 亿元，与同一条快照里的成交额 148,687,799 元吻合；若按「股」理解会差 100 倍。
 * 前端展示必须带单位，否则「45322」会被读者误读成股数。
 *
 * @param {string} text 已解码为 UTF-8 的文本
 * @param {string} symbol sh600702
 * @returns {null | { code, name, price, prevClose, open, high, low, volume, amount, amplitude, turnoverRate, change, changePct, date }}
 */
export function parseTencentSnapshot(text, symbol) {
  const match = /v_([a-z]{2}\d{6})="([^"]*)"/i.exec(String(text ?? ''));
  if (!match) return null;
  const payload = match[2];
  if (!payload) return null;

  const parts = payload.split('~');
  const price = num(parts[3]);
  const prevClose = num(parts[4]);
  const open = num(parts[5]) || price;
  const stamp = String(parts[30] ?? '');

  // 涨跌额/涨跌幅优先用接口给的值，缺失时自行计算
  let change = num(parts[31]);
  let changePct = num(parts[32]);
  if (!change && prevClose) change = round2(price - prevClose);
  if (!changePct && prevClose) changePct = round2(((price - prevClose) / prevClose) * 100);

  return {
    code: String(parts[2] ?? symbol.slice(2)),
    name: String(parts[1] ?? ''),
    price,
    prevClose,
    open,
    high: num(parts[33]) || Math.max(open, price),
    low: num(parts[34]) || Math.min(open, price),
    volume: num(parts[6]),
    amount: pickTencentAmount(parts),
    // 振幅直接取源值：它是 (最高-最低)/昨收×100，用昨收作分母；
    // 早先前端自己按「/今收」算，与行业口径不一致（同一只票会差零点几个百分点）。
    amplitude: num(parts[43]),
    turnoverRate: num(parts[38]),
    change,
    changePct,
    date: /^\d{8}/.test(stamp)
      ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`
      : '',
  };
}

/**
 * 从腾讯快照字段数组里取「成交额」，单位**元**。
 *
 * 快照里有两处可取值，优先用精度高的那个：
 * 1. `parts[35]` 是 `价格/成交量(手)/成交额(元)` 的打包串，第三段就是元（实测 `32.48/45322/148687799`）；
 * 2. `parts[37]` 是成交额（万元）的整数形式，四舍五入后精度低一档，作为退路。
 *
 * 为什么值得单开一个函数：腾讯的**日 K 接口根本不返回成交额**（只有开/收/高/低/量六列），
 * 所以「成交额」这一项只能借快照补。这个取值逻辑原先散落在快照解析里，
 * 现在提出来给日 K 复用 —— 否则日 K 里的成交额恒为 0，看板上直接显示成 `0`。
 *
 * @param {string[]} parts 快照 `~` 分隔字段
 * @returns {number} 元；取不到时返回 0
 */
export function pickTencentAmount(parts) {
  const packed = String(parts?.[35] ?? '').split('/');
  if (packed.length >= 3) {
    const yuan = num(packed[2]);
    if (yuan > 0) return Math.round(yuan);
  }
  const wan = num(parts?.[37]);
  return wan > 0 ? Math.round(wan * 10_000) : 0;
}

/**
 * 把腾讯返回里的 `\uXXXX` 转义还原成真实字符。
 *
 * 腾讯的联想接口（smartbox）虽然按 GBK 编码传输，但中文**并不直接是 GBK 字节**，
 * 而是被写成 ASCII 的 `\u820d\u5f97\u9152\u4e1a` 形式。若只做 GBK 解码，
 * 界面上会原样显示一串 `\uXXXX`，看起来像「接口坏了」，实则是漏了一步反转义。
 *
 * @param {string} text
 * @returns {string}
 */
export function unescapeUnicodeEscapes(text) {
  return String(text ?? '').replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}

/**
 * 判断一个「市场~代码~名称~拼音~类型」条目是不是**A 股个股**。
 *
 * 联想接口会一并返回港股/美股、ETF、LOF、REIT、权证乃至指数，
 * 而本站行情终端的其余部分（`detectMarket`、日 K 源）只支持沪深北 A 股 6 位代码。
 * 若不过滤，用户搜「平安」会看到「平安好医生(港股)」，选中后取数必然失败。
 *
 * 类型码实测取值：`GP-A`（A 股）、`GP`（港/美普通股）、`FJ`（封闭基金/REIT）、
 * `LOF`、`QZ`（权证）、`ZS`（指数）。这里只认 `GP-A`。
 *
 * @param {{ market: string, type: string }} item
 */
export function isAShareQuotable(item) {
  const market = String(item?.market ?? '').toLowerCase();
  const type = String(item?.type ?? '').toUpperCase();
  return (market === 'sh' || market === 'sz' || market === 'bj') && type === 'GP-A';
}

/**
 * 解析腾讯联想（smartbox）响应。
 *
 * 原始文本形如：
 *   v_hint="sh~600702~\u820d\u5f97\u9152\u4e1a~sdjy~GP-A^sz~000001~\u5e73\u5b89\u94f6\u884c~payh~GP-A"
 *
 * 多个候选以 `^` 分隔，字段以 `~` 分隔：
 *   0 市场 | 1 代码 | 2 名称 | 3 拼音简写 | 4 类型码
 *
 * @param {string} text 已解码（GBK 或 latin1）后的文本
 * @returns {Array<{ market: string, code: string, name: string, pinyin: string, type: string }>}
 */
export function parseSmartboxHints(text) {
  const match = /v_hint="([^"]*)"/i.exec(String(text ?? ''));
  if (!match) return [];
  const payload = unescapeUnicodeEscapes(match[1]);
  if (!payload) return [];

  const out = [];
  for (const chunk of payload.split('^')) {
    const parts = chunk.split('~');
    if (parts.length < 3) continue;
    const market = String(parts[0] ?? '').toLowerCase();
    const code = String(parts[1] ?? '').trim();
    const name = String(parts[2] ?? '').trim();
    if (!market || !code || !name) continue;
    out.push({
      market,
      code,
      name,
      pinyin: String(parts[3] ?? '').trim(),
      type: String(parts[4] ?? '').trim(),
    });
  }
  return out;
}

/**
 * 由股票代码派生一个**稳定的**客户端指纹用种子（仅测试与演示数据使用）。
 * @param {string} code
 */
export function seedOf(code) {
  let h = 2166136261;
  for (let i = 0; i < code.length; i += 1) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round(n * 100) / 100;
