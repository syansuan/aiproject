// ============================================
// app.js —— 第 0 周核心练习
// ============================================
//
// 这里面有 2 个 TODO 要你写（TODO 1 流式解析、TODO 2 失败重试）。
// 另外还有一处「中断生成」的机制已经接通了，不用你写，但你要看懂它——
// 见下面「关于中断生成」那一节。
//
// 【为什么不用框架】
//   智谱/OpenAI 的接口就是一个普通 HTTP 接口。理解它不需要 React、Vue、
//   也不需要 LangChain。先裸写一次，你才知道框架到底帮你做了什么。
//   ——这一点在面试里很值钱：「我用原生 fetch 手写过流式解析」这句话，
//      比「我用过 LangChain」有分量得多。
//
// 【怎么调试】
//   浏览器打开 index.html，按 F12 打开控制台。
//   报错、network 请求内容、返回的数据结构，全都能在这里看到。
//   遇到问题先看控制台，不要猜。
// ============================================

// ---------- 配置 ----------
// 浏览器里没有 process、没有 fs，所以读不了 .env 文件（那是 Node 环境的东西）。
// 配置从 config.local.js 来 —— 它在 index.html 里比 app.js 先加载，
// 做的事就是往 window 上挂一个 __APP_CONFIG__ 对象。
//
// 为什么绕这一下？
//   · config.local.js 被 .gitignore 排除 → 真实 Key 不会进 GitHub
//   · 这个模式叫「运行时配置注入」，真实 SPA 项目里很常见
//     （同一份构建产物，部署时替换配置文件即可切环境）
//
// ⚠️ 但要清楚：Key 依然是下发到浏览器的，打开 F12 就能看到。
//    本地练习没问题，【绝对不能】这样部署到公网。
//    正确做法是第 1–4 周要做的后端转发：Key 藏在服务端，前端只调自己的接口。
//    面试问「你的 Key 怎么保护的」，答这个思路就对了。
const ENV = window.__APP_CONFIG__ || {};

const API_KEY = ENV.ZHIPU_API_KEY || '';
const BASE_URL = ENV.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
const MODEL = ENV.ZHIPU_MODEL || 'glm-4-flash';

// ---------- DOM ----------
const $input = document.querySelector('#input');
const $send = document.querySelector('#send');
const $stop = document.querySelector('#stop');
const $clear = document.querySelector('#clear');
const $output = document.querySelector('#output');
const $status = document.querySelector('#status');

// 用一个变量记住「当前这次请求是否已被用户中止」。
// 这是「中断生成」功能的实现基础，先在这里定义好。
let aborted = false;
let currentController = null;

// ============================================
// TODO 1：把消息发给模型，并流式接收回复
// ============================================
//
// 【开工前先做这一件事】
//   currentController = new AbortController();
//   然后把它加到 fetch 的 options 里：{ ..., signal: currentController.signal }
//   这样底部的「停止」按钮才有东西可以中止。
//   这个变量是模块级的 let，你在这里直接赋值即可，外面的 handleSend 和
//   停止按钮都能读到同一个引用。
//
// 要求：
//   1. 用 fetch 请求 `${BASE_URL}/chat/completions`
//   2. method 是 POST，headers 里要有：
//        'Content-Type': 'application/json'
//        'Authorization': `Bearer ${API_KEY}`
//      ——「Bearer」和 Key 之间必须有一个空格，少了会 401
//   3. body 是 JSON，关键字段：
//        model: MODEL
//        messages: [{ role:'user', content: 用户输入 }]
//        stream: true          ← 这个设为 true 才会流式返回
//   4. 拿到 response 后，拿到 response.body（一个 ReadableStream）
//   5. 用 getReader() 读它，逐块 decode 成字符串
//   6. 每一块里是 SSE 格式的文本，长这样：
//
//        data: {"choices":[{"delta":{"content":"你"}}]}
//
//        data: {"choices":[{"delta":{"content":"好"}}]}
//
//        data: [DONE]
//
//      —— 你要按行拆开，去掉开头的 "data: "，然后 JSON.parse。
//         拿到 delta.content 就累加到页面上。
//         遇到 "[DONE]" 就说明结束了。
//   7. 注意：一个网络分块可能包含多行，也可能一行被切成两半。
//      所以要用一个 buffer 变量缓存起来，按 \n 切，最后一段留在 buffer 里等下次。
//      —— 这是流式解析最容易错的地方，也是面试常问的点。
//
// 提示：
//   · 让 $output.textContent 随着内容增长，就实现了「打字机」效果
//   · 不要用 innerHTML，用 textContent（避免 XSS）
//
// ============================================
async function streamChat(userText) {
  // 把你的实现写在这里
  currentController = new AbortController();

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: userText }],
      // 非流式请求，一次性拿到完整回答。
      // 流式（stream: true）是下一步要做的事，这里先跑通最简单的。
      stream: true,
      temperature: 0,
    }),
    signal: currentController.signal,
  });

  // ② 先检查 HTTP 状态，再谈解析。
  //    不检查的话，401 的响应体也会被当成流去读，报错信息会非常误导人。
  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  // ③ 拿 reader，准备逐块读
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // ★ 关键：{ stream: true } 告诉解码器后面还有数据，
    //    多字节字符（中文）被切断时不要急着输出乱码
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    // ★ 关键：pop() 把最后一段拿出来——它可能是半行，
    //    留到下一轮和新的数据拼起来再处理
    buffer = lines.pop();
    for (const line of lines) {
      // ⑤ SSE 每行格式是 "data: {json}"，空行要跳过
      if (!line.startsWith('data: ')) continue;

      // ⑥ 剥掉 "data: " 前缀（注意是 6 个字符：'d','a','t','a',':',' '）
      const payload = line.slice(6).trim();

      // ⑦ 结束标记
      if (payload === '[DONE]') return;

      // ⑧ 解析并累加
      let json;
      try {
        json = JSON.parse(payload);
      } catch (error) {
        // 极少数情况下会遇到不完整的一行，跳过即可，不要整个崩掉
        continue;
      }
      const content = json.choices[0].delta.content;
      if (content) {
        // ★ 用 textContent 而不是 innerHTML —— 避免 XSS
        $output.textContent += content;
      }
    }
  }
}

// ============================================
// TODO 2：失败自动重试
// ============================================
//
// 要求：
//   包一层重试逻辑，最多重试 3 次。
//   什么情况该重试？网络异常、5xx、429。
//   什么情况不该重试？401（Key 错了，重试一万次也没用）、400（请求本身有问题）。
//
// 提示：
//   · 用一个 for 循环，catch 到可重试的错误就等一会儿再试
//   · 每次重试之间建议等 1 秒、2 秒、4 秒（这叫「指数退避」，面试会问）
//   · 如果用户点了「停止」，就不要重试了（判断 aborted）
//
// 【怎么验证自己写对了】—— 不用改 .env，也不用拔网线
//   npm run smoke -- --fail=401     期望：只尝试 1 次（401 不该重试）
//   npm run smoke -- --fail=429x2   期望：尝试 3 次，间隔 ≈1s、≈2s
//   npm run smoke -- --fail=500x9   期望：尝试 4 次后放弃
//   npm run smoke -- --fail=netx2   期望：尝试 3 次（网络异常也该重试）
//
// ============================================

// 等一会儿再继续。
// 单独抽成函数，是为了让 withRetry 读起来像「业务逻辑」，
// 而不是一堆 setTimeout 杂耍。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ★ 这道题真正考的东西：判断「重发一次，结果会不会不一样」
//
//     会不一样 → 重试（网络抖了、被限流了、服务器抽风了）
//     不会变   → 立刻放弃（Key 错了、参数错了、路径错了）
//
//   判断依据只有两个：err.status 是多少、以及它到底有没有 status。
function isRetryable(err) {
  const status = err.status;

  // ① 没有 status → 不是「服务器明确拒绝」，而是根本没走到服务器
  //    （断网、DNS 解析不了、连接被掐）。这种多半是暂时的，值得再试。
  if (status === undefined) return true;

  // ② 429 = 被限流了。等一会儿再来 —— 这就是 429 存在的全部意义。
  if (status === 429) return true;

  // ③ 5xx = 服务器自己的锅，它可能下一秒就好了。
  if (status >= 500) return true;

  // ④ 剩下的：400 参数错、401 Key 错、403 没权限、404 路径错……
  //    你再发一次，结果一模一样，只是让用户白等几秒。
  return false;
}

async function withRetry(fn, maxRetries = 3) {
  // 注意这里没有写成「循环 3 次」。
  // attempt 一直往上加，「什么时候停」全部交给下面三个 throw 出口决定
  // —— 停下来的规则集中在一个地方，比散落在循环条件里好读。
  for (let attempt = 0; ; attempt++) {
    try {
      // ★ 每次尝试都重新调用 fn()。
      //   这就是「重试」的全部含义：把同一件事再做一遍。
      return await fn();
    } catch (err) {
      // 出口 1：用户按了「停止」。
      //   AbortError 是 fetch 被 abort() 掐断时抛的；
      //   aborted 是停止按钮打的标记。两个都判断，是双保险。
      //   —— 必须放在最前面：用户说停就停，不能在背后偷偷重试。
      if (aborted || err.name === 'AbortError') throw err;

      // 出口 2：重试次数用完了。把最后一次的错误原样抛出去，
      //   交给 handleSend 去显示「出错：...」。
      if (attempt >= maxRetries) throw err;

      // 出口 3：这个错重试也没用（401 / 400 这类）。
      if (!isRetryable(err)) throw err;

      // 能走到这里 → 说明这次失败是「暂时的」，值得再试。
      //
      // 指数退避：第 1 次等 1s，第 2 次等 2s，第 3 次等 4s。
      // 为什么不统一等 1 秒？
      //   如果是服务端过载或被限流，所有客户端一起「每秒重试一次」，
      //   等于在持续砸它，越砸越起不来。拉开间隔能让压力自己散掉。
      //   （面试问「你怎么设计重试」，重点就是这句 + 上面那三个出口。）
      const waitMs = 1000 * 2 ** attempt;
      setStatus(`请求失败，${waitMs / 1000} 秒后重试...`);
      await sleep(waitMs);
    }
  }
}

// ⚠️ 一个已知局限（面试主动说出来是加分项）：
//   如果流已经吐了一半才断，重试会「从头再来」——
//   页面上会变成「前半段 + 完整重来一遍」。
//   更严谨的做法：每次尝试前先清空 $output，或者记住已收到的长度做「续传」。
//   这里先不做（那要动 streamChat），你现在只要知道有这么一个坑。

// ============================================
// 关于「中断生成」—— 不用你写，但要看懂
// ============================================
//
// 「点停止 → 请求被掐断」这条链已经接通了，由两部分拼起来：
//
//   ① 你在 TODO 1 里做的那一步（创建 controller、把它挂到 fetch 的 signal 上）
//        currentController = new AbortController();
//        fetch(url, { ..., signal: currentController.signal });
//
//   ② 文件底部已经写好的按钮处理（在「已经写好的部分」那一节）
//        $stop.addEventListener('click', () => {
//          aborted = true;                                    // 打个标记
//          if (currentController) currentController.abort();  // 真的掐断
//        });
//
//   被掐断的 fetch 会抛出一个 name 是 'AbortError' 的异常。
//   handleSend 里单独判断了这种情况，不会弹成"出错"给用户。
//
// 【唯一还需要你操心的地方，在 TODO 2 里】
//   做完重试之后，「用户主动停止」不能算作"失败"去重试。
//   否则用户按了停止，代码还在背后偷偷重试三次。
//   所以重试逻辑里必须判断 aborted。
//
// 想自己验证中断真的生效：npm run smoke -- --stop
// ============================================

// ============================================
// 下面这些是已经写好的部分 —— 不用改，但建议读一遍
// ============================================

function setStatus(text, isError = false) {
  $status.textContent = text || '';
  $status.classList.toggle('err', isError);
}

function setBusy(busy) {
  $send.disabled = busy;
  $stop.disabled = !busy;
  $input.disabled = busy;
}

// 主流程：用户点「发送」时触发
async function handleSend() {
  const text = $input.value.trim();
  if (!text) return;

  if (!API_KEY) {
    setStatus('没读到 Key：先在 .env 里填好 Key，再跑一次 npm run config', true);
    return;
  }

  $output.textContent = '';
  setBusy(true);
  aborted = false;
  setStatus('生成中...');

  try {
    await withRetry(() => streamChat(text));
    setStatus(aborted ? '已停止' : '完成');
  } catch (err) {
    // 注意：用户点「停止」也会走到这里（fetch 会抛 AbortError），
    // 但那是正常流程，不是错误 —— 所以这里不打印，只改状态。
    // （调试真正的报错看下面的 console.error，那里会打出完整的 err。）
    if (err.name === 'AbortError' || aborted) {
      setStatus('已停止');
    } else {
      setStatus('出错：' + err.message, true);
      console.error(err);
    }
  } finally {
    setBusy(false);
    currentController = null;
  }
}

// 事件绑定
$send.addEventListener('click', handleSend);
$stop.addEventListener('click', () => {
  aborted = true;
  if (currentController) currentController.abort();
});
$clear.addEventListener('click', () => {
  $output.textContent = '';
  setStatus('');
});

// Ctrl / Cmd + Enter 快捷发送
$input.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleSend();
});

// 说明：上面的代码都在同一个模块作用域里，
// 所以你在 TODO 函数里可以直接访问 $output、$input、currentController、aborted，
// 不需要 import 或 export。
