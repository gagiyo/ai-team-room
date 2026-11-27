# 무림AI방 — AI 사용량 보고 설치 (한 번만 실행)
# 1) 무림AI방 입장 키를 이 PC 사용자 계정에서만 풀리게 암호화해 저장
# 2) 15분마다 usage-push.ps1 을 조용히 실행하는 Windows 작업 스케줄러 작업 등록
# 3) 바로 한 번 올려 보고 결과를 보여 줌

$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Push = Join-Path $Dir 'usage-push.ps1'
if (-not (Test-Path $Push)) { throw "같은 폴더에 usage-push.ps1 이 있어야 합니다." }

Write-Host "무림AI방 입장 키를 입력하세요 (화면에 보이지 않습니다):"
$sec = Read-Host -AsSecureString
$sec | ConvertFrom-SecureString | Set-Content -Path (Join-Path $Dir 'usage-push.key') -Encoding UTF8
Write-Host "키를 저장했습니다 (이 PC·이 계정에서만 풀림)."

$TaskName = 'MurimAI-UsagePush'
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ("-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"" + $Push + "`"")
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description '무림AI방 AI 사용량 보고 (15분마다)' -Force | Out-Null
Write-Host "작업 스케줄러에 '$TaskName' 을(를) 등록했습니다 (15분마다)."

Write-Host "지금 한 번 올려 봅니다..."
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Push
Get-Content -Path (Join-Path $Dir 'usage-push.log') -Tail 1 -Encoding UTF8
Write-Host "끝. 무림AI방 위쪽 '📊 사용량' 을 눌러 확인하세요."
