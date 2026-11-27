# 무림AI방 — AI 사용량 보고 스크립트 (지존 PC에서 30분마다 실행, 간격은 usage-setup.ps1 -Minutes)
# Win-CodexBar 의 codexbar-cli 로 Claude·Codex·Gemini·Antigravity 등의 사용량을 읽어
# 무림AI방 /api/usage 로 올린다. 무림AI방 상단 '📊 사용량' 에서 PC·폰 어디서든 본다.
# 키는 usage-setup.ps1 이 이 PC 사용자 계정으로만 풀리게(DPAPI) 암호화해 둔 파일에서 읽는다.

$ErrorActionPreference = 'Stop'
$Base   = 'https://ai-team-room-120.pages.dev'
$Dir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$KeyFile = Join-Path $Dir 'usage-push.key'
$CliCache = Join-Path $Dir 'usage-push.cli'
$ClaudeKeyFile = Join-Path $Dir 'usage-claude.key'
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

function Read-DpapiFile($path) {
  $enc = (Get-Content -Path $path -Raw -Encoding UTF8)
  $enc = $enc.Trim([char]0xFEFF, [char]0x200B, ' ', "`r", "`n", "`t")
  $sec = ConvertTo-SecureString -String $enc
  return [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}

# Claude 는 codexbar-cli 가 브라우저 쿠키를 못 읽는 경우가 있어(웨일 미지원·크롬/엣지 잠금),
# usage-setup.ps1 -ClaudeKey 로 넣어 둔 sessionKey 로 claude.ai 사용량을 직접 읽는다. 키는 claude.ai 로만 보낸다.
function Format-Left($iso) {
  if (-not $iso) { return '' }
  try {
    $t = [DateTimeOffset]::Parse($iso)
    $d = $t - [DateTimeOffset]::Now
    if ($d.TotalMinutes -le 0) { return 'resets now' }
    if ($d.TotalHours -ge 24) { return ('resets in {0}d {1}h' -f [int][Math]::Floor($d.TotalDays), $d.Hours) }
    return ('resets in {0}h {1}m' -f [int][Math]::Floor($d.TotalHours), $d.Minutes)
  } catch { return '' }
}
function Get-ClaudeWebUsage {
  if (-not (Test-Path $ClaudeKeyFile)) { return $null }
  $sk = Read-DpapiFile $ClaudeKeyFile
  if ($sk -notmatch '=') { $sk = 'sessionKey=' + $sk }
  $h = @{
    'Cookie' = $sk
    'User-Agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
    'Accept' = 'application/json'
    'anthropic-client-platform' = 'web_claude_ai'
  }
  $orgs = Invoke-RestMethod -Method Get -Uri 'https://claude.ai/api/organizations' -Headers $h -TimeoutSec 30
  $org = @($orgs) | Where-Object { $_.capabilities -and (($_.capabilities -join ',') -match 'claude_(pro|max)') } | Select-Object -First 1
  if (-not $org) { $org = @($orgs) | Select-Object -First 1 }
  if (-not $org) { throw 'Claude 조직 정보를 못 받았습니다.' }
  $u = Invoke-RestMethod -Method Get -Uri ("https://claude.ai/api/organizations/" + $org.uuid + "/usage") -Headers $h -TimeoutSec 30
  $names = @{ five_hour = 'Session (5h)'; seven_day = 'Weekly'; seven_day_opus = 'Weekly Opus'; seven_day_sonnet = 'Weekly Sonnet' }
  $lines = @('Claude (web)')
  foreach ($p in $u.PSObject.Properties) {
    $v = $p.Value
    if ($v -and ($v.PSObject.Properties.Name -contains 'utilization') -and $v.utilization -ne $null) {
      $label = $names[$p.Name]; if (-not $label) { $label = $p.Name }
      $lines += ('  {0}: {1}% used ({2})' -f $label, [Math]::Round([double]$v.utilization), (Format-Left $v.resets_at))
    }
  }
  if ($lines.Count -eq 1) { $lines += '  (사용량 항목을 찾지 못했습니다)' }
  return ($lines -join "`n")
}

# Claude: CodexBar 트레이 앱이 새로고침할 때마다 적어 두는 기록 파일(DPAPI 암호화)에서 최신 값을 꺼낸다.
# codexbar-cli 는 트레이 앱에 넣은 수동 쿠키를 못 쓰지만, 이 파일은 트레이 앱이 읽은 값 그대로다.
$BurndownFile = Join-Path $env:APPDATA 'CodexBar\history\claude-burndown-v1.json'
function Get-ClaudeTrayUsage {
  if (-not (Test-Path $BurndownFile)) { return $null }
  Add-Type -AssemblyName System.Security
  $o = Get-Content -Path $BurndownFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($o.payload) {
    $b = [Convert]::FromBase64String($o.payload)
    $o = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')) | ConvertFrom-Json
  }
  $lines = @()
  $newest = $null
  foreach ($acc in $o.accounts.PSObject.Properties) {
    foreach ($w in @($acc.Value)) {
      $e = @($w.entries) | Sort-Object { [DateTimeOffset]::Parse($_.captured_at) } | Select-Object -Last 1
      if (-not $e) { continue }
      $label = switch -Regex ($w.name) { '^session' { 'Session (5h)' } '^week' { 'Weekly' } default { if ($w.window_minutes -ge 10000) { 'Weekly' } else { $w.name } } }
      $lines += ('  {0}: {1}% used ({2})' -f $label, [Math]::Round([double]$e.used_percent), (Format-Left $e.resets_at))
      $cap = [DateTimeOffset]::Parse($e.captured_at)
      if (-not $newest -or $cap -gt $newest) { $newest = $cap }
    }
    break  # 계정이 여럿이면 첫 계정만(지금은 하나)
  }
  if (-not $lines.Count) { return $null }
  $age = [int][Math]::Round(([DateTimeOffset]::Now - $newest).TotalMinutes)
  $head = 'Claude (CodexBar)'
  if ($age -gt 30) { $head += ('  · 트레이 앱 기록이 {0}분 전 값입니다(트레이 앱이 꺼져 있으면 갱신 안 됨)' -f $age) }
  return (@($head) + $lines) -join "`n"
}

function Find-Cli {
  # 한 번 찾은 위치는 기억해 두고 다음부터 바로 쓴다(매번 Program Files 를 뒤지지 않게)
  if (Test-Path $CliCache) {
    $cached = (Get-Content -Path $CliCache -Raw -Encoding UTF8).Trim([char]0xFEFF, ' ', "`r", "`n")
    if ($cached -and (Test-Path $cached)) { return $cached }
  }
  $found = Find-CliUncached
  Set-Content -Path $CliCache -Value $found -Encoding UTF8
  return $found
}

function Find-CliUncached {
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
  # 오래된 Windows 의 PowerShell 5.1 은 TLS 1.2 를 기본으로 안 쓰는 경우가 있어 명시한다(Cloudflare 는 1.2 이상만 받음)
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $key = Get-RoomKey
  $cli = Find-Cli

  # codexbar-cli 는 안 쓰는 서비스(Codex 등)에 대해 경고(WARN)를 stderr 로 낸다.
  # Windows PowerShell 5.1 은 Stop 모드에서 그걸 오류로 보고 멈추므로, 이 구간만 Continue 로 두고 stdout 만 쓴다.
  $ErrorActionPreference = 'Continue'
  # -p 를 빼면 CodexBar 설정에서 켠 서비스만 읽는다(86개를 다 돌지 않게)
  $text = (& $cli usage --no-color 2>$null | Out-String)
  $json = $null
  try {
    $raw = (& $cli usage --json 2>$null | Out-String).Trim()
    if ($raw -and ($raw.StartsWith('{') -or $raw.StartsWith('['))) { $json = $raw | ConvertFrom-Json }
  } catch { $json = $null }
  $ErrorActionPreference = 'Stop'
  $text = ($text -replace "\x1B\[[0-9;]*m", '')
  # 혹시 섞여 들어온 로그 줄(2026-..T.. WARN/INFO ...)은 걷어 낸다
  $text = (($text -split "`r?`n") | Where-Object { $_ -notmatch '^\s*\d{4}-\d\d-\d\dT\S+\s+(WARN|INFO|DEBUG|TRACE|ERROR)\b' }) -join "`n"
  $text = $text.Trim()

  # Claude: ① 트레이 앱 기록 파일 → ② (있으면) sessionKey 로 claude.ai 직접. 찾으면 codexbar 의 Claude 오류 덩어리를 바꿔 끼운다
  try {
    $cw = $null
    try { $cw = Get-ClaudeTrayUsage } catch { $cw = $null }
    if (-not $cw) { $cw = Get-ClaudeWebUsage }
    if ($cw) {
      $blocks = @($text -split "`n\s*`n" | Where-Object { $_ -notmatch '^\s*Claude\b' })
      $text = (@($cw) + $blocks) -join "`n`n"
    }
  } catch {
    $text = "Claude (web)  Error: claude.ai 에서 사용량을 못 읽었습니다 — " + $_.Exception.Message + " (sessionKey 가 만료됐으면 usage-setup.ps1 -ClaudeKey 로 다시 넣기)`n`n" + $text
  }
  if (-not $text -and -not $json) { throw "codexbar-cli 가 아무 값도 주지 않았습니다. 트레이 앱에서 Claude 연결 상태를 확인하세요." }

  $body = @{ text = $text; json = $json; host = $env:COMPUTERNAME; tool = 'codexbar-cli' } | ConvertTo-Json -Depth 12 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($body)
  $res = Invoke-RestMethod -Method Post -Uri "$Base/api/usage" -Headers @{ 'X-Room-Key' = $key } -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 30
  Write-Log ("올림 OK · " + $res.created_at)
} catch {
  Write-Log ("실패 · " + $_.Exception.Message + " (줄 " + $_.InvocationInfo.ScriptLineNumber + ")")
  exit 1
}
