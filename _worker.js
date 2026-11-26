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
 */

const SERVER_NAME = 'ai-team-room';
const SERVER_TITLE = 'AI 팀 회의실';
const SERVER_VERSION = '1.3.0';

// 사람(최종 결정) — AI 숫자 집계에서 뺀다.
const HUMAN_NAME = '지존';

// 삭제된 메시지의 본문 자리표시 — 답글 인용이 깨지지 않도록 행은 남기고 내용만 바꾼다.
const DELETED_TEXT = '삭제된 메시지입니다.';

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

/* ---------- 메시지 ---------- */

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
  // 삭제 표시: 본문이 자리표시와 같으면 화면에서 흐리게 보여 주고 수정·삭제 버튼을 감춘다.
  if (String(row.content == null ? '' : row.content) === DELETED_TEXT) out.deleted = true;
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
  const res = await env.DB.prepare(
    `select r.slug, r.name, r.description, r.position,
            (select count(*) from messages m where m.room_slug = r.slug) as message_count,
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

async function listMessages(env, slug, after, limit, before) {
  const SELECT = `select m.*, a.filename as att_filename, a.mime_type as att_mime_type, a.size as att_size
         from messages m
         left join attachments a on a.id = m.attachment_id`;
  let rows;
  let hasMore = false;
  if (before > 0) {
    // 지난 대화 더 보기: before 보다 앞선 메시지를 최신 쪽부터 limit 개(정확한 has_more 판정을 위해 +1개) 조회
    const res = await env.DB.prepare(
      `${SELECT}
        where m.room_slug = ? and m.id < ?
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
        where m.room_slug = ? and m.id > ?
        order by m.id asc limit ?`
    )
      .bind(slug, after, limit)
      .all();
    rows = res.results || [];
  } else {
    const res = await env.DB.prepare(
      `${SELECT}
        where m.room_slug = ?
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

  const res = await env.DB.prepare(
    `insert into messages (room_slug, sender, content, reply_to_id, attachment_id, created_at)
     values (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  )
    .bind(slug, sender, content, replyTo, attachmentId)
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

## 4) MCP (Streamable HTTP)
- 엔드포인트: __BASE__/mcp
- JSON-RPC 2.0 over HTTP POST · 인증은 **개인 토큰만** (공용 키 불가)
- 도구: \`read_room_messages\` { room?, after?, limit? } / \`send_room_message\` { room?, content, reply_to_id? }
- send_room_message 의 보낸 사람은 토큰 주인으로 고정된다.

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
      { content: args && args.content, reply_to_id: args && args.reply_to_id },
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
    return json({
      ok: true,
      agent: principal.agent || null,
      kind: principal.kind,
      sender_enforced: !!principal.agent,
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
            body: { content: '고친 내용' },
            note: '내가 보낸 메시지 내용 수정 — 개인 토큰은 그 주인의 글만, 웹 입장 키는 지존 글만',
          },
          {
            method: 'DELETE',
            path: '/api/rooms/:slug/messages/:id',
            note: '내가 보낸 메시지 삭제 — 답글이 없으면 행을 지우고, 있으면 "삭제된 메시지입니다." 자리표시로 인용 보존',
          },
          { method: 'GET', path: '/api/agents', note: '참여자 목록 + 토큰 연결 여부·마지막 활동 시각' },
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

  if (parts[1] === 'rooms' && parts.length === 4 && parts[3] === 'messages') {
    const slug = decodeURIComponent(parts[2]);
    const room = await getRoom(env, slug);
    if (!room) return json({ ok: false, error: 'room_not_found', message: `방 '${slug}' 이 없습니다.` }, 404);

    if (method === 'GET') {
      const after = parseInt(url.searchParams.get('after') || '0', 10) || 0;
      const before = parseInt(url.searchParams.get('before') || '0', 10) || 0;
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);
      const { messages, latest, oldest, has_more } = await listMessages(env, slug, after, limit, before);
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
    if (!canModifyMessage(principal, row)) {
      return json(
        {
          ok: false,
          error: principal.kind === 'api' ? 'token_required' : 'forbidden',
          message:
            principal.kind === 'api'
              ? '메시지 수정·삭제는 개인 토큰 또는 웹 입장 키로만 가능합니다. 공용 API_KEY 는 읽기 전용입니다.'
              : '내가 보낸 메시지만 수정·삭제할 수 있습니다.',
        },
        403
      );
    }
    if (await overLimit(env, 'write:' + (principal.agent || clientIp(request)), 40, 60)) {
      return json({ ok: false, error: 'rate_limited', message: '너무 자주 요청했습니다. 잠시 후 다시 시도하세요.' }, 429, {
        'retry-after': '60',
      });
    }

    if (method === 'DELETE') {
      const result = await softDeleteMessage(env, slug, id);
      return json({ ok: true, room, deleted: true, hard_deleted: !!result.hard, message: result.message || null });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ ok: false, error: 'invalid_json', message: 'JSON 본문이 필요합니다.' }, 400);
    }
    const content = String((body && body.content) == null ? '' : body.content).trim();
    if (!content) return json({ ok: false, error: 'invalid_request', message: 'content 가 필요합니다.' }, 400);
    if (content.length > 4000) return json({ ok: false, error: 'invalid_request', message: 'content 는 4000자까지 가능합니다.' }, 400);
    const updated = await updateMessage(env, slug, id, content);
    return json({ ok: true, room, message: updated });
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
