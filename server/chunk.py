"""
chunk.py —— 语料切分：把 data/raw/ 下的文档切成带编号的小块。

输入：data/raw/*.md | *.html
      Markdown 直接读；HTML 先经 html2md 转成行首 ## 的纯文本
输出：data/chunks.json
      [{"id": 1, "source": ..., "heading": ..., "text": ...}, ...]

切分策略分两级：
  1. 按 "## " 标题切 —— 保证一个主题不被切开，同时给每块留下 heading 元数据
  2. 主题仍超长时再按长度切 + 相邻重叠 —— 避免单块超出模型的上下文预算，
     重叠是为了不让答案正好卡在切缝上

用法：python chunk.py
"""

from pathlib import Path
import json

import html2md

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
OUT_FILE = ROOT / "data" / "chunks.json"

# chunking 策略参数 —— 这三个数直接影响检索质量，改动后需重跑并对比命中情况
MAX_CHARS = 600   # 单块字符上限
OVERLAP = 100     # 相邻块重复的字符数，用来兜住跨切缝的语义


def load_documents() -> list[tuple[str, str]]:
    """读取 data/raw/ 下所有语料，返回 [(来源名, 纯文本), ...]。

    排序后再遍历：iterdir() 的返回顺序依赖文件系统，不排序的话每次跑出来的
    chunk id 都可能不同，前后两次的产物没法 diff。
    """
    docs = []
    for path in sorted(RAW_DIR.iterdir()):
        if path.suffix == ".md":
            text = path.read_text(encoding="utf-8")
        elif path.suffix == ".html":
            text = html2md.html_to_md(path)
        else:
            continue
        docs.append((path.stem, text))
    return docs


def split_by_heading(text: str, source: str) -> list[dict]:
    """第一级切分：按 "## " 标题切成主题块。

    第一个标题之前的内容（文档大标题、引言）直接丢弃 —— 它们属于全篇，
    不属于任何一个可检索的主题，留着只会污染召回结果。
    """
    parts = []
    for line in text.splitlines():
        if line.startswith("## "):
            parts.append(
                {
                    "source": source,
                    "heading": line.removeprefix("## "),
                    "text": "",
                }
            )
        elif parts:
            parts[-1]["text"] += line + "\n"

    for part in parts:
        part["text"] = part["text"].strip()
    return parts


def split_long(text: str, limit: int = MAX_CHARS, overlap: int = OVERLAP) -> list[str]:
    """第二级切分：把超长文本按长度切开，相邻块重叠 overlap 个字符。

    start 的前进量是 limit - overlap，必须为正，否则原地打转。
    这里用 while 而不是 range：range 的步长固定，将来若要把切点对齐到句子边界，
    需要临时调整 start，range 做不到。
    """
    if len(text) <= limit:
        return [text]

    pieces = []
    start = 0
    while start < len(text):
        if len(text) - start <= overlap:
            # 剩余内容已被上一块完整覆盖，再切一块只是重复内容
            break
        pieces.append(text[start : start + limit])
        start += limit - overlap
    return pieces


def build_chunks(docs: list[tuple[str, str]]) -> list[dict]:
    """两级切分并按顺序编号，产出最终的 chunk 列表。"""
    chunks = []
    for source, text in docs:
        for part in split_by_heading(text, source):
            for piece in split_long(part["text"]):
                chunks.append(
                    {
                        "id": len(chunks) + 1,
                        "source": part["source"],
                        "heading": part["heading"],
                        "text": piece,
                    }
                )
    return chunks


def save(chunks: list[dict]) -> None:
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(
        json.dumps(chunks, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"共切出 {len(chunks)} 块 → {OUT_FILE}")


def preview(chunks: list[dict], n: int = 3) -> None:
    """打印前 n 条，用于人工抽查切分质量。"""
    print(f"\n抽查前 {n} 条：")
    for c in chunks[:n]:
        print(f"\n[id={c['id']}] {c['source']} / {c['heading']}")
        print(f"  {len(c['text'])} 字 | {c['text'][:80]}...")


def main() -> None:
    docs = load_documents()
    print(f"读到 {len(docs)} 份文档：{[name for name, _ in docs]}")

    chunks = build_chunks(docs)
    if not chunks:
        raise SystemExit("没有切出任何内容，检查 data/raw/ 下是否有 .md / .html")

    save(chunks)
    preview(chunks)


if __name__ == "__main__":
    main()
