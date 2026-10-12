// ============================================
// 验证智谱 API Key 是否可用
// ============================================
// 运行方式（在项目根目录）：
//   node scripts/check-key.mjs
//
// 这个脚本只做一件事：证明你的 Key 能调通模型。
// 它不写任何业务代码——先确认「管道通了」，再谈别的。
//
// 【重要】它不依赖任何第三方库，只用 Node 内置的 fetch。
// 这是故意的：第 0 周的任务是理解链路本身，不是学框架。
// ============================================

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------- 1. 读取 .env ----------
// 这里手写一个极简的 .env 解析器。
// 为什么要手写？因为想让你看清「读环境变量」这件事本身有多简单。
// 生产项目里会用 dotenv 之类的库，但原理就是这样：
// 读文件 → 按行切 → 跳过注释和空行 → 按 = 拆成键值对。

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
// 智谱的接口是 OpenAI 兼容格式，所以结构是标准的 chat/completions。
// 记住这个结构，后面不管换哪家模型，形状都差不多。

console.log('📡 正在请求模型...');

const startedAt = Date.now();

try {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // 注意：授权头是 Bearer + 空格 + Key，这个空格少一个都会 401
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: '你是一个简洁的助手，回答不超过 20 个字。' },
        { role: 'user', content: '用一句话说明你是谁。' },
      ],
      // 非流式请求，一次性拿到完整回答。
      // 为什么这里用 false？因为下面是用 res.json() 解析的，
      // 它只能处理「一个完整 JSON」。如果开 stream: true，
      // 返回的是一堆 "data: {...}" 拼成的 SSE 文本流，res.json() 会直接解析失败。
      // 流式解析是你后面要练的核心技能，放在 app.js 的 TODO 1 里专门做，
      // 不要在验证脚本这里提前消耗掉。
      stream: false,
      temperature: 0.3,
    }),
  });

  const elapsed = Date.now() - startedAt;

  // ---------- 4. 处理错误 ----------
  // HTTP 状态码是最重要的排查线索，这里逐个说明，以后你一看就知道问题在哪。
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
      console.error('   5xx = 服务端问题，不是你的错。稍后重试。');
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
  // 这是你必须看懂的数字：计费是按 token 算的，输入输出分开计。
  // 面试问「token 怎么计费」时，你能拿这组真实数字来答。
  if (usage.total_tokens !== undefined) {
    console.log('');
    console.log('   token 用量（这就是计费依据）：');
    console.log(`     输入 prompt_tokens     : ${usage.prompt_tokens}`);
    console.log(`     输出 completion_tokens : ${usage.completion_tokens}`);
    console.log(`     合计 total_tokens      : ${usage.total_tokens}`);
  }

  console.log('');
  console.log('🎉 管道已打通。第 0 周的第 1 个半天完成。');
  console.log('');
  console.log('下一步：');
  console.log('  1. 用浏览器打开 index.html（界面在这里）');
  console.log('  2. 打开 app.js，实现里面的 TODO 1（逻辑在那里），');
  console.log('     让回复像打字一样一个字一个字蹦出来。');
} catch (err) {
  // 网络层面的错误（连不上、超时、DNS 失败）会走到这里
  const elapsed = Date.now() - startedAt;
  console.error(`❌ 网络请求异常，耗时 ${elapsed}ms`);
  console.error('');
  console.error('   错误信息：' + err.message);
  console.error('');
  console.error('   可能原因：');
  console.error('   · 网络不通（试试浏览器能不能打开 open.bigmodel.cn）');
  console.error('   · 公司网络/代理拦截了请求');
  console.error('   · 接口地址写错了');
  process.exit(1);
}
