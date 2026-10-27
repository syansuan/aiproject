"""embed.py —— 把 data/chunks.json 里每块文本变成向量，存 data/vectors.json

用法（在 server/ 目录下）：
    .\\.venv\\Scripts\\python embed.py
"""

from pathlib import Path
import json
import os
import time
import urllib.error
import urllib.request

# ── 路径 ────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent
CHUNKS_FILE = ROOT / "data" / "chunks.json"
VECTORS_FILE = ROOT / "data" / "vectors.json"

# ── 接口参数 ────────────────────────────────────────────────────
EMBED_URL = "https://open.bigmodel.cn/api/paas/v4/embeddings"
EMBED_MODEL = "embedding-3"
DIMENSIONS = 2048  # 可选 256 / 512 / 1024 / 2048，越大精度越高、流量越大
BATCH_SIZE = 8  # /embeddings 的 input 支持数组，一次最多 64 条；取 8 是为了让失败重试的代价可控

# ── 重试参数 ────────────────────────────────────────────────────
MAX_RETRIES = 3
RETRY_BASE_SECONDS = 1.0


def load_env():
    """读项目根的 .env，把里面的 KEY=VALUE 塞进 os.environ。

    .env 是密钥的唯一真源，代码只负责读进来。格式简单到不值得引 python-dotenv。
    """
    env_file = ROOT / ".env"
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _headers():
    return {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + os.environ["ZHIPU_API_KEY"],
    }


def _post(url, payload):
    """发一次 POST 并解析 JSON。失败时把异常原样抛出，由 with_retry 决定要不要重发。

    只负责"发一次"，不负责重试 —— 单一职责，重试策略改起来不用动这里。

    注意 urllib 与 fetch 的失败模型不同：非 2xx 时 urlopen 直接抛 HTTPError，
    不会像 fetch 那样把失败也当成一个正常返回的 response，所以这里没有
    "先拿 response 再检查状态码"这一步。
    """
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=_headers(), method="POST")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def describe_error(err):
    """把异常变成一行能看懂的原因。

    HTTPError 的错误体只在 except 块内可读（出了块 socket 就关了），
    所以这个方法必须当场被调用，不能把异常对象存起来晚点再解析。
    不读错误体的话，只能看到 "HTTP Error 401: Unauthorized" 这种没信息量的话。
    """
    if isinstance(err, urllib.error.HTTPError):
        try:
            return f"HTTP {err.code}: {err.read().decode('utf-8')[:200]}"
        except Exception:
            return f"HTTP {err.code}: {err.reason}"
    if isinstance(err, urllib.error.URLError):
        return f"网络错误: {err.reason}"
    return f"{type(err).__name__}: {err}"


def is_retryable(err):
    """判断"再发一次，结果会不会不一样"。

    这是唯一需要记的标准，不必背状态码清单：
      会不一样 → 重试：408 超时、429 限流、5xx 服务端故障、连不上服务器
      不会变   → 立刻放弃：400 参数错、401 鉴权失败、403 无权限、404 路径错
    后面这些重发一百次也是同样的错误，只会让调用方白等。
    """
    if isinstance(err, urllib.error.HTTPError):
        return err.code in (408, 429) or 500 <= err.code < 600
    if isinstance(err, urllib.error.URLError):
        return True
    return False


def with_retry(fn, max_retries=MAX_RETRIES):
    """执行 fn()；失败且值得重试时，按 1s → 2s → 4s 退避后重发。

    指数退避而不是固定 1 秒：服务端过载时，所有客户端按同一节奏重试
    等于持续加压，拉开间隔能让压力自己散掉。

    重试只有三个出口：① 次数用完 → 抛   ② 不值得重试 → 抛   ③ 否则等待后重发。
    """
    for attempt in range(max_retries + 1):
        try:
            return fn()
        except (urllib.error.HTTPError, urllib.error.URLError) as err:
            reason = describe_error(err)
            if attempt >= max_retries or not is_retryable(err):
                raise RuntimeError(f"请求失败（尝试 {attempt + 1} 次）：{reason}") from err
            wait = RETRY_BASE_SECONDS * 2**attempt
            print(f"    {reason} → {wait:g}s 后重试（第 {attempt + 1}/{max_retries} 次）")
            time.sleep(wait)


def embed_one(text):
    """把一段文本变成向量，返回 list[float]。"""
    resp = with_retry(
        lambda: _post(
            EMBED_URL,
            {"model": EMBED_MODEL, "input": text, "dimensions": DIMENSIONS},
        )
    )
    return resp["data"][0]["embedding"]


def embed_many(texts):
    """把一堆文本变成一堆向量，返回 list[list[float]]，顺序与 texts 一致。

    按 range 切批：步进由 range 保证，不存在计数器忘记递增导致的死循环。
    """
    vectors = []
    for start in range(0, len(texts), BATCH_SIZE):
        batch = texts[start : start + BATCH_SIZE]
        resp = with_retry(
            lambda: _post(
                EMBED_URL,
                {"model": EMBED_MODEL, "input": batch, "dimensions": DIMENSIONS},
            )
        )
        vectors.extend(item["embedding"] for item in resp["data"])
        print(f"  已处理 {len(vectors)}/{len(texts)} 条")
    return vectors

def save(records: list) -> None:
    """写 data/vectors.json。

    结构 = meta 头 + items 数组。meta 不是装饰：向量文件一旦离开生成它的代码
    就"来历不明" —— 换模型、改维度之后，单看文件无法知道它是哪个版本产出的。

    文本只存 id 引用，正文仍以 chunks.json 为唯一真源（原因见 main 里那段注释）。
    """
    payload = {
        "meta": {
            "model": EMBED_MODEL,
            "dimensions": DIMENSIONS,
            "count": len(records),
            "source": "data/chunks.json",
        },
        "items": records,
    }
    VECTORS_FILE.parent.mkdir(parents=True, exist_ok=True)
    VECTORS_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"共生成 {len(records)} 条向量 → {VECTORS_FILE}")


def main():
    load_env()
    chunks = json.loads(CHUNKS_FILE.read_text(encoding="utf-8"))
    print(f"读到 {len(chunks)} 条 chunk")

    texts = [c["text"] for c in chunks]
    vectors = embed_many(texts)

    # 条数对不上就直接停：zip 会静默截断，切出来的向量会悄悄少几条。
    if len(vectors) != len(chunks):
        raise SystemExit(f"向量 {len(vectors)} 条 ≠ chunk {len(chunks)} 条，先查 embed_many")

    # 只存 id + vector，正文留在 chunks.json：向量会随模型/维度反复重算，而文本
    # 只有一份真源；两边都存文本，迟早出现"改了切分忘了同步"的静默错位。
    records = [{"id": c["id"], "vector": v} for c, v in zip(chunks, vectors)]
    save(records)


if __name__ == "__main__":
    main()
