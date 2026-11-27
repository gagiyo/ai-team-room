# 무림AI방 — AI 사용량 보고 설치 (한 번만 실행)
# 1) 무림AI방 입장 키를 이 PC 사용자 계정에서만 풀리게 암호화해 저장
# 2) N분마다(기본 30) usage-push.ps1 을 창 없이 실행하는 Windows 작업 스케줄러 작업 등록
# 3) 바로 한 번 올려 보고 결과를 보여 줌

param(
  [int]$Minutes = 30,      # 보고 간격(분)
  [switch]$NewKey          # 키를 새로 넣고 싶을 때만
)
$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Vbs = Join-Path $Dir 'usage-push.vbs'
$KeyFile = Join-Path $Dir 'usage-push.key'
$Push = Join-Path $Dir 'usage-push.ps1'
if (-not (Test-Path $Push)) { throw "같은 폴더에 usage-push.ps1 이 있어야 합니다." }

if ($NewKey -or -not (Test-Path $KeyFile)) {
  Write-Host ""
  Write-Host "[1/3] 무림AI방 입장 키를 붙여 넣고 Enter (입력한 글자는 화면에 안 보이는 게 정상입니다)" -ForegroundColor Yellow
  $sec = Read-Host -AsSecureString -Prompt "입장 키"
  $sec | ConvertFrom-SecureString | Set-Content -Path $KeyFile -Encoding ASCII -NoNewline
  Write-Host "키를 저장했습니다 (이 PC·이 계정에서만 풀림)."
} else {
  Write-Host "[1/3] 저장된 키를 그대로 씁니다. (바꾸려면 -NewKey 를 붙여 실행)"
}

$TaskName = 'MurimAI-UsagePush'
# 콘솔 창이 잠깐씩 번쩍이지 않게 wscript + usage-push.vbs 로 숨겨서 돌린다(vbs 가 없으면 powershell 직접)
if (Test-Path $Vbs) {
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ("`"" + $Vbs + "`"")
} else {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ("-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"" + $Push + "`"")
}
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $Minutes)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "무림AI방 AI 사용량 보고 ($Minutes 분마다)" -Force | Out-Null
Write-Host "[2/3] 작업 스케줄러에 '$TaskName' 을(를) 등록했습니다 ($Minutes 분마다, 창 안 뜸)."


Write-Host "[3/3] 지금 한 번 올려 봅니다..."
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Push
Get-Content -Path (Join-Path $Dir 'usage-push.log') -Tail 1 -Encoding UTF8
Write-Host "끝. 무림AI방 위쪽 '📊 사용량' 을 눌러 확인하세요."
