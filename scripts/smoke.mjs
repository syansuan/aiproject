// ============================================
// 冒烟测试：不用打开浏览器，直接验证 app.js 的核心逻辑
// ============================================
// 运行方式（在项目根目录）：
//   npm run smoke                 ← 正常发一次，验证 TODO 1（流式解析）
//   npm run smoke -- --stop       ← 发出去后中途点「停止」，验证中断真的生效
//   npm run smoke -- --fail=401   ← 让请求「注定失败」，验证 TODO 2（重试）
//
// 【--fail 是什么】
//   想测重试，就必须让请求「失败几次之后再成功」。
//   靠改 .env 里的 Key / 模型名做不到这件事——那种错是「每次都错」，
//   只能测出「一次就挂了」，测不出「重试」。
//   所以这里把 globalThis.fetch 换成一个「按剧本失败」的假 fetch。
//   这个手法叫「测试替身 / 打桩」（test double / stub），是测重试的标准做法。
//   面试问「你怎么测重试」，答这个比答「我把网线拔了」高一档。
//
//   可用的剧本：
//     --fail=401      每次都返回 401（Key 错）→ 期望【不重试】，1 次就结束
//     --fail=429x2    前 2 次 429，第 3 次放行真实请求 → 期望共 3 次尝试
//     --fail=500x9    一直 500 → 期望重试到上限后放弃（共 4 次）
//     --fail=netx2    前 2 次抛网络错误（无 status），第 3 次放行 → 期望共 3 次
//   少写 x 次数就是「一直失败」，例如 --fail=429
//
// 【它在干什么】
//   app.js 是给浏览器写的，里面用了 document.querySelector 这些东西。
//   Node 里没有 document，所以下面先造一套「假的 DOM」——
//   每个元素只有 textContent / value / addEventListener 这几个假属性，
//   足够骗过 app.js，让它以为自己跑在浏览器里。
//   然后按 file:// 把 app.js 当普通模块 import 进来，触发「发送」按钮的处理函数。
//
//   这样就能在不打开浏览器的情况下，跑通「发请求 → 解析 SSE → 写进 output」全链路。
//   这个思路叫 headless 测试，前端圈很常用（真实项目里会用 jsdom / Vitest）。
//
// 【为什么值得做】
//   浏览器里验证得靠眼睛看，改一行、刷一次、再点一次，很慢。
//   这个脚本 1 秒出结果，而且能给出「流式到了几次」这种肉眼看不出来的结论。
// ============================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WANT_STOP = process.argv.includes('--stop');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. 读配置（和 check-key / gen-config 一样，只认 .env） ----------
const raw = readFileSync(resolve(ROOT, '.env'), 'utf8');
const env = {};
for (const line of raw.split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i === -1) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

// ---------- 1.5 失败注入（只有加了 --fail=xxx 才生效） ----------
const FAIL_SPEC = (() => {
  const arg = process.argv.find((a) => a === '--fail' || a.startsWith('--fail='));
  if (!arg) return null;
  return arg.includes('=') ? arg.slice('--fail='.length) : '429x2';
})();

const FAIL = (() => {
  if (!FAIL_SPEC) return null;
  const m = /^(\d{3}|[a-z]+)(?:x(\d+))?$/i.exec(FAIL_SPEC);
  if (!m) return { kind: FAIL_SPEC.toLowerCase(), times: Infinity };
  return { kind: m[1].toLowerCase(), times: m[2] ? Number(m[2]) : Infinity };
})();

// 真实报错体的结构：{"error":{"code":"...","message":"..."}}
// 这几条是我实际打接口抓下来的原文，不是编的。
const FAIL_BODIES = {
  401: [401, { error: { code: '401', message: '令牌已过期或验证不正确' } }],
  429: [429, { error: { code: '1302', message: '您的账号当前调用并发量超限，请稍后重试' } }],
  500: [500, { error: { code: '500', message: '服务内部错误，请稍后重试' } }],
};

const REAL_FETCH = globalThis.fetch; // 先存起来，剧本演完要放行
const fetchCalls = []; // 每次 fetch 被调用的时刻 → 用来数「尝试次数」和算「退避间隔」

// 写了不认识的类型（比如 --fail=abc）→ 回落到 429，并提醒一下
if (FAIL && FAIL.kind !== 'net' && !Object.prototype.hasOwnProperty.call(FAIL_BODIES, FAIL.kind)) {
  console.log(
    `（提示：不认识的失败类型 "${FAIL.kind}"，已按 429 处理。可用：401 / 429 / 500 / net）`
  );
  FAIL.kind = '429';
}

if (FAIL) {
  globalThis.fetch = async (...args) => {
    fetchCalls.push(Date.now());
    const nth = fetchCalls.length;

    // 剧本演完了 → 放行给真实的 fetch
    if (nth > FAIL.times) return REAL_FETCH(...args);

    // 模拟「域名解析不了 / 网线断了」：fetch 自己抛错，没有 status
    if (FAIL.kind === 'net') {
      throw new TypeError('fetch failed', {
        cause: new Error('getaddrinfo ENOTFOUND open.bigmodel.invalid'),
      });
    }

    const [status, body] = FAIL_BODIES[FAIL.kind] || FAIL_BODIES[429];
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

// ---------- 2. 造假 DOM ----------
const listeners = {};

function makeEl(id) {
  return {
    id,
    textContent: '',
    value: '',
    disabled: false,
    scrollTop: 0,
    scrollHeight: 100,
    classList: { toggle() {} },
    addEventListener(type, fn) {
      (listeners[id] ||= []).push([type, fn]);
    },
  };
}

const els = {};
for (const id of ['input', 'send', 'stop', 'clear', 'output', 'status']) {
  els['#' + id] = makeEl(id);
}

globalThis.document = { querySelector: (sel) => els[sel] };
globalThis.window = {
  __APP_CONFIG__: {
    ZHIPU_API_KEY: env.ZHIPU_API_KEY,
    ZHIPU_BASE_URL: env.ZHIPU_BASE_URL,
    ZHIPU_MODEL: env.ZHIPU_MODEL,
  },
};

// ---------- 3. 加载 app.js ----------
await import('file:///' + ROOT + '/app.js');

const $input = els['#input'];
const $output = els['#output'];
const $status = els['#status'];

// ---------- 4. 给 output 装个计数器 ----------
// 数一数 textContent 被「追加」了多少次。
// 这是判断有没有真的流式的唯一硬证据：
//   只增长 1 次  → 一次性拿到全文（说明 stream 没生效，或者解析有问题）
//   增长多次     → 真的在逐字蹦出来 ✅
let ticks = 0;
let lastLen = 0;
const lengths = [];
const tickTimes = []; // 每次内容到达的时刻 —— 用来看「是不是真的分散到达」
let backing = '';
Object.defineProperty($output, 'textContent', {
  get: () => backing,
  set(v) {
    backing = v;
    if (v.length > lastLen) {
      ticks++;
      if (lengths.length < 10) lengths.push(v.length);
      if (tickTimes.length < 12) tickTimes.push(Date.now());
      lastLen = v.length;
    }
  },
  configurable: true,
});

const call = (id) => {
  const hs = listeners[id] || [];
  if (!hs.length) throw new Error(`没找到 #${id} 的监听器，app.js 可能加载失败`);
  return hs.map(([, fn]) => fn());
};

// ---------- 5. 跑 ----------
$input.value = WANT_STOP ? '数到一百，每个数字都写出来。' : '用一句话说明你是谁。';

const t0 = Date.now();
const sendPromises = call('send');

if (WANT_STOP) {
  // --stop 模式：等第一批内容**真的到达了**，再点停止。
  //
  // 为什么要等？如果在 0 字的时候就按停止，那"最后是 0 字"这个结果
  // 可能只是因为模型还没开始吐字，证明不了「中断生效」。
  // 等到有字了再打断、并且确认之后不再增长 —— 这才叫测试通过。
  let waited = 0;
  while (backing.length === 0 && waited < 8000) {
    await sleep(50);
    waited += 50;
  }
  const lenAtStop = backing.length;
  const arrivedAt = waited;

  call('stop');
  await Promise.all(sendPromises);
  await sleep(400); // 再等一会儿，看有没有漏网的内容继续冒出来

  console.log('');
  console.log('================ 结果（--stop 模式）================');
  console.log('第一批内容到达   :', arrivedAt, 'ms 后，当时已显示', lenAtStop, '字');
  console.log('停止后的最终长度 :', backing.length, '字');
  console.log('停止后又多出的字 :', backing.length - lenAtStop, '字');
  console.log('状态提示 status  :', JSON.stringify($status.textContent));
  console.log('----------------------------------------------------');
  console.log('被打断时的内容：');
  console.log(backing);
  console.log('====================================================');
  console.log('');

  const bad = [];
  if (lenAtStop === 0) {
    bad.push('等到 8 秒都没收到第一批内容，这次测试说明不了问题（重跑一次）');
  }
  if ($status.textContent !== '已停止') {
    bad.push('期望 status 是「已停止」，实际是 ' + JSON.stringify($status.textContent));
  }
  if (backing.length - lenAtStop > 20) {
    bad.push('点停止后又多出了 ' + (backing.length - lenAtStop) + ' 字，说明没真的掐断');
  }

  if (bad.length) {
    console.log('❌ 有问题：');
    for (const b of bad) console.log('   · ' + b);
    process.exit(1);
  }
  console.log('✅ 通过：中途打断后不再继续输出，状态是「已停止」');
  process.exit(0);
}

await Promise.all(sendPromises);
const elapsed = Date.now() - t0;

// ---------- 5.5 --fail 模式：单独出一份「重试结论」 ----------
// 为什么要单独一套断言：
//   正常模式关心的是「内容有没有流式到达」，
//   失败模式关心的是「错了几次、等没等、最后有没有放弃」。两回事。
if (FAIL) {
  const MAX_ATTEMPTS = 4; // 首发 1 次 + 最多重试 3 次
  const attempts = FAIL.kind === '401' ? 1 : Math.min(FAIL.times + 1, MAX_ATTEMPTS);
  const plan =
    FAIL.kind === '401'
      ? { attempts, final: 'err', why: '401 = Key 错了，重试一万次也没用' }
      : {
          attempts,
          // 最后一次尝试如果还是「剧本里的失败」，那最终结果必然是出错
          final: attempts > FAIL.times ? 'ok' : 'err',
          why:
            (FAIL.kind === 'net' ? '网络异常（没有 status）' : FAIL.kind.toUpperCase() + ' 响应') +
            ' 属于「可重试」',
        };

  const gaps = [];
  for (let i = 1; i < fetchCalls.length; i++) gaps.push(fetchCalls[i] - fetchCalls[i - 1]);

  const statusText = $status.textContent;
  const cut = (s) => (s.length > 70 ? s.slice(0, 70) + '…' : s);

  console.log('');
  console.log(`======== 失败注入结果（--fail=${FAIL_SPEC}）========`);
  console.log(
    '剧本           :',
    FAIL.kind.toUpperCase() +
      (FAIL.times >= 4 ? '，一直失败（超过重试上限）' : `，前 ${FAIL.times} 次失败`)
  );
  console.log('判定规则       :', plan.why);
  console.log('--------------------------------------------');
  console.log('fetch 被调用   :', fetchCalls.length, '次   ← 这就是「尝试次数」');
  console.log('期望尝试次数   :', plan.attempts, '次');
  console.log(
    '两次尝试的间隔 :',
    gaps.length ? gaps.map((g) => g + 'ms').join(' → ') : '（没有第 2 次尝试）'
  );
  console.log('总耗时         :', elapsed + 'ms');
  console.log('最终 status    :', JSON.stringify(cut(statusText)));
  console.log('最终输出长度   :', backing.length, '字');
  console.log('--------------------------------------------');

  const bad = [];
  if (fetchCalls.length !== plan.attempts) {
    bad.push(`期望尝试 ${plan.attempts} 次，实际尝试了 ${fetchCalls.length} 次`);
    if (fetchCalls.length === 1 && plan.attempts > 1) {
      bad.push(
        '一次就结束了 → withRetry 还没实现（现在只是 return fn()），或者没判断「这个错该不该重试」'
      );
    }
  }
  if (gaps.length) {
    const want = [1000, 2000, 4000];
    gaps.forEach((g, i) => {
      const w = want[i] ?? want[want.length - 1];
      if (g < w * 0.6)
        bad.push(`第 ${i + 1} 次重试只等了 ${g}ms，期望 ≈${w}ms —— 是不是没等，或者等得太短？`);
    });
  }
  const wantStatus = plan.final === 'ok' ? '完成' : '出错';
  if (!statusText.includes(wantStatus)) {
    bad.push(`期望最终 status 含「${wantStatus}」，实际是 ${JSON.stringify(cut(statusText))}`);
  }

  if (bad.length) {
    console.log('❌ 还没通过：');
    for (const b of bad) console.log('   · ' + b);
    console.log('');
    console.log('（TODO 2 就是要把上面这些变绿。改完再跑同一条命令。）');
    console.log('');
    process.exit(1);
  }
  console.log(
    plan.attempts === 1
      ? '✅ 通过：401 没有重试，1 次就结束，错误直接抛给用户'
      : `✅ 通过：共尝试 ${fetchCalls.length} 次（重试 ${fetchCalls.length - 1} 次），退避间隔正常`
  );
  console.log('');
  process.exit(0);
}

// ---------- 6. 断言 ----------
console.log('');
console.log('================ 结果 ================');
console.log('状态提示 status :', JSON.stringify($status.textContent));
console.log('耗时            :', elapsed + 'ms');
console.log('收到内容的次数  :', ticks, '次');
console.log('前几次长度      :', lengths.join(' → '));
console.log(
  '前几次到达时刻  :',
  tickTimes.length ? tickTimes.map((t) => t - t0 + 'ms').join(' → ') : '（无）'
);
console.log('最终长度        :', backing.length, '字');
console.log('--------------------------------------');
console.log('模型输出：');
console.log(backing);
console.log('======================================');
console.log('');

const problems = [];
if (!backing.trim()) problems.push('output 是空的，一个字都没收到');
if (ticks < 2) problems.push(`只收到 ${ticks} 次内容，不是流式（应该多次到达）`);
if (/data:|\[DONE\]|\{"choices"/.test(backing)) {
  problems.push('output 里混进了 SSE 原始文本 —— 前缀没剥干净，或者拼接逻辑有问题');
}
if ($status.textContent.includes('出错')) {
  problems.push('status 显示出错：' + $status.textContent);
}

if (problems.length) {
  console.log('❌ 有问题：');
  for (const p of problems) console.log('   · ' + p);
  process.exit(1);
}

console.log(`✅ TODO 1 通过：流式到达 ${ticks} 次，内容干净，无 SSE 残留`);
console.log('');
console.log('（中断已经接通了，随时可以跑 `npm run smoke -- --stop` 验证）');
