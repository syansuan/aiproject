/**
 * useChatStream —— 根目录原生版 app.js 的 React 版。
 *
 * 两版分工：原生版直接改 DOM（$output.textContent += content），
 * 本版把「文本」变成 state，界面由数据渲染出来。
 * 与原生版的核心差异在 appendDelta：流式一秒几十次更新，
 * 必须用函数式更新，避开渲染快照的陈旧闭包。
 *
 * 能力清单（与原生版一致）：
 *   1. 原生 fetch + ReadableStream 读 SSE，逐字输出
 *   2. 处理半包（网络切分点落在行中间）
 *   3. 用户中途停止（AbortController 真断连接）
 *   4. 失败重试 + 指数退避，且区分「值得重试」与「重试也没用」
 *
 * 自检题见本目录 README「每个 TODO 的判定标准」。
 */

import { useCallback, useRef, useState } from 'react';

const CHAT_URL = '/zhipu/chat/completions';
const MODEL = 'glm-4-flash';

export function useChatStream({ apiKey }) {
  // messages 是唯一的数据源，界面由它渲染出来（单向数据流）
  // 形状：[{ id, role: 'user' | 'assistant', text }]
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  // 用 ref 而不是 state 存这两个：
  // state 变化会触发渲染，而「当前请求的控制器」只是给 stop() 用的句柄，
  // 它变了界面不需要重画。ref 改值不触发渲染，正好。
  const abortRef = useRef(null);
  const abortedRef = useRef(false);

  /**
   * 把增量文本追加到最后一条（assistant 占位）消息。
   *
   * 必须用函数式更新：流式一秒调用几十次，若读外层 messages（渲染快照），
   * 每次都基于同一份旧数组计算，屏幕上只剩最后一块，前面的字全丢。
   * 用不可变替换而非原地改 last.text —— React 靠引用变化决定是否重渲染。
   */
  const appendDelta = useCallback((delta) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
    });
  }, []);

  /**
   * 发一次流式请求，边读边把增量交给 onDelta（移植自根目录 app.js 的 streamChat）。
   *
   * 三个关键点：
   *   a) 先判 response.ok 再读 body —— 401 的错误响应体被当流读，
   *      报错会指向 JSON 解析失败，离真相十万八千里
   *   b) decoder 传 { stream: true } —— 中文是多字节，切分点可能落在一个字的中间
   *   c) buffer 保留最后一段 —— 半包：一行还没收全，等下一轮拼上再处理
   */
  async function streamOnce(userText, onDelta) {
    abortRef.current = new AbortController();

    const response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Bearer 与 Key 之间必须有一个空格，少了会 401
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: userText }],
        stream: true, // 开启 SSE，逐块写入 response.body
        temperature: 0, // 固定为 0 便于复现；智谱取值区间是 [0, 1]
      }),
      signal: abortRef.current?.signal,
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

        const content = json?.choices?.[0]?.delta?.content;
        if (content) onDelta(content);
      }
    }
  }

  /**
   * 重试。判据只有一个：重发一次，结果会不会不一样。
   *   会变（断网 / 429 限流 / 5xx）→ 重试
   *   不会变（400 参数错 / 401 Key 错 / 404 路径错）→ 立刻放弃
   * 用户点了停止 → 任何情况都不许偷偷重试
   */
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
        if (abortedRef.current || err.name === 'AbortError') throw err;

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

  /**
   * 发送。外面这一层是「流程编排」，里面的请求细节在 streamOnce 里。
   */
  const send = useCallback(
    async (text) => {
      const question = text.trim();
      if (!question) return;

      if (!apiKey) {
        setStatus('没读到 Key：先在根目录 .env 里填好，再跑一次 npm run config');
        return;
      }

      abortedRef.current = false;
      setIsStreaming(true);
      setStatus('生成中...');

      // 两条一起 push、一次 setState：先放「你」的提问，再放一条空的 assistant 占位 ——
      // appendDelta 永远改最后一条，请求发出前必须先有接收方。
      // 每次尝试（含重试）前 resetPlaceholder 清空占位，避免重试时拼接出重复内容。
      const resetPlaceholder = () =>
        setMessages((prev) => {
          if (!prev.length) return prev;
          const last = prev[prev.length - 1];
          return [...prev.slice(0, -1), { ...last, text: '' }];
        });
      try {
        await withRetry(() => {
          resetPlaceholder();
          return streamOnce(question, appendDelta);
        });
        setStatus(abortedRef.current ? '已停止' : '完成');
      } catch (err) {
        // 用户点停止 → fetch 抛 AbortError，这是正常流程，不是错误
        if (err.name === 'AbortError' || abortedRef.current) {
          setStatus('已停止');
        } else {
          setStatus('出错：' + err.message);
          console.error(err);
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [apiKey, appendDelta]
  );

  /** 停止：置位 + 真正掐断连接（只让界面停住是假的，请求还在烧 token） */
  const stop = useCallback(() => {
    abortedRef.current = true;
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    setMessages([]);
    setStatus('');
  }, []);

  return { messages, status, isStreaming, send, stop, clear };
}
