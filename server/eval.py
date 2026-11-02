from pathlib import Path
import json
import search

ROOT = Path(__file__).resolve().parent.parent
EVAL_FILE = ROOT / "data" / "eval_set.json"


def main():
  cases =  json.loads(EVAL_FILE.read_text('utf-8'))['cases']
  for i,c in enumerate(cases, 1):
    hits =  search.search(c['question'], top_k = 3)
    print(f"===== 第 {i} 题：{c['question']} =====")
    for score, chunk in hits:
      print(f"{score:.4f}  [{chunk['source']}] {chunk['heading']} (id={chunk['id']})")

if __name__ == "__main__":
    main()