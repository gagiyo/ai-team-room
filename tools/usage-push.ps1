# 무림AI방 — AI 사용량 보고 스크립트 (지존 PC에서 15분마다 실행)
# Win-CodexBar 의 codexbar-cli 로 Claude·Codex·Gemini·Antigravity 등의 사용량을 읽어
# 무림AI방 /api/usage 로 올린다. 무림AI방 상단 '📊 사용량' 에서 PC·폰 어디서든 본다.
# 키는 usage-setup.ps1 이 이 PC 사용자 계정으로만 풀리게(DPAPI) 암호화해 둔 파일에서 읽는다.

$ErrorActionPreference = 'Stop'
$Base   = 'https://ai-team-room-120.pages.dev'
$Dir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$KeyFile = Join-Path $Dir 'usage-push.key'
$LogFile = Join-Path $Dir 'usage-push.log'

function Write-Log($msg) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $msg
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
  # 로그는 최근 200줄만
  $all = Get-Content -Path $LogFile -Encoding UTF8 -ErrorAction SilentlyContinue
  if ($all -and $all.Count -gt 200) { $all | Select-Object -Last 200 | Set-Content -Path $LogFile -Encoding UTF8 }
}

function Get-RoomKey {
  if ($env:MURIM_ROOM_KEY) { return $env:MURIM_ROOM_KEY }
  if (-not (Test-Path $KeyFile)) { throw "키 파일이 없습니다. usage-setup.ps1 을 먼저 실행하세요." }
  # Windows PowerShell 5.1 의 UTF8 저장은 BOM·줄바꿈이 붙으므로 걷어 내고 푼다
  $enc = (Get-Content -Path $KeyFile -Raw -Encoding UTF8)
  $enc = $enc.Trim([char]0xFEFF, [char]0x200B, ' ', "`r", "`n", "`t")
  $sec = ConvertTo-SecureString -String $enc
  return [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}

function Find-Cli {
  $cmd = Get-Command codexbar-cli -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $cands = @(
    (Join-Path $Dir 'codexbar-cli.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\CodexBar\codexbar-cli.exe'),
    (Join-Path $env:LOCALAPPDATA 'CodexBar\codexbar-cli.exe'),
    (Join-Path $env:ProgramFiles 'CodexBar\codexbar-cli.exe')
  )
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  $hit = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Programs'), $env:ProgramFiles -Filter 'codexbar-cli.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { return $hit.FullName }
  throw "codexbar-cli.exe 를 찾지 못했습니다. Win-CodexBar 를 설치했는지 확인하세요."
}

try {
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  $key = Get-RoomKey
  $cli = Find-Cli

  # codexbar-cli 는 안 쓰는 서비스(Codex 등)에 대해 경고(WARN)를 stderr 로 낸다.
  # Windows PowerShell 5.1 은 Stop 모드에서 그걸 오류로 보고 멈추므로, 이 구간만 Continue 로 두고 stdout 만 쓴다.
  $ErrorActionPreference = 'Continue'
  $text = (& $cli usage -p all 2>$null | Out-String)
  $json = $null
  try {
    $raw = (& $cli usage -p all --json 2>$null | Out-String).Trim()
    if ($raw -and ($raw.StartsWith('{') -or $raw.StartsWith('['))) { $json = $raw | ConvertFrom-Json }
  } catch { $json = $null }
  $ErrorActionPreference = 'Stop'
  # 혹시 섞여 들어온 로그 줄(2026-..T.. WARN/INFO ...)은 걷어 낸다
  $text = (($text -split "`r?`n") | Where-Object { $_ -notmatch '^\s*\d{4}-\d\d-\d\dT\S+\s+(WARN|INFO|DEBUG|TRACE|ERROR)\b' }) -join "`n"
  $text = $text.Trim()
  if (-not $text -and -not $json) { throw "codexbar-cli 가 아무 값도 주지 않았습니다. 트레이 앱에서 Claude 연결 상태를 확인하세요." }

  $body = @{ text = $text; json = $json; host = $env:COMPUTERNAME; tool = 'codexbar-cli' } | ConvertTo-Json -Depth 12 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($body)
  $res = Invoke-RestMethod -Method Post -Uri "$Base/api/usage" -Headers @{ 'X-Room-Key' = $key } -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 30
  Write-Log ("올림 OK · " + $res.created_at)
} catch {
  Write-Log ("실패 · " + $_.Exception.Message + " (줄 " + $_.InvocationInfo.ScriptLineNumber + ")")
  exit 1
}
