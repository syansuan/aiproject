# web-react —— AI 对话前端 · React 版

和根目录的原生 JS 版**并存**，不是替换。两个版本存在的理由不同：

| | 根目录原生版（index.html + app.js） | 本目录 React 版 |
|---|---|---|
| 用途 | 面试讲**底层**：fetch、ReadableStream、SSE 半包、AbortController、指数退避 | 面试讲**工程化**：组件拆分、hooks、状态驱动视图 |
| 一句话 | "我不靠 SDK 也写得出来" | "我也用 React 把同一个东西工程化过" |

两版共用同一个后端和同一份密钥（根目录 `.env`）。

---

## 启动

```bash
# 1. 装依赖（第一次）
cd E:\study\ai-journey\web-react
npm install

# 如果报 @esbuild/win32-x64 could not be found（Windows 上偶发，可选项没被装上）
npm install @esbuild/win32-x64 --no-save

# 2. 起后端（另开一个终端）
cd E:\study\ai-journey\server
.venv\Scripts\python -m uvicorn app:app --reload

# 3. 起前端
cd E:\study\ai-journey\web-react
npm run dev          # http://localhost:5173
```

> Key 来自根目录 `.env`（`vite.config.js` 里 `envDir` 指过去了）。
> 前端页面 F12 仍能看到 Key —— 本地练习可以，不能这样上线，正式做法是加后端转发。

---

## 你的 4 个 TODO

全部在 `src/hooks/useChatStream.js`。界面（`App.jsx`）和样式已经写好了，不用动。

| # | 目标 | 验收（做到什么算完成） |
|---|---|---|
| **1** | `streamOnce()`：发流式请求 + 解析 SSE | 提问后文字**逐块**出现在页面上，不是一次性全冒出来 |
| **2** | `appendDelta()`：把增量追加到最后一条消息 | 中文长回答**一个字都不丢**（说明函数式更新写对了） |
| **3** | `withRetry()`：重试 + 指数退避 | 把 Key 改错 → 只报一次错不重试；拔网线 → 看到 1s/2s/4s 三次重试 |
| **4** | `send()` 里塞入用户消息 + assistant 占位消息 | 提问后立刻出现"你"的气泡和 AI 的空占位，然后才开始长字 |

### 每个 TODO 的判定标准（能讲出来才算过）

1. **为什么先判 `response.ok` 再读 body？**
   → 401/500 的错误响应体也会被当成流去读，最后的报错会指向 JSON 解析失败，离真相十万八千里。

2. **`decoder.decode(value, { stream: true })` 的 `stream: true` 是干什么的？**
   → 中文是多字节（UTF-8 三个字节一个字），网络切分点可能落在某个字的中间。不加这个参数，半个字会被解成乱码。

3. **`buffer = lines.pop()` 为什么要把最后一段留下？**
   → 半包。一行还没收全，先留着，下一轮和新数据拼起来再处理。

4. **为什么用 `setMessages(prev => ...)` 而不是 `setMessages(messages.map(...))`？**
   → 后者读的是本次渲染的快照。流式一秒调几十次，每次都基于同一份旧数据算，屏幕上只剩最后一块。

5. **停止时为什么必须 `controller.abort()`，只把按钮禁用不行？**
   → 只改界面是假的，请求还在跑，token 还在烧。

6. **为什么 401 不该重试，429 和 5xx 可以？**
   → 判据是"重发一次结果会不会不一样"。Key 错重发一万次还是错；限流和服务端故障是暂时的。

7. **退避为什么要 1s→2s→4s，不统一等 1 秒？**
   → 服务端过载时，所有客户端按同一节奏重试等于持续加压。

8. **React 版的 `messages` 和原生版的 `$output.textContent` 有什么本质区别？**
   → 前者是数据源，界面是它的函数；后者是直接改视图。前者能回放、能撤销、能测试，后者不能。

---

## 一天怎么排（4h 主线 + 1h 概念 + 0.5h 求职）

- **0:00–2:00** TODO 1 + 2：打通逐字输出。卡住就对着根目录 `app.js` 的 `streamChat()` 一行行对照移植。
- **2:00–3:00** TODO 4：消息列表能正常显示用户提问与回答（列表渲染 + key）。
- **3:00–4:00** TODO 3：重试与停止。用改错 Key、断网两种方式自测。
- **+1h 概念**：React 状态更新为什么是异步的 / 函数式更新的意义（陈旧闭包）。
- **+0.5h 求职**：投 5 家 C 级（见今日计划）。

---

## 已知坑

- **StrictMode 下看到两次请求**：开发环境故意挂载两次，用来暴露副作用没清理。生产构建不会有。
- **流式时页面有点抖**：每个增量都触发一次渲染。能跑通之后再考虑优化（缓冲到 ref、按帧批量刷）。
- **`npm install` 报 esbuild 二进制缺失**：见上面启动第 1 步的补救命令。
- **本版还没接 `/ask`（RAG 知识库问答）**：后端接口是现成的，等流式跑顺了再加「知识库模式」，那一步会把 sources 展示一起做掉。
