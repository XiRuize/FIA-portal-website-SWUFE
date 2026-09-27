/**
 * 修复 pnpm 在 Windows 上未创建 / 错误创建顶层包链接的问题。
 *
 * 背景：pnpm 在部分 Windows 环境下会「漏建」顶层 node_modules/<name> 链接。
 * 典型表现有两类：
 *   A) 空目录或断链的符号链接（目录存在但读不出内容）
 *   B) 顶层目录**根本不存在**——这在 @scope 包上尤其常见：
 *      node_modules/@radix-ui/ 下缺 react-primitive / react-context 等
 *      传递依赖，于是 @radix-ui/react-primitive 的 .d.ts 里
 *      `React.ComponentPropsWithoutRef<typeof Primitive.div>` 解析失败，
 *      PrimitiveDivProps 退化成空，最终炸出大量
 *      "Property 'className' does not exist on type 'Omit<...>'" 的类型错误。
 *
 * 本脚本做两件事：
 *   1) 重建「有目录但内容缺失」的链接（情况 A）；
 *   2) 补齐「顶层完全缺失」的链接（情况 B）——只补 .pnpm 里确实存在的包，
 *      避免把未安装的包凭空链接进来。
 *
 * 可重复执行，正常的目录会跳过。
 *
 * 用法：node scripts/fix-node-modules-links.cjs
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const nm = path.join(process.cwd(), 'node_modules');
const store = path.join(nm, '.pnpm');

if (!fs.existsSync(store)) {
  console.error('未找到 node_modules/.pnpm，请先执行 pnpm install');
  process.exit(1);
}

const storeEntries = fs.readdirSync(store);

/** 建立「包名 -> .pnpm 中真实包路径」索引，用于补齐完全缺失的顶层链接 */
function buildStoreIndex() {
  const index = new Map();
  for (const dir of storeEntries) {
    if (dir === 'node_modules') continue;
    const inner = path.join(store, dir, 'node_modules');
    if (!fs.existsSync(inner)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(inner, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const names = ent.name.startsWith('@')
        ? (() => {
            const scoped = path.join(inner, ent.name);
            try {
              return fs
                .readdirSync(scoped)
                .map((n) => `${ent.name}/${n}`)
                .map((n) => [n, path.join(scoped, n.split('/')[1])]);
            } catch {
              return [];
            }
          })()
        : [[ent.name, path.join(inner, ent.name)]];
      for (const [name, p] of names) {
        let ok = false;
        try {
          ok = fs.readdirSync(p).length > 0;
        } catch {
          ok = false;
        }
        if (!ok) continue;
        // 优先保留「无 peer 后缀、路径最短」的候选（更接近顶层主版本）
        const prev = index.get(name);
        if (!prev || p.length < prev.length) index.set(name, p);
      }
    }
  }
  return index;
}

const storeIndex = buildStoreIndex();

let fixed = 0;
let created = 0;
let skipped = 0;
const failed = [];

/** 从 .pnpm 存储中解析某个包名的真实路径 */
function resolveFromStore(pkgName) {
  const prefixLoose = pkgName.replace('/', '+');
  const candidates = storeEntries.filter(
    (d) => d.startsWith(prefixLoose + '@') || d.startsWith(prefixLoose)
  );
  candidates.sort((a, b) => {
    const aPeer = a.includes('_') ? 1 : 0;
    const bPeer = b.includes('_') ? 1 : 0;
    if (aPeer !== bPeer) return aPeer - bPeer;
    return a.length - b.length;
  });
  for (const c of candidates) {
    const p = path.join(store, c, 'node_modules', pkgName);
    if (fs.existsSync(p)) {
      try {
        if (fs.readdirSync(p).length > 0) return p;
      } catch {
        /* 忽略 */
      }
    }
  }
  return storeIndex.get(pkgName) || null;
}

/** 用 junction 建立链接 */
function link(full, target) {
  execFileSync('cmd', ['/c', 'mklink', '/J', full, target], { stdio: 'ignore' });
}

/** 收集“顶层目录名 -> .pnpm 中真实包路径”的映射（含 @scope 包） */
function collect(scope) {
  const base = scope ? path.join(nm, scope) : nm;
  if (!fs.existsSync(base)) return;
  for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
    if (ent.name === '.pnpm') continue;
    if (!scope && ent.name.startsWith('@')) {
      collect(ent.name);
      continue;
    }
    const pkgName = scope ? `${scope}/${ent.name}` : ent.name;
    const full = path.join(base, ent.name);

    // 跳过已正常解析的目录/链接
    let inner = [];
    try {
      inner = fs.readdirSync(full);
    } catch {
      inner = [];
    }
    if (inner.length > 0) {
      skipped += 1;
      continue;
    }

    // 情况 A：空目录（pnpm 创建了目录但没填充）
    // 情况 B：断链的符号链接（pnpm 指向了不存在的传递依赖位置，如 react → radix-ui 内部的 react）
    // 两者都统一「删掉 → 用 junction 指向 .pnpm 里的真实包」。
    let lstat = null;
    try {
      lstat = fs.lstatSync(full);
    } catch {
      continue;
    }
    const brokenLink = lstat.isSymbolicLink() && inner.length === 0;
    const emptyDir = lstat.isDirectory() && !lstat.isSymbolicLink() && inner.length === 0;
    if (!brokenLink && !emptyDir) {
      skipped += 1;
      continue;
    }

    const target = resolveFromStore(pkgName);
    if (!target) {
      failed.push(`${pkgName}（.pnpm 中未找到真实包）`);
      continue;
    }

    try {
      // 先解除链接/删除空目录，再建立 junction
      fs.rmSync(full, { recursive: true, force: true });
      link(full, target);
      fixed += 1;
    } catch (e) {
      failed.push(`${pkgName}（${e.message}）`);
    }
  }
}

/**
 * 情况 B：顶层**完全缺失**的包（目录都不存在）。
 * 常见于 @scope 下的传递依赖。只补 .pnpm 中确实存在的包。
 */
function createMissing() {
  return (pkgName, full) => {
    if (fs.existsSync(full)) return;
    const target = storeIndex.get(pkgName);
    if (!target) return;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    try {
      link(full, target);
      created += 1;
    } catch (e) {
      failed.push(`${pkgName}（补建失败：${e.message}）`);
    }
  };
}

const create = createMissing();

// 先把 .pnpm 里存在、但顶层缺失的包补出来。
// 注意：必须同时覆盖非 @scope 包——v7 的 react-router-dom 把全部类型
// 都放在 peer 依赖 react-router 里，少了它就会一路报
// "has no exported member 'Link'"。只补 @scope 是不够的。
for (const name of storeIndex.keys()) {
  const full = name.startsWith('@')
    ? path.join(nm, name.split('/')[0], name.split('/')[1])
    : path.join(nm, name);
  // 只补「顶层依赖的直接依赖树」里已有的包；storeIndex 本身已保证包真实存在
  create(name, full);
}

collect('');

/**
 * 深度修复：pnpm 的**每个包内部** node_modules 目录同样会漏建/建空。
 * 典型：node_modules/.pnpm/vite@x/node_modules/esbuild 是空目录，
 * 导致 `vite build` 报 ERR_MODULE_NOT_FOUND: esbuild。
 * 这里遍历 .pnpm 下每个包内部的 node_modules，对空目录/断链统一用 junction 指回真实包。
 */
function deepRepair() {
  let deepFixed = 0;
  const deepFailed = [];
  for (const dir of storeEntries) {
    const inner = path.join(store, dir, 'node_modules');
    if (!fs.existsSync(inner)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(inner, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      // 展开 @scope
      const subEntries = ent.name.startsWith('@')
        ? (() => {
            const scoped = path.join(inner, ent.name);
            try {
              return fs
                .readdirSync(scoped, { withFileTypes: true })
                .map((s) => ({ name: `${ent.name}/${s.name}`, full: path.join(scoped, s.name) }));
            } catch {
              return [];
            }
          })()
        : [{ name: ent.name, full: path.join(inner, ent.name) }];

      for (const sub of subEntries) {
        let lstat;
        try {
          lstat = fs.lstatSync(sub.full);
        } catch {
          continue;
        }
        let cnt = 0;
        try {
          cnt = fs.readdirSync(sub.full).length;
        } catch {
          cnt = 0;
        }
        if (cnt > 0) continue;

        const brokenLink = lstat.isSymbolicLink();
        const emptyDir = lstat.isDirectory() && !lstat.isSymbolicLink();
        if (!brokenLink && !emptyDir) continue;

        const target = storeIndex.get(sub.name);
        if (!target) {
          deepFailed.push(sub.name);
          continue;
        }
        try {
          fs.rmSync(sub.full, { recursive: true, force: true });
          link(sub.full, target);
          deepFixed += 1;
        } catch (e) {
          deepFailed.push(`${sub.name}（${e.message}）`);
        }
      }
    }
  }
  return { deepFixed, deepFailed };
}

const { deepFixed, deepFailed } = deepRepair();
console.log(`深度修复（包内依赖）${deepFixed} 个，失败 ${deepFailed.length} 个`);
deepFailed.slice(0, 10).forEach((f) => console.log(`  深度失败 -> ${f}`));

console.log(
  `重建 ${fixed} 个，补建缺失 ${created} 个，跳过（已有内容）${skipped} 个，失败 ${failed.length} 个`
);
failed.forEach((f) => console.log(`  失败 -> ${f}`));
