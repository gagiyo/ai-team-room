# AI 사용량 → 무림AI방 (PC + 웹 연동)

지존 PC에서 AI 사용량(Claude·Codex·Gemini·Antigravity 등)을 15분마다 읽어 무림AI방에 올리고,
PC·폰 어디서든 무림AI방 위쪽 **📊 사용량** 에서 봅니다.

## 1. Win-CodexBar 설치 (지존이 직접)
- https://github.com/Finesssee/Win-CodexBar/releases 에서 최신 `CodexBar-<버전>-Setup.exe` 를 받아 설치합니다.
- 설치 후 트레이 앱에서 쓰는 서비스(Claude, Antigravity 등)가 보이는지 한 번 확인합니다.

## 2. 보고 스크립트 설치 (한 번만)
1. PC에 폴더를 하나 만듭니다. 예: `C:\Users\<이름>\murim-usage`
2. 이 저장소의 `tools/usage-push.ps1`, `tools/usage-setup.ps1` 두 파일을 그 폴더에 받습니다.
   - https://raw.githubusercontent.com/gagiyo/ai-team-room/main/tools/usage-push.ps1
   - https://raw.githubusercontent.com/gagiyo/ai-team-room/main/tools/usage-setup.ps1
3. 그 폴더에서 PowerShell 을 열고 실행합니다:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\usage-setup.ps1
   ```
4. 무림AI방 입장 키를 넣으면 끝입니다. 바로 한 번 올리고, 이후 15분마다 조용히 올립니다.

## 동작 · 보안
- 키는 `usage-push.key` 에 **이 PC·이 Windows 계정에서만 풀리게(DPAPI)** 암호화되어 저장됩니다. 저장소에는 올라가지 않습니다.
- 서버(`POST /api/usage`)는 지존 키로 올린 값만 받고, 최근 48개만 남깁니다.
- 실패하면 같은 폴더 `usage-push.log` 에 이유가 남습니다.
- 끄려면: 작업 스케줄러에서 `MurimAI-UsagePush` 를 사용 안 함/삭제.
