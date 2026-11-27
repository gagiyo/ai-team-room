#!/usr/bin/env python3
"""index.html 화면 코드의 중복 글 방지 로직을 V8 로 실행해 보는 테스트.

`newMessagesOnly()` 를 index.html 에서 그대로 떼어 내 가짜 DOM·state 로 돌린다.
(같은 글이 폴링·전송 응답으로 두 번 와도 화면에 한 번만 붙는지 확인)

    python3 test_ui.py
"""
import json
import os
import re
import sys

from py_mini_racer import MiniRacer

HERE = os.path.dirname(os.path.abspath(__file__))
HTML_PATH = os.environ.get("HTML_PATH") or os.path.join(HERE, "index.html")
HTML = open(HTML_PATH, encoding="utf-8").read()


def extract_function(src, name):
    """`function name(...){ ... }` 본문을 중괄호 균형으로 잘라 낸다."""
    m = re.search(r"function\s+" + re.escape(name) + r"\s*\(", src)
    if not m:
        raise SystemExit(f"index.html 에서 {name}() 를 찾지 못했습니다")
    start = src.index("{", m.end())
    depth = 0
    for i in range(start, len(src)):
        ch = src[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return src[m.start():i + 1]
    raise SystemExit(f"{name}() 본문의 끝을 찾지 못했습니다")


FUNC = extract_function(HTML, "newMessagesOnly")

TESTS = r"""
var out = [];
function ok(name, cond, extra){ out.push({name: name, ok: !!cond, extra: extra === undefined ? '' : String(extra)}); }

function domWith(ids){
  return { querySelectorAll: function(){
    return ids.map(function(id){ return { getAttribute: function(){ return String(id); } }; });
  } };
}
function run(msgIds, stateIds, domIds){
  state = { messages: stateIds.map(function(id){ return { id: id, content: 'm' + id }; }) };
  elMessages = domWith(domIds);
  return newMessagesOnly(msgIds.map(function(id){ return { id: id, content: 'm' + id }; })).map(function(m){ return m.id; });
}

// 1. 빈 목록
ok('dedupe: 빈 목록', run([], [], []).length === 0, JSON.stringify(run([], [], [])));

// 2. state.messages 에 이미 있는 id 는 버린다
ok('dedupe: 이미 목록에 있는 글', JSON.stringify(run([1, 2], [1, 2], [])) === '[]', JSON.stringify(run([1, 2], [1, 2], [])));

// 3. 목록엔 없어도 DOM 에 있으면 버린다(폴링·전송 응답이 엇갈린 경우)
ok('dedupe: 이미 화면에 있는 글', JSON.stringify(run([3], [], [3])) === '[]', JSON.stringify(run([3], [], [3])));

// 4. data-id 는 문자열, m.id 는 숫자 — 타입이 달라도 같은 글로 본다
ok('dedupe: data-id 문자열과 숫자 id', JSON.stringify(run([7], [], ['7'])) === '[]', JSON.stringify(run([7], [], ['7'])));

// 5. 한 응답 안에 같은 id 가 두 번 와도 한 번만
ok('dedupe: 한 목록 안의 중복', JSON.stringify(run([5, 5, 5], [], [])) === '[5]', JSON.stringify(run([5, 5, 5], [], [])));

// 6. 새 글만 순서 그대로 남는다
ok('dedupe: 새 글만 통과', JSON.stringify(run([4, 6, 7], [6], [7])) === '[4]', JSON.stringify(run([4, 6, 7], [6], [7])));

// 7. 새 글 여러 개는 순서 유지
ok('dedupe: 새 글 순서 유지', JSON.stringify(run([8, 9, 10], [8], [])) === '[9,10]', JSON.stringify(run([8, 9, 10], [8], [])));

// 8. id 가 없는 항목은 그리지 않는다(빈 data-id 방지)
ok('dedupe: id 없는 항목 제외', run([null, undefined], [], []).length === 0 && run([null, undefined], [], []).length === 0, '');

// 9. 입력 목록을 건드리지 않는다
var src = [{ id: 11 }, { id: 12 }];
state = { messages: [] }; elMessages = domWith([]);
var dst = newMessagesOnly(src);
ok('dedupe: 원본 목록 불변', src.length === 2 && dst.length === 2 && src !== dst, 'src ' + src.length);

globalThis.__out = out;
"""

ctx = MiniRacer()
ctx.eval("var state = {messages: []}; var elMessages = {querySelectorAll: function(){ return []; }};\n" + FUNC + "\n" + TESTS)
results = json.loads(ctx.eval("JSON.stringify(globalThis.__out || [])"))

# 전송 중 Enter 중복 방지 — 코드가 실제로 그 자리에 있는지 보는 정적 확인
def has(needle):
    return needle in HTML

source_checks = [
    ("send: sending 플래그 초기값", "sending: false," in HTML),
    ("send: 전송 중 재진입 차단", "if (state.sending) return; // 전송 중에는" in HTML),
    ("send: 전송 시작 시 플래그", "state.sending = true;" in HTML),
    ("send: 응답 뒤 플래그 해제", "state.sending = false;" in HTML),
    ("Enter: 전송 중·자동반복 차단", "if (state.sending || e.repeat) return;" in HTML),
    ("appendMessages: 중복 id 거르기", "list = newMessagesOnly(list);" in HTML),
]
fail = 0
for t in results:
    mark = "PASS" if t["ok"] else "FAIL"
    if not t["ok"]:
        fail += 1
    print(f'{mark}  {t["name"]:<28} {t["extra"]}')
for name, cond in source_checks:
    mark = "PASS" if cond else "FAIL"
    if not cond:
        fail += 1
    print(f'{mark}  {name:<28}')

total = len(results) + len(source_checks)
print(f"\n{total - fail}/{total} passed")
sys.exit(1 if fail else 0)
