"""
HTML → Markdown 风格纯文本的转换器。

用途：把带结构的 HTML 文档（知识页、笔记导出）转成「行首 ## 表示标题」的纯文本，
      让上层的 chunk.py 只用一套切分规则就能同时处理 md 和 html 两种来源。

实现上有两处容易出错的地方，原因都写在对应位置：

  1. 标题文字会被拆成多次 handle_data 回调。
     <h2 id="l2"><span class="num">02</span>第二层 · 知识层（RAG）</h2>
     标题里套了 <span>，文字分两次到达；边收边输出会把标题截成两段。
     所以标题文字只在缓冲区累积，遇到标题结束标签再一次性落盘。

  2. 空元素（void tag）没有结束标签。
     <meta charset="utf-8"> / <link …> 永远不会有 </meta>。
     若用"进入 +1 / 离开 −1"的深度计数处理 SKIP 标签，计数永远回不到 0，
     结果是整篇文档都被当成"应跳过内容"，输出为空。
     所以 SKIP 标签改用集合记录当前打开的那些，空元素不入集合。

用法：
    from html2md import html_to_md
    text = html_to_md("data/raw/概念地图.html")
"""

from html.parser import HTMLParser
from pathlib import Path
import re


class HtmlToMarkdown(HTMLParser):
    """把 HTML 转成「行首 ## 表示标题」的纯文本。"""

    # 这些标签里的文字整块丢弃：script/style 里是代码和 CSS，head/title 不是正文
    SKIP_TAGS = {"script", "style", "head", "title", "meta", "link", "nav"}
    # nav 的内容是页面目录，正文里会重复出现，对检索属于噪音

    # 没有结束标签的标签，原因见模块 docstring 第 2 点
    VOID_TAGS = {
        "meta", "link", "br", "hr", "img", "input",
        "area", "base", "col", "embed", "source", "track", "wbr",
    }

    HEADING_TAGS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4}

    # 这些标签意味着"上一段话讲完了"，该把缓冲区内容落成一段
    BLOCK_TAGS = {
        "p", "div", "li", "dd", "dt", "tr", "td", "th", "table",
        "ul", "ol", "dl", "header", "footer", "section", "blockquote", "hr",
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)   # 自动把 &amp; 之类还原成 &
        self.blocks = []            # 已完成的段落
        self.skip_open = set()      # 当前打开的 SKIP 标签，非空则丢弃输入
        self.heading_level = 0      # 0 = 不在标题内；2 = 正在 <h2> 内
        self.heading_buf = []       # 标题文字缓冲区
        self.para_buf = []          # 正文文字缓冲区
        self.in_pre = 0             # <pre> 的嵌套层数，其内部需保留原始换行

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP_TAGS:
            if tag not in self.VOID_TAGS:
                self.skip_open.add(tag)
            return
        if self.skip_open:
            return

        if tag in self.HEADING_TAGS:
            self.flush_para()                       # 标题前先落地上一段
            self.heading_level = self.HEADING_TAGS[tag]
            self.heading_buf = []
        elif tag == "br":
            self.para_buf.append("\n")
        elif tag == "pre":
            self.flush_para()
            self.in_pre += 1
        elif tag in self.BLOCK_TAGS:
            self.flush_para()

    def handle_endtag(self, tag):
        if tag in self.SKIP_TAGS:
            self.skip_open.discard(tag)
            return
        if self.skip_open:
            return

        if tag in self.HEADING_TAGS:
            # 标题文字到这一刻才收齐，可以落盘
            text = re.sub(r"\s+", " ", "".join(self.heading_buf)).strip()
            text = re.sub(r"^\d{1,2}\s*", "", text)   # 去掉开头装饰性的 "00/01/02"
            if text:
                self.blocks.append("#" * self.heading_level + " " + text)
            self.heading_level = 0
        elif tag == "pre":
            self.flush_para()                         # 先落地再退出，否则丢换行
            self.in_pre = max(0, self.in_pre - 1)
        elif tag in self.BLOCK_TAGS:
            self.flush_para()

    def handle_data(self, data):
        if self.skip_open:
            return
        if self.heading_level:
            self.heading_buf.append(data)             # 标题内只累积，不落盘
        else:
            self.para_buf.append(data)

    def flush_para(self):
        """把缓冲区内容整理成一段，追加到 blocks。"""
        if not self.para_buf:
            return
        raw = "".join(self.para_buf)
        self.para_buf = []

        if self.in_pre:
            text = raw.strip("\n")
            if text:
                self.blocks.append("```\n" + text + "\n```")
            return

        text = re.sub(r"[ \t\r\f\v]+", " ", raw)      # 连续空格压成一个
        text = re.sub(r"\n\s*\n+", "\n", text)        # 段内空行压成一个换行
        text = text.strip()
        if text:
            self.blocks.append(text)

    def to_text(self) -> str:
        self.flush_para()
        text = "\n\n".join(self.blocks)
        return re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"


def html_to_md(path) -> str:
    """读取一个 HTML 文件，返回转换后的纯文本。

    显式指定 encoding="utf-8"：Windows 上 open() 默认使用系统编码（中文环境是 GBK），
    读 UTF-8 中文文件会乱码。
    """
    html = Path(path).read_text(encoding="utf-8")
    parser = HtmlToMarkdown()
    parser.feed(html)
    return parser.to_text()
