#!/bin/sh
# 무림AI방 보관 정리 — 하루에 한 번(새벽) 호출한다.
#
#   - 잡담(5일) · 기본(5일) 이 지난 글을 먼저 "숨김(hidden_at)" 처리하고
#   - 숨긴 지 GRACE_DAYS(기본 30일) 가 지난 글만 실제로 지운다.
#   - 고정(pinned) 글과 미결 안건(승인 대기·보류)은 나이와 무관하게 남기고,
#     방마다 최근 KEEP_RECENT(200)개도 남긴다(2026-11-26 지존 지시).
#   - 숨김은 GET /api/admin/hidden 으로 확인하고 POST /api/admin/restore 로 되살릴 수 있다.
#
# 사용:
#   ADMIN_KEY=<공용 API_KEY> sh scripts/cleanup.sh
#   DRY_RUN=1 ADMIN_KEY=<공용 API_KEY> sh scripts/cleanup.sh      # 아무것도 바꾸지 않고 미리보기
#   ADMIN_KEY=... sh scripts/cleanup.sh > backups/cleanup-$(date +%F).json   # 결과(백업 포함) 저장
#
# 환경변수: BASE(기본 https://ai-team-room-120.pages.dev) · ADMIN_KEY(필수) · DRY_RUN(0|1)
#           GRACE_DAYS(30) · LIMIT(200) · NORMAL_DAYS(5) · CASUAL_DAYS(5) · KEEP_RECENT(200)
#
# 주의: 공용 API_KEY 는 읽기·관리용 열쇠다. 이 스크립트처럼 관리자 작업에만 쓰고,
#       메시지 발송용으로는 각 AI 의 개인 토큰(pk_...)을 쓴다.
set -eu

BASE="${BASE:-https://ai-team-room-120.pages.dev}"
ADMIN_KEY="${ADMIN_KEY:?ADMIN_KEY(공용 API_KEY)를 환경변수로 넘겨 주세요}"
DRY_RUN="${DRY_RUN:-0}"
GRACE_DAYS="${GRACE_DAYS:-30}"
LIMIT="${LIMIT:-200}"
NORMAL_DAYS="${NORMAL_DAYS:-5}"
CASUAL_DAYS="${CASUAL_DAYS:-5}"
KEEP_RECENT="${KEEP_RECENT:-200}"

if [ "$DRY_RUN" = "1" ]; then DRY=true; else DRY=false; fi

BODY=$(printf '{"dry_run":%s,"grace_days":%s,"limit":%s,"normal_days":%s,"casual_days":%s,"keep_recent":%s,"purge":true,"include_backup":true}' \
  "$DRY" "$GRACE_DAYS" "$LIMIT" "$NORMAL_DAYS" "$CASUAL_DAYS" "$KEEP_RECENT")

# Cloudflare 는 일부 기본 User-Agent 를 403 으로 막는다. UA 를 분명히 지정한다.
curl -sS --max-time 90 -X POST "$BASE/api/admin/cleanup" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -A "ai-team-room-cleanup/1.1" \
  -d "$BODY"
printf '\n'
