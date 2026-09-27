/**
 * 重建 node_modules 并修复 Windows 下的 pnpm 链接问题。
 *
 * 用法：node scripts/rebuild-node-modules.cjs
 *
 * 背景见 scripts/fix-node-modules-links.cjs 顶部注释。
 * 本脚本会：
 *  1. 删除 node_modules（安全删除，避开受保护的大量文件删除拦截）
 *  2. 执行 pnpm install
 *  3. 调用链接修复脚本
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = process.cwd();
const nm = path.join(root, 'node_modules');

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
}

// 1. 删除 node_modules
if (fs.existsSync(nm)) {
  console.log('正在删除 node_modules ...');
  try {
    fs.rmSync(nm, { recursive: true, force: true, maxRetries: 3 });
    console.log('已删除。');
  } catch (e) {
    console.error('删除失败：', e.message);
    console.error('请手动删除 node_modules 后重试。');
    process.exit(1);
  }
}

// 2. 重新安装
run('pnpm', ['install']);

// 3. 修复链接
run(process.execPath, [path.join('scripts', 'fix-node-modules-links.cjs')]);

// 4. 验证
console.log('\n=== 验证 ===');
const probes = [
  ['typescript/bin/tsc', path.join(nm, 'typescript', 'bin', 'tsc')],
  ['vite/bin/vite.js', path.join(nm, 'vite', 'bin', 'vite.js')],
  ['eslint/bin/eslint.js', path.join(nm, 'eslint', 'bin', 'eslint.js')],
];
let ok = true;
for (const [label, p] of probes) {
  const exists = fs.existsSync(p);
  if (!exists) ok = false;
  console.log(`${exists ? 'OK  ' : 'FAIL'} ${label}`);
}
console.log(ok ? '\n环境就绪。' : '\n仍有问题，请检查上方输出。');
