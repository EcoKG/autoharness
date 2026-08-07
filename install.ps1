#Requires -Version 5.1
<#
.SYNOPSIS
  AutoHarness 설치 / 워치독 등록 / 제거 스크립트 (Windows PowerShell 5.1 호환)

.DESCRIPTION
  기본 실행  : 스킬+엔진을 %USERPROFILE%\.claude\skills\autoharness 로 복사하고
               사용자 스코프 MCP 서버(autoharness)를 등록합니다.
  -Watchdog  : 작업 스케줄러에 AutoHarnessWatchdog 작업(기본 15분 간격)을 등록합니다.
  -Uninstall : 스케줄러 작업·MCP 등록·스킬 폴더를 제거합니다(런타임 상태는 보존).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Watchdog -IntervalMinutes 15

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$Watchdog,
    [switch]$Uninstall,
    [int]$IntervalMinutes = 15
)

$ErrorActionPreference = "Stop"

# ------------------------------------------------------------------ 공통 경로
$Src         = $PSScriptRoot
$Dst         = Join-Path $env:USERPROFILE ".claude\skills\autoharness"
$RuntimeDir  = Join-Path $env:USERPROFILE ".claude\autoharness"
$RuntimeLogs = Join-Path $RuntimeDir "logs"
$TaskName    = "AutoHarnessWatchdog"

function Write-Step {
    param([string]$Message)
    Write-Host ("[autoharness] " + $Message)
}

function Resolve-PythonExe {
    # 계약(DESIGN.md 12): python 경로는 (Get-Command python).Source 로 해석합니다.
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($null -ne $cmd) { return $cmd.Source }
    return $null
}

function Resolve-ClaudeCli {
    $cmd = Get-Command claude -ErrorAction SilentlyContinue
    if ($null -ne $cmd) { return $cmd.Source }
    $fallback = Join-Path $env:USERPROFILE ".local\bin\claude.exe"
    if (Test-Path $fallback) { return $fallback }
    return $null
}

function Invoke-Native {
    # 네이티브 명령을 EAP=Continue 로 실행해 stderr 출력으로 인한 중단을 막고,
    # 종료 코드와 합쳐진 출력 문자열을 함께 돌려줍니다.
    param([string]$Exe, [string[]]$NativeArgs)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $out = & $Exe @NativeArgs 2>&1
        $text = ($out | Out-String).TrimEnd()
        return @{ ExitCode = $LASTEXITCODE; Output = $text }
    }
    finally {
        $ErrorActionPreference = $prev
    }
}

# ------------------------------------------------------------------ 설치(기본)
function Install-AutoHarness {
    Write-Step ("설치 원본: " + $Src)

    # 0) 원본 구성 검증 — 빠진 파일이 있으면 반쪽 설치를 만들지 않고 중단합니다.
    $required = @(
        (Join-Path $Src "skill\SKILL.md"),
        (Join-Path $Src "bin\harness_engine.py"),
        (Join-Path $Src "bin\harness_mcp.py"),
        (Join-Path $Src "bin\harness_watchdog.py"),
        (Join-Path $Src "templates"),
        (Join-Path $Src "DESIGN.md"),
        (Join-Path $Src "README.md")
    )
    $missing = @()
    foreach ($item in $required) {
        if (-not (Test-Path $item)) { $missing += $item }
    }
    if ($missing.Count -gt 0) {
        Write-Step "다음 원본 파일이 없어 설치를 중단합니다:"
        foreach ($m in $missing) { Write-Host ("  - " + $m) }
        exit 1
    }

    # 1) 기존 설치 백업 (통째로 Move — 잔여 파일이 섞이지 않게 합니다)
    if (Test-Path $Dst) {
        $stamp  = Get-Date -Format "yyyyMMddHHmmss"
        $backup = $Dst + ".bak-" + $stamp
        Move-Item -Path $Dst -Destination $backup -Force
        Write-Step ("기존 설치를 백업했습니다: " + $backup)
    }

    # 2) 파일 복사
    New-Item -ItemType Directory -Force -Path $Dst | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $Dst "bin") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $Dst "templates") | Out-Null
    Copy-Item -Path (Join-Path $Src "skill\SKILL.md") -Destination (Join-Path $Dst "SKILL.md") -Force
    Copy-Item -Path (Join-Path $Src "bin\*")          -Destination (Join-Path $Dst "bin") -Recurse -Force
    Copy-Item -Path (Join-Path $Src "templates\*")    -Destination (Join-Path $Dst "templates") -Recurse -Force
    Copy-Item -Path (Join-Path $Src "DESIGN.md")      -Destination $Dst -Force
    Copy-Item -Path (Join-Path $Src "README.md")      -Destination $Dst -Force
    # 설치본에서 -Watchdog / -Uninstall 을 다시 실행할 수 있도록 자기 자신도 복사합니다.
    Copy-Item -Path $PSCommandPath                    -Destination (Join-Path $Dst "install.ps1") -Force
    Write-Step ("스킬 설치 완료: " + $Dst)

    # 3) 런타임 디렉토리 (registry.json·워치독 로그가 여기 쌓입니다)
    New-Item -ItemType Directory -Force -Path $RuntimeLogs | Out-Null
    Write-Step ("런타임 디렉토리 준비: " + $RuntimeDir)

    # 4) python / claude 해석
    $python = Resolve-PythonExe
    if ($null -eq $python) {
        Write-Step "python 을 PATH 에서 찾지 못했습니다. Python 3.9 설치 또는 PATH 를 확인하십시오."
        exit 1
    }
    Write-Step ("python: " + $python)

    $claude    = Resolve-ClaudeCli
    $mcpScript = Join-Path $Dst "bin\harness_mcp.py"
    $mcpState  = "건너뜀 (claude CLI 미발견 — 수동 등록 필요)"

    # 5) MCP 등록: 기존 등록 제거(실패 무시) 후 새로 추가하고, 목록에서 확인합니다.
    if ($null -ne $claude) {
        Write-Step ("claude CLI: " + $claude)
        try {
            Invoke-Native $claude @("mcp", "remove", "--scope", "user", "autoharness") | Out-Null
        }
        catch {
            # 기존 등록이 없으면 실패하지만 무시합니다.
        }
        $add = Invoke-Native $claude @("mcp", "add", "--scope", "user", "autoharness", "--", $python, $mcpScript)
        if ($add.ExitCode -ne 0) {
            Write-Step "claude mcp add 실패:"
            Write-Host $add.Output
            $mcpState = "실패 — 위 출력을 확인하십시오"
        }
        else {
            $list = Invoke-Native $claude @("mcp", "list")
            $line = $list.Output -split "`r?`n" | Where-Object { $_ -match "autoharness" } | Select-Object -First 1
            if ($null -ne $line) {
                $mcpState = "등록 확인 — " + ([string]$line).Trim()
            }
            else {
                $mcpState = "add 성공, 목록 확인 실패 — 'claude mcp list' 로 직접 확인하십시오"
            }
        }
    }
    Write-Step ("MCP 등록: " + $mcpState)

    # 6) 설치 요약
    $summary = @"

==================================================
 AutoHarness 설치 요약
--------------------------------------------------
 스킬/코드   : $Dst
 런타임 상태 : $RuntimeDir
 python      : $python
 MCP 등록    : $mcpState
--------------------------------------------------
 다음 단계
  1. 새 Claude Code 세션을 열고 /autoharness 로 시작하십시오.
     (MCP 서버는 새 세션부터 로드됩니다)
  2. 워치독 등록(세션 자동 부활):
     powershell -NoProfile -ExecutionPolicy Bypass -File "$PSCommandPath" -Watchdog
==================================================
"@
    Write-Host $summary
}

# ------------------------------------------------------------------ 워치독 등록
function Install-WatchdogTask {
    $watchdogScript = Join-Path $Dst "bin\harness_watchdog.py"
    if (-not (Test-Path $watchdogScript)) {
        Write-Step ("설치본이 없습니다: " + $watchdogScript)
        Write-Step "먼저 install.ps1 을 스위치 없이 실행해 설치를 완료하십시오."
        exit 1
    }
    if ($IntervalMinutes -lt 1) {
        Write-Step "IntervalMinutes 는 1 이상이어야 합니다."
        exit 1
    }

    $python = Resolve-PythonExe
    if ($null -eq $python) {
        Write-Step "python 을 PATH 에서 찾지 못했습니다. Python 3.9 설치 또는 PATH 를 확인하십시오."
        exit 1
    }
    # 콘솔 창이 뜨지 않도록 python 옆의 pythonw.exe 를 우선 사용합니다(없으면 python).
    $pythonw = Join-Path (Split-Path $python -Parent) "pythonw.exe"
    if (-not (Test-Path $pythonw)) { $pythonw = $python }
    Write-Step ("워치독 인터프리터: " + $pythonw)

    # schtasks /TR 은 PowerShell 5.1 의 네이티브 인자 전달에서 내부 따옴표가 소실되어
    # 공백 포함 경로가 조각납니다. ScheduledTasks 모듈 cmdlet 은 실행 파일과 인자를
    # 분리해 받으므로 따옴표 문제가 원천적으로 없습니다.
    try {
        $action  = New-ScheduledTaskAction -Execute $pythonw -Argument ('"{0}"' -f $watchdogScript)
        # [TimeSpan]::MaxValue 는 XML Duration 범위를 벗어나 스케줄러가 거부한다 — 10년으로 충분.
        $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
                     -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
                     -RepetitionDuration (New-TimeSpan -Days 3650)
        $tsettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
                     -ExecutionTimeLimit (New-TimeSpan -Hours 2)
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
            -Settings $tsettings -Description "AutoHarness 워치독 — 자율 주행 세션 자동 부활" -Force | Out-Null
    }
    catch {
        Write-Step ("작업 스케줄러 등록 실패: " + $_.Exception.Message)
        exit 1
    }
    Write-Step ("작업 스케줄러 등록 완료: " + $TaskName + " (" + $IntervalMinutes + "분 간격)")

    # 설치 시각·주기를 레지스트리에 남긴다 — watchdog_status 의 유예 판정 기준이다.
    # 이게 없으면 첫 주기가 오기 전에 '실행 흔적 없음' 경고가 떠 오탐이 된다.
    # 기록 실패가 설치를 깨뜨리면 안 되므로 실패해도 계속 진행한다.
    $mcpScript = Join-Path $Dst "bin\harness_mcp.py"
    if (Test-Path $mcpScript) {
        & $python $mcpScript stamp-watchdog-install --interval-minutes $IntervalMinutes | Out-Null
        if (-not $?) { Write-Step "설치 시각 기록에 실패했습니다 (설치는 정상 — 진단 유예만 영향)" }
    }

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $task) {
        $exec = $task.Actions[0].Execute
        $arg  = $task.Actions[0].Arguments
        Write-Step ("등록 확인: 상태=" + $task.State + " / 실행=" + $exec + " " + $arg)
    }
    else {
        Write-Step "등록 확인에 실패했습니다. 'schtasks /Query /TN AutoHarnessWatchdog' 로 직접 확인하십시오."
    }
    Write-Step ("워치독 로그: " + (Join-Path $RuntimeLogs "watchdog.log"))
}

# ------------------------------------------------------------------ 제거
function Uninstall-AutoHarness {
    # 1) 스케줄러 작업 삭제 (없으면 무시)
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    }
    catch { }
    Write-Step ("작업 스케줄러 작업 삭제 시도: " + $TaskName + " (없으면 무시)")

    # 2) MCP 등록 제거 (없으면 무시)
    $claude = Resolve-ClaudeCli
    if ($null -ne $claude) {
        try {
            Invoke-Native $claude @("mcp", "remove", "--scope", "user", "autoharness") | Out-Null
        }
        catch { }
        Write-Step "MCP 등록 제거 시도: autoharness (없으면 무시)"
    }
    else {
        Write-Step "claude CLI 를 찾지 못해 MCP 제거를 건너뜁니다."
    }

    # 3) 스킬 폴더 제거
    if (Test-Path $Dst) {
        Remove-Item -Path $Dst -Recurse -Force
        Write-Step ("스킬 폴더 제거 완료: " + $Dst)
    }
    else {
        Write-Step ("스킬 폴더가 이미 없습니다: " + $Dst)
    }

    # 4) 런타임 상태는 보존
    Write-Step ("런타임 상태는 보존됩니다: " + $RuntimeDir)
    Write-Step "  (registry.json 과 로그가 남아 있어, 재설치하면 프로젝트 상태가 그대로 이어집니다)"
}

# ------------------------------------------------------------------ 분기
if ($Uninstall) {
    Uninstall-AutoHarness
}
elseif ($Watchdog) {
    Install-WatchdogTask
}
else {
    Install-AutoHarness
}

exit 0
