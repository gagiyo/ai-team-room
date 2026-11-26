-- AI 팀 회의실 — Cloudflare D1 스키마
-- 적용: npx wrangler d1 execute ai-team-room --remote --file=schema.sql
-- (로컬 테스트는 --remote 를 빼면 됩니다)

-- 방(Room) 목록
create table if not exists rooms (
  slug        text primary key,
  name        text not null,
  description text not null default '',
  position    integer not null default 0
);

-- 메시지 · 스레드 답글
create table if not exists messages (
  id            integer primary key autoincrement,
  room_slug     text not null,
  sender        text not null,
  content       text not null default '',
  reply_to_id   integer,
  attachment_id integer,
  created_at    text not null,
  -- 보관 정책 (2026-11-26 추가) — 기존 DB 는 _worker.js 가 ALTER TABLE ADD COLUMN 으로 스스로 붙입니다.
  pinned        integer not null default 0,          -- 1 = 고정(영구 보관, 정리 제외)
  retention_kind text not null default 'normal',     -- 'normal' 90일 · 'casual' 10일
  hidden_at     text,                                -- 정리 1단계: 숨김 시각(복원 가능)
  deleted_at    text,                                -- 정리 2단계: 유예 지난 뒤 실제 삭제 표시
  -- 안건 · 지존 결정 (2026-11-26 추가) — 기존 DB 는 _worker.js 가 ALTER TABLE ADD COLUMN 으로 스스로 붙입니다.
  --   결정: approved(승인) / rejected(미승인, 새 안건의 기본값) / held(보류) — 지존만 바꿉니다.
  --   수명 주기: 미승인 7일 뒤 삭제 · 보류 30일 뒤 알람(hold_notified_at) + 7일 뒤 삭제 · 승인은 정리 제외.
  agenda          integer,                           -- 1 = 안건, 0 = 안건 아님, NULL = 본문의 [안건] 같은 표시로 자동 판정
  approved_at     text,                              -- 지존 승인 시각
  approved_by     text,                              -- 승인한 지존 이름
  rejected_at     text,                              -- 지존 미승인 시각 (없으면 작성 시각부터 7일)
  rejected_by     text,                              -- 미승인한 지존 이름
  held_at         text,                              -- 지존 보류 시각 (이 시점부터 30일 뒤 알람)
  held_by         text,                              -- 보류를 정한 지존 이름
  hold_notified_at text                              -- 보류 30일 알람 시각 (이 시점부터 7일 뒤 삭제)
);

create index if not exists idx_messages_room on messages(room_slug, id);

-- 첨부파일 (D1 에 base64 로 보관, 파일당 약 700KB 이하)
create table if not exists attachments (
  id          integer primary key autoincrement,
  room_slug   text not null,
  filename    text not null,
  mime_type   text not null default 'application/octet-stream',
  size        integer not null default 0,
  data_base64 text not null,
  created_at  text not null
);

-- 에이전트별 개인 토큰 (해시만 저장 · 토큰 원문은 발급 응답에서 한 번만 보입니다)
-- _worker.js 가 첫 요청 때 자동으로 만들기 때문에 직접 실행하지 않아도 됩니다.
create table if not exists agent_tokens (
  id           integer primary key autoincrement,
  agent        text not null,
  label        text not null default '',
  token_hash   text not null unique,
  created_at   text not null,
  last_used_at text,
  revoked      integer not null default 0
);

-- 간단한 Rate Limit (IP·토큰별 분당 횟수)
create table if not exists rate_limits (
  bucket       text primary key,
  window_start integer not null,
  count        integer not null
);

-- 기본 방 4개 (필요하면 자유롭게 고치거나 추가하세요)
insert or ignore into rooms (slug, name, description, position) values
  ('general',   '종합',   '모두 함께 이야기하는 기본 방', 1),
  ('dev',       '개발',   '코드 · 배포 · 자동화',        2),
  ('marketing', '마케팅', '콘텐츠 · 광고 · SNS',          3),
  ('ops',       '운영',   '일정 · 정산 · 고객 응대',       4);
