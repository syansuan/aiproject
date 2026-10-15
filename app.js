// 原生 fetch 实现的大模型流式对话：SSE 逐块解析、中途停止、失败自动重试。
// 不引入 SDK 或框架 —— 接口本身就是普通 HTTP 请求，先看清它，
// 才知道框架替我们封装了什么。

// ---------- 配置 ----------
// 浏览器里没有 fs / process，读不了 .env，配置由 config.local.js 注入到 window 上
// （index.html 中先于本文件加载）。生成方式：npm run config。
//
// Key 依然会下发到浏览器（F12 可见），本地练习可行，不能这样上线。
// 正式做法是加一层后端转发，Key 只留在服务端。
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

// 本次请求是否被用户中止。停止按钮置位，withRetry 据此决定还要不要重试。
let aborted = false;
// 当前请求的 AbortController，用于真正掐断连接（而不只是让界面停止变化）。
let currentController = null;

// ---------- 流式请求与 SSE 解析 ----------

async function streamChat(userText) {
  currentController = new AbortController();

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Bearer 与 Key 之间必须有一个空格，少了会 401
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: userText }],
      stream: true, // 开启 SSE，逐块写入 response.body
      temperature: 0, // 固定为 0 便于复现；智谱取值区间是 [0, 1]
    }),
    signal: currentController.signal,
  });

  // 先判断 HTTP 状态再解析。否则 401 的错误响应体也会被当成流去读，
  // 报出来的错会非常误导人。
  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // { stream: true } 告诉解码器后面还有数据：多字节字符（中文）被网络切分点
    // 截断时先不要急着输出乱码，等下一次 decode 补齐。
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    // 网络切分点落在字节流中间是随机的，最后一段可能是半行 ——
    // 留在 buffer 里，等下一轮和新数据拼全再处理。
    buffer = lines.pop();

    for (const line of lines) {
      // SSE 每条消息以 "data: " 开头，其余（空行等）跳过。
      if (!line.startsWith('data: ')) continue;

      const payload = line.slice(6).trim(); // 剥掉 "data: " 前缀
      if (payload === '[DONE]') return; // 结束标记

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        // 极少见的不完整行，跳过即可，不要让整个流崩掉
        continue;
      }

      const content = json.choices[0].delta.content;
      if (content) {
        // 用 textContent 而不是 innerHTML：模型输出不可信，避免 XSS
        $output.textContent += content;
      }
    }
  }
}

// ---------- 失败重试 ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 判断一次失败值不值得重发，也就是「重发一次结果会不会不一样」：
//   会不一样（网络抖动 / 限流 / 服务端故障）→ 重试
//   不会变（Key 错、参数错、路径错）→ 立刻放弃
// 依据只有两个：err.status 是多少，以及它到底有没有 status。
function isRetryable(err) {
  const status = err.status;

  // 没有 status → 请求根本没到服务器（断网、DNS 失败、连接被掐）。
  // 这类失败通常是暂时的。
  if (status === undefined) return true;

  // 429 限流：等一会儿再来，这正是 429 存在的意义。
  if (status === 429) return true;

  // 5xx 是服务端自己的问题，它可能下一秒就好。
  if (status >= 500) return true;

  // 400 参数错 / 401 Key 错 / 403 没权限 / 404 路径错：
  // 再发一次结果一模一样，只会让用户白等几秒。
  return false;
}

async function withRetry(fn, maxRetries = 3) {
  // attempt 只负责递增，「什么时候停」全部交给下面三个出口判断 ——
  // 停止规则集中在一处，比塞进循环条件里好读。
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // 出口 1：用户点了停止。必须最先判断 —— 用户说停就停，不能在背后偷偷重试。
      // AbortError 来自被 abort() 掐断的 fetch，aborted 来自停止按钮，两个都判是双保险。
      if (aborted || err.name === 'AbortError') throw err;

      // 出口 2：重试次数用完，把最后一次的错误原样抛给调用方显示。
      if (attempt >= maxRetries) throw err;

      // 出口 3：这类错重试也没用（401 / 400 …）。
      if (!isRetryable(err)) throw err;

      // 指数退避：1s → 2s → 4s。
      // 不统一等 1 秒的原因：服务端过载或限流时，所有客户端按同一节奏重试
      // 等于持续加压，只会更起不来；拉开间隔能让压力自己散掉。
      const waitMs = 1000 * 2 ** attempt;
      setStatus(`请求失败，${waitMs / 1000} 秒后重试...`);
      await sleep(waitMs);
    }
  }
}

// 已知局限：如果流吐到一半才断，重试会从头再来，页面变成「前半段 + 完整重放」。
// 更严谨的做法是每次尝试前清空 $output，或记录已收长度做续传。

// ---------- 界面状态 ----------

function setStatus(text, isError = false) {
  $status.textContent = text || '';
  $status.classList.toggle('err', isError);
}

function setBusy(busy) {
  $send.disabled = busy;
  $stop.disabled = !busy;
  $input.disabled = busy;
}

// 主流程：点击「发送」
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
    // 用户点「停止」也会走到这里（fetch 抛 AbortError），但那是正常流程不是错误，
    // 所以只更新状态、不当作报错；真正的异常才打 console.error 便于排查。
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

// ---------- 事件绑定 ----------

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
