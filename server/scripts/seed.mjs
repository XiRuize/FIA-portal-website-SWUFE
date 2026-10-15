#!/usr/bin/env node
/**
 * 初始化种子数据：创建初始管理员账号 + 初始临时浏览账号 + 站点配置默认值。
 *
 * 幂等：账号已存在时**不会**覆盖其口令（避免把线上密码重置回示例值），
 * 只提示「已存在，跳过」。要重置口令请用 `--reset-password` 显式指定。
 *
 * 用法：
 *   node scripts/seed.mjs
 *   node scripts/seed.mjs --reset-password    # 强制把种子账号口令重置为 .env 里的值
 *
 * 账号口令来源：server/.env（参考 .env.example）。
 *
 * ⚠️ 管理账号**没有内置默认口令**：缺失配置时本脚本直接报错退出，
 *    不会回落到任何已知口令 —— 理由见下方 REQUIRED_ENV_KEYS 处。
 */
import { buildConfig, createEnv } from '../src/lib/env.js';
import { openDatabase, plain } from '../src/lib/db.js';
import { ROLE_ADMIN, ROLE_VIEWER } from '../src/lib/accounts.js';
import { hashPasswordAsync, checkPasswordStrength } from '../src/lib/password.js';

const env = createEnv();
const config = buildConfig(env);
const resetPassword = process.argv.includes('--reset-password');

/**
 * 账号名脱敏：仅回显首尾各 1 个字符。
 * 种子脚本**不得**把口令写到 stdout——一旦被日志采集就等于泄露。
 */
function mask(name) {
  const s = String(name);
  if (s.length <= 2) return s[0] + '*';
  return s[0] + '*'.repeat(s.length - 2) + s[s.length - 1];
}

// ⚠️ 管理账号**没有内置默认口令**。
//
// 此前这里给出过一个「拿到就能进」的评审账号（账号与口令相同，且只有 7 位），
// 目的是让评审者免配置就能进后台。这个做法在**公开仓库**里不成立：
// 默认口令一旦随代码公开，就等于把后台入口一并公开 —— 只要部署时忘了配 .env，
// 它就会在生产环境真实生效。
//
// 因此改为「必须显式配置」：缺失即报错退出，绝不回落到任何已知口令。
const REQUIRED_ENV_KEYS = ['SEED_ADMIN_USERNAME', 'SEED_ADMIN_PASSWORD'];
const missingEnvKeys = REQUIRED_ENV_KEYS.filter((key) => !String(env.get(key, '')).trim());

if (missingEnvKeys.length > 0) {
  console.error('');
  console.error('❌ 缺少必填的种子账号配置：' + missingEnvKeys.join('、'));
  console.error('');
  console.error('   本项目不内置默认管理员口令。请先复制模板再填写：');
  console.error('     cp .env.example .env');
  console.error('');
  console.error('   至少要设这两项：');
  console.error('     SEED_ADMIN_USERNAME=<管理员账号名>');
  console.error('     SEED_ADMIN_PASSWORD=<建议 >=12 位，含大小写字母 / 数字 / 符号>');
  console.error('');
  console.error('   生成一个随机口令：');
  console.error("     node -e \"console.log(require('crypto').randomBytes(12).toString('base64url'))\"");
  console.error('');
  process.exit(1);
}

const adminUsername = String(env.get('SEED_ADMIN_USERNAME', '')).trim();
const adminPassword = String(env.get('SEED_ADMIN_PASSWORD', ''));

// 播种前先过一遍强度校验。本文件是**直接写库**的（绕过了服务层的
// createAccount），所以服务层那道校验在这里不会自动生效，必须显式补上 ——
// 否则「把弱口令写进生产库」就只靠调用方自觉了。
const adminStrength = checkPasswordStrength(adminPassword);
if (!adminStrength.ok) {
  console.error('');
  console.error(`❌ SEED_ADMIN_PASSWORD 未通过强度校验：${adminStrength.reason}`);
  console.error('   请换一个更长的口令（建议 >=12 位，含大小写字母 / 数字 / 符号）。');
  console.error('');
  process.exit(1);
}

// 临时浏览账号为**可选**：两项都配置了才创建；留空则跳过，不回落到任何已知口令。
const viewerUsername = String(env.get('SEED_VIEWER_USERNAME', '')).trim();
const viewerPassword = String(env.get('SEED_VIEWER_PASSWORD', ''));
const viewerEnabled = Boolean(viewerUsername && viewerPassword);
const viewerDays = env.int('SEED_VIEWER_DAYS', 30);
const viewerNote = env.get('SEED_VIEWER_NOTE', '临时浏览账号');

/** 站点配置默认值（与前端 siteConfig 的键名保持一致，便于逐键对照） */
const DEFAULT_SETTINGS = [
  ['site_name', '西南财经大学金融投资协会', 0],
  ['site_short_name', '西财金融投资协会', 0],
  ['site_slogan', '以研究立身 · 以投资会友', 0],
  ['about_title', '关于协会', 0],
  [
    'about_content',
    '西南财经大学金融投资协会（Financial Investment Association, FIA）成立于2002年9月，是由西南财经大学在校学生自发组织、面向全校同学的学术实践类社团。协会以「连接课堂与市场」为宗旨，通过行业研究、数据实践、模拟投资赛事与课程分享，帮助成员建立扎实的投研框架与风险意识。\n\n协会长期举办内部培训、读书会、研究报告评审与年度模拟投资大赛，并定期组织成员参访证券公司、基金公司与金融科技企业，为成员搭建从课堂知识到市场实践的桥梁。\n\n历经二十余年发展，协会累计发展会员2000余人，成员广泛就职于互联网、证券、银行、基金等领域的头部机构。',
    0,
  ],
  [
    'about_stats',
    '[{"label":"成立年份","value":"2002"},{"label":"累计会员","value":"2000+"},{"label":"会友机构","value":"300+"},{"label":"年度活动","value":"20+"}]',
    0,
  ],
  ['join_us', '招新面向全校本科生与研究生，不设专业限制。关注协会招新公告，或通过下方联系方式咨询。', 0],
  ['copyright', '© 西南财经大学金融投资协会', 0],
  ['contact_email', '', 0],
  ['contact_address', '', 0],
  [
    'stock_watchlist',
    '[{"code":"600702","name":"舍得酒业"},{"code":"600519","name":"贵州茅台"},{"code":"000001","name":"平安银行"},{"code":"000858","name":"五粮液"},{"code":"601318","name":"中国平安"},{"code":"300750","name":"宁德时代"}]',
    0,
  ],
  // 行情源：让前端指向同源代理，从而绕开 HTTPS 页面的混合内容拦截
  ['stock_api_base', '/api/stock', 0],
  // ⚠️ 以下为敏感键：永远不会下发访客（见 routes/settings.js）
  ['admin_passcode', '', 1],
];

const db = openDatabase(config.dbPath);
// 注意：播种刻意不走 createAccountService，而是直接写库。
// 原因是要把 password_changed_at 置为 NULL，以便前端能提醒「首次登录后必须改口令」，
// 而服务层的 createAccount() 会自动写入当前时间，表达不了这个状态。

console.log('─'.repeat(72));
console.log('初始化数据库：', config.dbPath);

/** 直接写库创建账号（绕过服务层，便于控制 password_changed_at = NULL） */
async function ensureAccount({ username, password, role, expiresAt, note, displayName }) {
  const existing = plain(
    db.prepare('SELECT id, role FROM accounts WHERE username = ?').get(username)
  );

  if (existing && !resetPassword) {
    console.log(`· 账号 ${username} 已存在（角色 ${existing.role}），跳过`);
    return { created: false, username };
  }

  const hash = await hashPasswordAsync(password);
  const now = new Date().toISOString();

  if (existing) {
    // 显式重置：把 password_changed_at 清空，前端据此提醒「首次登录后必须改密」
    db.prepare(
      `UPDATE accounts SET password_hash = ?, expires_at = ?, note = ?, revoked_at = NULL,
       password_changed_at = NULL, updated_at = ? WHERE id = ?`
    ).run(hash, expiresAt ?? null, note ?? '', now, existing.id);
    db.prepare('DELETE FROM sessions WHERE account_id = ?').run(existing.id);
    console.log(`· 账号 ${username} 口令已重置（该账号历史会话已全部失效）`);
    return { created: false, reset: true, username };
  }

  db.prepare(
    `INSERT INTO accounts
       (username, password_hash, role, display_name, note, expires_at, revoked_at,
        last_login_at, created_at, created_by, updated_at, password_changed_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'seed', ?, NULL)`
  ).run(username, hash, role, displayName ?? '', note ?? '', expiresAt ?? null, now, now);

  console.log(`· 已创建账号 ${username}（角色 ${role}）`);
  return { created: true, username };
}

// 1) 管理权限账号（可多人共用，无到期时间）
await ensureAccount({
  username: adminUsername,
  password: adminPassword,
  role: ROLE_ADMIN,
  expiresAt: null,
  note: '协会成员管理共用账号',
  displayName: '协会管理员',
});

// 2) 临时浏览权限账号（可选：两项都配置了才创建；有有效期，过期作废）
const viewerExpiresAt = viewerEnabled
  ? new Date(Date.now() + viewerDays * 86_400_000).toISOString()
  : null;
if (viewerEnabled) {
  await ensureAccount({
    username: viewerUsername,
    password: viewerPassword,
    role: ROLE_VIEWER,
    expiresAt: viewerExpiresAt,
    note: viewerNote,
    displayName: '临时浏览账号',
  });
} else {
  console.log('· 未配置 SEED_VIEWER_USERNAME / SEED_VIEWER_PASSWORD，跳过临时浏览账号');
}

// 3) 站点配置默认值：只在键不存在时插入，不覆盖已有值
const now = new Date().toISOString();
let settingsWritten = 0;
for (const [key, value, secret] of DEFAULT_SETTINGS) {
  const exists = db.prepare('SELECT 1 AS x FROM settings WHERE key = ?').get(key);
  if (exists) continue;
  db.prepare(
    'INSERT INTO settings (key, value, description, secret, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(key, value, '', secret, now);
  settingsWritten += 1;
}

console.log('─'.repeat(72));
console.log(`站点配置：新增 ${settingsWritten} 项默认值`);
console.log('');
console.log('✅ 种子数据初始化完成');
console.log('');
console.log('   已就绪的账号：');
console.log(`     管理权限账号      ${mask(adminUsername)}（角色 admin，可访问 /admin 与 /productions）`);
if (viewerEnabled) {
  console.log(`     临时浏览权限账号  ${mask(viewerUsername)}（角色 viewer，到期 ${viewerExpiresAt}）`);
} else {
  console.log('     临时浏览权限账号  （未配置，已跳过）');
}
console.log('');
console.log('   口令取自 .env 的 SEED_ADMIN_PASSWORD / SEED_VIEWER_PASSWORD，');
console.log('   出于安全考虑不在此处回显。若忘记，请查看 .env 或执行：');
console.log('     node scripts/seed.mjs --reset-password   （会重置为 .env 中当前配置的口令）');
console.log('   登录后也可调用 POST /api/auth/password 自助改密。');
console.log('');
console.log('   ⚠️ 正式部署前必须确认 .env 里的 FINGERPRINT_SECRET 已设为随机值。');
console.log('─'.repeat(72));

db.close();
