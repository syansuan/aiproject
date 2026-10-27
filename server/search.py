"""向量检索：把一个提问在本地向量库里找出最相近的几段原文。

检索是 RAG 的前半段 —— 它只负责"找出资料"，不负责回答。
答案由 app.py 的 /ask 把这几段拼进提示词，再交给大模型生成。

用法（在 server/ 目录下）：
    .\\.venv\\Scripts\\python search.py "流式输出怎么中途停止"

已知局限：这里没有"拒答"能力。库里没有相关内容时，它照样返回分数最高的
top_k 条，只是分数偏低。判断"资料够不够答"目前压在模型层（靠提示词约束），
第 2 周会用评测集决定要不要加分数阈值。
"""

from pathlib import Path
import json
import sys

import embed

ROOT = Path(__file__).resolve().parent.parent
CHUNKS_FILE = ROOT / "data" / "chunks.json"
VECTORS_FILE = ROOT / "data" / "vectors.json"


def load_index():
    """把原文和向量一次读进内存，返回 (chunks, vectors)。

    chunks  —— [{"id", "source", "heading", "text"}, ...]
    vectors —— [[2048 个浮点数], ...]，与 chunks 按下标一一对应

    vectors.json 的结构是 {"meta": ..., "items": [{"id", "vector"}, ...]}，
    不是裸列表 —— 取向量前要先下到 "items" 这一层。

    这里按下标对齐、没有比对 id，依赖"重切 chunks 后必须重跑 embed.py"这条约定。
    embed.py 存了 id 正是为了将来能校验；现在靠约定，属于技术债。
    """
    chunks = json.loads(CHUNKS_FILE.read_text(encoding="utf-8"))
    vectors = json.loads(VECTORS_FILE.read_text(encoding="utf-8"))
    return chunks, [item["vector"] for item in vectors["items"]]


def dot(a, b):
    """两个等长向量的内积。

    智谱返回的向量模长都是 1.0000，所以内积就等于余弦相似度，
    不必再写 a·b / (|a|·|b|)。换用未归一化的模型时要把除法补回来。
    """
    return sum(x * y for x, y in zip(a, b))


def score_all(qvec, chunks, vectors):
    """给每条 chunk 打一个分数，返回 [(分数, chunk), ...]，顺序与输入一致。

    打分是"一问多比"：拿问题向量，和库里每一条向量各比一次 ——
    不是把整个库当成一个向量去比，所以必须逐条算。

    用 enumerate 而不是 zip：两边条数不等时它会当场 IndexError，
    而 zip 会静默少算几条，检索结果看起来正常但缺了东西。
    """
    return [[dot(qvec, vectors[i]), chunk] for i, chunk in enumerate(chunks)]


def rank(pairs, top_k):
    """把 [(分数, chunk), ...] 按分数从高到低排好，取前 top_k 条。"""
    return sorted(pairs, key=lambda pair: pair[0], reverse=True)[:top_k]


def search(question, top_k=3):
    """问题 → 向量 → 逐条打分 → 排序 → 取前 top_k。返回 [(分数, chunk), ...]。

    提问这一侧也要过一遍 embed：库里的向量是 2048 个数，新问题必须先变成
    同维度的数才能比。且必须用同一个模型（embedding-3），换模型两侧就不在
    同一个空间里，算出来的分数没有意义。
    """
    embed.load_env()
    chunks, vectors = load_index()
    qvec = embed.embed_one(question)
    return rank(score_all(qvec, chunks, vectors), top_k)


def main():
    """命令行自检：不开服务也能看检索结果，用来单独验证切分与向量是否靠谱。"""
    question = sys.argv[1] if len(sys.argv) > 1 else "流式输出怎么中途停止"
    print(f"问题：{question}\n")
    for score, chunk in search(question):
        print(f"{score:.4f}  [{chunk['source']}] {chunk['heading']}")
        print(f"        {chunk['text'][:70]}...\n")


if __name__ == "__main__":
    main()
