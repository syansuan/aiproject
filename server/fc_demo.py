"""Function Calling 稳定闭环：让模型自主决定何时查知识库。

用法（在 server/ 目录下）：
    .\\.venv\\Scripts\\python fc_demo.py "RAG 是什么"

与 /ask 的分工：/ask 由代码决定「先检索再回答」，检索是必然发生的；
这里把「查什么、查几次」交给模型，用于考察工具调用链路。

已知局限（实测 glm-4-flash）：
- temperature=0 也不保证确定性：让模型自主决定是否调工具时，同一问题
  5 次结果 3:2 不稳定（有时直接答、有时调工具）。
- tool_choice="required" 强制率实测约 87.5%（8 次大样本），仍非硬保证。
- 因此首轮检索改为应用层无条件执行（见 main 中的 run_tool 注入）——
  平台保证不了的行为移到架构层保证，模型只负责后续追问的追加查询。
- 当前固定为「1 次注入 + 1 轮工具往返」两段式；若第 2 轮模型仍返回
  tool_calls 而非文字，按未作答兜底处理（见 main 末尾）。
"""

from pathlib import Path
import json
import sys

import embed
import search

ROOT = Path(__file__).resolve().parent.parent
CHAT_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
CHAT_MODEL = "glm-4-flash"

SYSTEM_PROMPT = (
    "你是资料问答助手。严格按规则执行："
    "1. 资料已在对话中提供；如需更多信息可调用 search_knowledge 追加查询。"
    "问题涉及多个话题时，必须为每个话题分别调用；"
    "2. 只依据工具返回的资料回答；"
    "3. 资料与问题无关或不足以回答时，只输出一句话：资料里没有相关内容；"
    "4. 资料足以回答时，直接给出针对问题的回答，展开说明，不要复述资料原文。"
)

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_knowledge",
            "description": "在用户的个人AI开发知识库里检索资料。凡是被问到AI开发相关概念、实现、踩坑，都应该先查它再回答",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "检索用的关键词或问题"}
                },
            },
            "required": ["query"],
        },
    }
]


def run_tool(name, arguments):
    """执行模型点名的工具。name 必须在白名单里——模型可能编造不存在的工具名。"""
    if name != "search_knowledge":
        return f"错误：未知工具 {name}"
    
    query = arguments.get("query")
    
    if not isinstance(query, str) or not query.strip():
        return "错误：缺少有效的 query 参数，请传一个非空字符串"

    try:
        hits = search.search(query, top_k=3)
    except Exception as e:
        return f"错误：检索失败： {str(e)}"

    return json.dumps(
        [{"heading": c["heading"], "text": c["text"][:300]} for _, c in hits],
        ensure_ascii=False,
    )


def main():
    embed.load_env()
    question = sys.argv[1]
    post_data = {
        "model": CHAT_MODEL,
        "tools": TOOLS,
        "stream": False,
        "temperature": 0,
        "tool_choice": "auto",
    }
    # messages 是对话的唯一事实源，模型每轮都看全量历史。
    # tool_calls 往返的完整形状：
    #   [system, user, assistant(带tool_calls), tool(结果), assistant(最终答案)]
    # 第 3 条（模型的调用意图）必须原样入史，缺了它模型对不上账。
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": question},
    ]

    # 首轮检索不交给模型，由代码无条件执行（架构保证）。
    # 资料以 user 消息注入而非伪造 tool 消息——协议要求 tool 消息
    # 必须携带真实存在的 tool_call_id，伪造会破坏对账。
    result = run_tool("search_knowledge", {"query": question})
    messages.append({
        "role": "user",
        "content": f"[系统已检索的资料]\n{result}\n\n请基于以上资料回答最初的问题。",
    })
    resp = embed._post(CHAT_URL, {**post_data, "messages": messages})
    msg = resp["choices"][0]["message"]
    messages.append(msg)

    if not msg.get("tool_calls"):
        print(msg.get("content") or "（模型未给出文字回答，可能仍在调用工具）")
        return

    for tool_call in msg["tool_calls"]:
        tool_content = tool_call[tool_call["type"]]
        arguments = json.loads(tool_content["arguments"])
        result = run_tool(tool_content["name"], arguments)
        messages.append(
            {"role": "tool", "tool_call_id": tool_call["id"], "content": result}
        )

    response = embed._post(CHAT_URL, {**post_data, "messages": messages})
    final = response["choices"][0]["message"]
    print(final.get("content") or "（模型未给出文字回答，可能仍在调用工具）")


if __name__ == "__main__":
    main()
