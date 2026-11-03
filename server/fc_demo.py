"""Function Calling 稳定闭环：让模型自主决定何时查知识库。

用法（在 server/ 目录下）：
    .\\.venv\\Scripts\\python fc_demo.py "RAG 是什么"

与 /ask 的分工：/ask 由代码决定「先检索再回答」，检索是必然发生的；
这里把「查什么、查几次」交给模型，用于考察工具调用链路。

已知局限（实测 glm-4-flash，2026-11-03）：
- 提示词约束下首轮必调工具的比率约 60%；tool_choice="required" 提升到
  约 87.5%（8 次大样本），但均非硬保证——模型仍可能跳过工具用训练
  记忆作答，且 temperature=0 也不保证确定性。
- 待做：把首轮检索改为应用层无条件执行（架构保证），模型只决定后续
  追问。届时本文件的 first-round required 策略可退役。
"""

from pathlib import Path
import json
import sys

import embed
import search

ROOT = Path(__file__).resolve().parent.parent
CHAT_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
CHAT_MODEL = "glm-4-flash"

MAX_ROUNDS = 5  # 防死循环：模型可能反复要求调工具而不给出最终回答

SYSTEM_PROMPT = (
    "你是资料问答助手。严格按规则执行："
    "1. 回答任何问题前，必须先调用 search_knowledge 工具查资料，禁止直接回答；"
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
    hits = search.search(arguments["query"], top_k=3)
    return json.dumps(
        [{"heading": c["heading"], "text": c["text"][:300]} for _, c in hits],
        ensure_ascii=False,
    )


def main():
    embed.load_env()
    question = sys.argv[1]

    # messages 是对话的唯一事实源，模型每轮都看全量历史。
    # tool_calls 往返的完整形状：
    #   [system, user, assistant(带tool_calls), tool(结果), assistant(最终答案)]
    # 第 3 条（模型的调用意图）必须原样入史，缺了它模型对不上账。
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": question},
    ]

    post_data = {
        "model": CHAT_MODEL,
        "messages": messages,
        "tools": TOOLS,
        "stream": False,
        "temperature": 0,
    }

    for round_i in range(MAX_ROUNDS):
        # 第一轮 required：尽量强制先查资料；后续轮 auto：
        # required 若全程开着，模型每轮都只能调工具，永远给不出最终回答
        post_data["tool_choice"] = "required" if round_i == 0 else "auto"

        resp = embed._post(CHAT_URL, post_data)
        msg = resp["choices"][0]["message"]
        messages.append(msg)

        if not msg.get("tool_calls"):
            print(msg.get("content") or "（模型未给出文字回答，可能仍在调用工具）")
            return

        print("模型调用工具：", msg["tool_calls"])
        for tool_call in msg["tool_calls"]:
            tool_content = tool_call[tool_call["type"]]
            arguments = json.loads(tool_content["arguments"])
            result = run_tool(tool_content["name"], arguments)
            messages.append(
                {"role": "tool", "tool_call_id": tool_call["id"], "content": result}
            )

    print(f"（异常：模型连续 {MAX_ROUNDS} 轮请求调用工具，未给出最终回答）")


if __name__ == "__main__":
    main()
