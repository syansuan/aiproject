// ============================================
// 从 .env 生成 config.local.js
// ============================================
// 运行方式（在项目根目录）：
//   npm run config
//   或：node scripts/gen-config.mjs
//
// 【为什么需要这个脚本】
//   同样的配置有两类使用方：
//     · Node 脚本（scripts/check-key.mjs）—— 能直接读 .env
//     · 浏览器页面（index.html → app.js）—— 读不了 .env，
//       因为浏览器里没有 fs、没有 process，只能读一个普通 .js 文件
//
//   两份配置手工维护，迟早会出现「改了 .env 忘了同步，命令行能通、页面报 401」
//   这种最难查的问题。
//
//   所以定个规矩：**.env 是唯一真源，config.local.js 由本脚本生成。**
//   任何时候都只改 .env，然后跑一次 npm run config。
//
// 【这和构建工具做的事一样】
//   Vite / Next.js 会在构建时把 .env 里的变量注入到前端代码里，
//   import.meta.env.VITE_XXX 本质就是这个。
//   区别只是它们有构建步骤，这里用一个脚本代替。
// ============================================

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------- 1. 读取并解析 .env ----------
// 与 check-key.mjs 中的逻辑一致：
// 读文件 → 按行切 → 跳过注释和空行 → 按 = 拆成键值对。
function loadEnv(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    console.error(`❌ 找不到 ${file}`);
    console.error('   请先复制 .env.example 为 .env，并填入你的 Key：');
    console.error('     Copy-Item .env.example .env');
    process.exit(1);
  }

  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const envPath = resolve(process.cwd(), '.env');
const outPath = resolve(process.cwd(), 'config.local.js');
const env = loadEnv(envPath);

const API_KEY = env.ZHIPU_API_KEY || '';
const BASE_URL = env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
const MODEL = env.ZHIPU_MODEL || 'glm-4-flash';

// ---------- 2. 校验 Key ----------
if (!API_KEY) {
  console.error('❌ .env 里的 ZHIPU_API_KEY 是空的。');
  console.error('   打开 .env，在 ZHIPU_API_KEY= 后面填上你的 Key。');
  process.exit(1);
}

// 拦住最常见的配置错误：只复制了模板，但没把占位符换成真 Key。
if (/^x+\.x+$/i.test(API_KEY)) {
  console.error('❌ .env 里的 ZHIPU_API_KEY 还是模板里的占位符（xxxx.xxxx）。');
  console.error('   去 https://open.bigmodel.cn/ → 右上角「API 密钥」复制真实 Key。');
  process.exit(1);
}

// ---------- 3. 生成 config.local.js ----------
// 用 JSON.stringify 而不是字符串拼接，这样即使 Key 里有引号、反斜杠
// 也不会把生成的 JS 写坏。
const out = `// ============================================
// config.local.js —— 自动生成，请勿手动编辑
// ============================================
// 由 scripts/gen-config.mjs 从 .env 生成，改了 .env 后重新生成：npm run config
//
// 该文件已被 .gitignore 排除，不会提交。
// 作用是把配置挂到 window 上，供 index.html 里的 app.js 读取。
//
// 这种模式叫「运行时配置注入」（runtime config injection）：
// 同一份构建产物，部署时替换配置文件即可切换环境（测试/预发/生产）。
// ============================================

window.__APP_CONFIG__ = {
  ZHIPU_API_KEY: ${JSON.stringify(API_KEY)},
  ZHIPU_BASE_URL: ${JSON.stringify(BASE_URL)},
  ZHIPU_MODEL: ${JSON.stringify(MODEL)},
};
`;

writeFileSync(outPath, out, 'utf8');

// ---------- 4. 打印结果（不回显完整 Key） ----------
console.log('✅ config.local.js 已生成');
console.log(`   来源：${envPath}`);
console.log(`   输出：${outPath}`);
console.log('');
console.log(`   接口地址：${BASE_URL}`);
console.log(`   使用模型：${MODEL}`);
console.log(`   Key 长度：${API_KEY.length} 位，前缀 ${API_KEY.slice(0, 4)}...（不回显完整 Key）`);
console.log('');
console.log('   这个文件在 .gitignore 里，不会被提交。');
console.log('');
console.log('下一步：');
console.log('  1. npx serve .        ← 起本地服务');
console.log('  2. 打开提示的地址，按 F12 可看控制台日志');
