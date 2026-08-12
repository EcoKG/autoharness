#Requires -Version 5.1
<#
.SYNOPSIS
  AutoHarness 설치 / 제거 스크립트 (Windows PowerShell 5.1 호환)

.DESCRIPTION
  기본 실행  : 릴리스에서 단일 실행 파일을 받아 설치하고, 스킬 자산 배치·MCP 등록은
               그 실행 파일에 맡깁니다. 파이썬이 필요 없습니다.
  -Autostart : 로그온 자동 시작까지 등록합니다.
  -Uninstall : 자동 시작·MCP 등록·스킬 폴더를 제거합니다(런타임 상태는 보존).

  이전 버전(파이썬 엔진·MCP 서버·워치독)의 잔재는 설치·제거할 때 EXE 가 함께 정리합니다
  (묻지 않습니다 — 부를 코드가 없는 파일이라 물어볼 여지가 없습니다).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Autostart

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    # 구현이 하나뿐이라 -V2 는 기본 동작입니다. 문서·스크립트에 이미 퍼져 있어 계속 받습니다.
    [switch]$V2,
    # v1 워치독은 사라졌습니다(데몬이 자기 시계로 돕니다). 오류로 세우지 않고 안내만 합니다.
    [switch]$Watchdog,
    [switch]$Autostart,
    [switch]$Uninstall,
    [int]$IntervalMinutes = 15
)

# 배포 목록은 scripts/deploy_manifest.py 가 정합니다 — 설치 자산은 EXE 가 옮기고
# (daemon/src/install/install.ts), 두 곳이 어긋나면 tests/test_installer_parity.py 가
# 실패합니다. 이 스크립트는 바이너리만 내려놓고 나머지를 EXE 에 맡깁니다.
$ErrorActionPreference = "Stop"

# ------------------------------------------------------------------ 공통 경로
$Src         = $PSScriptRoot
$Dst         = Join-Path $env:USERPROFILE ".claude\skills\autoharness"
$RuntimeDir  = Join-Path $env:USERPROFILE ".claude\autoharness"
$InstalledExe = Join-Path $RuntimeDir "bin\autoharness.exe"

function Write-Step {
    param([string]$Message)
    Write-Host ("[autoharness] " + $Message)
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

# ------------------------------------------------------------------ 제거
#
# 자동 시작 해제·MCP 등록 제거·v1 잔재 정리는 **EXE 가 압니다**(install/cleanup.ts).
# 여기서 다시 구현하면 같은 규칙이 두 언어로 갈라집니다 — 실제로 갈라져 있었습니다:
# 이 스크립트는 옛 워치독 작업 이름만 지우고, v2 가 실제로 등록하는 데몬 작업과
# 시작프로그램 폴더 항목은 그대로 남겼습니다(즉 제거해도 자동 시작이 살아 있었습니다).
function Uninstall-AutoHarness {
    # 1) 자동 시작·MCP·v1 잔재 — EXE 에 맡깁니다
    if (Test-Path $InstalledExe) {
        $r = Invoke-Native $InstalledExe @("install", "--uninstall")
        Write-Host $r.Output
        if ($r.ExitCode -ne 0) {
            Write-Step "제거 단계에서 문제가 있었습니다 — 위 출력의 steps 를 확인하십시오."
        }
    }
    else {
        Write-Step ("설치본 실행 파일이 없습니다(" + $InstalledExe + ") — 스킬 폴더만 정리합니다.")
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
    }

    # 2) 스킬 폴더 제거
    if (Test-Path $Dst) {
        Remove-Item -Path $Dst -Recurse -Force
        Write-Step ("스킬 폴더 제거 완료: " + $Dst)
    }
    else {
        Write-Step ("스킬 폴더가 이미 없습니다: " + $Dst)
    }

    # 3) 런타임 상태는 보존
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
        if ($Autostart) { $args += "--autostart" }
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
if ($Watchdog) {
    Write-Step "-Watchdog 은 더 이상 없습니다 — 데몬이 자기 시계로 돌기 때문입니다."
    Write-Step "  로그온 자동 시작을 원하시면 -Autostart 를 쓰십시오."
}

if ($Uninstall) {
    Uninstall-AutoHarness
}
else {
    # 구현이 하나뿐이라 -V2 는 기본 동작이다. 문서·스크립트에 이미 퍼져 있어 계속 받아들인다.
    Install-AutoHarnessV2
}

exit 0
