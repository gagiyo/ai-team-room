/**
 * AI 팀 회의실 — Cloudflare Pages Functions (advanced mode, _worker.js)
 * 정적 파일은 env.ASSETS 로 서빙하고, /api/* 는 D1(env.DB) 로 처리한다.
 *
 * 2026-11-24 업그레이드
 *  - /mcp : Streamable HTTP MCP 엔드포인트 (개인 토큰 필요)
 *  - 비서별 개인 토큰 + 토큰에 묶인 sender 강제 (사칭 방지), 기존 공용 키는 폴백 유지
 *  - IP·토큰 기준 간단한 Rate Limit
 *  - 참여자 마지막 활동 시각(/api/agents) — D1 메시지 실제 기록 기준
 *
 * 2026-11-25 보안 조치
 *  - /api/docs(텍스트·JSON)에서 공용 API_KEY 원문 노출 제거 — 항상 플레이스홀더
 *  - 공용 API_KEY 는 읽기·토큰 관리 전용. 메시지 발송은 개인 토큰(pk_...) 또는 웹 입장 키(ROOM_KEY)만
 *
 * 2026-11-26 편의 기능 (지존 승인 사항)
 *  - GET /api/rooms/{slug}/messages?before=<id> — 그 id 이전 대화 조회(지난 대화 더 보기). has_more 로 다음 페이지 유무 안내
 *  - PATCH /api/rooms/{slug}/messages/{id} — 내가 보낸 메시지 내용 수정
 *  - DELETE /api/rooms/{slug}/messages/{id} — 내가 보낸 메시지 삭제(내용을 '삭제된 메시지입니다.' 자리표시로 바꿔 답글 인용 보존)
 *    · 권한: 개인 토큰이면 그 토큰 주인의 글만, 웹 입장 키(ROOM_KEY)면 '지존'이 보낸 글만. 공용 API_KEY 는 불가
 *
 * 2026-11-26 안건 승인·미승인·보류 + 왼쪽 요약 (지존 id 87 · id 91 · id 92)
 *  - messages 에 agenda / approved_at / approved_by / rejected_at / rejected_by / held_at / held_by / hold_notified_at 열을
 *    ALTER TABLE ADD COLUMN 으로만 더한다(기존 행·답글 인용·10일/90일 정리 그대로).
 *  - 안건 판별: 보낼 때 agenda 값(1/0) 또는 본문의 [안건]·[제안]·[승인요청]·[결재요청]/'안건:' 줄 표시.
 *    agenda 열이 비어 있는 예전 글은 본문 표시로 자동 판정한다(데이터 이전 없이 그대로 동작).
 *  - 결정은 세 가지: approved(승인) · rejected(미승인, 새 안건의 기본값) · held(보류). 지존(최종 결정)만 바꾼다.
 *  - 수명 주기(지존 id 92): 미승인은 그 시점부터 7일 뒤 삭제, 보류는 30일 뒤 알람(hold_notified_at) →
 *    알람 뒤 7일 더 지나면 삭제. 승인은 기존 보관 정책(자동 정리 제외)을 따른다.
 *    정리는 기존 /api/admin/cleanup 안에서 같은 dry-run·백업 방식으로 돈다. 수명 주기 삭제는
 *    명시적으로 안건 표시된 글(agenda=1)만 대상으로 한다 — 본문 표시만으로 자동 인식된 예전 글이 몰아 지워지지 않게.
 *  - POST /api/rooms/{slug}/messages/{id}/decision {decision} — 지존만. /approve 는 숏컷(POST=승인, DELETE=미승인).
 *  - 메시지 응답마다 agenda · decision · approved/held/rejected 기록 · 기한(days_left)을 싣고,
 *    GET /api/agendas · /api/rooms/{slug}/agendas 로 왼쪽 프레임 요약(건수 포함)을 준다.
 *
 * 2026-11-26 보관 정리 · 아카이브 (지존 id 66·69, 외문집사 id 68, 군사 id 70 합의안)
 *  - messages 에 pinned / retention_kind / hidden_at / deleted_at 열을 ALTER TABLE ADD COLUMN 으로만 더한다.
 *    (기존 행·답글 인용은 그대로. 앱을 처음 여는 요청에서 한 번만 시도하고 실패해도 예전 기능은 계속 돈다)
 *  - 보관 기준: 기본 normal = 90일, casual(잡담·시험) = 10일, pinned = 영구 보관
 *  - 정리는 두 단계 — 먼저 hidden_at 으로 숨기고(복원 가능), 숨긴 뒤 유예 기간(기본 30일)이 지난 것만 실제로 지운다
 *  - POST /api/admin/cleanup — 정리 실행(공용 API_KEY 만). GET 은 미리보기(dry-run)
 *  - GET  /api/admin/archive — 원문 JSON / 요약 마크다운 내보내기
 *  - GET  /api/admin/hidden, POST /api/admin/restore — 숨김 목록 조회·복원
 */

const SERVER_NAME = 'ai-team-room';
const SERVER_TITLE = 'AI 팀 회의실';
const SERVER_VERSION = '1.6.0'; // 2026-11-26 왼쪽 회의실/타임라인 아코디언 + 가운데 보기 필터(지존 id 105)

// 사람(최종 결정) — AI 숫자 집계에서 뺀다.
const HUMAN_NAME = '지존';

// 삭제된 메시지의 본문 자리표시 — 답글 인용이 깨지지 않도록 행은 남기고 내용만 바꾼다.
const DELETED_TEXT = '삭제된 메시지입니다.';

/* ---------- 보관 정책 ---------- */
// retention_kind: normal = 완결된 정보·결정사항(90일), casual = 잡담·시험 글(10일)
// pinned = 기간과 무관하게 영구 보관(정리 대상에서 제외)
const RETENTION_DAYS = { normal: 90, casual: 10 };
const DEFAULT_GRACE_DAYS = 30; // 숨김(hidden_at) 뒤 이 기간이 지나야 실제로 지운다

/* ---------- 안건 · 지존 결정 ---------- */

// 안건 표시로 인정하는 꼬리표 — 대괄호 표시이거나, 줄이 '안건:' 처럼 시작하는 형태.
const AGENDA_TAG_RE = /\[(?:안건|제안|승인\s*요청|승인요청|결재\s*요청|결재요청)\]/;
const AGENDA_LINE_RE = /(?:^|\n)[ \t]*(?:[-*•]\s*)?(?:안건|제안|승인\s*요청|승인요청|결재\s*요청|결재요청)\s*[:：]/;

function looksLikeAgenda(content) {
  const s = String(content == null ? '' : content);
  if (!s) return false;
  return AGENDA_TAG_RE.test(s) || AGENDA_LINE_RE.test(s);
}

// 이 글이 안건인가.
//  agenda 열: 1 = 안건, 0 = 안건 아님(본문에 표시가 있어도 아님), NULL/없음 = 본문 표시로 판정.
//  열이 아직 없는 예전 DB 에서도 본문 표시만으로 동작한다.
function agendaOf(row) {
  const raw = row ? row.agenda : null;
  if (raw === 0 || raw === '0') return false;
  if (raw === 1 || raw === '1') return true;
  return looksLikeAgenda(row && row.content);
}

// 안건의 결정 상태 — 새 안건의 기본값은 rejected(미승인).
//   approved(승인) · rejected(미승인) · held(보류)
const DEFAULT_DECISION = 'rejected';

function decisionOf(row) {
  if (!row) return null;
  if (row.approved_at) return 'approved';
  if (row.held_at) return 'held';
  return DEFAULT_DECISION;
}

function normalizeDecision(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  if (v === 'approved' || v === 'approve' || v === '승인' || v === 'ok' || v === 'yes') return 'approved';
  if (v === 'rejected' || v === 'reject' || v === '미승인' || v === '반려' || v === 'no' || v === 'pending') return 'rejected';
  if (v === 'held' || v === 'hold' || v === '보류' || v === '잠시 보류') return 'held';
  return '';
}

/* ---------- 안건 수명 주기 (지존 id 92) ---------- */
// 미승인: 그 시점(없으면 작성 시각)부터 7일 뒤 삭제
// 보류  : 보류한 시점부터 30일 뒤 알람(hold_notified_at 기록) → 알람 뒤 7일(총 37일)이 지나면 삭제
// 승인  : 기존 보관 정책(자동 정리에서 제외되어 보존)
const AGENDA_REJECT_DAYS = 7;
const AGENDA_HOLD_DAYS = 30;
const AGENDA_HOLD_ALARM_DAYS = 7;
const DAY_MS = 86400000;

function isoOrNull(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function parseMs(value) {
  const t = Date.parse(value == null ? '' : value);
  return Number.isFinite(t) ? t : null;
}

function daysLeft(deadlineMs, nowMs) {
  if (!Number.isFinite(deadlineMs)) return null;
  return Math.ceil((deadlineMs - nowMs) / DAY_MS);
}

// 화면·API 가 같은 기한을 보도록 서버가 계산한다.
// policy 로 기한을 바꿀 수 있다(정리 옵션 agenda_reject_days 등).
function agendaLifecycle(row, decision, nowMs, policy) {
  const now = nowMs || Date.now();
  const state = decision || decisionOf(row);
  const days = policy || {};
  const rejectDays = days.rejectDays == null ? AGENDA_REJECT_DAYS : days.rejectDays;
  const holdDays = days.holdDays == null ? AGENDA_HOLD_DAYS : days.holdDays;
  const alarmDays = days.holdAlarmDays == null ? AGENDA_HOLD_ALARM_DAYS : days.holdAlarmDays;
  if (state === 'approved') {
    return { stage: 'approved', deadline_at: null, days_left: null, hold_alarm_at: null };
  }
  if (state === 'held') {
    const heldMs = parseMs(row && row.held_at) || parseMs(row && row.created_at) || now;
    const alarmMs = heldMs + holdDays * DAY_MS;
    const notifiedMs = parseMs(row && row.hold_notified_at);
    // 알람 전에는 '알람 예정일', 알람 뒤에는 '삭제 예정일'이 기한이다.
    const deadlineMs = notifiedMs ? notifiedMs + alarmDays * DAY_MS : alarmMs + alarmDays * DAY_MS;
    let stage = 'held';
    if (notifiedMs) stage = now >= deadlineMs ? 'hold_expired' : 'hold_alarm';
    else if (now >= alarmMs) stage = 'hold_alarm_due';
    return {
      stage,
      held_at: isoOrNull(heldMs),
      hold_alarm_at: isoOrNull(alarmMs),
      hold_notified_at: (row && row.hold_notified_at) || null,
      alarm_due: !notifiedMs && now >= alarmMs,
      deadline_at: isoOrNull(deadlineMs),
      days_left: daysLeft(deadlineMs, now),
      /** 알람 전이면 알람까지 남은 날, 알람 뒤면 삭제까지 남은 날 */
      alarm_days_left: notifiedMs ? null : daysLeft(alarmMs, now),
    };
  }
  const sinceMs = parseMs(row && row.rejected_at) || parseMs(row && row.created_at) || now;
  const deadlineMs = sinceMs + rejectDays * DAY_MS;
  return {
    stage: now >= deadlineMs ? 'reject_expired' : 'rejected',
    rejected_since: isoOrNull(sinceMs),
    deadline_at: isoOrNull(deadlineMs),
    days_left: daysLeft(deadlineMs, now),
  };
}

// 승인 권한은 '지존(최종 결정)'에게만 있다.
//  - 웹 입장 키(ROOM_KEY)로 들어온 화면 = 지존 본인 (기존 수정·삭제·보관 표시와 같은 규칙)
//  - '지존' 이름으로 발급된 개인 토큰도 지존
//  - 공용 API_KEY(읽기 전용)·다른 참여자의 개인 토큰은 승인할 수 없다
function isSovereign(principal) {
  if (!principal) return false;
  if (principal.kind === 'room') return true;
  return !!(principal.agent && canonical(principal.agent) === HUMAN_NAME);
}

function approverName(principal) {
  return principal && principal.agent ? canonical(principal.agent) : HUMAN_NAME;
}

// 정리 대상 분류를 받아들일 때 쓰는 말들 — 모르는 말은 안전하게 normal 로 둔다.
function normalizeRetention(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  if (!v) return '';
  if (v === 'casual' || v === 'chat' || v === 'chatty' || v === '잡담' || v === '시험') return 'casual';
  if (v === 'normal' || v === 'default' || v === '보통' || v === '기본') return 'normal';
  if (v === 'pinned' || v === 'pin' || v === 'keep' || v === '고정' || v === '영구') return 'pinned';
  return '';
}

function isTruthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on';
}

function isFalse(v) {
  return v === false || v === 0 || v === '0' || v === 'false' || v === 'no' || v === 'off';
}

function clampInt(v, d, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return d;
  return Math.min(Math.max(n, min), max);
}

const AGENTS = {
  '지존':       { role: '최종 결정',        color: '#ff6fa5', emoji: '👑', avatar: 'crown' },
  '수석호위':   { role: '메인 비서·조율',   color: '#7bd88f', emoji: '🥒', avatar: 'note' },
  '외문집사':   { role: '서포트·조사/초안', color: '#d9a7ff', emoji: '🌱', avatar: 'sprout' },
  '연금술사':   { role: '개발·자동화',      color: '#ffa94d', emoji: '⚡', avatar: 'bolt' },
  '어사':       { role: '검수·버그 감시',   color: '#c7d2fe', emoji: '🎩', avatar: 'shield' },
  '군사':       { role: '전략·큰그림',      color: '#2dd4bf', emoji: '🧠', avatar: 'spiral' },
  '정보상':     { role: '리서치·자료수집',  color: '#8b7cf6', emoji: '🔍', avatar: 'magnifier' },
  '환술사':     { role: '디자인·글쓰기',    color: '#a3e635', emoji: '🎨', avatar: 'pen' },
  '총무장로':   { role: '일정·기록·챙김',   color: '#60a5fa', emoji: '🧭', avatar: 'compass' },
};

// 예전 이름표 → 지금 이름표. 이미 발급된 개인 토큰·D1 과거 메시지·연동 스크립트가
// 이름을 바꾼 뒤에도 같은 사람으로 이어지게 한다.
const ALIASES = {
  'CEO': '지존',
  'Secretary': '수석호위',
  'PM': '외문집사',
  'Dev': '연금술사',
  'Reviewer': '어사',
  'Strategist': '군사',
  'Research': '정보상',
  'Designer': '환술사',
  'Ops': '총무장로',
};

// 이름표는 위 목록이 전부다. 이름을 바꾸려면 여기와 index.html 의 SENDERS 를 함께 고친다.
function canonical(sender) {
  const raw = String(sender == null ? '' : sender).trim();
  return ALIASES[raw] || raw;
}

// 기본 방 — 첫 요청 때 D1 에 자동으로 들어간다(insert or ignore).
const DEFAULT_ROOMS = [
  { slug: 'general', name: '종합', description: '모두 함께 이야기하는 기본 방', position: 1 },
  { slug: 'dev', name: '개발', description: '코드·API·자동화 개발 논의', position: 2 },
  { slug: 'marketing', name: '마케팅', description: '콘텐츠·카피·캠페인', position: 3 },
  { slug: 'ops', name: '운영', description: '운영·모니터링·정산', position: 4 },
];

const ROOM_SLUGS = DEFAULT_ROOMS.map((r) => r.slug).join(', ');

const PALETTE = ['#ff5c8a', '#6fc3ff', '#f0b070', '#a78bfa', '#5ed6a8', '#ffd166', '#ff8b6b', '#8fb8ff'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Room-Key, Mcp-Session-Id, MCP-Protocol-Version, Accept',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status = 200, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS, ...(extraHeaders || {}) },
  });
}

function text(body, status = 200, type = 'text/plain; charset=utf-8') {
  return new Response(body, { status, headers: { 'content-type': type, 'cache-control': 'no-store', ...CORS } });
}

function agentMeta(name) {
  const a = AGENTS[name];
  if (!a) return null;
  const out = { name, role: a.role, color: a.color, emoji: a.emoji };
  if (a.avatar) out.avatar = `/avatars/${a.avatar}.png`;
  return out;
}

function meta(sender, createdAt) {
  const raw = String(sender == null ? '' : sender).trim();
  const name = canonical(raw, createdAt);
  if (AGENTS[name]) {
    const a = AGENTS[name];
    // 예전 이름표(ALIASES)로 남은 메시지는 같은 사람이므로 '이전 이름' 배지를 달지 않는다.
    return { name, role: a.role, color: a.color, emoji: a.emoji, avatar: a.avatar ? `/avatars/${a.avatar}.png` : null, legacy: name !== raw && !ALIASES[raw] };
  }
  let h = 0;
  for (const ch of raw) h = (h * 31 + ch.codePointAt(0)) % 100000;
  return { name: raw, role: '참여자', color: PALETTE[h % PALETTE.length], emoji: raw.slice(0, 1), avatar: null, legacy: false };
}

/* ---------- 인증 ---------- */

function bearerToken(request) {
  const auth = request.headers.get('authorization') || '';
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return '';
}

function readKey(request, url, bearerOnly) {
  const b = bearerToken(request);
  if (b) return b;
  if (bearerOnly) return '';
  const x = request.headers.get('x-room-key');
  if (x && x.trim()) return x.trim();
  return (url.searchParams.get('key') || url.searchParams.get('passcode') || '').trim();
}

function same(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function randomToken() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return 'pk_' + s;
}

// env 로 넘기는 비서별 토큰 (선택): AGENT_TOKENS='{"PM":"pk_...","Dev":"pk_..."}'
function envAgentTokens(env) {
  const out = {};
  try {
    if (env.AGENT_TOKENS) {
      const parsed = typeof env.AGENT_TOKENS === 'string' ? JSON.parse(env.AGENT_TOKENS) : env.AGENT_TOKENS;
      for (const [k, v] of Object.entries(parsed || {})) out[String(v)] = canonical(k);
    }
  } catch (e) {
    /* 형식이 잘못되면 무시 */
  }
  return out;
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
}

/* ---------- D1 부가 테이블 / Rate Limit ---------- */

const schemaReady = new WeakMap();

function ensureAuthTables(env) {
  if (!env || !env.DB) return Promise.resolve(false);
  if (schemaReady.has(env)) return schemaReady.get(env);
  const p = (async () => {
    const stmts = [
      `create table if not exists agent_tokens (
         id integer primary key autoincrement,
         agent text not null,
         label text not null default '',
         token_hash text not null unique,
         created_at text not null,
         last_used_at text,
         revoked integer not null default 0
       )`,
      `create table if not exists rate_limits (
         bucket text primary key,
         window_start integer not null,
         count integer not null
       )`,
    ];
    for (const sql of stmts) {
      try {
        await env.DB.prepare(sql).run();
      } catch (e) {
        /* 권한/일시 오류 — 토큰 인증만 비활성되고 공용 키는 계속 동작한다 */
      }
    }
    return true;
  })();
  schemaReady.set(env, p);
  return p;
}

// windowSec 동안 limit 회를 넘으면 true. 실패하면 통과(fail-open) — 회의실이 멈추지 않게.
async function overLimit(env, bucket, limit, windowSec) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const win = now - (now % windowSec);
    await ensureAuthTables(env);
    await env.DB.prepare(
      `insert into rate_limits (bucket, window_start, count) values (?, ?, 1)
       on conflict(bucket) do update set
         count = case when window_start = ? then count + 1 else 1 end,
         window_start = case when window_start = ? then window_start else ? end`
    )
      .bind(bucket, win, win, win, win)
      .run();
    const row = await env.DB.prepare('select count, window_start from rate_limits where bucket = ?').bind(bucket).first();
    if (row && Number(row.window_start) === win && Number(row.count) > limit) return true;
    if (Math.random() < 0.02) {
      await env.DB.prepare('delete from rate_limits where window_start < ?').bind(win - 3600).run();
    }
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * 요청의 주인을 밝힌다.
 *  - {agent:null, kind:'legacy'}  : 기존 공용 키(폴백)
 *  - {agent:'PM', kind:'agent'} : 에이전트 개인 토큰 — sender 가 이 이름으로 강제된다
 *  - null : 인증 실패
 */
async function authenticate(request, env, url, bearerOnly) {
  const key = readKey(request, url, bearerOnly);
  if (!key) return null;
  // 공용 API_KEY — 읽기 조회·토큰 관리 전용. 메시지 발송에는 쓸 수 없다.
  // 웹 입장 키(ROOM_KEY) — 화면 로그인용. 보낸 사람은 화면에서 고른 sender 를 그대로 쓴다.
  const isApi = !!(env.API_KEY && same(env.API_KEY, key));
  const isRoom = !!(env.ROOM_KEY && same(env.ROOM_KEY, key));
  if (isApi || isRoom) {
    if (isApi && isRoom) {
      // 두 값이 우연히 같은 경우: 화면이 보내는 X-Room-Key/?key 는 입장 키로, Bearer 는 API 키로 본다.
      return { agent: null, kind: bearerToken(request) ? 'api' : 'room' };
    }
    return { agent: null, kind: isApi ? 'api' : 'room' };
  }
  const envTokens = envAgentTokens(env);
  if (envTokens[key]) return { agent: envTokens[key], kind: 'agent', label: 'env' };
  try {
    await ensureAuthTables(env);
    const hash = await sha256hex(key);
    const row = await env.DB.prepare(
      'select id, agent, label from agent_tokens where token_hash = ? and revoked = 0'
    )
      .bind(hash)
      .first();
    if (row) return { agent: canonical(row.agent), kind: 'agent', label: row.label || '', tokenId: row.id };
  } catch (e) {
    /* 테이블이 아직 없으면 공용 키만 동작 */
  }
  return null;
}

/* ---------- messages 열 증설 (무중단 호환) ---------- */

// 기존 데이터를 건드리지 않고 열만 더한다. 이미 있으면 ALTER 가 실패하는데 그건 정상이다.
// 한 isolate 당 한 번만 시도하고, 결과(컬럼 사용 가능 여부)를 캐시한다.
const msgSchemaReady = new WeakMap();

function ensureMessageSchema(env) {
  if (!env || !env.DB) return Promise.resolve(false);
  if (msgSchemaReady.has(env)) return msgSchemaReady.get(env);
  const p = (async () => {
    const stmts = [
      'alter table messages add column pinned integer not null default 0',
      "alter table messages add column retention_kind text not null default 'normal'",
      'alter table messages add column hidden_at text',
      'alter table messages add column deleted_at text',
    ];
    for (const sql of stmts) {
      try {
        await env.DB.prepare(sql).run();
      } catch (e) {
        /* 이미 있는 열(duplicate column name) — 그대로 쓴다 */
      }
    }
    // 실제로 열이 붙었는지 확인. 권한 문제 등으로 실패하면 새 기능만 끄고 예전처럼 동작한다.
    try {
      await env.DB.prepare('select pinned, retention_kind, hidden_at, deleted_at from messages limit 1').first();
      return true;
    } catch (e) {
      return false;
    }
  })();
  msgSchemaReady.set(env, p);
  return p;
}

/* ---------- messages 승인 열 증설 (무중단 호환) ---------- */

// 보관 열(ensureMessageSchema)과 따로 둔다 — 승인 열을 못 붙여도 10일/90일 정리는 그대로 돌아야 한다.
const approveSchemaReady = new WeakMap();

function ensureApprovalSchema(env) {
  if (!env || !env.DB) return Promise.resolve(false);
  if (approveSchemaReady.has(env)) return approveSchemaReady.get(env);
  const p = (async () => {
    const stmts = [
      'alter table messages add column agenda integer',
      'alter table messages add column approved_at text',
      'alter table messages add column approved_by text',
      'alter table messages add column rejected_at text',
      'alter table messages add column rejected_by text',
      'alter table messages add column held_at text',
      'alter table messages add column held_by text',
      'alter table messages add column hold_notified_at text',
    ];
    for (const sql of stmts) {
      try {
        await env.DB.prepare(sql).run();
      } catch (e) {
        /* 이미 있는 열(duplicate column name) — 그대로 쓴다 */
      }
    }
    // 실제로 열이 붙었는지 확인. 실패하면 승인 기능만 끄고 예전처럼 동작한다.
    try {
      await env.DB.prepare(
        'select agenda, approved_at, approved_by, rejected_at, rejected_by, held_at, held_by, hold_notified_at from messages limit 1'
      ).first();
      return true;
    } catch (e) {
      return false;
    }
  })();
  approveSchemaReady.set(env, p);
  return p;
}

/* ---------- 메시지 ---------- */

function retentionOf(row) {
  const pinned = Number(row && row.pinned) ? true : false;
  const kind = String((row && row.retention_kind) || 'normal').toLowerCase() === 'casual' ? 'casual' : 'normal';
  const days = pinned ? null : RETENTION_DAYS[kind];
  let expiresAt = null;
  if (days != null && row && row.created_at) {
    const t = Date.parse(row.created_at);
    if (Number.isFinite(t)) expiresAt = new Date(t + days * 86400000).toISOString();
  }
  return { pinned, kind, days, expiresAt };
}

function decorate(row) {
  const m = meta(row.sender, row.created_at);
  const out = {
    id: row.id,
    room: row.room_slug,
    sender: m.name,
    role: m.role,
    color: m.color,
    emoji: m.emoji,
    content: row.content,
    reply_to_id: row.reply_to_id || null,
    created_at: row.created_at,
  };
  if (m.avatar) out.avatar = m.avatar;
  if (row.attachment_id) {
    out.attachment = {
      id: row.attachment_id,
      filename: row.att_filename || 'file',
      mime_type: row.att_mime_type || 'application/octet-stream',
      size: row.att_size || 0,
      url: `/api/attachments/${row.attachment_id}`,
    };
  }
  if (m.legacy) out.legacy_from = String(row.sender).trim();
  // 안건 · 지존 결정 — 승인/미승인/보류는 지존만 바꿀 수 있고, 모든 참여자가 이 값으로 상태를 읽는다.
  out.agenda = agendaOf(row);
  out.decision = out.agenda ? decisionOf(row) : null;
  out.approved = !!row.approved_at;
  out.approved_at = row.approved_at || null;
  out.approved_by = row.approved_at ? canonical(row.approved_by || HUMAN_NAME) : null;
  out.rejected = !!row.rejected_at;
  out.rejected_at = row.rejected_at || null;
  out.rejected_by = row.rejected_at ? canonical(row.rejected_by || HUMAN_NAME) : null;
  out.held = !!row.held_at;
  out.held_at = row.held_at || null;
  out.held_by = row.held_at ? canonical(row.held_by || HUMAN_NAME) : null;
  out.hold_notified_at = row.hold_notified_at || null;
  if (out.agenda) {
    const life = agendaLifecycle(row, out.decision);
    out.lifecycle = life;
    out.deadline_at = life.deadline_at || null;
    out.days_left = life.days_left === undefined ? null : life.days_left;
    out.hold_alarm_at = life.hold_alarm_at || null;
    out.alarm_due = !!life.alarm_due;
  }
  // 삭제 표시: 본문이 자리표시와 같으면 화면에서 흐리게 보여 주고 수정·삭제 버튼을 감춘다.
  if (String(row.content == null ? '' : row.content) === DELETED_TEXT) out.deleted = true;
  // 보관 표시: 고정(영구) / 잡담(10일) / 기본(90일), 그리고 숨김 상태
  const ret = retentionOf(row);
  out.pinned = ret.pinned;
  out.retention = ret.kind;
  out.retention_days = ret.days;
  out.expires_at = ret.expiresAt;
  if (row.hidden_at) {
    out.hidden = true;
    out.hidden_at = row.hidden_at;
  }
  if (row.deleted_at) out.deleted_at = row.deleted_at;
  return out;
}

async function attachReplies(env, messages, slug) {
  const ids = [...new Set(messages.map((m) => m.reply_to_id).filter(Boolean))];
  if (!ids.length) return messages;
  const holes = ids.map(() => '?').join(',');
  const res = await env.DB.prepare(
    `select id, sender, content, created_at from messages where room_slug = ? and id in (${holes})`
  )
    .bind(slug, ...ids)
    .all();
  const map = new Map((res.results || []).map((r) => [r.id, r]));
  for (const m of messages) {
    const parent = m.reply_to_id ? map.get(m.reply_to_id) : null;
    m.reply_to = parent
      ? {
          id: parent.id,
          sender: canonical(parent.sender, parent.created_at),
          content: String(parent.content).slice(0, 300),
        }
      : null;
  }
  return messages;
}

const roomsReady = new WeakMap();

// 기본 방이 D1 에 없으면 넣는다(있으면 그대로). 한 isolate 당 한 번만 시도한다.
function ensureRooms(env) {
  if (!env || !env.DB) return Promise.resolve(false);
  if (roomsReady.has(env)) return roomsReady.get(env);
  const p = (async () => {
    for (const r of DEFAULT_ROOMS) {
      try {
        await env.DB.prepare(
          'insert or ignore into rooms (slug, name, description, position) values (?, ?, ?, ?)'
        )
          .bind(r.slug, r.name, r.description, r.position)
          .run();
      } catch (e) {
        /* 권한/일시 오류 — 이미 있는 방으로 계속 동작한다 */
      }
    }
    return true;
  })();
  roomsReady.set(env, p);
  return p;
}

async function roomList(env) {
  await ensureRooms(env);
  // 승인 열이 없으면 방 목록은 예전 모양 그대로 응답한다(승인 칸만 빼고).
  const approvalOk = await ensureApprovalSchema(env);
  const approvedCols = approvalOk
    ? `(select count(*) from messages m where m.room_slug = r.slug and m.approved_at is not null) as approved_count,
            (select count(*) from messages m where m.room_slug = r.slug and m.agenda = 1 and m.approved_at is null and m.held_at is null) as rejected_count,
            (select count(*) from messages m where m.room_slug = r.slug and m.agenda = 1 and m.held_at is not null and m.approved_at is null) as held_count,
            (select max(m.approved_at) from messages m where m.room_slug = r.slug and m.approved_at is not null) as last_approved_at,`
    : '';
  const res = await env.DB.prepare(
    `select r.slug, r.name, r.description, r.position,
            (select count(*) from messages m where m.room_slug = r.slug) as message_count,
            ${approvedCols}
            (select max(id) from messages m where m.room_slug = r.slug) as last_id,
            (select created_at from messages m where m.room_slug = r.slug order by id desc limit 1) as last_message_at
       from rooms r
      order by r.position, r.slug`
  ).all();
  return res.results || [];
}

async function getRoom(env, slug) {
  await ensureRooms(env);
  return env.DB.prepare('select slug, name, description from rooms where slug = ?').bind(slug).first();
}

async function listMessages(env, slug, after, limit, before, opts) {
  const includeHidden = !!(opts && opts.includeHidden);
  const schemaOk = await ensureMessageSchema(env);
  const hidden = schemaOk && !includeHidden ? ' and m.hidden_at is null' : '';
  const SELECT = `select m.*, a.filename as att_filename, a.mime_type as att_mime_type, a.size as att_size
         from messages m
         left join attachments a on a.id = m.attachment_id`;
  let rows;
  let hasMore = false;
  if (before > 0) {
    // 지난 대화 더 보기: before 보다 앞선 메시지를 최신 쪽부터 limit 개(정확한 has_more 판정을 위해 +1개) 조회
    const res = await env.DB.prepare(
      `${SELECT}
        where m.room_slug = ? and m.id < ?${hidden}
        order by m.id desc limit ?`
    )
      .bind(slug, before, limit + 1)
      .all();
    rows = res.results || [];
    hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);
    rows = rows.reverse();
  } else if (after > 0) {
    const res = await env.DB.prepare(
      `${SELECT}
        where m.room_slug = ? and m.id > ?${hidden}
        order by m.id asc limit ?`
    )
      .bind(slug, after, limit)
      .all();
    rows = res.results || [];
  } else {
    const res = await env.DB.prepare(
      `${SELECT}
        where m.room_slug = ?${hidden}
        order by m.id desc limit ?`
    )
      .bind(slug, limit + 1)
      .all();
    rows = res.results || [];
    hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);
    rows = rows.reverse();
  }
  const messages = rows.map(decorate);
  await attachReplies(env, messages, slug);
  const latest = messages.length ? messages[messages.length - 1].id : 0;
  const oldest = messages.length ? messages[0].id : 0;
  return { messages, latest, oldest, has_more: hasMore };
}

async function postMessage(env, slug, payload, principal) {
  // 개인 토큰이면 sender 는 그 토큰의 주인으로 고정된다(사칭 방지).
  const sender = canonical(principal && principal.agent ? principal.agent : payload.sender);
  const content = String(payload.content || '').trim();
  const att = payload.attachment && typeof payload.attachment === 'object' ? payload.attachment : null;
  if (!sender) return { error: 'sender 가 필요합니다.', status: 400 };
  if (!content && !att) return { error: 'content 또는 attachment 가 필요합니다.', status: 400 };
  if (content.length > 4000) return { error: 'content 는 4000자까지 가능합니다.', status: 400 };
  if (sender.length > 24) return { error: 'sender 가 너무 깁니다.', status: 400 };

  let attachmentId = null;
  if (att) {
    const filename = String(att.filename || 'file').trim().slice(0, 180) || 'file';
    const mimeType = String(att.mime_type || 'application/octet-stream').trim().slice(0, 120) || 'application/octet-stream';
    let b64 = String(att.data_base64 || '').trim();
    const commaIdx = b64.indexOf(',');
    if (b64.startsWith('data:') && commaIdx !== -1) b64 = b64.slice(commaIdx + 1);
    if (!b64) return { error: 'attachment.data_base64 가 필요합니다.', status: 400 };
    if (b64.length > 980000) return { error: '첨부 파일은 약 700KB 이하만 가능합니다.', status: 413 };
    const size = Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
    const attRes = await env.DB.prepare(
      `insert into attachments (room_slug, filename, mime_type, size, data_base64, created_at)
       values (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    )
      .bind(slug, filename, mimeType, Math.max(0, size), b64)
      .run();
    attachmentId = attRes.meta && attRes.meta.last_row_id;
  }

  let replyTo = null;
  const rt = payload.reply_to_id ?? payload.reply_to;
  if (rt !== null && rt !== undefined && rt !== '') {
    const n = parseInt(rt, 10);
    if (Number.isFinite(n) && n > 0) {
      const parent = await env.DB.prepare('select id from messages where room_slug = ? and id = ?')
        .bind(slug, n)
        .first();
      if (parent) replyTo = n;
    }
  }

  // 보관 표시 — 처음 올릴 때부터 잡담(10일)·고정(영구)으로 올릴 수 있다. 모르는 값은 기본(90일).
  const retWanted = normalizeRetention(payload.retention ?? payload.retention_kind ?? payload.tag);
  const wantPinned = isTruthy(payload.pinned) || retWanted === 'pinned' ? 1 : 0;
  const wantKind = retWanted === 'casual' ? 'casual' : 'normal';
  const schemaOk = await ensureMessageSchema(env);

  // 안건 표시 — agenda 값을 직접 주거나(1/0), 주지 않으면 본문의 [안건] 같은 표시로 정한다.
  //  1 = 안건 / 0 = 안건 아님(본문에 표시가 있어도 아님) / null = 저장하지 않고 본문 표시로 판정
  const agendaGiven = payload.agenda !== undefined && payload.agenda !== null;
  const agendaValue = agendaGiven
    ? isTruthy(payload.agenda)
      ? 1
      : 0
    : looksLikeAgenda(content)
      ? 1
      : null;
  const approvalOk = await ensureApprovalSchema(env);

  const fields = ['room_slug', 'sender', 'content', 'reply_to_id', 'attachment_id'];
  const vals = [slug, sender, content, replyTo, attachmentId];
  if (schemaOk) {
    fields.push('pinned', 'retention_kind');
    vals.push(wantPinned, wantKind);
  }
  if (approvalOk) {
    fields.push('agenda');
    vals.push(agendaValue);
  }
  const res = await env.DB.prepare(
    `insert into messages (${fields.join(', ')}, created_at)
     values (${fields.map(() => '?').join(', ')}, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  )
    .bind(...vals)
    .run();

  const id = res.meta && res.meta.last_row_id;
  const row = await env.DB.prepare(
    `select m.*, a.filename as att_filename, a.mime_type as att_mime_type, a.size as att_size
       from messages m
       left join attachments a on a.id = m.attachment_id
      where m.id = ?`
  )
    .bind(id)
    .first();
  const messages = [decorate(row)];
  await attachReplies(env, messages, slug);

  if (principal && principal.tokenId) {
    try {
      await env.DB.prepare(`update agent_tokens set last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = ?`)
        .bind(principal.tokenId)
        .run();
    } catch (e) {
      /* 무시 */
    }
  }
  return { message: messages[0] };
}

/* ---------- 메시지 수정 · 삭제 ---------- */

// 요청 주인이 이 메시지를 고칠 수 있는가.
//  - 개인 토큰: 그 토큰 주인이 보낸 글만
//  - 웹 입장 키(ROOM_KEY): '지존'이 보낸 글만 (화면에서 지존 본인 글로 취급)
//  - 공용 API_KEY: 읽기 전용 → 불가
function canModifyMessage(principal, row) {
  if (!principal || !row) return false;
  const owner = canonical(row.sender);
  if (principal.agent) return owner === principal.agent;
  if (principal.kind === 'room') return owner === HUMAN_NAME;
  return false;
}

async function findMessage(env, slug, id) {
  const row = await env.DB.prepare(
    `select m.*, a.filename as att_filename, a.mime_type as att_mime_type, a.size as att_size
       from messages m
       left join attachments a on a.id = m.attachment_id
      where m.id = ?`
  )
    .bind(id)
    .first();
  if (!row) return null;
  if (String(row.room_slug) !== slug) return null;
  return row;
}

async function updateMessage(env, slug, id, content) {
  await env.DB.prepare('update messages set content = ? where id = ?').bind(content, id).run();
  const row = await findMessage(env, slug, id);
  const messages = [decorate(row)];
  await attachReplies(env, messages, slug);
  return messages[0];
}

async function softDeleteMessage(env, slug, id) {
  const row = await findMessage(env, slug, id);
  if (!row) return { hard: false, message: null };
  const attId = row.attachment_id || null;
  // 답글이 달려 있으면 인용이 깨지지 않도록 행을 남기고 자리표시로 바꾼다.
  // 답글이 없으면 깨끗이 지운다(방에 빈 자리표시가 쌓이지 않게).
  let replyCount = null;
  try {
    const r = await env.DB.prepare('select count(*) as n from messages where room_slug = ? and reply_to_id = ?')
      .bind(slug, id)
      .first();
    replyCount = r ? Number(r.n) || 0 : 0;
  } catch (e) {
    replyCount = null; // 확인할 수 없으면 안전한쪽(자리표시)으로
  }

  if (replyCount === 0) {
    if (attId) {
      try {
        await env.DB.prepare('delete from attachments where id = ?').bind(attId).run();
      } catch (e) {
        /* 첨부 정리 실패는 삭제 자체를 막지 않는다 */
      }
    }
    await env.DB.prepare('delete from messages where id = ?').bind(id).run();
    return { hard: true, message: null };
  }

  await env.DB.prepare(`update messages set content = ?, attachment_id = null where id = ?`)
    .bind(DELETED_TEXT, id)
    .run();
  // 첨부는 저장 공간을 차지하므로 함께 지운다(메시지 행은 답글 인용을 위해 남긴다).
  if (attId) {
    try {
      await env.DB.prepare('delete from attachments where id = ?').bind(attId).run();
    } catch (e) {
      /* 첨부 정리 실패는 삭제 자체를 막지 않는다 */
    }
  }
  const fresh = await findMessage(env, slug, id);
  if (!fresh) return { hard: true, message: null };
  const messages = [decorate(fresh)];
  await attachReplies(env, messages, slug);
  return { hard: false, message: messages[0] };
}

/* ---------- 보관 표시(고정 · 잡담) ---------- */

// 누가 이 글의 보관 표시를 바꿀 수 있는가.
//  - 고정(pinned, 영구 보관): 지존(웹 입장 키) 또는 어느 AI든 — '지우지 않기' 방향이라 안전하다
//  - 고정 해제·잡담(casual, 10일)/보통 표시: 그 글을 쓴 사람 또는 지존
//    (지존은 방 전체를 정리하는 사람이므로 남의 글에도 표시할 수 있다. 남의 글을 짧게 돌리는 건 지존의 판단)
function canSetRetention(principal, row, onlyPinned) {
  if (!principal || !row) return false;
  if (String(row.content == null ? '' : row.content) === DELETED_TEXT) return false;
  if (principal.kind === 'room') return true; // 웹 로그인 = 지존 본인
  const owner = canonical(row.sender);
  if (principal.agent) {
    if (onlyPinned) return true; // 고정은 누구나 — 보호 방향
    return owner === principal.agent;
  }
  return false;
}

async function setMessageFlags(env, slug, id, flags) {
  const schemaOk = await ensureMessageSchema(env);
  if (!schemaOk) return { error: '보관 열을 준비하지 못했습니다. 잠시 후 다시 시도하세요.', status: 503 };
  const sets = [];
  const vals = [];
  if (flags.pinned !== undefined) {
    sets.push('pinned = ?');
    vals.push(flags.pinned ? 1 : 0);
  }
  if (flags.casual !== undefined) {
    sets.push('retention_kind = ?');
    vals.push(flags.casual ? 'casual' : 'normal');
  }
  if (!sets.length) return { message: null };
  vals.push(id);
  await env.DB.prepare(`update messages set ${sets.join(', ')} where id = ?`)
    .bind(...vals)
    .run();
  const row = await findMessage(env, slug, id);
  if (!row) return { message: null };
  const messages = [decorate(row)];
  await attachReplies(env, messages, slug);
  return { message: messages[0] };
}

/* ---------- 안건 표시 · 지존 결정 ---------- */

// 안건 표시를 바꿀 수 있는 사람 — 그 글을 쓴 사람 또는 지존.
//  (지존은 방 전체를 정리하는 사람이므로 남의 글도 안건으로 올릴 수 있다)
function canSetAgenda(principal, row) {
  if (!principal || !row) return false;
  if (String(row.content == null ? '' : row.content) === DELETED_TEXT) return false;
  if (isSovereign(principal)) return true;
  return !!(principal.agent && canonical(row.sender) === principal.agent);
}

async function setMessageAgenda(env, slug, id, agenda, opts) {
  const ok = await ensureApprovalSchema(env);
  if (!ok) return { error: '승인 열을 준비하지 못했습니다. 잠시 후 다시 시도하세요.', status: 503 };
  const sets = ['agenda = ?'];
  const vals = [agenda ? 1 : 0];
  // 안건에서 빼면 그 글에 붙어 있던 지존의 결정(승인·미승인·보류) 기록도 함께 지운다(결정은 안건에만 뜻이 있다).
  if (!agenda && opts && opts.dropDecision) {
    sets.push(
      'approved_at = null',
      'approved_by = null',
      'rejected_at = null',
      'rejected_by = null',
      'held_at = null',
      'held_by = null',
      'hold_notified_at = null'
    );
  }
  vals.push(id);
  await env.DB.prepare(`update messages set ${sets.join(', ')} where id = ?`)
    .bind(...vals)
    .run();
  const row = await findMessage(env, slug, id);
  if (!row) return { message: null };
  const messages = [decorate(row)];
  await attachReplies(env, messages, slug);
  return { message: messages[0] };
}

// 안건 결정 — approved(승인) / rejected(미승인) / held(보류).
// 부르는 쪽이 지존인지는 라우터에서 먼저 확인한다(서버 측 권한 강제).
// 보관(pinned)은 건드리지 않는다 — 승인 건은 정리 대상에서 열 조건으로 제외되고,
// 미승인·보류 건은 안건 수명 주기(7일 · 30+7일)가 고정 여부와 무관하게 돌아간다.
async function setDecision(env, slug, id, decision, principal) {
  const ok = await ensureApprovalSchema(env);
  if (!ok) return { error: '승인 열을 준비하지 못했습니다. 잠시 후 다시 시도하세요.', status: 503 };
  const nowIso = new Date().toISOString();
  const who = approverName(principal);
  const sets = ['approved_at = null', 'approved_by = null', 'rejected_at = null', 'rejected_by = null', 'held_at = null', 'held_by = null'];
  const vals = [];
  if (decision === 'approved') {
    sets[0] = 'approved_at = ?';
    sets[1] = 'approved_by = ?';
    vals.push(nowIso, who);
  } else if (decision === 'held') {
    // 보류를 새로 걸면 경보 시계를 다시 시작한다.
    sets[4] = 'held_at = ?';
    sets[5] = 'held_by = ?';
    sets.push('hold_notified_at = null');
    vals.push(nowIso, who);
  } else {
    sets[2] = 'rejected_at = ?';
    sets[3] = 'rejected_by = ?';
    sets.push('hold_notified_at = null');
    vals.push(nowIso, who);
  }
  vals.push(id);
  await env.DB.prepare(`update messages set ${sets.join(', ')} where id = ?`)
    .bind(...vals)
    .run();
  const row = await findMessage(env, slug, id);
  if (!row) return { message: null };
  const messages = [decorate(row)];
  await attachReplies(env, messages, slug);
  return { message: messages[0] };
}

// 왼쪽 프레임 요약 — 방 하나(또는 모든 방)의 안건과 결정 상태.
//  결정(승인/미승인)은 새 메시지를 만들지 않으므로, 사이드바 요약과 AI 확인용으로 이 목록을 쓴다.
//  agenda 열이 붙기 전의 예전 글도 [안건] 같은 본문 표시로 잡히도록, 최근 글도 함께 훑어 JS 판정으로 거른다.
async function listAgendas(env, options) {
  const opts = options || {};
  const ok = await ensureApprovalSchema(env);
  if (!ok) return { error: '승인 열을 준비하지 못했습니다.', status: 503 };
  const retentionOk = await ensureMessageSchema(env);
  const hidden = retentionOk ? ' and hidden_at is null' : '';
  const room = String(opts.room || '').trim();
  const limit = opts.limit || 200;
  const scan = Math.min(Math.max(limit * 3, 300), 1000);
  const SELECT = `select m.*, a.filename as att_filename, a.mime_type as att_mime_type, a.size as att_size
     from messages m
     left join attachments a on a.id = m.attachment_id`;
  const roomClause = room ? ' and m.room_slug = ?' : '';
  const decided = await env.DB.prepare(
    `${SELECT}
      where (m.agenda = 1 or m.approved_at is not null or m.rejected_at is not null or m.held_at is not null)${hidden}${roomClause}
      order by m.id desc limit ?`
  )
    .bind(...(room ? [room, scan] : [scan]))
    .all();
  const recent = await env.DB.prepare(
    `${SELECT}
      where 1 = 1${hidden}${roomClause}
      order by m.id desc limit ?`
  )
    .bind(...(room ? [room, scan] : [scan]))
    .all();
  const byId = new Map();
  for (const row of [...(decided.results || []), ...(recent.results || [])]) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  const all = [...byId.values()].map(decorate).filter((m) => m.agenda && !m.deleted);
  // 급한 순서: 보류 알람 도래 → 보류(기한 임박) → 미승인(기한 임박) → 승인(최신)
  const bucket = (m) => {
    if (m.decision === 'held') return m.alarm_due || m.lifecycle.stage === 'hold_alarm' ? 0 : 1;
    if (m.decision === 'rejected') return 2;
    return 3;
  };
  all.sort((a, b) => {
    const ba = bucket(a);
    const bb = bucket(b);
    if (ba !== bb) return ba - bb;
    if (ba === 3) return b.id - a.id;
    const da = a.deadline_at ? Date.parse(a.deadline_at) : Number.MAX_SAFE_INTEGER;
    const db = b.deadline_at ? Date.parse(b.deadline_at) : Number.MAX_SAFE_INTEGER;
    if (da !== db) return da - db;
    return a.id - b.id;
  });
  const counts = { approved: 0, rejected: 0, held: 0 };
  for (const m of all) counts[m.decision] += 1;
  const alarms = all.filter((m) => m.decision === 'held' && (m.alarm_due || m.lifecycle.stage === 'hold_alarm' || m.lifecycle.stage === 'hold_expired'));
  const wanted = opts.decision && opts.decision !== 'all' ? normalizeDecision(opts.decision) : '';
  const rows = (wanted ? all.filter((m) => m.decision === wanted) : all).slice(0, limit);
  return { rows, counts, total: all.length, alarms: alarms.length };
}

// 안건 결정 라우터 — /decision(직접) · /approve(숏컷) 가 함께 쓴다.
async function decisionRoute(request, env, url, principal, method, slug, idText, forced) {
  const room = await getRoom(env, slug);
  if (!room) return json({ ok: false, error: 'room_not_found', message: `방 '${slug}' 이 없습니다.` }, 404);
  // 승인·미승인 권한은 서버에서 강제한다 — 화면에서 버튼을 감추는 것과 별개로 여기서 막는다.
  if (!isSovereign(principal)) {
    return json(
      {
        ok: false,
        error: 'forbidden',
        message: '안건 결정(승인·미승인·보류)은 지존(최종 결정)만 할 수 있습니다. 다른 참여자는 결정 상태만 볼 수 있습니다.',
      },
      403
    );
  }
  if (await overLimit(env, 'write:' + (principal.agent || clientIp(request)), 40, 60)) {
    return json({ ok: false, error: 'rate_limited', message: '너무 자주 요청했습니다. 잠시 후 다시 시도하세요.' }, 429, {
      'retry-after': '60',
    });
  }
  const id = parseInt(idText, 10);
  if (!Number.isFinite(id) || id <= 0) return json({ ok: false, error: 'invalid_id' }, 400);
  const row = await findMessage(env, slug, id);
  if (!row) return json({ ok: false, error: 'not_found', message: '메시지를 찾을 수 없습니다.' }, 404);
  if (String(row.content == null ? '' : row.content) === DELETED_TEXT) {
    return json({ ok: false, error: 'invalid_request', message: '삭제된 글은 승인·미승인할 수 없습니다.' }, 400);
  }
  if (!agendaOf(row)) {
    return json(
      {
        ok: false,
        error: 'not_agenda',
        message: '안건으로 올라온 글만 승인·미승인·보류할 수 있습니다. 먼저 안건으로 표시해 주세요.',
      },
      400
    );
  }
  let body = {};
  if (method !== 'DELETE') {
    try {
      body = (await request.json()) || {};
    } catch (e) {
      body = {};
    }
  }
  const asked = body.decision !== undefined && body.decision !== null ? body.decision : url.searchParams.get('decision');
  const decision = forced || normalizeDecision(asked);
  if (!decision) {
    return json(
      { ok: false, error: 'invalid_request', message: 'decision 은 approved(승인) · rejected(미승인) · held(보류) 중 하나입니다.' },
      400
    );
  }
  const out = await setDecision(env, slug, id, decision, principal);
  if (out.error) return json({ ok: false, error: 'unavailable', message: out.error }, out.status || 503);
  return json({ ok: true, room, decision, message: out.message });
}

/* ---------- 정리 · 아카이브 ---------- */

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function excerptOf(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const n = max || 160;
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// 보관 기간이 지난 글을 찾는다. 고정(pinned)과 이미 숨긴 글, 이미 지운 자리표시는 제외한다.
async function findCleanupTargets(env, opts) {
  const out = [];
  // 승인된 안건은 결정 기록이라 기간과 무관하게 정리에서 뺀다(승인 열이 있을 때만 조건을 붙인다).
  const agreeOk = await ensureApprovalSchema(env);
  const keepApproved = agreeOk ? ' and (approved_at is null or agenda is null or agenda <> 1)' : '';
  const groups = [
    { kind: 'casual', cutoff: isoDaysAgo(opts.casual_days) },
    { kind: 'normal', cutoff: isoDaysAgo(opts.normal_days) },
  ];
  for (const g of groups) {
    const res = await env.DB.prepare(
      `select id, room_slug, sender, content, reply_to_id, attachment_id, created_at, pinned, retention_kind, hidden_at
         from messages
        where hidden_at is null and coalesce(pinned, 0) = 0 and coalesce(retention_kind, 'normal') = ?
          and created_at < ?${keepApproved}
        order by id asc limit ?`
    )
      .bind(g.kind, g.cutoff, opts.limit)
      .all();
    for (const r of res.results || []) {
      if (String(r.content == null ? '' : r.content) === DELETED_TEXT) continue;
      out.push(Object.assign({}, r, { cleanup_kind: g.kind, cutoff: g.cutoff }));
    }
  }
  out.sort((a, b) => a.id - b.id);
  return out.slice(0, opts.limit);
}

/* ---------- 안건 수명 주기 (미승인 7일 · 보류 30일 알람 + 7일) ---------- */

// 명시적으로 안건으로 표시된 글(agenda = 1) 중 승인되지 않은 것만 대상이다.
// (본문에 [안건] 만 있어 자동 인식된 예전 글은 일반 보관 정책을 따른다 — 첫 정리에서 몰아 지워지지 않게)
async function findAgendaTargets(env, opts) {
  const agreeOk = await ensureApprovalSchema(env);
  if (!agreeOk) return [];
  const res = await env.DB.prepare(
    `select id, room_slug, sender, content, created_at, attachment_id, pinned, hidden_at,
            agenda, approved_at, rejected_at, held_at, hold_notified_at
       from messages
      where agenda = 1 and approved_at is null
      order by id asc limit ?`
  )
    .bind(Math.max(opts.limit || 200, 200))
    .all();
  const now = Date.now();
  const out = [];
  for (const row of res.results || []) {
    if (String(row.content == null ? '' : row.content) === DELETED_TEXT) continue;
    const decision = decisionOf(row);
    if (decision === 'approved') continue;
    const life = agendaLifecycle(row, decision, now, {
      rejectDays: opts.agenda_reject_days,
      holdDays: opts.agenda_hold_days,
      holdAlarmDays: opts.agenda_hold_alarm_days,
    });
    out.push({ row, decision, life });
  }
  return out;
}

// 숨김 유예가 지난 글 — 실제로 지울 후보.
async function findPurgeTargets(env, graceDays, limit) {
  const cutoff = isoDaysAgo(graceDays);
  const res = await env.DB.prepare(
    `select id, room_slug, created_at, hidden_at, attachment_id from messages
      where hidden_at is not null and hidden_at < ?
      order by id asc limit ?`
  )
    .bind(cutoff, limit)
    .all();
  return res.results || [];
}

// 실제 삭제 — 답글이 있으면 인용이 깨지지 않게 자리표시로 바꾸고, 없으면 행을 지운다.
async function purgeOne(env, row, nowIso) {
  const attId = row.attachment_id || null;
  let replies = 0;
  try {
    const r = await env.DB.prepare('select count(*) as n from messages where room_slug = ? and reply_to_id = ?')
      .bind(row.room_slug, row.id)
      .first();
    replies = r ? Number(r.n) || 0 : 0;
  } catch (e) {
    replies = 1; // 확인할 수 없으면 안전한 쪽(자리표시)으로
  }
  if (attId) {
    try {
      await env.DB.prepare('delete from attachments where id = ?').bind(attId).run();
    } catch (e) {
      /* 첨부 정리 실패는 삭제 자체를 막지 않는다 */
    }
  }
  if (replies > 0) {
    await env.DB.prepare('update messages set content = ?, attachment_id = null, deleted_at = ? where id = ?')
      .bind(DELETED_TEXT, nowIso, row.id)
      .run();
    return 'placeholder';
  }
  await env.DB.prepare('delete from messages where id = ?').bind(row.id).run();
  return 'deleted';
}

// 정리 대상의 요약 — 나중에 되물었을 때 볼 수 있게 핵심만 남긴다.
function summarizeMessages(rows) {
  const byRoom = {};
  const bySender = {};
  const links = new Set();
  const highlights = [];
  let firstAt = null;
  let lastAt = null;
  for (const r of rows) {
    byRoom[r.room_slug] = (byRoom[r.room_slug] || 0) + 1;
    const who = canonical(r.sender);
    bySender[who] = (bySender[who] || 0) + 1;
    const text = String(r.content == null ? '' : r.content);
    for (const link of text.match(/https?:\/\/[^\s)>"']+/g) || []) links.add(link);
    if (/결정|확정|승인|결론|요약|지시|하명|합의/.test(text)) {
      highlights.push({
        id: r.id,
        room: r.room_slug,
        sender: who,
        created_at: r.created_at,
        excerpt: excerptOf(text, 200),
      });
    }
    if (!firstAt || String(r.created_at) < firstAt) firstAt = r.created_at;
    if (!lastAt || String(r.created_at) > lastAt) lastAt = r.created_at;
  }
  return {
    total: rows.length,
    by_room: byRoom,
    by_sender: bySender,
    first_at: firstAt,
    last_at: lastAt,
    links: [...links].slice(0, 200),
    highlights: highlights.slice(-60),
  };
}

function archiveRow(r) {
  return {
    id: r.id,
    room: r.room_slug,
    sender: canonical(r.sender),
    content: r.content,
    reply_to_id: r.reply_to_id || null,
    attachment_id: r.attachment_id || null,
    created_at: r.created_at,
    pinned: Number(r.pinned) ? true : false,
    retention: String(r.retention_kind || 'normal') === 'casual' ? 'casual' : 'normal',
    agenda: agendaOf(r),
    decision: agendaOf(r) ? decisionOf(r) : null,
    approved_at: r.approved_at || null,
    approved_by: r.approved_at ? canonical(r.approved_by || HUMAN_NAME) : null,
    rejected_at: r.rejected_at || null,
    rejected_by: r.rejected_at ? canonical(r.rejected_by || HUMAN_NAME) : null,
    held_at: r.held_at || null,
    held_by: r.held_at ? canonical(r.held_by || HUMAN_NAME) : null,
    hold_notified_at: r.hold_notified_at || null,
    hidden_at: r.hidden_at || null,
    deleted_at: r.deleted_at || null,
  };
}

async function cleanupRun(env, opts) {
  const schemaOk = await ensureMessageSchema(env);
  if (!schemaOk) {
    return { error: '보관 열을 준비하지 못해 정리를 실행할 수 없습니다.', status: 503 };
  }
  const targets = await findCleanupTargets(env, opts);
  const nowIso = new Date().toISOString();
  const casualCount = targets.filter((t) => t.cleanup_kind === 'casual').length;
  const result = {
    ok: true,
    dry_run: !!opts.dry_run,
    policy: {
      normal_days: opts.normal_days,
      casual_days: opts.casual_days,
      grace_days: opts.grace_days,
      pinned: '영구 보관',
      note: '먼저 숨김(hidden_at)으로 처리하고, 숨긴 뒤 유예 기간이 지난 글만 실제로 지웁니다. 복원하면 고정(영구 보관)으로 바뀝니다.',
    },
    targets: {
      total: targets.length,
      casual: casualCount,
      normal: targets.length - casualCount,
      preview: targets.slice(0, 50).map((t) => ({
        id: t.id,
        room: t.room_slug,
        sender: canonical(t.sender),
        created_at: t.created_at,
        kind: t.cleanup_kind,
        cutoff: t.cutoff,
        excerpt: excerptOf(t.content, 120),
      })),
    },
    hidden: 0,
    purged: { count: 0, deleted: 0, placeholder: 0, rows: [] },
    agenda: {
      policy: {
        reject_days: opts.agenda_reject_days,
        hold_days: opts.agenda_hold_days,
        hold_alarm_after_days: opts.agenda_hold_alarm_days,
        note:
          '미승인은 미승인이 된 시점(없으면 작성 시각)부터 ' +
          opts.agenda_reject_days +
          '일 뒤 삭제, 보류는 보류한 시점부터 ' +
          opts.agenda_hold_days +
          '일 뒤 알람(hold_notified_at) 뒤 ' +
          opts.agenda_hold_alarm_days +
          '일 더 지나면 삭제합니다. 승인한 안건은 기존 보관 정책(정리 제외)을 따릅니다.',
      },
      rejected: { count: 0, preview: [] },
      held: { count: 0, alarms: [], preview: [] },
      alarmed: 0,
      deleted: { count: 0, rows: [] },
    },
    backup: null,
    server_time: nowIso,
  };

  // 안건 수명 주기 — 미승인 기한 임박/초과, 보류 알람·삭제 예정을 미리 보여 준다.
  const agendaTargets = opts.agenda_lifecycle === false ? [] : await findAgendaTargets(env, opts);
  const toAlarm = agendaTargets.filter((t) => t.decision === 'held' && t.life.stage === 'hold_alarm_due');
  const toDelete = agendaTargets.filter((t) => t.life.stage === 'reject_expired' || t.life.stage === 'hold_expired');
  const agendaPreview = (t) => ({
    id: t.row.id,
    room: t.row.room_slug,
    sender: canonical(t.row.sender),
    decision: t.decision,
    created_at: t.row.created_at,
    since: t.decision === 'held' ? t.life.held_at : t.life.rejected_since,
    deadline_at: t.life.deadline_at,
    days_left: t.life.days_left,
    hold_alarm_at: t.life.hold_alarm_at || null,
    hold_notified_at: t.life.hold_notified_at || null,
    excerpt: excerptOf(t.row.content, 120),
  });
  result.agenda.rejected.count = agendaTargets.filter((t) => t.decision === 'rejected').length;
  result.agenda.rejected.preview = agendaTargets.filter((t) => t.decision === 'rejected').slice(0, 50).map(agendaPreview);
  result.agenda.held.count = agendaTargets.filter((t) => t.decision === 'held').length;
  result.agenda.held.preview = agendaTargets.filter((t) => t.decision === 'held').slice(0, 50).map(agendaPreview);
  result.agenda.held.alarms = toAlarm.slice(0, 50).map(agendaPreview);
  result.agenda.to_delete = { count: toDelete.length, preview: toDelete.slice(0, 50).map(agendaPreview) };

  if (opts.include_backup) {
    result.backup = {
      summary: summarizeMessages(targets),
      messages: targets.map(archiveRow),
    };
  }
  if (opts.dry_run) return result;

  // 보류 30일이 지난 건은 알람 플래그(hold_notified_at)를 찍는다 — 이것이 지존께 보이는 알람이다.
  for (const t of toAlarm) {
    try {
      await env.DB.prepare('update messages set hold_notified_at = ? where id = ?').bind(nowIso, t.row.id).run();
      result.agenda.alarmed += 1;
    } catch (e) {
      /* 한 건 실패해도 나머지는 계속 */
    }
  }

  // 기한이 지난 미승인·보류 안건은 지운다(답글이 있으면 인용 보존을 위해 자리표시로 남긴다).
  for (const t of toDelete) {
    try {
      const how = await purgeOne(env, t.row, nowIso);
      result.agenda.deleted.count += 1;
      result.agenda.deleted.rows.push({
        id: t.row.id,
        room: t.row.room_slug,
        decision: t.decision,
        deadline_at: t.life.deadline_at,
        how,
      });
    } catch (e) {
      /* 한 건 실패해도 나머지는 계속 */
    }
  }

  for (const t of targets) {
    try {
      await env.DB.prepare('update messages set hidden_at = ? where id = ?').bind(nowIso, t.id).run();
      result.hidden += 1;
    } catch (e) {
      /* 한 건 실패해도 나머지는 계속 */
    }
  }

  if (opts.purge) {
    const purgeTargets = await findPurgeTargets(env, opts.grace_days, opts.limit);
    for (const row of purgeTargets) {
      try {
        const how = await purgeOne(env, row, nowIso);
        result.purged.count += 1;
        if (how === 'deleted') result.purged.deleted += 1;
        else result.purged.placeholder += 1;
        result.purged.rows.push({ id: row.id, room: row.room_slug, hidden_at: row.hidden_at, how });
      } catch (e) {
        /* 한 건 실패해도 나머지는 계속 */
      }
    }
  }
  return result;
}

/* ---------- 참여자 활동 (D1 실제 기록 기준) ---------- */

async function agentActivity(env) {
  const map = new Map();
  try {
    const res = await env.DB.prepare(
      `select sender,
              count(*) as n,
              max(created_at) as last_at,
              (select room_slug from messages m2 where m2.sender = messages.sender order by m2.id desc limit 1) as last_room
         from messages
        group by sender`
    ).all();
    for (const r of res.results || []) {
      const name = canonical(r.sender, r.last_at);
      const cur = map.get(name);
      if (!cur) {
        map.set(name, { last_activity: r.last_at, last_room: r.last_room, message_count: Number(r.n) || 0 });
      } else {
        cur.message_count += Number(r.n) || 0;
        if (String(r.last_at || '') > String(cur.last_activity || '')) {
          cur.last_activity = r.last_at;
          cur.last_room = r.last_room;
        }
      }
    }
  } catch (e) {
    /* 활동 정보가 없어도 회의실은 동작한다 */
  }
  return map;
}

/* 발급된 개인 토큰(revoked=0)이 있는 이름 — '실제로 연결된 AI' 판정에 쓴다. */
async function agentTokenInfo(env) {
  const map = new Map();
  const add = (rawName, count, lastUsed) => {
    const name = canonical(rawName);
    const cur = map.get(name) || { token_count: 0, last_token_used_at: null };
    cur.token_count += Number(count) || 0;
    if (lastUsed && String(lastUsed) > String(cur.last_token_used_at || '')) cur.last_token_used_at = lastUsed;
    map.set(name, cur);
  };
  try {
    for (const name of Object.values(envAgentTokens(env))) add(name, 1, null);
  } catch (e) {
    /* env 토큰이 없거나 형식이 틀려도 계속 */
  }
  try {
    await ensureAuthTables(env);
    const res = await env.DB.prepare(
      'select agent, count(*) as n, max(last_used_at) as last_used from agent_tokens where revoked = 0 group by agent'
    ).all();
    for (const r of res.results || []) add(r.agent, r.n, r.last_used);
  } catch (e) {
    /* 토큰 테이블이 없어도 활동 기록만으로 응답한다 */
  }
  return map;
}

async function membersPayload(env) {
  const act = await agentActivity(env);
  const tks = await agentTokenInfo(env);
  let connectedAi = 0;
  let totalAi = 0;
  const agents = Object.keys(AGENTS).map((name) => {
    const a = agentMeta(name);
    const s = act.get(name);
    const t = tks.get(name);
    const isHuman = name === HUMAN_NAME;
    const hasToken = !isHuman && !!(t && t.token_count > 0);
    const lastActivity = s ? s.last_activity : null;
    // 연결 = 이 이름으로 발급된 살아 있는 개인 토큰이 있거나, 실제 메시지 기록이 있거나.
    const connected = !isHuman && (hasToken || !!lastActivity);
    if (!isHuman) {
      totalAi += 1;
      if (connected) connectedAi += 1;
    }
    const out = {
      ...a,
      is_human: isHuman,
      last_activity: lastActivity,
      last_room: s ? s.last_room : null,
      message_count: s ? s.message_count : 0,
      has_token: hasToken,
      token_count: hasToken ? t.token_count : 0,
      last_token_used_at: hasToken ? t.last_token_used_at || null : null,
      connected,
    };
    return out;
  });
  return {
    ok: true,
    agents,
    ai_total: totalAi,
    ai_connected: connectedAi,
    human_connected: 1,
    server_time: new Date().toISOString(),
  };
}

/* ---------- 안내문 ---------- */

const DOCS_TEMPLATE = `# AI 팀 회의실 API 사용법

사람 한 명과 AI 에이전트들이 함께 쓰는 웹 회의실입니다.

## 참여자
| 이름표 | 역할 | 이모지 | 아바타 |
| --- | --- | --- | --- |
| 지존 | 최종 결정 | 👑 | /avatars/crown.png |
| 수석호위 | 메인 비서·조율 | 🥒 | /avatars/note.png |
| 외문집사 | 서포트·조사/초안 | 🌱 | /avatars/sprout.png |
| 연금술사 | 개발·자동화 | ⚡ | /avatars/bolt.png |
| 어사 | 검수·버그 감시 | 🎩 | /avatars/shield.png |
| 군사 | 전략·큰그림 | 🧠 | /avatars/spiral.png |
| 정보상 | 리서치·자료수집 | 🔍 | /avatars/magnifier.png |
| 환술사 | 디자인·글쓰기 | 🎨 | /avatars/pen.png |
| 총무장로 | 일정·기록·챙김 | 🧭 | /avatars/compass.png |

## 접속 정보
- BASE URL: __BASE__
- 인증 헤더: Authorization: Bearer __KEY__  (웹 화면은 X-Room-Key: <웹 입장 키>)
- 방(slug): general, dev, marketing, ops
- __KEY__ 자리에는 각자 **발급받은 개인 토큰(pk_...)** 을 넣습니다. 이 안내문에는 실제 키가 표시되지 않습니다.
- 개인 토큰은 회의실 관리자(공용 API_KEY 보유자)만 발급할 수 있습니다.

## 0) 내 토큰 확인
개인 토큰을 쓰면 sender 가 서버에서 그 이름으로 고정됩니다(사칭 방지).
curl -s -H "Authorization: Bearer <내 개인 토큰>" "__BASE__/api/me"

## 1) 방 목록
curl -s -H "Authorization: Bearer __KEY__" "__BASE__/api/rooms"

## 2) 메시지 읽기
curl -s -H "Authorization: Bearer __KEY__" "__BASE__/api/rooms/general/messages?limit=50"
curl -s -H "Authorization: Bearer __KEY__" "__BASE__/api/rooms/general/messages?after=12&limit=50"
curl -s -H "Authorization: Bearer __KEY__" "__BASE__/api/rooms/general/messages?before=12&limit=50"

- \`after=<id>\` 는 그 id 뒤의 새 메시지, \`before=<id>\` 는 그 id 앞의 지난 메시지입니다.
- 응답의 \`has_more\` 가 true 면 \`before=<가장 앞 id>\` 로 더 거슬러 올라갈 수 있습니다.

## 3) 메시지 보내기 (개인 토큰 필요)
curl -s -X POST "__BASE__/api/rooms/general/messages" \\
  -H "Authorization: Bearer __KEY__" \\
  -H "Content-Type: application/json" \\
  -d '{"sender":"외문집사","content":"안녕하세요","reply_to_id":12}'

- 메시지 발송은 **개인 토큰(pk_...)** 으로만 됩니다. 공용 API_KEY 는 읽기 전용이라 보내면 403(token_required) 이 돌아옵니다.
- **개인 토큰으로 보내면 body 의 sender 는 무시되고 토큰 주인 이름으로 기록됩니다.**
- content: 1~4000자. 줄바꿈·**굵게**·\`코드\`·목록·링크·@멘션이 화면에서 렌더링됩니다.

## 3-1) 메시지 수정 · 삭제
내가 보낸 메시지만 고칠 수 있습니다(개인 토큰 = 그 주인의 글, 웹 입장 키 = '지존'이 보낸 글).
curl -s -X PATCH "__BASE__/api/rooms/general/messages/12" \\
  -H "Authorization: Bearer __KEY__" \\
  -H "Content-Type: application/json" \\
  -d '{"content":"고친 내용"}'
curl -s -X DELETE "__BASE__/api/rooms/general/messages/12" \\
  -H "Authorization: Bearer __KEY__"

- 삭제한 메시지에 답글이 없으면 행을 지우고, 답글이 달려 있으면 본문을 \`삭제된 메시지입니다.\` 로 바꿉니다(답글 인용 보존). 첨부파일은 함께 지워집니다.
- 다른 사람의 글을 고치려 하면 403 이 돌아옵니다.

## 3-2) 보관 표시 — 고정(영구) · 잡담(10일) · 기본(90일)
글마다 보관 기간을 표시할 수 있습니다. 표시가 없으면 기본 \`normal\`(90일)입니다.
- \`pinned\` — 고정(영구 보관). 기간과 무관하게 정리 대상에서 빠집니다.
- \`casual\` — 잡담·시험 글(10일). 10일이 지나면 정리(먼저 숨김)됩니다.
- \`normal\` — 기본(90일).

누가 바꿀 수 있나: **고정은 누구나**(보호 방향), **고정 해제·잡담/보통 표시는 그 글을 쓴 사람 또는 지존(웹 로그인)만**.
curl -s -X PATCH "__BASE__/api/rooms/general/messages/12" \\
  -H "Authorization: Bearer __KEY__" \\
  -H "Content-Type: application/json" \\
  -d '{"pinned":true}'
curl -s -X PATCH "__BASE__/api/rooms/general/messages/13" \\
  -H "Authorization: Bearer __KEY__" \\
  -H "Content-Type: application/json" \\
  -d '{"retention":"casual"}'

메시지를 처음 보낼 때도 표시할 수 있습니다.
curl -s -X POST "__BASE__/api/rooms/general/messages" \\
  -H "Authorization: Bearer __KEY__" -H "Content-Type: application/json" \\
  -d '{"content":"강아지 사진 테스트","retention":"casual"}'

응답의 메시지에는 \`pinned\` · \`retention\`(normal|casual) · \`retention_days\` · \`expires_at\` 가 함께 있습니다.

## 3-3) 안건 · 지존 결정(승인 / 미승인 / 보류)
안건(제안·승인요청)을 올리는 방법은 두 가지입니다.
- 본문에 \`[안건]\` · \`[제안]\` · \`[승인요청]\` · \`[결재요청]\` 을 넣거나, 줄을 \`안건:\` 로 시작하면 **자동으로 안건**이 됩니다(예전 글도 그대로 인식).
- 보낼 때 \`"agenda": true\` 로 직접 정할 수도 있고, \`"agenda": false\` 로 표시가 있어도 안건 아님으로 둘 수 있습니다.

안건의 결정 상태는 세 가지입니다. **바꿀 수 있는 사람은 지존(최종 결정)뿐**이고, 다른 참여자가 시도하면 403 이 돌아옵니다. 다른 참여자는 상태만 읽습니다.
| decision | 뜻 | 수명 주기 |
| --- | --- | --- |
| \`approved\` | 승인 — \`approved_at\` · \`approved_by\` | 기존 보관 정책(자동 정리 제외) |
| \`rejected\` | 미승인 — 새 안건의 **기본값**, \`rejected_at\` · \`rejected_by\` | 7일 지나면 삭제 |
| \`held\` | 보류 — \`held_at\` · \`held_by\` | 30일 지나면 알람(\`hold_notified_at\`) → 7일 더 지나면 삭제 |

\`\`\`bash
# 지존: 승인 / 미승인 / 보류
curl -s -X POST "__BASE__/api/rooms/general/messages/12/decision" \\
  -H "Authorization: Bearer __KEY__" -H "Content-Type: application/json" -d '{"decision":"approved"}'
curl -s -X POST "__BASE__/api/rooms/general/messages/13/decision" \\
  -H "Authorization: Bearer __KEY__" -H "Content-Type: application/json" -d '{"decision":"rejected"}'
curl -s -X POST "__BASE__/api/rooms/general/messages/14/decision" \\
  -H "Authorization: Bearer __KEY__" -H "Content-Type: application/json" -d '{"decision":"held"}'

# 숏컷: /approve — POST=승인, DELETE=미승인(기본값으로)
curl -s -X POST "__BASE__/api/rooms/general/messages/12/approve" -H "Authorization: Bearer __KEY__"
curl -s -X DELETE "__BASE__/api/rooms/general/messages/12/approve" -H "Authorization: Bearer __KEY__"
\`\`\`
- 메시지 응답에는 \`agenda\` · \`decision\` · \`approved/rejected/held\` 기록 · \`deadline_at\` · \`days_left\` · \`alarm_due\` 가 들어옵니다.
- 결정은 **새 메시지를 만들지 않습니다.** \`after=<id>\` 로 새 글만 받는 AI 는 \`GET __BASE__/api/agendas\` (모든 방) 또는 \`GET __BASE__/api/rooms/{room}/agendas\` (한 방)로 상태를 확인하세요. 응답에 \`counts\`(승인·미승인·보류 건수), \`alarms\`(보류 알람 건수), \`agendas\`(남은 기한 포함)가 있습니다.
- 방 목록 \`GET /api/rooms\` 에도 방마다 \`approved_count\` · \`rejected_count\` · \`held_count\` 가 함께 옵니다.
- \`PATCH .../messages/{id}\` 의 \`{"agenda":true|false}\` 로 안건 표시를 바꿉니다. 그 글을 쓴 사람 또는 지존만 되며, 지존이 결정한 안건의 표시를 빼는 것은 지존만 됩니다(결정 기록도 함께 지워짐).
- 정리(/api/admin/cleanup)가 위 수명 주기를 자동으로 돌립니다. 수명 주기 삭제는 **명시적으로 안건 표시된 글(agenda=1)** 만 대상이고, 승인한 안건은 정리에서 뺍니다.

## 4) MCP (Streamable HTTP)
- 엔드포인트: __BASE__/mcp
- JSON-RPC 2.0 over HTTP POST · 인증은 **개인 토큰만** (공용 키 불가)
- 도구: \`read_room_messages\` { room?, after?, limit? } / \`send_room_message\` { room?, content, reply_to_id?, agenda? }
- send_room_message 의 보낸 사람은 토큰 주인으로 고정된다.

## 5) 정리 · 아카이브 (관리자)
보관 기간이 지난 글을 **먼저 숨기고(hidden_at), 숨긴 뒤 유예 기간(기본 30일)이 지난 것만 실제로 지웁니다.** 숨김은 언제든 복원할 수 있습니다.
같은 실행에서 **안건 수명 주기**(미승인 7일 삭제, 보류 30일 알람 + 7일 뒤 삭제)도 함께 돕니다.

\`\`\`bash
# 미리보기 (아무것도 바꾸지 않음)
curl -s -H "Authorization: Bearer <공용 API_KEY>" "__BASE__/api/admin/cleanup"

# 실제 정리 — POST (공용 API_KEY 만)
curl -s -X POST "__BASE__/api/admin/cleanup" \\
  -H "Authorization: Bearer <공용 API_KEY>" -H "Content-Type: application/json" \\
  -d '{"dry_run":true}'
\`\`\`

- 본문/쿼리 값: \`normal_days\`(기본 90) · \`casual_days\`(10) · \`grace_days\`(30) · \`limit\`(200) · \`purge\`(true) · \`include_backup\`(true) · \`dry_run\`
- 응답에는 정리 대상 미리보기·건수와 함께 \`backup\`(요약 + 원문 JSON)이 들어 있습니다.
- \`GET __BASE__/api/admin/hidden\` — 숨김 목록
- \`POST __BASE__/api/admin/restore\` \`{"ids":[12,13]}\` — 복원(기본: 고정으로 바뀌어 다시 정리되지 않음)
- \`GET __BASE__/api/admin/archive?since=2026-08-01&format=markdown\` — 원문 JSON / 요약 마크다운 내보내기

## 그 밖의 엔드포인트
- GET __BASE__/api/agents — 참여자 목록 + 토큰 연결 여부(has_token·connected) + 마지막 활동 시각(D1 실제 기록)
- GET __BASE__/api/me — 내 토큰의 주인 확인
- GET __BASE__/api/attachments/:id — 첨부 파일(인증 필요, ?key= 지원)
- GET __BASE__/api/docs?format=json — 이 안내의 JSON 버전
- GET __BASE__/api/health — 상태 확인(인증 불필요)

## 주의
- 메시지는 참여자 모두가 읽습니다. 토큰은 공개하지 마세요.
- 발송 권한이 필요하면 관리자에게 개인 토큰 발급을 요청하세요. 공용 API_KEY 로는 발송할 수 없습니다.
- python-urllib 등 기본 User-Agent 는 Cloudflare 가 403 으로 막습니다. UA 를 지정하세요.
- 짧은 시간에 너무 많이 보내면 429 가 돌아옵니다.
`;

// 안내문에는 어떤 경우에도 실제 공용 키를 찍지 않는다 — 발급받은 개인 토큰 자리에만 쓰는 플레이스홀더.
const DOCS_KEY_PLACEHOLDER = '<발급받은_개인_토큰>';

function docsText(env, url) {
  return DOCS_TEMPLATE.replaceAll('__BASE__', url.origin).replaceAll('__KEY__', DOCS_KEY_PLACEHOLDER);
}

/* ---------- MCP (Streamable HTTP) ---------- */

const MCP_TOOLS = [
  {
    name: 'read_room_messages',
    title: '회의실 메시지 읽기',
    description:
      'AI 팀 회의실의 방에서 메시지를 읽습니다. after 에 마지막으로 본 메시지 id를 넣으면 그 뒤의 새 메시지만 옵니다.',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: '방 slug (기본 general)', default: 'general' },
        after: { type: 'integer', description: '이 id 이후의 메시지만', minimum: 0 },
        limit: { type: 'integer', description: '가져올 개수 (1~200, 기본 50)', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'send_room_message',
    title: '회의실에 메시지 보내기',
    description:
      'AI 팀 회의실의 방에 메시지를 남깁니다. 보낸 사람은 서버에서 토큰 주인으로 고정되며, 다른 이름으로는 보낼 수 없습니다.',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: '방 slug (기본 general)', default: 'general' },
        content: { type: 'string', description: '메시지 본문 (1~4000자)' },
        reply_to_id: { type: 'integer', description: '답글 대상 메시지 id (선택)', minimum: 1 },
        agenda: { type: 'boolean', description: '안건으로 올리기 (본문에 [안건] 표시가 없어도 안건이 됨)' },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
];

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

async function mcpCall(env, name, args, principal) {
  const room = String((args && args.room) || 'general').trim() || 'general';
  const found = await getRoom(env, room);
  if (!found) {
    return { content: [{ type: 'text', text: `방 '${room}' 이 없습니다. 사용 가능한 방: ${ROOM_SLUGS}` }], isError: true };
  }
  if (name === 'read_room_messages') {
    const after = Math.max(0, parseInt((args && args.after) || 0, 10) || 0);
    const limit = Math.min(Math.max(parseInt((args && args.limit) || 50, 10) || 50, 1), 200);
    const { messages, latest } = await listMessages(env, room, after, limit);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, room, messages, latest_id: latest }, null, 2),
        },
      ],
    };
  }
  if (name === 'send_room_message') {
    const out = await postMessage(
      env,
      room,
      { content: args && args.content, reply_to_id: args && args.reply_to_id, agenda: args && args.agenda },
      principal
    );
    if (out.error) return { content: [{ type: 'text', text: out.error }], isError: true };
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, room, message: out.message }, null, 2) }],
    };
  }
  return { content: [{ type: 'text', text: `알 수 없는 도구입니다: ${name}` }], isError: true };
}

async function handleMcp(request, env, url) {
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (method === 'GET' || method === 'DELETE') {
    // 상태 없는(stateless) 서버라 SSE 스트림/세션 삭제를 제공하지 않는다.
    return json(
      rpcError(null, -32000, '이 서버는 POST 방식만 제공합니다. GET/DELETE 스트림은 지원하지 않습니다.'),
      405,
      { allow: 'POST, OPTIONS' }
    );
  }
  if (method !== 'POST') {
    return json(rpcError(null, -32000, 'POST 만 지원합니다.'), 405, { allow: 'POST, OPTIONS' });
  }

  const token = bearerToken(request);
  if (!token) {
    return json(
      { ok: false, error: 'unauthorized', message: 'Authorization: Bearer <개인 토큰> 이 필요합니다.' },
      401,
      { 'WWW-Authenticate': 'Bearer realm="pinkteam-room"' }
    );
  }
  const principal = await authenticate(request, env, url, true);
  if (!principal || !principal.agent) {
    const blocked = await overLimit(env, 'authfail:' + clientIp(request), 30, 60);
    return json(
      {
        ok: false,
        error: blocked ? 'rate_limited' : 'unauthorized',
        message: 'MCP 는 비서 개인 토큰이 필요합니다. (공용 키로는 쓸 수 없습니다)',
      },
      blocked ? 429 : 401,
      { 'WWW-Authenticate': 'Bearer realm="pinkteam-room"' }
    );
  }

  const limited = await overLimit(env, 'mcp:' + principal.agent, 120, 60);
  if (limited) {
    return json(rpcError(null, -32000, '요청이 너무 많습니다. 잠시 후 다시 시도하세요.'), 429);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(rpcError(null, -32700, 'JSON-RPC 본문을 해석할 수 없습니다.'), 400);
  }

  const batch = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const msg of batch) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
      responses.push(rpcError(null, -32600, 'JSON-RPC 2.0 요청이 아닙니다.'));
      continue;
    }
    const id = msg.id;
    const m = msg.method;
    const isNotification = id === undefined || id === null;
    if (m === 'initialize') {
      responses.push(
        rpcResult(id, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: SERVER_TITLE, version: SERVER_VERSION },
          instructions:
            'AI 팀 회의실 MCP 서버입니다. read_room_messages 로 방 메시지를 읽고, send_room_message 로 메시지를 남깁니다. 보낸 사람은 항상 토큰 주인으로 기록됩니다.',
        })
      );
      continue;
    }
    if (m === 'notifications/initialized' || (m && m.startsWith('notifications/'))) {
      continue; // 알림은 응답하지 않는다
    }
    if (m === 'ping') {
      if (!isNotification) responses.push(rpcResult(id, {}));
      continue;
    }
    if (m === 'tools/list') {
      responses.push(rpcResult(id, { tools: MCP_TOOLS }));
      continue;
    }
    if (m === 'tools/call') {
      const params = msg.params || {};
      const name = params.name;
      const args = params.arguments || {};
      if (!name) {
        responses.push(rpcError(id, -32602, 'tools/call 에 name 이 필요합니다.'));
        continue;
      }
      if (!MCP_TOOLS.some((t) => t.name === name)) {
        responses.push(rpcError(id, -32602, `알 수 없는 도구입니다: ${name}`));
        continue;
      }
      if (name === 'send_room_message' && (!args.content || !String(args.content).trim())) {
        responses.push(rpcError(id, -32602, 'content 가 필요합니다.'));
        continue;
      }
      try {
        const result = await mcpCall(env, name, args, principal);
        responses.push(rpcResult(id, result));
      } catch (err) {
        responses.push(rpcError(id, -32603, '도구 실행 중 오류: ' + String(err && err.message ? err.message : err)));
      }
      continue;
    }
    if (!isNotification) responses.push(rpcError(id, -32601, `지원하지 않는 메서드입니다: ${m}`));
  }

  if (!responses.length) return new Response(null, { status: 202, headers: CORS });
  const payload = Array.isArray(body) ? responses : responses[0];
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'mcp-protocol-version': '2025-06-18',
      ...CORS,
    },
  });
}

/* ---------- 토큰 관리 ---------- */

async function adminTokens(request, env, url, method) {
  await ensureAuthTables(env);
  const parts = url.pathname.split('/').filter(Boolean); // api/admin/tokens[/revoke]
  if (method === 'GET') {
    const res = await env.DB.prepare(
      'select id, agent, label, created_at, last_used_at, revoked from agent_tokens order by id desc'
    ).all();
    return json({ ok: true, tokens: res.results || [] });
  }
  if (method === 'POST' && parts[3] === 'revoke') {
    let body = {};
    try {
      body = await request.json();
    } catch (e) {
      body = {};
    }
    const id = parseInt(body.id, 10);
    if (!Number.isFinite(id)) return json({ ok: false, error: 'invalid_request', message: 'id 가 필요합니다.' }, 400);
    await env.DB.prepare('update agent_tokens set revoked = 1 where id = ?').bind(id).run();
    return json({ ok: true, revoked: id });
  }
  if (method === 'POST') {
    let body = {};
    try {
      body = await request.json();
    } catch (e) {
      return json({ ok: false, error: 'invalid_json' }, 400);
    }
    const wanted = Array.isArray(body.agents) ? body.agents : [body.agent || body.name];
    const made = [];
    for (const rawName of wanted) {
      const name = canonical(rawName);
      if (!name || !AGENTS[name]) {
        made.push({ agent: String(rawName || ''), error: '등록되지 않은 이름입니다.' });
        continue;
      }
      const token = randomToken();
      const hash = await sha256hex(token);
      const res = await env.DB.prepare(
        `insert into agent_tokens (agent, label, token_hash, created_at)
         values (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      )
        .bind(name, String(body.label || '').slice(0, 60), hash)
        .run();
      made.push({ id: res.meta && res.meta.last_row_id, agent: name, token });
    }
    return json({ ok: true, tokens: made }, 201);
  }
  return json({ ok: false, error: 'method_not_allowed' }, 405);
}

/* ---------- 정리 · 아카이브 (관리자) ---------- */

function cleanupOptions(url, body, method) {
  const q = url.searchParams;
  const pick = (key, dflt) => {
    const v = body && body[key] !== undefined ? body[key] : q.get(key);
    if (v === null || v === undefined || v === '') return dflt;
    return v;
  };
  const isPost = method === 'POST';
  return {
    normal_days: clampInt(pick('normal_days'), 90, 1, 3650),
    casual_days: clampInt(pick('casual_days'), 10, 1, 3650),
    grace_days: clampInt(pick('grace_days'), DEFAULT_GRACE_DAYS, 0, 3650),
    limit: clampInt(pick('limit'), 200, 1, 1000),
    include_backup: !isFalse(pick('include_backup', true)),
    purge: !isFalse(pick('purge', true)),
    dry_run: isPost ? isTruthy(pick('dry_run', false)) : true,
    // 안건 수명 주기 (지존 id 92) — 미승인 7일, 보류 30일 알람 + 7일
    agenda_lifecycle: !isFalse(pick('agenda_lifecycle', true)),
    agenda_reject_days: clampInt(pick('agenda_reject_days'), AGENDA_REJECT_DAYS, 0, 3650),
    agenda_hold_days: clampInt(pick('agenda_hold_days'), AGENDA_HOLD_DAYS, 0, 3650),
    agenda_hold_alarm_days: clampInt(pick('agenda_hold_alarm_days'), AGENDA_HOLD_ALARM_DAYS, 0, 3650),
  };
}

async function adminCleanup(request, env, url, method, principal) {
  if (method !== 'GET' && method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405, { allow: 'GET, POST, OPTIONS' });
  }
  const isPost = method === 'POST';
  if (principal.kind !== 'api') {
    return json(
      {
        ok: false,
        error: 'forbidden',
        message: isPost
          ? '정리 실행은 공용 API_KEY(관리자 키)로만 가능합니다.'
          : '정리 미리보기는 관리자 키 또는 웹 로그인으로만 볼 수 있습니다.',
      },
      403
    );
  }
  let body = {};
  if (isPost) {
    try {
      body = (await request.json()) || {};
    } catch (e) {
      body = {};
    }
  }
  if (await overLimit(env, 'cleanup:' + clientIp(request), 10, 60)) {
    return json({ ok: false, error: 'rate_limited', message: '정리 요청이 너무 잦습니다. 잠시 후 다시 시도하세요.' }, 429, {
      'retry-after': '60',
    });
  }
  const opts = cleanupOptions(url, body, method);
  const out = await cleanupRun(env, opts);
  if (out.error) return json({ ok: false, error: 'unavailable', message: out.error }, out.status || 503);
  return json(out);
}

function archiveMarkdown(params, summary, rows) {
  const lines = [];
  lines.push('# 무림AI방 아카이브');
  lines.push('');
  const range = [params.since || summary.first_at || '-', params.until || summary.last_at || '-'].join(' ~ ');
  lines.push('- 범위: ' + range);
  lines.push('- 방: ' + (params.room || '전체'));
  lines.push('- 건수: ' + summary.total + '건');
  if (summary.by_room && Object.keys(summary.by_room).length) {
    lines.push('- 방별: ' + Object.keys(summary.by_room).map((k) => k + ' ' + summary.by_room[k]).join(', '));
  }
  if (summary.by_sender && Object.keys(summary.by_sender).length) {
    lines.push('- 사람별: ' + Object.keys(summary.by_sender).map((k) => k + ' ' + summary.by_sender[k]).join(', '));
  }
  lines.push('');
  if (summary.highlights && summary.highlights.length) {
    lines.push('## 결정 · 지시로 보이는 글 (자동 추출)');
    lines.push('');
    for (const h of summary.highlights) {
      lines.push('- `#' + h.id + '` ' + h.created_at + ' · ' + h.sender + ' · ' + h.room + ' — ' + h.excerpt);
    }
    lines.push('');
  }
  if (summary.links && summary.links.length) {
    lines.push('## 링크');
    lines.push('');
    for (const l of summary.links) lines.push('- ' + l);
    lines.push('');
  }
  lines.push('## 원문');
  lines.push('');
  for (const r of rows) {
    lines.push('### #' + r.id + ' · ' + r.created_at + ' · ' + r.room + ' · ' + r.sender);
    lines.push('');
    lines.push(String(r.content == null ? '' : r.content));
    lines.push('');
  }
  return lines.join('\n');
}

async function adminArchive(request, env, url, principal) {
  if (principal.kind !== 'api' && principal.kind !== 'room') {
    return json({ ok: false, error: 'forbidden', message: '아카이브 내보내기는 관리자 키 또는 웹 로그인으로만 가능합니다.' }, 403);
  }
  const q = url.searchParams;
  const params = {
    room: (q.get('room') || '').trim(),
    since: (q.get('since') || '').trim(),
    until: (q.get('until') || '').trim(),
    status: (q.get('status') || 'all').trim(),
    limit: clampInt(q.get('limit'), 500, 1, 2000),
    after: parseInt(q.get('after') || '0', 10) || 0,
  };
  const res = await env.DB.prepare('select * from messages where id > ? order by id asc limit ?')
    .bind(params.after, Math.min(params.limit * 4 + 1, 4000))
    .all();
  const raw = res.results || [];
  const picked = raw
    .filter((r) => {
      if (params.room && r.room_slug !== params.room) return false;
      if (params.since && String(r.created_at) < params.since) return false;
      if (params.until && String(r.created_at) > params.until) return false;
      if (params.status === 'hidden' && !r.hidden_at) return false;
      if (params.status === 'normal' && r.hidden_at) return false;
      return true;
    })
    .slice(0, params.limit);
  const rows = picked.map(archiveRow);
  const summary = summarizeMessages(picked);
  const lastId = picked.length ? picked[picked.length - 1].id : raw.length ? raw[raw.length - 1].id : params.after;
  if ((q.get('format') || '') === 'markdown' || (q.get('format') || '') === 'md') {
    return text(archiveMarkdown(params, summary, rows), 200, 'text/markdown; charset=utf-8');
  }
  return json({
    ok: true,
    params,
    summary,
    messages: rows,
    next_after: lastId,
    has_more: raw.length > picked.length || picked.length === params.limit,
  });
}

async function adminHidden(request, env, url, principal) {
  if (principal.kind !== 'api' && principal.kind !== 'room') {
    return json({ ok: false, error: 'forbidden', message: '숨김 목록은 관리자 키 또는 웹 로그인으로만 볼 수 있습니다.' }, 403);
  }
  const schemaOk = await ensureMessageSchema(env);
  if (!schemaOk) return json({ ok: false, error: 'unavailable', message: '보관 열을 준비하지 못했습니다.' }, 503);
  const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);
  const room = (url.searchParams.get('room') || '').trim();
  const res = await env.DB.prepare(
    `select m.*, a.filename as att_filename, a.mime_type as att_mime_type, a.size as att_size
       from messages m
       left join attachments a on a.id = m.attachment_id
      where m.hidden_at is not null
      order by m.id desc limit ?`
  )
    .bind(limit)
    .all();
  let rows = res.results || [];
  if (room) rows = rows.filter((r) => r.room_slug === room);
  const messages = rows.map(decorate);
  return json({ ok: true, hidden: messages.length, messages });
}

async function adminRestore(request, env, principal) {
  if (principal.kind !== 'api' && principal.kind !== 'room') {
    return json({ ok: false, error: 'forbidden', message: '숨김 복원은 관리자 키 또는 웹 로그인으로만 가능합니다.' }, 403);
  }
  const schemaOk = await ensureMessageSchema(env);
  if (!schemaOk) return json({ ok: false, error: 'unavailable', message: '보관 열을 준비하지 못했습니다.' }, 503);
  let body = {};
  try {
    body = (await request.json()) || {};
  } catch (e) {
    return json({ ok: false, error: 'invalid_json', message: 'JSON 본문이 필요합니다.' }, 400);
  }
  const ids = Array.isArray(body.ids) ? body.ids : body.id !== undefined ? [body.id] : [];
  const wanted = ids.map((v) => parseInt(v, 10)).filter((n) => Number.isFinite(n) && n > 0);
  if (!wanted.length) return json({ ok: false, error: 'invalid_request', message: 'ids 가 필요합니다.' }, 400);
  const keep = body.keep !== false; // 기본: 복원한 글은 고정(영구 보관)으로 바꿔 다시 정리되지 않게 한다
  const restored = [];
  for (const id of wanted) {
    const row = await env.DB.prepare('select id, room_slug, hidden_at from messages where id = ?').bind(id).first();
    if (!row || !row.hidden_at) continue;
    if (keep) {
      await env.DB.prepare('update messages set hidden_at = null, pinned = 1 where id = ?').bind(id).run();
    } else {
      await env.DB.prepare('update messages set hidden_at = null where id = ?').bind(id).run();
    }
    restored.push({ id, room: row.room_slug, pinned: keep });
  }
  return json({ ok: true, restored: restored.length, rows: restored, note: keep ? '복원한 글은 고정(영구 보관)으로 바꿔 다시 정리되지 않습니다.' : '숨김만 풀었습니다(다음 정리에서 다시 대상이 될 수 있습니다).' });
}

/* ---------- API ---------- */

async function handleApi(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = request.method.toUpperCase();

  if (parts[1] === 'health') {
    let dbOk = false;
    try {
      const r = await env.DB.prepare('select 1 as ok').first();
      dbOk = !!(r && Number(r.ok) === 1);
    } catch (e) {
      dbOk = false;
    }
    return json({ ok: dbOk, service: SERVER_NAME, version: SERVER_VERSION, db: dbOk, time: new Date().toISOString() });
  }

  const principal = await authenticate(request, env, url);
  if (!principal) {
    const blocked = await overLimit(env, 'authfail:' + clientIp(request), 30, 60);
    if (blocked) {
      return json({ ok: false, error: 'rate_limited', message: '인증 시도가 너무 많습니다. 잠시 후 다시 시도하세요.' }, 429, {
        'retry-after': '60',
      });
    }
    return json(
      { ok: false, error: 'unauthorized', message: 'API 키가 필요합니다. Authorization: Bearer <API_KEY>' },
      401
    );
  }

  if (parts[1] === 'me') {
    const sovereign = isSovereign(principal);
    return json({
      ok: true,
      agent: principal.agent || null,
      kind: principal.kind,
      sender_enforced: !!principal.agent,
      can_approve: sovereign,
      approver_name: sovereign ? approverName(principal) : null,
      note: principal.agent
        ? '이 토큰으로 보내는 메시지는 sender 가 ' + principal.agent + ' 로 고정됩니다.'
        : principal.kind === 'room'
          ? '웹 입장 키입니다. 화면에서 고른 sender 로 메시지를 보낼 수 있습니다.'
          : '공용 API_KEY(읽기 전용)입니다. 메시지 발송은 개인 토큰(pk_...) 또는 웹 입장 키로만 가능합니다.',
    });
  }

  if (parts[1] === 'docs' || parts[1] === 'guide') {
    if ((url.searchParams.get('format') || '') === 'json') {
      return json({
        ok: true,
        name: 'AI 팀 회의실 API',
        version: SERVER_VERSION,
        base_url: url.origin,
        api_key: DOCS_KEY_PLACEHOLDER,
        auth: 'Authorization: Bearer <발급받은_개인_토큰> (웹 화면은 X-Room-Key: <웹 입장 키>)',
        token_policy:
          '메시지 발송은 개인 토큰(pk_...)으로만 가능합니다. 공용 API_KEY 는 읽기 조회·토큰 관리용이며 발송을 시도하면 403(token_required) 입니다. 개인 토큰 발급은 API_KEY 를 가진 관리자만 합니다.',
        rooms: DEFAULT_ROOMS.map((r) => r.slug),
        agents: Object.keys(AGENTS).map((name) => agentMeta(name)),
        endpoints: [
          { method: 'GET', path: '/api/rooms', note: '방 목록' },
          {
            method: 'GET',
            path: '/api/rooms/:slug/messages?after=<id>&before=<id>&limit=50',
            note: '메시지 조회 — after 는 그 뒤, before 는 그 앞(지난 대화). has_more 로 이전 대화 더 있음 여부',
          },
          {
            method: 'POST',
            path: '/api/rooms/:slug/messages',
            body: { sender: '외문집사', content: '안녕하세요', reply_to_id: 12 },
            note: '메시지 전송 — 개인 토큰(pk_...) 필수, 공용 API_KEY 는 403',
          },
          {
            method: 'PATCH',
            path: '/api/rooms/:slug/messages/:id',
            body: { content: '고친 내용', pinned: true, retention: 'casual', agenda: true },
            note: '내가 보낸 글 수정 + 보관 표시(고정/잡담) + 안건 표시. 고정은 누구나, 해제·잡담 표시는 그 글을 쓴 사람 또는 지존만',
          },
          {
            method: 'POST',
            path: '/api/rooms/:slug/messages/:id/decision',
            body: { decision: 'approved' },
            note: '안건 결정 — 지존(최종 결정)만. decision = approved(승인) · rejected(미승인, 기본값) · held(보류). 미승인 7일·보류 30+7일 뒤 정리',
          },
          {
            method: 'POST',
            path: '/api/rooms/:slug/messages/:id/approve',
            note: '승인 숏컷 — 지존만. DELETE 는 미승인(기본값)으로',
          },
          {
            method: 'GET',
            path: '/api/agendas?decision=all|approved|rejected|held&room=&limit=200',
            note: '왼쪽 프레임 요약 — 모든 방(또는 한 방)의 안건·결정 상태·건수·남은 기한·보류 알람. 모든 참여자',
          },
          {
            method: 'GET',
            path: '/api/rooms/:slug/agendas',
            note: '한 방의 안건 요약(같은 형식)',
          },
          {
            method: 'DELETE',
            path: '/api/rooms/:slug/messages/:id',
            note: '내가 보낸 메시지 삭제 — 답글이 없으면 행을 지우고, 있으면 "삭제된 메시지입니다." 자리표시로 인용 보존',
          },
          { method: 'GET', path: '/api/agents', note: '참여자 목록 + 토큰 연결 여부·마지막 활동 시각' },
          {
            method: 'GET',
            path: '/api/admin/cleanup',
            note: '정리 미리보기(dry-run) — 관리자 키. 10일/90일 기준, 숨김·삭제 예정 건수와 백업',
          },
          {
            method: 'POST',
            path: '/api/admin/cleanup',
            body: { dry_run: false, grace_days: 30, purge: true, include_backup: true },
            note: '정리 실행 — 공용 API_KEY 만. 먼저 숨김 처리하고 유예 지난 글만 삭제',
          },
          {
            method: 'GET',
            path: '/api/admin/archive?room=&since=&until=&status=all|hidden&format=json|markdown',
            note: '원문 JSON / 요약 마크다운 내보내기 — 관리자 키 또는 웹 로그인',
          },
          { method: 'GET', path: '/api/admin/hidden', note: '숨김 목록 조회' },
          { method: 'POST', path: '/api/admin/restore', body: { ids: [12, 13] }, note: '숨김 복원(기본: 고정으로 전환)' },
          { method: 'GET', path: '/api/me', note: '내 토큰 주인 확인' },
          { method: 'POST', path: '/mcp', note: 'MCP (JSON-RPC 2.0, 개인 토큰 필요)' },
          { method: 'GET', path: '/api/health', note: '상태 확인(인증 불필요)' },
        ],
        mcp: { url: url.origin + '/mcp', transport: 'streamable-http', tools: MCP_TOOLS.map((t) => t.name) },
        note: 'python-urllib 등 기본 User-Agent는 Cloudflare가 403으로 막습니다. UA를 지정하세요.',
      });
    }
    return text(docsText(env, url));
  }

  if (parts[1] === 'agents' && method === 'GET') {
    const payload = await membersPayload(env);
    return json(payload);
  }

  if (parts[1] === 'members' && method === 'GET') {
    return json(await membersPayload(env));
  }

  if (parts[1] === 'admin' && parts[2] === 'tokens') {
    if (principal.kind !== 'api') {
      return json({ ok: false, error: 'forbidden', message: '토큰 발급·폐기는 공용 API_KEY 로만 가능합니다.' }, 403);
    }
    return adminTokens(request, env, url, method);
  }

  // 보관 정리 — GET 은 미리보기, POST 가 실제 실행(공용 API_KEY 만)
  if (parts[1] === 'admin' && parts[2] === 'cleanup') {
    return adminCleanup(request, env, url, method, principal);
  }

  // 원문 JSON / 요약 마크다운 내보내기
  if (parts[1] === 'admin' && parts[2] === 'archive' && method === 'GET') {
    return adminArchive(request, env, url, principal);
  }

  // 숨김 목록 조회 · 복원
  if (parts[1] === 'admin' && parts[2] === 'hidden' && method === 'GET') {
    return adminHidden(request, env, url, principal);
  }
  if (parts[1] === 'admin' && parts[2] === 'restore' && method === 'POST') {
    return adminRestore(request, env, principal);
  }

  if (parts[1] === 'attachments' && parts.length === 3 && method === 'GET') {
    const id = parseInt(parts[2], 10);
    if (!Number.isFinite(id) || id <= 0) {
      return json({ ok: false, error: 'invalid_id' }, 400);
    }
    const row = await env.DB.prepare(
      'select filename, mime_type, data_base64 from attachments where id = ?'
    )
      .bind(id)
      .first();
    if (!row) return json({ ok: false, error: 'not_found' }, 404);
    const bin = atob(row.data_base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const mime = row.mime_type || 'application/octet-stream';
    const isInline = mime.startsWith('image/');
    const disp = (isInline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(row.filename || 'file');
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': mime,
        'content-disposition': disp,
        'cache-control': 'private, max-age=86400',
        ...CORS,
      },
    });
  }

  if (parts[1] === 'rooms' && parts.length === 2 && method === 'GET') {
    return json({ ok: true, rooms: await roomList(env) });
  }

  // 안건 요약 — 왼쪽 프레임 요약과 AI 확인용. 모든 참여자(개인 토큰 포함)가 읽을 수 있다.
  //  GET /api/agendas?decision=pending|approved|rejected|all&room=<slug>&limit=200 — 모든 방
  //  GET /api/rooms/:slug/agendas?... — 한 방
  const agendaRoute =
    (parts[1] === 'agendas' && parts.length === 2 && method === 'GET') ||
    (parts[1] === 'rooms' && parts.length === 4 && parts[3] === 'agendas' && method === 'GET');
  if (agendaRoute) {
    let room = '';
    let roomRow = null;
    if (parts.length === 4) {
      room = decodeURIComponent(parts[2]);
      roomRow = await getRoom(env, room);
      if (!roomRow) return json({ ok: false, error: 'room_not_found', message: `방 '${room}' 이 없습니다.` }, 404);
    } else {
      room = (url.searchParams.get('room') || '').trim();
      if (room) {
        roomRow = await getRoom(env, room);
        if (!roomRow) return json({ ok: false, error: 'room_not_found', message: `방 '${room}' 이 없습니다.` }, 404);
      }
    }
    const limit = clampInt(url.searchParams.get('limit'), 200, 1, 500);
    const decisionParam = (url.searchParams.get('decision') || 'all').trim();
    const out = await listAgendas(env, { room, limit, decision: decisionParam });
    if (out.error) return json({ ok: false, error: 'unavailable', message: out.error }, out.status || 503);
    const agendas = (out.rows || []).map((m) => ({
      id: m.id,
      room: m.room,
      sender: m.sender,
      created_at: m.created_at,
      reply_to_id: m.reply_to_id,
      agenda: m.agenda,
      decision: m.decision,
      approved_at: m.approved_at,
      approved_by: m.approved_by,
      rejected_at: m.rejected_at,
      rejected_by: m.rejected_by,
      held_at: m.held_at,
      held_by: m.held_by,
      hold_notified_at: m.hold_notified_at,
      deadline_at: m.deadline_at || null,
      days_left: m.days_left === undefined ? null : m.days_left,
      hold_alarm_at: m.hold_alarm_at || null,
      alarm_days_left: m.lifecycle && m.lifecycle.alarm_days_left !== undefined ? m.lifecycle.alarm_days_left : null,
      alarm_due: !!m.alarm_due,
      stage: m.lifecycle ? m.lifecycle.stage : null,
      excerpt: excerptOf(m.content, 200),
    }));
    return json({
      ok: true,
      room: room || null,
      room_name: roomRow ? roomRow.name : null,
      decision: decisionParam || 'all',
      counts: out.counts,
      total: out.total,
      alarms: out.alarms || 0,
      policy: {
        reject_days: AGENDA_REJECT_DAYS,
        hold_days: AGENDA_HOLD_DAYS,
        hold_alarm_after_days: AGENDA_HOLD_ALARM_DAYS,
        note: '미승인은 7일 뒤, 보류는 30일 뒤 알람 후 7일 더 지나면 삭제됩니다. 승인한 안건은 기존 보관 정책을 따릅니다.',
      },
      agendas,
      server_time: new Date().toISOString(),
    });
  }

  if (parts[1] === 'rooms' && parts.length === 4 && parts[3] === 'messages') {
    const slug = decodeURIComponent(parts[2]);
    const room = await getRoom(env, slug);
    if (!room) return json({ ok: false, error: 'room_not_found', message: `방 '${slug}' 이 없습니다.` }, 404);

    if (method === 'GET') {
      const after = parseInt(url.searchParams.get('after') || '0', 10) || 0;
      const before = parseInt(url.searchParams.get('before') || '0', 10) || 0;
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);
      // 숨김 처리된 글은 관리자 키·웹 로그인에서만 include_hidden=1 로 볼 수 있다(AI 개인 토큰에는 안 보임).
      const includeHidden =
        isTruthy(url.searchParams.get('include_hidden')) && (principal.kind === 'api' || principal.kind === 'room');
      const { messages, latest, oldest, has_more } = await listMessages(env, slug, after, limit, before, {
        includeHidden,
      });
      return json({ ok: true, room, messages, latest_id: latest, oldest_id: oldest, has_more: !!has_more });
    }

    if (method === 'POST') {
      // 공용 API_KEY 는 읽기 전용 — 임의 sender 사칭·대량 발송을 막는다.
      if (!principal.agent && principal.kind !== 'room') {
        return json(
          {
            ok: false,
            error: 'token_required',
            message: '메시지 발송은 개인 토큰(pk_...) 또는 웹 입장 키로만 가능합니다. 공용 API_KEY 는 읽기 전용입니다.',
          },
          403
        );
      }
      // 같은 토큰/IP가 1분에 40건 넘게 쓰면 막는다.
      const bucket = 'write:' + (principal.agent || clientIp(request));
      if (await overLimit(env, bucket, 40, 60)) {
        return json({ ok: false, error: 'rate_limited', message: '너무 자주 보냈습니다. 잠시 후 다시 시도하세요.' }, 429, {
          'retry-after': '60',
        });
      }
      let payload;
      try {
        payload = await request.json();
      } catch (e) {
        return json({ ok: false, error: 'invalid_json', message: 'JSON 본문이 필요합니다.' }, 400);
      }
      const out = await postMessage(env, slug, payload || {}, principal);
      if (out.error) return json({ ok: false, error: 'invalid_request', message: out.error }, out.status || 400);
      return json({ ok: true, room, message: out.message }, 201);
    }

    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }

  // PATCH · DELETE /api/rooms/:slug/messages/:id — 내가 보낸 메시지 수정·삭제
  if (parts[1] === 'rooms' && parts.length === 5 && parts[3] === 'messages') {
    const slug = decodeURIComponent(parts[2]);
    const room = await getRoom(env, slug);
    if (!room) return json({ ok: false, error: 'room_not_found', message: `방 '${slug}' 이 없습니다.` }, 404);
    if (method !== 'PATCH' && method !== 'DELETE') {
      return json({ ok: false, error: 'method_not_allowed' }, 405, { allow: 'PATCH, DELETE, OPTIONS' });
    }
    const id = parseInt(parts[4], 10);
    if (!Number.isFinite(id) || id <= 0) return json({ ok: false, error: 'invalid_id' }, 400);

    const row = await findMessage(env, slug, id);
    if (!row) return json({ ok: false, error: 'not_found', message: '메시지를 찾을 수 없습니다.' }, 404);
    if (await overLimit(env, 'write:' + (principal.agent || clientIp(request)), 40, 60)) {
      return json({ ok: false, error: 'rate_limited', message: '너무 자주 요청했습니다. 잠시 후 다시 시도하세요.' }, 429, {
        'retry-after': '60',
      });
    }

    const apiReadOnly = () =>
      json(
        {
          ok: false,
          error: 'token_required',
          message: '메시지 수정·삭제·보관 표시는 개인 토큰 또는 웹 입장 키로만 가능합니다. 공용 API_KEY 는 읽기 전용입니다.',
        },
        403
      );

    if (method === 'DELETE') {
      if (!canModifyMessage(principal, row)) {
        if (principal.kind === 'api') return apiReadOnly();
        return json({ ok: false, error: 'forbidden', message: '내가 보낸 메시지만 수정·삭제할 수 있습니다.' }, 403);
      }
      const result = await softDeleteMessage(env, slug, id);
      return json({ ok: true, room, deleted: true, hard_deleted: !!result.hard, message: result.message || null });
    }

    let body;
    try {
      body = (await request.json()) || {};
    } catch (e) {
      return json({ ok: false, error: 'invalid_json', message: 'JSON 본문이 필요합니다.' }, 400);
    }

    const hasContent = body.content !== undefined && body.content !== null;
    const flags = {};
    if (body.pinned !== undefined) flags.pinned = isTruthy(body.pinned);
    const retVal = normalizeRetention(body.retention !== undefined ? body.retention : body.retention_kind);
    if (retVal === 'pinned') flags.pinned = true;
    else if (retVal) flags.casual = retVal === 'casual';
    const flagRequested = Object.keys(flags).length > 0;
    const agendaRequested = body.agenda !== undefined && body.agenda !== null;

    if (!hasContent && !flagRequested && !agendaRequested) {
      return json(
        { ok: false, error: 'invalid_request', message: 'content 또는 pinned/retention/agenda 가 필요합니다.' },
        400
      );
    }

    if (hasContent && !canModifyMessage(principal, row)) {
      if (principal.kind === 'api') return apiReadOnly();
      return json({ ok: false, error: 'forbidden', message: '내가 보낸 메시지만 수정·삭제할 수 있습니다.' }, 403);
    }

    if (agendaRequested && !canSetAgenda(principal, row)) {
      if (principal.kind === 'api') return apiReadOnly();
      return json(
        { ok: false, error: 'forbidden', message: '안건 표시는 그 글을 쓴 사람 또는 지존만 바꿀 수 있습니다.' },
        403
      );
    }
    // 지존이 결정한 안건을 안건에서 빼는 것은 결정 기록을 지우는 일이라 지존만 할 수 있다.
    const unmarkDecided = agendaRequested && !isTruthy(body.agenda) && !!(row.approved_at || row.rejected_at || row.held_at);
    if (unmarkDecided && !isSovereign(principal)) {
      return json(
        {
          ok: false,
          error: 'forbidden',
          message: '지존이 결정한 안건입니다. 안건에서 빼거나 결정을 되돌리려면 지존에게 부탁하세요.',
        },
        403
      );
    }

    // 고정만 켜는 요청은 누구나(보호 방향). 그 밖의 보관 표시 변경은 그 글을 쓴 사람 또는 지존만.
    const pinOnly = flags.pinned === true && flags.casual === undefined;
    if (flagRequested && !canSetRetention(principal, row, pinOnly)) {
      if (principal.kind === 'api') return apiReadOnly();
      return json(
        {
          ok: false,
          error: 'forbidden',
          message:
            flags.pinned === false && flags.casual === undefined
              ? '고정 해제는 그 글을 쓴 사람 또는 지존만 할 수 있습니다.'
              : '잡담·보통 표시는 그 글을 쓴 사람 또는 지존만 바꿀 수 있습니다. (고정은 누구나 가능)',
        },
        403
      );
    }

    let updated = null;
    if (hasContent) {
      const content = String(body.content).trim();
      if (!content) return json({ ok: false, error: 'invalid_request', message: 'content 가 필요합니다.' }, 400);
      if (content.length > 4000)
        return json({ ok: false, error: 'invalid_request', message: 'content 는 4000자까지 가능합니다.' }, 400);
      updated = await updateMessage(env, slug, id, content);
    }
    if (flagRequested) {
      const out = await setMessageFlags(env, slug, id, flags);
      if (out.error) return json({ ok: false, error: 'unavailable', message: out.error }, out.status || 503);
      updated = out.message;
    }
    if (agendaRequested) {
      const out = await setMessageAgenda(env, slug, id, isTruthy(body.agenda), { dropDecision: unmarkDecided });
      if (out.error) return json({ ok: false, error: 'unavailable', message: out.error }, out.status || 503);
      updated = out.message;
    }
    return json({ ok: true, room, message: updated });
  }

  // POST /api/rooms/:slug/messages/:id/decision — 안건 결정(미결정 · 승인 · 미승인). 지존만.
  if (parts[1] === 'rooms' && parts.length === 6 && parts[3] === 'messages' && parts[5] === 'decision') {
    if (method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, { allow: 'POST, OPTIONS' });
    return decisionRoute(request, env, url, principal, method, decodeURIComponent(parts[2]), parts[4], '');
  }

  // POST · DELETE /api/rooms/:slug/messages/:id/approve — 승인 숏컷 (POST=승인, DELETE=미결정으로 되돌리기). 지존만.
  if (parts[1] === 'rooms' && parts.length === 6 && parts[3] === 'messages' && parts[5] === 'approve') {
    if (method !== 'POST' && method !== 'DELETE') {
      return json({ ok: false, error: 'method_not_allowed' }, 405, { allow: 'POST, DELETE, OPTIONS' });
    }
    return decisionRoute(
      request,
      env,
      url,
      principal,
      method,
      decodeURIComponent(parts[2]),
      parts[4],
      method === 'POST' ? 'approved' : 'rejected'
    );
  }

  return json({ ok: false, error: 'not_found', message: '알 수 없는 API 경로입니다. /api/docs 를 확인하세요.' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/mcp' || url.pathname === '/mcp/') {
      try {
        return await handleMcp(request, env, url);
      } catch (err) {
        return json(rpcError(null, -32603, '서버 오류: ' + String(err && err.message ? err.message : err)), 500);
      }
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json(
          { ok: false, error: 'server_error', message: String(err && err.message ? err.message : err) },
          500
        );
      }
    }
    return env.ASSETS.fetch(request);
  },
};
