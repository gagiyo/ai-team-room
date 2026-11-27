#!/usr/bin/env python3
"""index.html 화면 코드를 V8 로 실행해 보는 테스트.

1) 중복 글 방지 — `newMessagesOnly()` 를 index.html 에서 그대로 떼어 내 가짜 DOM·state 로 돌린다.
   (같은 글이 폴링·전송 응답으로 두 번 와도 화면에 한 번만 붙는지 확인)
2) 프로젝트 목록·필터 — `projectOf()` / `projectCounts()` / `matchProject()` 를 실제 코드로 돌린다.
3) 회의실 색 — `roomColor()` / `hslToHex()` (등록된 방·새 방의 결정적 색)
4) 이번 개편의 화면 코드가 실제로 그 자리에 있는지 정적 확인(타임라인 제거·제목 버튼 등)

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


def extract_var(src, name):
    """`var name = <식>;` 선언을 통째로 잘라 낸다(대괄호·중괄호·문자열 무시)."""
    m = re.search(r"var\s+" + re.escape(name) + r"\s*=\s*", src)
    if not m:
        raise SystemExit(f"index.html 에서 var {name} 선언을 찾지 못했습니다")
    i = m.end()
    depth = 0
    quote = None
    while i < len(src):
        ch = src[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
        elif ch in "'\"`":
            quote = ch
        elif ch in "[{(":
            depth += 1
        elif ch in "]})":
            depth -= 1
        elif ch == ";" and depth == 0:
            return src[m.start():i + 1]
        i += 1
    raise SystemExit(f"var {name} 선언의 끝을 찾지 못했습니다")


FUNC = extract_function(HTML, "newMessagesOnly")

PROJECT_DECLS = "\n".join(
    extract_var(HTML, n)
    for n in ("PROJECTS", "PROJECT_ALIASES", "PROJECT_ROOM", "PROJECT_ALL", "PROJECT_NONE", "PROJECT_KEY", "ROOM_COLORS")
)
PROJECT_FUNCS = "\n".join(
    extract_function(HTML, n)
    for n in ("normText", "projectNames", "projectTerms", "projectOf", "projectCounts",
              "projectLabel", "isProjectFilterActive", "matchProject", "hslToHex", "roomColor")
)

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

// ---------------- 중복 글 방지 (v1.10.1) ----------------
ok('dedupe: 빈 목록', run([], [], []).length === 0, JSON.stringify(run([], [], [])));
ok('dedupe: 이미 목록에 있는 글', JSON.stringify(run([1, 2], [1, 2], [])) === '[]', JSON.stringify(run([1, 2], [1, 2], [])));
ok('dedupe: 이미 화면에 있는 글', JSON.stringify(run([3], [], [3])) === '[]', JSON.stringify(run([3], [], [3])));
ok('dedupe: data-id 문자열과 숫자 id', JSON.stringify(run([7], [], ['7'])) === '[]', JSON.stringify(run([7], [], ['7'])));
ok('dedupe: 한 목록 안의 중복', JSON.stringify(run([5, 5, 5], [], [])) === '[5]', JSON.stringify(run([5, 5, 5], [], [])));
ok('dedupe: 새 글만 통과', JSON.stringify(run([4, 6, 7], [6], [7])) === '[4]', JSON.stringify(run([4, 6, 7], [6], [7])));
ok('dedupe: 새 글 순서 유지', JSON.stringify(run([8, 9, 10], [8], [])) === '[9,10]', JSON.stringify(run([8, 9, 10], [8], [])));
ok('dedupe: id 없는 항목 제외', run([null, undefined], [], []).length === 0 && run([null, undefined], [], []).length === 0, '');
var src = [{ id: 11 }, { id: 12 }];
state = { messages: [] }; elMessages = domWith([]);
var dst = newMessagesOnly(src);
ok('dedupe: 원본 목록 불변', src.length === 2 && dst.length === 2 && src !== dst, 'src ' + src.length);

// ---------------- 프로젝트 목록 · 분류 ----------------
ok('project: 설정 순서 그대로 4개',
   JSON.stringify(projectNames()) === JSON.stringify(['무림AI방','사이즈핏','스크랩박스','브랜드커넥트']),
   JSON.stringify(projectNames()));
// v1.11.1 — 묶음은 3개 그대로 두고 소속만 옮겼다(빈 묶음은 화면에서 건너뛴다)
ok('project: 분류 묶음 3개 유지',
   JSON.stringify(PROJECTS.map(function(g){ return g.grp; })) === JSON.stringify(['완료·수정 중','진행 중','예정']),
   JSON.stringify(PROJECTS.map(function(g){ return g.grp; })));
ok('project: 사이즈핏·스크랩박스는 완료·수정 중',
   JSON.stringify(PROJECTS[0].names) === JSON.stringify(['무림AI방','사이즈핏','스크랩박스']) &&
   PROJECTS[1].names.length === 0 &&
   JSON.stringify(PROJECTS[2].names) === JSON.stringify(['브랜드커넥트']),
   JSON.stringify(PROJECTS));
ok('project: 이름이 글에 있으면 그 프로젝트', projectOf({content:'사이즈핏 배포 끝났습니다'}) === '사이즈핏', projectOf({content:'사이즈핏 배포 끝났습니다'}));
ok('project: 별칭 size-fit 매칭', projectOf({content:'size-fit v2 라이브 확인'}) === '사이즈핏', projectOf({content:'size-fit v2 라이브 확인'}));
ok('project: 띄어쓰기·하이픈 무시', projectOf({content:'scrap box 폴더 UI'}) === '스크랩박스', projectOf({content:'scrap box 폴더 UI'}));
ok('project: 별칭 ai-team-room 매칭', projectOf({content:'ai-team-room 1.11.0 배포'}) === '무림AI방', projectOf({content:'ai-team-room 1.11.0 배포'}));
ok('project: 대소문자 무시', projectOf({content:'Size-Fit 화면'}) === '사이즈핏', projectOf({content:'Size-Fit 화면'}));
ok('project: 첨부 파일 이름도 본다', projectOf({content:'', attachment:{filename:'scrap-box.png'}}) === '스크랩박스', '');
ok('project: 어느 이름에도 안 걸리면 미분류', projectOf({content:'회의는 목요일로 합시다'}) === '', '[' + projectOf({content:'회의는 목요일로 합시다'}) + ']');
ok('project: 먼저 나온 이름이 이긴다', projectOf({content:'무림AI방이랑 사이즈핏 둘 다'}) === '무림AI방', projectOf({content:'무림AI방이랑 사이즈핏 둘 다'}));
ok('project: 빈 글은 미분류', projectOf({content:''}) === '' && projectOf(null) === '', '');
var counts = projectCounts([
  {id:1, content:'사이즈핏 배포'},
  {id:2, content:'그냥 잡담'},
  {id:3, content:'size-fit 재확인'},
  {id:4, content:'스크랩박스 폴더', deleted:true},
  {id:5, content:'브랜드커넥트 기획'}
]);
ok('project: 건수 집계(삭제 글 제외)',
   counts.all === 4 && counts['사이즈핏'] === 2 && counts['브랜드커넥트'] === 1 && counts.none === 1,
   JSON.stringify(counts));
// 이름 한 줄만 더하면 바로 반영되는 구조인지
PROJECTS.push({grp:'예정', names:['테스트프로젝트']});
ok('project: 이름 추가가 바로 반영', projectNames().indexOf('테스트프로젝트') >= 0 &&
   projectOf({content:'테스트프로젝트 시작'}) === '테스트프로젝트', projectOf({content:'테스트프로젝트 시작'}));
PROJECTS.pop();

// ---------------- 프로젝트 필터(matchProject) ----------------
state = {room:'dev', projectFilter:'all'};
ok('filter: 전체면 다 통과', matchProject({content:'잡담'}) && matchProject({content:'사이즈핏'}));
state = {room:'dev', projectFilter:'사이즈핏'};
ok('filter: 개발방에서 고른 프로젝트만', matchProject({content:'사이즈핏 배포'}) && !matchProject({content:'스크랩박스 수정'}) && !matchProject({content:'잡담'}));
state = {room:'dev', projectFilter:'none'};
ok('filter: 미분류만', matchProject({content:'잡담'}) && !matchProject({content:'사이즈핏 배포'}));
state = {room:'general', projectFilter:'사이즈핏'};
ok('filter: 다른 방에서는 걸리지 않는다', matchProject({content:'잡담'}) && !isProjectFilterActive(), '');
state = {room:'dev', projectFilter:'all'};
ok('filter: 필터 이름', projectLabel() === 'all', projectLabel());
state = {room:'dev', projectFilter:'none'};
ok('filter: 미분류 이름', projectLabel() === '미분류', projectLabel());

// ---------------- 회의실 색 ----------------
ok('color: 종합 하늘', roomColor('general') === '#8fb3ff', roomColor('general'));
ok('color: 개발 민트', roomColor('dev') === '#4fd1a5', roomColor('dev'));
ok('color: 마케팅 살구', roomColor('marketing') === '#ffb366', roomColor('marketing'));
ok('color: 운영 연보라', roomColor('ops') === '#c49bff', roomColor('ops'));
ok('color: 빈 값은 종합', roomColor('') === '#8fb3ff' && roomColor(null) === '#8fb3ff', '');
ok('color: 새 방은 이름에서 정해진다', roomColor('design') === roomColor('design') && /^#[0-9a-f]{6}$/.test(roomColor('design')), roomColor('design'));
ok('color: 새 방끼리는 다른 색', roomColor('design') !== roomColor('qa'), roomColor('design') + ' / ' + roomColor('qa'));
ok('color: 등록된 방은 해시로 덮지 않는다', roomColor('general') !== roomColor('general2'), '');
ok('color: hslToHex 기본', hslToHex(0, 100, 50) === '#ff0000' && hslToHex(120, 100, 50) === '#00ff00', hslToHex(0,100,50));

globalThis.__out = out;
"""

ctx = MiniRacer()
ctx.eval(
    "var state = {messages: []}; var elMessages = {querySelectorAll: function(){ return []; }};\n"
    + FUNC + "\n" + PROJECT_DECLS + "\n" + PROJECT_FUNCS + "\n" + TESTS
)
results = json.loads(ctx.eval("JSON.stringify(globalThis.__out || [])"))


def has(needle):
    return needle in HTML


def gone(needle):
    return needle not in HTML


source_checks = [
    ("send: sending 플래그 초기값", has("sending: false,")),
    ("send: 전송 중 재진입 차단", has("if (state.sending) return; // 전송 중에는")),
    ("send: 전송 시작 시 플래그", has("state.sending = true;")),
    ("send: 응답 뒤 플래그 해제", has("state.sending = false;")),
    ("Enter: 전송 중·자동반복 차단", has("if (state.sending || e.repeat) return;")),
    ("appendMessages: 중복 id 거르기", has("list = newMessagesOnly(list);")),
    # v1.11.0 — 타임라인 삭제
    ("timeline: 마크업 제거", gone('id="timelineSect"')),
    ("timeline: 스크립트 제거", gone("function loadTimeline") and gone("TL_PER_ROOM") and gone("renderTimeline")),
    ("timeline: css 제거", gone(".tlrow") and gone(".tptopic")),
    ("timeline: mode 전환 제거", gone("mode-timeline")),
    ("rooms: 처음부터 펼침", has('class="sect roomsect open"') and has("sectMode: 'rooms'")),
    # v1.11.0 — 제목 → 종합방
    ("brand: PC 제목 버튼", has('id="brandHome"') and has("switchRoom('general')")),
    ("brand: 모바일 제목 버튼", has('id="brandHomeMobile"')),
    # v1.11.0 — 개발 방 프로젝트 목록
    ("projects: 설정 한 곳", has("var PROJECTS = [") and has("var PROJECT_ALIASES = {")),
    ("projects: 개발 방 아래 렌더", has("if (r.slug === PROJECT_ROOM) html += projectsHtml();")),
    ("projects: 화면에서만 거름", has("function matchProject") and has("state.messages.filter(matchFilter)")),
    ("projects: 고른 값 기억", has("localStorage.setItem(PROJECT_KEY") and has("localStorage.getItem(PROJECT_KEY)")),
    ("projects: 필터 칩", has('id="fProject"')),
    # v1.11.1 — 분류 수정
    ("projects: 빈 묶음은 건너뜀", has("if (!g || !g.names || !g.names.length) return;")),
    # v1.11.0 — 방 색
    ("color: ROOM_COLORS + --room", has("var ROOM_COLORS = {") and has("setProperty('--room'")),
    ("color: switchRoom 에서 적용", has("applyRoomColor(slug);")),
]
fail = 0
for t in results:
    mark = "PASS" if t["ok"] else "FAIL"
    if not t["ok"]:
        fail += 1
    print(f'{mark}  {t["name"]:<34} {t["extra"]}')
for name, cond in source_checks:
    mark = "PASS" if cond else "FAIL"
    if not cond:
        fail += 1
    print(f'{mark}  {name:<34}')

total = len(results) + len(source_checks)
print(f"\n{total - fail}/{total} passed")
sys.exit(1 if fail else 0)
