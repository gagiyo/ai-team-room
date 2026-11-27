# AI 사용량 → 무림AI방 (PC + 웹 연동)

지존 PC에서 AI 사용량(Claude·Codex·Gemini·Antigravity 등)을 30분마다(바꿀 수 있음) 읽어 무림AI방에 올리고,
PC·폰 어디서든 무림AI방 위쪽 **📊 사용량** 에서 봅니다.

## 1. Win-CodexBar 설치 (지존이 직접)
- https://github.com/Finesssee/Win-CodexBar/releases 에서 최신 `CodexBar-<버전>-Setup.exe` 를 받아 설치합니다.
- 설치 후 트레이 앱에서 쓰는 서비스(Claude, Antigravity 등)가 보이는지 한 번 확인합니다.

## 2. 보고 스크립트 설치 (한 번만)
1. PC에 폴더를 하나 만듭니다. 예: `C:\Users\<이름>\murim-usage`
2. 이 저장소의 `tools/usage-push.ps1`, `tools/usage-push.vbs`, `tools/usage-setup.ps1` 세 파일을 그 폴더에 받습니다.
   - https://raw.githubusercontent.com/gagiyo/ai-team-room/main/tools/usage-push.ps1
   - https://raw.githubusercontent.com/gagiyo/ai-team-room/main/tools/usage-push.vbs
   - https://raw.githubusercontent.com/gagiyo/ai-team-room/main/tools/usage-setup.ps1
3. 그 폴더에서 PowerShell 을 열고 실행합니다:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\usage-setup.ps1
   ```
4. 무림AI방 입장 키를 넣으면 끝입니다. 바로 한 번 올리고, 이후 30분마다 창 없이 조용히 올립니다.

## Claude 가 'No cookies available' 로 나올 때
codexbar-cli 는 브라우저(크롬·엣지·브레이브·파이어폭스) 쿠키만 읽고, 트레이 앱에 직접 넣은 쿠키는 쓰지 못합니다.
웨일을 쓰거나 브라우저가 쿠키를 잠가 두면 Claude 가 오류로 나옵니다. 그때는 sessionKey 를 스크립트에 한 번 넣습니다:
```powershell
powershell -ExecutionPolicy Bypass -File .\usage-setup.ps1 -ClaudeKey
```
- sessionKey 는 `usage-claude.key` 에 이 PC·이 계정에서만 풀리게(DPAPI) 저장되고, **claude.ai 로만** 보냅니다(무림방에는 사용률 숫자만).
- 만료되면 📊 사용량에 'claude.ai 에서 사용량을 못 읽었습니다'가 뜹니다. 같은 명령으로 새 값을 넣으면 됩니다.

## 간격 바꾸기 · 업데이트
- 간격 바꾸기: `powershell -ExecutionPolicy Bypass -File .\usage-setup.ps1 -Minutes 60` (키는 다시 묻지 않음)
- 키 바꾸기: `... usage-setup.ps1 -NewKey`
- 스크립트를 새로 받은 뒤에도 `usage-setup.ps1` 을 한 번 실행하면 작업이 새 방식으로 다시 등록됩니다.

## 동작 · 보안
- 키는 `usage-push.key` 에 **이 PC·이 Windows 계정에서만 풀리게(DPAPI)** 암호화되어 저장됩니다. 저장소에는 올라가지 않습니다.
- 서버(`POST /api/usage`)는 지존 키로 올린 값만 받고, 최근 48개만 남깁니다.
- 실패하면 같은 폴더 `usage-push.log` 에 이유가 남습니다.
- 끄려면: 작업 스케줄러에서 `MurimAI-UsagePush` 를 사용 안 함/삭제.
