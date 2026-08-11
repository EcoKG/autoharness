#Requires -Version 5.1
<#
.SYNOPSIS
  AutoHarness 설치 / 워치독 등록 / 제거 스크립트 (Windows PowerShell 5.1 호환)

.DESCRIPTION
  기본 실행  : 스킬+엔진을 %USERPROFILE%\.claude\skills\autoharness 로 복사하고
               사용자 스코프 MCP 서버(autoharness)를 등록합니다.
  -V2        : 릴리스에서 단일 실행 파일(v2)을 받아 설치합니다. 파이썬이 필요 없습니다.
  -Watchdog  : 작업 스케줄러에 AutoHarnessWatchdog 작업(기본 15분 간격)을 등록합니다.
  -Uninstall : 스케줄러 작업·MCP 등록·스킬 폴더를 제거합니다(런타임 상태는 보존).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -V2

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Watchdog -IntervalMinutes 15

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$V2,
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
    # 배포 목록은 scripts/deploy_manifest.py 가 정합니다 — 세 설치 경로가 같은 집합을
    # 복사해야 하며, 어긋나면 tests/test_installer_parity.py 가 실패합니다.
    #
    # bin\ 은 **.py 만** 가져갑니다. 종전에는 `bin\*` 를 재귀 복사해 저장소에 실재하는
    # bin\__pycache__ 를 그대로 설치본에 넣었습니다(다른 파이썬 버전의 .pyc 가 사용자
    # 계정에 남습니다). templates\ 도 하위 디렉토리는 부산물이라 파일만 가져갑니다.
    Copy-Item -Path (Join-Path $Src "skill\SKILL.md")   -Destination (Join-Path $Dst "SKILL.md") -Force
    Copy-Item -Path (Join-Path $Src "bin\*.py")         -Destination (Join-Path $Dst "bin") -Force
    Get-ChildItem -Path (Join-Path $Src "templates") -File |
        Copy-Item -Destination (Join-Path $Dst "templates") -Force
    Copy-Item -Path (Join-Path $Src "DESIGN.md")        -Destination $Dst -Force
    Copy-Item -Path (Join-Path $Src "README.md")        -Destination $Dst -Force
    # 설치본에서 -Watchdog / -Uninstall 을 다시 실행할 수 있도록 자기 자신도 복사합니다.
    Copy-Item -Path $PSCommandPath                      -Destination (Join-Path $Dst "install.ps1") -Force
    # install.sh 도 함께 둡니다 — Windows 로 설치한 계정에서 WSL 로 재설치할 때
    # 설치본만 가지고 할 수 있어야 합니다(install.sh 는 양쪽을 다 복사하고 있었습니다).
    $shPath = Join-Path $Src "install.sh"
    if (Test-Path $shPath) { Copy-Item -Path $shPath -Destination (Join-Path $Dst "install.sh") -Force }
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

# ------------------------------------------------------------------ v2 설치
function Install-AutoHarnessV2 {
    <#
      릴리스에서 Windows 바이너리를 받아 설치합니다.

      이 경로가 없던 동안 **릴리스에는 autoharness-windows-x64.exe.gz 가 올라가 있는데
      그것을 설치할 방법이 하나도 없었습니다.** install.sh 는 Git Bash 를 요구하고,
      이 스크립트에는 v2 분기가 아예 없었습니다.

      받은 것은 확인한 뒤에만 설치합니다 — 체크섬 대조 + 실제 실행(version) 확인.
      확인 수단 없이 받은 바이너리를 실행 위치에 놓지 않습니다.
    #>
    $asset = "autoharness-windows-x64.exe"
    $base  = if ($env:AUTOHARNESS_RELEASE_BASE) { $env:AUTOHARNESS_RELEASE_BASE }
             else { "https://github.com/EcoKG/autoharness/releases/latest/download" }

    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ah-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        $gz = Join-Path $tmp ($asset + ".gz")
        Write-Step ("내려받는 중: " + $base + "/" + $asset + ".gz")
        try {
            Invoke-WebRequest -Uri ($base + "/" + $asset + ".gz") -OutFile $gz -UseBasicParsing
        } catch {
            Write-Step "릴리스 산출물을 받지 못했습니다."
            Write-Step "  아직 릴리스가 없다면 소스에서 빌드하십시오: cd daemon; bun run build"
            exit 1
        }

        # 체크섬 — 못 받거나 어긋나면 중단합니다(검증 없이 설치하지 않습니다)
        $sumsPath = Join-Path $tmp "SHA256SUMS"
        try {
            Invoke-WebRequest -Uri ($base + "/SHA256SUMS") -OutFile $sumsPath -UseBasicParsing
        } catch {
            Write-Step "SHA256SUMS 를 받지 못했습니다 — 검증 없이 설치하지 않습니다. 중단합니다."
            exit 1
        }
        # -SimpleMatch 는 패턴을 **문자 그대로** 본다. 여기에 Regex::Escape 를 씌우면
        # `\.` 가 리터럴 백슬래시로 취급돼 영영 매치되지 않는다(실측으로 확인).
        $line = Select-String -Path $sumsPath -Pattern ($asset + ".gz") -SimpleMatch |
                Select-Object -First 1
        if ($null -eq $line) {
            Write-Step ("체크섬 목록에 " + $asset + ".gz 가 없습니다 — 중단합니다.")
            Write-Step ("  받은 목록 첫 줄: " + (Get-Content $sumsPath -TotalCount 1))
            exit 1
        }
        $want = ($line.Line -split "\s+")[0]
        $got  = (Get-FileHash -Path $gz -Algorithm SHA256).Hash.ToLower()
        if ($got -ne $want.ToLower()) {
            Write-Step "체크섬 불일치 — 중단합니다."
            Write-Step ("  기대: " + $want)
            Write-Step ("  실제: " + $got)
            exit 1
        }
        Write-Step "체크섬 확인"

        # gunzip — 5.1 에 gzip 해제 cmdlet 이 없으므로 .NET 스트림으로 푼다
        $exeTmp = Join-Path $tmp "autoharness.exe"
        $in  = [System.IO.File]::OpenRead($gz)
        $out = [System.IO.File]::Create($exeTmp)
        try {
            $gzs = New-Object System.IO.Compression.GzipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
            $gzs.CopyTo($out)
            $gzs.Dispose()
        } finally {
            $out.Dispose(); $in.Dispose()
        }

        # 받은 것이 우리 것인지 동작으로 확인한다
        $probe = Invoke-Native $exeTmp @("version")
        if ($probe.ExitCode -ne 0 -or $probe.Output -notmatch "^\d+\.\d+\.\d+") {
            Write-Step "받은 파일이 실행되지 않습니다 — 중단합니다."
            exit 1
        }
        Write-Step ("버전: " + $probe.Output.Trim())

        $binDir = Join-Path $RuntimeDir "bin"
        New-Item -ItemType Directory -Path $binDir -Force | Out-Null
        $exe = Join-Path $binDir "autoharness.exe"

        # 실행 중이면 덮어쓸 수 없다 — 데몬과 MCP 서버를 함께 내린다
        Get-Process -Name "autoharness" -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Milliseconds 800
        try {
            Copy-Item -Path $exeTmp -Destination $exe -Force
        } catch {
            Write-Step "설치본이 실행 중이라 덮어쓸 수 없습니다. 멈춘 뒤 다시 실행하십시오:"
            Write-Step "  Get-Process autoharness | Stop-Process -Force"
            exit 1
        }
        Write-Step ("설치: " + $exe)

        # 나머지(스킬 배치·MCP 등록·자동 시작)는 EXE 자신이 안다 — 여기서 중복 구현하지 않는다
        $args = @("install", "--exe", $exe)
        $skillSrc = Join-Path $Src "skill"
        if (Test-Path $skillSrc) { $args += @("--skill", $skillSrc) }
        $r = Invoke-Native $exe $args
        Write-Host $r.Output
        if ($r.ExitCode -ne 0) {
            Write-Step "설치 단계에서 문제가 있었습니다 — 위 출력의 steps 를 확인하십시오."
            Write-Step ("확인:  " + $exe + " install --status")
            exit 1
        }

        Write-Step ""
        Write-Step "다음: 새 Claude Code 세션을 열고 대상 저장소에서 /autoharness 로 시작하십시오."
        Write-Step "      (MCP 도구와 스킬은 새로 시작하는 세션부터 보입니다 — 열려 있는 세션은 재시작)"
        Write-Step ""
        Write-Step ("확인:  " + $exe + " install --status")
        Write-Step ("       " + $exe + " selftest")
        Write-Step ("PATH 에 넣지 않아도 전체 경로로 쓸 수 있습니다: " + $exe)
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

# ------------------------------------------------------------------ 분기
if ($Uninstall) {
    Uninstall-AutoHarness
}
elseif ($V2) {
    Install-AutoHarnessV2
}
elseif ($Watchdog) {
    Install-WatchdogTask
}
else {
    Install-AutoHarness
}

exit 0
