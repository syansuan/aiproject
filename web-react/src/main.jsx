import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// React 18 起用 createRoot 取代 ReactDOM.render：
// 它开启并发渲染，setState 的调用会被批量合并，不再同步刷 DOM。
// 这一点对「流式逐字输出」影响很大 —— 见 hooks/useChatStream.js 顶部的说明。
//
// StrictMode 在开发环境会把组件挂载、effect 执行两遍，用来提前暴露副作用写错的问题。
// 副作用里如果发起请求、又没做清理，控制台会出现两次请求 —— 那是提醒，不是 bug。
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
