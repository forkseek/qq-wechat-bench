param([switch]$NoBrowser, [switch]$Stop)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$appRoot = $PSScriptRoot
$runtimeDir = Join-Path $appRoot 'data'
$pidFile = Join-Path $runtimeDir 'runtime.pid'
$serverFile = Join-Path $appRoot 'server.mjs'
$envFile = Join-Path $appRoot '.env'
. (Join-Path $appRoot 'scripts\runtime-config.ps1')

if ($Stop) {
    if (Test-Path -LiteralPath $pidFile) {
        $runtimeProcessId = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
        $runtimeProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $runtimeProcessId" -ErrorAction SilentlyContinue
        if ($runtimeProcess -and $runtimeProcess.Name -eq 'node.exe' -and $runtimeProcess.CommandLine.Contains($serverFile)) {
            $shutdownAccepted = $false
            try {
                $runtime = Get-WorkbenchRuntime -Root $appRoot
                $health = Invoke-RestMethod -Uri ($runtime.url + '/api/health') -TimeoutSec 3
                if ($health.pid -ne $runtimeProcessId -or $health.app -ne $runtime.app) { throw '当前端口不是本工作台进程。' }
                $web = New-Object Microsoft.PowerShell.Commands.WebRequestSession
                Invoke-WebRequest -Uri $runtime.url -WebSession $web -UseBasicParsing -TimeoutSec 3 | Out-Null
                $reply = Invoke-RestMethod -Uri ($runtime.url + '/api/shutdown') -Method Post -Headers @{Origin=$runtime.url} -WebSession $web -ContentType 'application/json' -Body '{}' -TimeoutSec 3
                $shutdownAccepted = ($reply.ok -eq $true)
            } catch {}
            if ($shutdownAccepted) {
                for ($attempt = 0; $attempt -lt 20; $attempt++) {
                    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $runtimeProcessId" -ErrorAction SilentlyContinue
                    if (-not $current -or $current.CreationDate -ne $runtimeProcess.CreationDate) { break }
                    Start-Sleep -Milliseconds 250
                }
                if ($current -and $current.CreationDate -eq $runtimeProcess.CreationDate) { Write-Host '已请求安全关闭，正在等待当前操作完成。'; exit }
            } else {
                # 兼容没有安全关闭接口的旧版；仅终止已核对身份的工作台进程。
                $current = Get-CimInstance Win32_Process -Filter "ProcessId = $runtimeProcessId" -ErrorAction SilentlyContinue
                if ($current -and $current.CreationDate -eq $runtimeProcess.CreationDate -and $current.CommandLine.Contains($serverFile)) {
                    $result = Invoke-CimMethod -InputObject $current -MethodName Terminate -Arguments @{Reason=[uint32]0}
                    if ($result.ReturnValue -ne 0) { throw "工作台停止失败（系统代码 $($result.ReturnValue)）。" }
                }
                for ($attempt = 0; $attempt -lt 8; $attempt++) {
                    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $runtimeProcessId" -ErrorAction SilentlyContinue
                    if (-not $current -or $current.CreationDate -ne $runtimeProcess.CreationDate) { break }
                    Start-Sleep -Milliseconds 250
                }
                if ($current -and $current.CreationDate -eq $runtimeProcess.CreationDate) { throw '工作台进程尚未退出，没有报告停止成功。' }
            }
            Write-Host '工作台已停止，本机数据已保留。'
        } else { Write-Host '工作台进程已结束。' }
    } else { Write-Host '没有发现此启动器启动的工作台。' }
    exit
}

$runtime = Get-WorkbenchRuntime -Root $appRoot
$appPort = $runtime.port
$appUrl = $runtime.url
try { $health = Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 2 } catch { $health = $null }
if ($health -and $health.app -ne $runtime.app) { throw "端口 $appPort 已被其他服务占用。请在 .env 中修改 PORT。" }
if (-not $health) {
    if (Test-Path -LiteralPath $pidFile) {
        $existingId = 0
        [void][int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$existingId)
        $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $existingId" -ErrorAction SilentlyContinue
        if ($existing -and $existing.Name -eq 'node.exe' -and $existing.CommandLine.Contains($serverFile)) { throw '工作台仍在运行，但当前端口没有响应。请先关闭工作台再重新打开。' }
    }
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw '请先安装 Node.js 24 或更高版本。' }
    $nodeMajor = [int]((& $nodeCommand.Source --version).TrimStart('v').Split('.')[0])
    if ($nodeMajor -lt 24) { throw '请先将 Node.js 升级到 24 或更高版本。' }
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    $arguments = @('--env-file-if-exists="' + $envFile + '"', '"' + $serverFile + '"')
    $runtimeProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList $arguments -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDir 'runtime.log') -RedirectStandardError (Join-Path $runtimeDir 'runtime-error.log')
    Set-Content -LiteralPath $pidFile -Value $runtimeProcess.Id -Encoding ascii
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 250
        try { $health = Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 1 } catch { $health = $null }
        if ($health -and $health.app -eq $runtime.app) { break }
    }
    if (-not $health -or $health.app -ne $runtime.app) { throw '启动未完成，请查看 data\runtime-error.log。' }
}
Write-Host "工作台已就绪：$appUrl"
if (-not $NoBrowser) { Start-Process $appUrl }
