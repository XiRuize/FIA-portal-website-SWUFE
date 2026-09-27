/**
 * 按依赖声明精确重建「包内部 node_modules」链接。
 *
 * 为什么不复用 repair-store-chunk 的粗放索引：
 * 那个索引按「路径最短」挑目标，无法保证版本满足声明，会把
 * vite 的 rollup 指到不符的版本上。更稳妥的做法是读每个包的
 * package.json，按其 dependencies/peerDependencies 的 semver 范围，
 * 在 .pnpm store 里挑出**真正满足**该范围的版本。
 *
 * 用法：node scripts/repair-deps-by-declaration.cjs <包目录名，如 vite@5.4.21>
 *       node scripts/repair-deps-by-declaration.cjs --all
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = process.cwd();
const store = path.join(root, 'node_modules', '.pnpm');

/** 极简 semver 范围判断：支持 ^ ~ >= <= > < = 与精确版本、|| 组合 */
function parseVer(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmp(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}
function satisfies(version, range) {
  const v = parseVer(version);
  if (!v) return false;
  return String(range)
    .split('||')
    .some((part) => {
      const segs = part.trim().split(/\s+/).filter(Boolean);
      return segs.every((seg) => {
        const m = seg.match(/^(\^|~|>=|<=|>|<|=)?\s*(.+)$/);
        if (!m) return true;
        const [, op, ver] = m;
        // 处理 x / * 通配
        if (/^[xX*]/.test(ver)) return true;
        const t = parseVer(ver);
        if (!t) return true;
        const c = cmp(v, t);
        switch (op) {
          case '^': {
            if (c < 0) return false;
            // ^1.2.3 -> >=1.2.3 <2.0.0 (major>0)；^0.2.3 -> >=0.2.3 <0.3.0
            if (t[0] > 0) return v[0] === t[0];
            if (t[1] > 0) return v[0] === 0 && v[1] === t[1];
            return v[0] === 0 && v[1] === 0 && v[2] === t[2];
          }
          case '~': {
            if (c < 0) return false;
            return v[0] === t[0] && v[1] === t[1];
          }
          case '>=':
            return c >= 0;
          case '<=':
            return c <= 0;
          case '>':
            return c > 0;
          case '<':
            return c < 0;
          case '=':
          case undefined:
            return c === 0;
          default:
            return true;
        }
      });
    });
}

/** 从 store 目录名解析出「包名 + 版本」 */
function parseStoreDir(dir) {
  // 形如 vite@5.4.21  或  @radix-ui+react-slot@1.3.3_peer@x
  const noPeer = dir.split('_')[0];
  const at = noPeer.lastIndexOf('@');
  if (at <= 0) return null;
  const rawName = noPeer.slice(0, at);
  const version = noPeer.slice(at + 1);
  if (!/^\d/.test(version)) return null;
  const name = rawName.startsWith('@') ? rawName.replace('+', '/') : rawName;
  return { name, version };
}

/** 建立 name -> [{version, dir, pkgPath}] */
function buildStoreIndex() {
  const idx = new Map();
  for (const dir of fs.readdirSync(store)) {
    const parsed = parseStoreDir(dir);
    if (!parsed) continue;
    const pkgPath = path.join(store, dir, 'node_modules', parsed.name);
    let entries = 0;
    try {
      entries = fs.readdirSync(pkgPath).length;
    } catch {
      entries = 0;
    }
    if (entries === 0) continue;
    if (!idx.has(parsed.name)) idx.set(parsed.name, []);
    idx.get(parsed.name).push({ version: parsed.version, pkgPath, dir });
  }
  return idx;
}

const storeIdx = buildStoreIndex();

/** 挑选满足 range 的最高版本 */
function pick(name, range) {
  const cands = storeIdx.get(name) || [];
  const ok = cands.filter((c) => satisfies(c.version, range));
  if (ok.length === 0) return null;
  ok.sort((a, b) => cmp(parseVer(b.version), parseVer(a.version)));
  return ok[0];
}

/** 对单个 store 包目录做依赖修复 */
function repairOne(dir) {
  const inner = path.join(store, dir, 'node_modules');
  if (!fs.existsSync(inner)) return { fixed: 0, skipped: 0, missing: [] };
  const parsed = parseStoreDir(dir);
  if (!parsed) return { fixed: 0, skipped: 0, missing: [] };

  const selfPkg = path.join(inner, parsed.name, 'package.json');
  let pj;
  try {
    pj = JSON.parse(fs.readFileSync(selfPkg, 'utf8'));
  } catch {
    return { fixed: 0, skipped: 0, missing: [] };
  }
  const deps = {
    ...(pj.dependencies || {}),
    ...(pj.optionalDependencies || {}),
    ...(pj.peerDependencies || {}),
  };

  let fixed = 0;
  let skipped = 0;
  const missing = [];
  let entries = [];
  try {
    entries = fs.readdirSync(inner);
  } catch {
    return { fixed: 0, skipped: 0, missing: [] };
  }

  for (const name of entries) {
    if (!(name in deps)) continue;
    const target = path.join(inner, name);
    let cnt = 0;
    try {
      cnt = fs.readdirSync(target).length;
    } catch {
      cnt = 0;
    }
    if (cnt > 0) {
      skipped += 1;
      continue;
    }
    const chosen = pick(name, deps[name]);
    if (!chosen) {
      missing.push(`${name}@${deps[name]}（store 无满足版本）`);
      continue;
    }
    try {
      fs.rmSync(target, { recursive: true, force: true });
      execFileSync('cmd', ['/c', 'mklink', '/J', target, chosen.pkgPath], { stdio: 'ignore' });
      fixed += 1;
    } catch (e) {
      missing.push(`${name}（${e.message}）`);
    }
  }
  return { fixed, skipped, missing };
}

const arg = process.argv[2] || '--all';
let targets;
if (arg === '--all') {
  targets = fs.readdirSync(store).filter((d) => {
    try {
      return fs.statSync(path.join(store, d, 'node_modules')).isDirectory();
    } catch {
      return false;
    }
  });
} else {
  targets = [arg];
}

let tf = 0;
let ts = 0;
const allMissing = [];
for (const t of targets) {
  const r = repairOne(t);
  tf += r.fixed;
  ts += r.skipped;
  allMissing.push(...r.missing);
}
console.log(`修复 ${tf} 个，已正常 ${ts} 个，无法满足 ${allMissing.length} 个`);
allMissing.slice(0, 15).forEach((m) => console.log(`  ! ${m}`));
