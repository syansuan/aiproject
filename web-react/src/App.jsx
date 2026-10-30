import { useEffect, useRef, useState } from 'react';
import { useChatStream } from './hooks/useChatStream.js';

// 密钥来源：根目录 .env（vite.config.js 里 envDir 指过去了）。
// 注意：Key 依然会下发到浏览器，F12 可见 —— 本地练习可以，不能这样上线。
// 正式做法是加一层后端转发，Key 只留服务端（和根目录原生版的已知局限一样）。
const API_KEY = import.meta.env.VITE_ZHIPU_API_KEY ?? import.meta.env.ZHIPU_API_KEY ?? '';

export default function App() {
  const { messages, status, isStreaming, send, stop, clear } = useChatStream({ apiKey: API_KEY });

  const [draft, setDraft] = useState('');
  const bottomRef = useRef(null);

  // 每次 messages 变化后滚到底部（流式时也会持续跟着走）
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  function handleSend() {
    if (isStreaming) return;
    send(draft);
    setDraft('');
  }

  function handleKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleSend();
  }

  return (
    <div className="app">
      <header className="bar">
        <div>
          <h1>AI 对话</h1>
          <p className="sub">React + Vite · 原生 fetch 手写 SSE 流式</p>
        </div>
        <button className="ghost" onClick={clear} disabled={isStreaming}>
          清空
        </button>
      </header>

      <main className="chat">
        {messages.length === 0 && (
          <div className="empty">
            <p>问点什么吧。</p>
            <p className="hint">Ctrl / Cmd + Enter 发送</p>
          </div>
        )}

        {/* React 默认把文本当纯文本渲染（不解析 HTML），
            所以这里不需要像原生版那样刻意用 textContent 来防 XSS —— 但要知道是谁在替你防 */}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="who">{m.role === 'user' ? '你' : 'AI'}</div>
            <div className="text">{m.text || (m.role === 'assistant' ? '…' : '')}</div>
          </div>
        ))}
        <div ref={bottomRef} />
      </main>

      <footer className="composer">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入问题，Ctrl / Cmd + Enter 发送"
          rows={3}
          disabled={isStreaming}
        />
        <div className="actions">
          <span className={`status ${status.startsWith('出错') ? 'err' : ''}`}>{status}</span>
          <button onClick={stop} disabled={!isStreaming}>
            停止
          </button>
          <button className="primary" onClick={handleSend} disabled={isStreaming || !draft.trim()}>
            发送
          </button>
        </div>
      </footer>
    </div>
  );
}
