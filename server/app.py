"""一次 RAG 问答：检索 → 拼提示词 → 调模型。

请求体  {"question": "..."}
返回    {"answer": "...", "sources": [{"id", "source", "heading"}, ...]}

设计取舍：
  - 检索与生成分两个文件。search.py 只管"找出哪几段最像"，不知道有模型的存在；
    这里只管"拿资料去问模型"。换检索策略（改切分、换向量模型、加 rerank）不动这里。
  - 请求直接复用 embed._post + with_retry：重试策略只该有一份实现，
    两处各写一份，迟早只改了一处。
  - 提示词拆 system / user：规则放 system（模型的纪律），资料和问题放 user（待处理的输入）。
    全部塞进一条 user 消息时，模型分不清"哪些是规则、哪些是材料"，
    遇到不相关资料就会把材料当任务，输出一大段原文摘要。
"""

from fastapi import FastAPI

import embed
import search

app = FastAPI()

# 不同的提示词，答案会有不同，无提示词时答案大部分为提供的资料复述。
# SYSTEM_PROMPT = (
#     "你是资料问答助手。严格按规则执行："
#     "1. 只依据用户提供的资料回答；"
#     "2. 资料与问题无关或不足以回答时，只输出一句话：资料里没有相关内容；"
#     "3. 禁止复述资料原文，禁止输出与问题无关的内容。"
# )
SYSTEM_PROMPT = (
    "你是资料问答助手。严格按规则执行："
    "1. 只依据用户提供的资料回答；"
    "2. 资料与问题无关或不足以回答时，只输出一句话：资料里没有相关内容；"
    "3. 资料足以回答时，直接给出针对问题的回答，展开说明，不要复述资料原文；"
    "4. 禁止输出与问题无关的内容。"
)
# 检索条数。调大能提高召回，但会把噪声一起塞进去，反而降低答案质量。
TOP_K = 3

CHAT_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
CHAT_MODEL = "glm-4-flash"


@app.get("/health")
def health():
    return {"ok": True}


def build_context(hits):
    """把命中的段落拼成带编号的资料块。

    编号不是装饰：模型靠它区分"第几段资料"，后续要做引用溯源时也靠它定位。
    """
    return "\n\n".join(
        f"[资料{i + 1}] {chunk['text']}" for i, (_, chunk) in enumerate(hits)
    )


def build_sources(hits):
    """只返回定位信息，不回传原文。

    接口返回的东西要过网络，前端只需要知道"这条答案出自哪一节"；
    原文留在 chunks.json，需要时按 id 回查。
    """
    return [
        {"id": chunk["id"], "source": chunk["source"], "heading": chunk["heading"]}
        for _, chunk in hits
    ]


@app.post("/ask")
def ask(payload: dict):
    question = payload["question"]

    # A. 检索：拿回最接近的几段原文（检索层不知道答案，只负责排序）
    hits = search.search(question, top_k=TOP_K)

    # B. 拼词：资料与问题分开标号，避免模型把材料当成任务
    user_prompt = f"资料：\n{build_context(hits)}\n\n问题：{question}"

    # C. 调用：非流式。服务端一次取完整个答案，流式留给前端那个页面去做
    resp = embed._post(
        CHAT_URL,
        {
            "model": CHAT_MODEL,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            "stream": False,
        },
    )

    return {
        "answer": resp["choices"][0]["message"]["content"],
        "sources": build_sources(hits),
    }
