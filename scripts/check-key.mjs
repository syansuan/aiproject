// ============================================
// 验证智谱 API Key 是否可用
// ============================================
// 运行方式（在项目根目录）：
//   node scripts/check-key.mjs     （或 npm run check）
//
// 只做一件事：证明 Key 能调通模型，不做任何业务逻辑 ——
// 先确认「管道通了」，再排查别的问题。
//
// 只用 Node 内置的 fetch，不依赖任何第三方库。
// ============================================

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------- 1. 读取 .env ----------
// 手写一个极简的 .env 解析器，避免为这点需求引入依赖。
// 原理就是：读文件 → 按行切 → 跳过注释和空行 → 按 = 拆成键值对。
// 生产项目里通常用 dotenv，做的事完全一样。

function loadEnv(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    console.error(`❌ 找不到 ${file}`);
    console.error('   请先复制 .env.example 为 .env，并填入你的 Key。');
    process.exit(1);
  }

  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue; // 跳过空行和注释
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    env[key] = value;
  }
  return env;
}

const envPath = resolve(process.cwd(), '.env');
const env = loadEnv(envPath);

const API_KEY = env.ZHIPU_API_KEY;
const BASE_URL = env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
const MODEL = env.ZHIPU_MODEL || 'glm-4-flash';

// ---------- 2. 检查 Key 是否填了 ----------
if (!API_KEY) {
  console.error('❌ .env 里的 ZHIPU_API_KEY 是空的。');
  console.error('   打开 .env，在 ZHIPU_API_KEY= 后面填上你的 Key。');
  process.exit(1);
}

console.log('🔍 检查配置...');
console.log(`   配置文件：${envPath}`);
console.log(`   接口地址：${BASE_URL}`);
console.log(`   使用模型：${MODEL}`);
console.log(`   Key 前缀：${API_KEY.slice(0, 8)}...（只显示前 8 位，避免泄露）`);
console.log('');

// ---------- 3. 发起请求 ----------
// 智谱接口是 OpenAI 兼容格式，结构就是标准的 chat/completions。

console.log('📡 正在请求模型...');

const startedAt = Date.now();

try {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // 授权头是 Bearer + 空格 + Key，空格少一个都会 401
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: '你是一个简洁的助手，回答不超过 20 个字。' },
        { role: 'user', content: '用一句话说明你是谁。' },
      ],
      // 这里用 false：下面是用 res.json() 解析的，只能处理「一个完整 JSON」。
      // 开 stream: true 拿到的是 "data: {...}" 拼成的 SSE 文本流，res.json() 会直接失败。
      // 流式解析在 app.js 里实现。
      stream: false,
      temperature: 0.3,
    }),
  });

  const elapsed = Date.now() - startedAt;

  // ---------- 4. 处理错误 ----------
  // HTTP 状态码是最重要的排查线索，逐个说明。
  if (!res.ok) {
    const text = await res.text();
    console.error(`❌ 请求失败（HTTP ${res.status}），耗时 ${elapsed}ms`);
    console.error('');
    if (res.status === 401) {
      console.error('   401 = 身份验证失败。可能原因：');
      console.error('   · Key 填错了或多了空格');
      console.error('   · Key 已被删除或重置');
      console.error('   · Authorization 头格式不对（应为 "Bearer 空格 Key"）');
    } else if (res.status === 402 || res.status === 403) {
      console.error('   402/403 = 权限或余额问题。可能原因：');
      console.error('   · 账户余额不足（智谱新用户有赠送额度）');
      console.error('   · 这个模型需要实名认证才能用');
    } else if (res.status === 429) {
      console.error('   429 = 请求太频繁，触发了限流。等几秒再试。');
    } else if (res.status >= 500) {
      console.error('   5xx = 服务端问题，不是客户端的问题。稍后重试。');
    }
    console.error('');
    console.error('   原始响应：');
    console.error('   ' + text.slice(0, 500));
    process.exit(1);
  }

  // ---------- 5. 解析结果 ----------
  const data = await res.json();

  const content = data?.choices?.[0]?.message?.content ?? '(没有拿到内容)';
  const usage = data?.usage ?? {};

  console.log('✅ 调用成功！');
  console.log('');
  console.log('   模型回复：');
  console.log('   ┌' + '─'.repeat(50));
  for (const line of content.split('\n')) {
    console.log('   │ ' + line);
  }
  console.log('   └' + '─'.repeat(50));
  console.log('');
  console.log('   耗时：' + elapsed + 'ms');

  // ---------- 6. 打印 token 用量 ----------
  // 计费按 token 算，输入输出分开计。
  if (usage.total_tokens !== undefined) {
    console.log('');
    console.log('   token 用量（计费依据）：');
    console.log(`     输入 prompt_tokens     : ${usage.prompt_tokens}`);
    console.log(`     输出 completion_tokens : ${usage.completion_tokens}`);
    console.log(`     合计 total_tokens      : ${usage.total_tokens}`);
  }

  console.log('');
  console.log('🎉 链路已打通。');
  console.log('');
  console.log('下一步：');
  console.log('  1. npm run config   —— 把 .env 里的配置同步给页面');
  console.log('  2. npx serve .      —— 打开提示的地址即可使用');
} catch (err) {
  // 网络层面的错误（连不上、超时、DNS 失败）会走到这里
  const elapsed = Date.now() - startedAt;
  console.error(`❌ 网络请求异常，耗时 ${elapsed}ms`);
  console.error('');
  console.error('   错误信息：' + err.message);
  console.error('');
  console.error('   可能原因：');
  console.error('   · 网络不通（试试浏览器能不能打开 open.bigmodel.cn）');
  console.error('   · 代理拦截了请求');
  console.error('   · 接口地址写错了');
  process.exit(1);
}
