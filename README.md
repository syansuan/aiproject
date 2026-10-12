# 大模型流式对话页（原生实现）

> 配套笔记：[前端转 AI 第一课：大模型其实是个会中途断线的异步接口](https://juejin.cn/post/7695437620618199094)

用原生 `fetch` 手写大模型流式输出的练习项目：不引入任何 SDK 或框架，从字节流开始
一步步拆出 SSE 协议，把「AI 好神奇」拆成「一个慢一点、贵一点、还会中途断线的异步接口」。

模型侧用智谱 GLM（`glm-4-flash`）。

## 实现了什么

| 功能     | 做法                                                                            |
| -------- | ------------------------------------------------------------------------------- |
| 流式输出 | 手动解析 SSE：按 `\n` 切分、`buffer` 存半行、`lines.pop()` 把半行留给下一轮      |
| 中途停止 | `AbortController` 真的掐断连接，不是只把界面藏起来                              |
| 失败重试 | 网络异常 / 429 / 5xx 自动重试，指数退避 1s → 2s → 4s；401、400 直接报错不再重试 |
| 无头自测 | `npm run smoke` 不开浏览器验证上面三件事（假 DOM + 可注入失败的假 fetch）       |

## 快速开始

```bash
git clone https://github.com/wangxiaoning2/aiproject.git
cd aiproject
cp .env.example .env      # 把智谱 API Key 填到 ZHIPU_API_KEY= 后面
npm install
npm run config            # 从 .env 生成 config.local.js
npm run check             # 请求一次模型，验证 Key 可用
npx serve .               # 打开提示的地址，按 F12 可以看日志
```

## 目录结构

```
aiproject/
├── .env.example          环境变量模板（会提交）—— 需要配哪些变量看这里
├── .env                  真实密钥（不提交，复制模板而来）
├── config.local.js       浏览器端配置（不提交，自动生成，别手动编辑）
├── .gitignore            防止密钥泄露
├── .gitattributes        统一换行符为 LF（避免 Windows/Mac 协作时整个文件都变了）
├── .prettierrc           代码格式规则（会提交）
├── .prettierignore       哪些文件不格式化（密钥、生成物）
├── .vscode/              插件推荐 + 存盘自动格式化（会提交，只这两份）
├── package.json
├── index.html            聊天页界面
├── app.js                流式请求 + SSE 解析 + 失败重试
└── scripts/
    ├── check-key.mjs     验证 Key 是否可用
    ├── gen-config.mjs    从 .env 生成 config.local.js
    └── smoke.mjs         不开浏览器验证 app.js
```

> **为什么配置要拆成两个文件？**
> Node 和浏览器读配置的方式不同：`.env` 给命令行脚本读；
> `config.local.js` 给页面读（浏览器里没有 `fs`，读不了 `.env`）。
> **配置只改 `.env`**，然后跑 `npm run config` 生成另一份。两个都在 `.gitignore` 里。

## 常用命令

```bash
npm run check              # Key 能用吗
npm run config             # 改了 .env 之后，同步给页面
npm run smoke              # app.js 写对了吗（不开浏览器，1 秒出结果）
npm run format             # 按 .prettierrc 排版
npm run format:check       # 只检查不改
```

`smoke` 支持**失败注入**：把 `fetch` 换成一个「按剧本失败」的假 fetch，
再数一数代码到底尝试了几次、中间等了多久。这种手法叫测试替身 / 打桩，
真实项目里测重试就是这么测的。

```bash
npm run smoke -- --stop      # 中途按「停止」，验证中断真的掐断
npm run smoke -- --fail=401  # 期望：只尝试 1 次（401 不该重试）
npm run smoke -- --fail=429x2  # 期望：尝试 3 次，间隔 ≈1s、≈2s（指数退避）
npm run smoke -- --fail=500x9  # 期望：重试到上限后放弃
npm run smoke -- --fail=netx2  # 期望：尝试 3 次（网络异常没有 status，也该重试）
```

> ⚠️ Prettier 只能管「长相」，管不了「结构」：缩进、引号、换行它会替你做；
> 但命名、函数拆分、注释讲的是「为什么」还是「是什么」、`try` 包的范围合不合理，
> 它一个字都改不了。

## 三个踩过的坑

**1. `reader` 不是可迭代对象。** 接口返回的不是 JSON，而是一个 `ReadableStream`。
用 `for...of` 遍历 reader 会直接报错，只能 `getReader()` 拿到 reader，
再用 `while(true)` + `await reader.read()` 一块一块读——这跟写惯了的
`await res.json()` 一次拿完是完全不同的编程模型。

**2. `split('\n')` 切的是协议，不是正文。** 一开始以为 `\n` 是内容里的换行，
其实它是 SSE 协议的分隔符：每条消息必须以 `data: ` 开头、以 `\n\n` 结尾。
真正的坑在于**网络切分点落在字节流中间是随机的**——服务端发的是完整的，
是 TCP 把它从任意位置掰开的，所以某一轮的最后一个元素可能是半行，
要 `pop()` 出来存进 `buffer`，等下一轮拼全。段数 = `\n` 的个数 + 1。

**3. 不要把响应体读两遍。** 调试时加过一行 `await res.clone().text()`，
结果它要等**整个流结束**才返回，打字机效果直接没了，「按停止」的测试也跟着失败
（界面上一直空白，没有东西可以打断）。要看原始数据，就写在 `if (!res.ok)` 分支里
（那是小 JSON，读了不阻塞）。

> 顺带一个边界发现：智谱 `temperature` 范围是 `[0,1]`，传 1.5 直接 400，
> 和 OpenAI 的 `[0,2]` 不一样——换平台时参数得重设。

## 关于安全：Key 能藏到哪一步

现在 API Key 通过 `config.local.js` 注入到页面里，打开 F12 就能看到。
**这只在本地练习时可行，绝不能这样上线。** 要分清两件事：

- 「**不进 Git**」= 密钥不会泄露到 GitHub ✅ 已经做到了
- 「**对使用者保密**」= 做不到。只要页面能跑，Key 就在浏览器内存里

所以 `config.local.js` 只解决了「别把 Key 传到公开仓库」，没有解决「Key 会到前端」。
正确做法是写一个后端接口转发请求：Key 存在服务端，前端只调自己的接口。

## 补充：embedding 模型和对话模型的区别

| 类型     | 作用                         | 例子        | 能聊天吗 |
| -------- | ---------------------------- | ----------- | -------- |
| 对话模型 | 一问一答，生成文字           | glm-4-flash | ✅       |
| 向量模型 | 把文字转成数字，用来算相似度 | embedding-3 | ❌       |

知识库检索（RAG）两个都要用：用向量模型把文档变成向量存起来，用户提问时也转成向量，
找最相似的几段，再交给对话模型生成答案。

## 下一步

- [ ] 加一个后端转发接口，让 Key 不出服务器
- [ ] 把重试抽成可复用的模块，加超时控制
- [ ] 试试工具调用（function calling）和多轮上下文裁剪
