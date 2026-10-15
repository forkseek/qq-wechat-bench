param([switch]$Stop, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$runtimeDir = Join-Path $PSScriptRoot 'data\napcat'
$launcherFile = Join-Path $runtimeDir 'shell\NapCatWinBootMain.exe'
$pidFile = Join-Path $runtimeDir 'launcher.pid'
# 存在这个文件时，工作台会保持 QQ 采集运行（掉线或退出后自动拉起）。
$keepRunningFile = Join-Path $runtimeDir 'keep-running'
if ($Stop) {
    # 先关闭自动拉起，再结束进程，避免刚停止又被工作台拉起。
    Remove-Item -LiteralPath $keepRunningFile -Force -ErrorAction SilentlyContinue
    $bridgeProcessId = 0
    $launchedAt = $null
    if (Test-Path -LiteralPath $pidFile) {
        [void][int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$bridgeProcessId)
        $launchedAt = (Get-Item -LiteralPath $pidFile).LastWriteTime
    }
    $processes = @(Get-CimInstance Win32_Process)
    $launchers = @($processes | Where-Object { $_.Name -eq 'NapCatWinBootMain.exe' -and $_.ExecutablePath -eq $launcherFile })
    $qqFile = if ($env:QQ_EXECUTABLE) { $env:QQ_EXECUTABLE } else { 'C:\Program Files\Tencent\QQNT\QQ.exe' }
    $ownedIds = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($launcher in $launchers) { [void]$ownedIds.Add([int]$launcher.ProcessId) }
    $recordedProcess = $processes | Where-Object { $_.ProcessId -eq $bridgeProcessId }
    # 只在记录的 PID 已经退出时采用时间窗口推断。PID 被其他进程复用时不能认领它的子进程。
    if (-not $recordedProcess -and $bridgeProcessId -gt 0) {
        foreach ($entry in $processes) {
            if ($entry.Name -eq 'QQ.exe' -and $entry.ExecutablePath -eq $qqFile -and $entry.ParentProcessId -eq $bridgeProcessId -and $entry.CreationDate -ge $launchedAt.AddSeconds(-5) -and $entry.CreationDate -le $launchedAt.AddMinutes(1)) { [void]$ownedIds.Add([int]$entry.ProcessId) }
        }
    }
    do {
        $added = $false
        foreach ($entry in $processes) {
            if ($entry.Name -ne 'QQ.exe' -or $entry.ExecutablePath -ne $qqFile -or -not $ownedIds.Contains([int]$entry.ParentProcessId)) { continue }
            $parentEntry = $processes | Where-Object { $_.ProcessId -eq $entry.ParentProcessId } | Select-Object -First 1
            if (-not $parentEntry -or $entry.CreationDate -lt $parentEntry.CreationDate) { continue }
            if ($ownedIds.Add([int]$entry.ProcessId)) { $added = $true }
        }
    } while ($added)
    if ($ownedIds.Count -eq 0) { Write-Host '采集进程已结束，没有停止其他 QQ 进程。'; exit }
    foreach ($ownedId in $ownedIds) {
        $original = $processes | Where-Object { $_.ProcessId -eq $ownedId } | Select-Object -First 1
        $current = Get-CimInstance Win32_Process -Filter "ProcessId = $ownedId" -ErrorAction SilentlyContinue
        if (-not $current -or $current.ExecutablePath -ne $original.ExecutablePath -or $current.CreationDate -ne $original.CreationDate) { continue }
        # 部分 QQ 实例在普通进程命令中不可见。用同一 WMI 快照终止，并核对返回值。
        $result = Invoke-CimMethod -InputObject $current -MethodName Terminate -Arguments @{Reason=[uint32]0}
        if ($result.ReturnValue -ne 0) {
            $stillRunning = Get-CimInstance Win32_Process -Filter "ProcessId = $ownedId" -ErrorAction SilentlyContinue
            if ($stillRunning -and $stillRunning.CreationDate -eq $original.CreationDate) { throw "QQ 采集进程 $ownedId 结束失败（系统代码 $($result.ReturnValue)），未停止桌面 QQ。" }
        }
    }
    for ($attempt = 0; $attempt -lt 8; $attempt++) {
        $remaining = @(Get-CimInstance Win32_Process -Filter "Name = 'QQ.exe' OR Name = 'NapCatWinBootMain.exe'" | Where-Object {
            $candidate = $_
            $original = $processes | Where-Object { $_.ProcessId -eq $candidate.ProcessId } | Select-Object -First 1
            $ownedIds.Contains([int]$candidate.ProcessId) -and $original -and $candidate.ExecutablePath -eq $original.ExecutablePath -and $candidate.CreationDate -eq $original.CreationDate
        })
        if ($remaining.Count -eq 0) { break }
        Start-Sleep -Milliseconds 250
    }
    if ($remaining.Count -gt 0) { throw 'QQ 采集进程尚未完全退出，请查看登录状态，停止操作未报告成功。' }
    Write-Host 'QQ 采集已停止，本机消息数据已保留。'
    exit
}
& (Join-Path $PSScriptRoot 'start.ps1') -NoBrowser
. (Join-Path $PSScriptRoot 'scripts\runtime-config.ps1')
$runtime = Get-WorkbenchRuntime -Root $PSScriptRoot
$appUrl = $runtime.url
$web = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-WebRequest -Uri "$appUrl/qq-login" -WebSession $web -UseBasicParsing | Out-Null
try { $result = Invoke-RestMethod -Uri "$appUrl/api/qq/start" -Method Post -Headers @{Origin=$appUrl} -ContentType 'application/json' -Body '{}' -WebSession $web }
catch {
    $failure = $_
    $message = 'QQ 采集未能开启，请打开工作台查看登录状态。'
    # Windows PowerShell 5.1 不一定填入 ErrorDetails；从响应流读取 UTF-8 错误正文。
    try {
        $bodyText = $failure.ErrorDetails.Message
        if (-not $bodyText -and $failure.Exception.Response) {
            $reader = [System.IO.StreamReader]::new($failure.Exception.Response.GetResponseStream(), [System.Text.Encoding]::UTF8)
            try { $bodyText = $reader.ReadToEnd() } finally { $reader.Dispose() }
        }
        $details = $bodyText | ConvertFrom-Json
        if ($details.error) { $message = $details.error }
    } catch {}
    throw $message
}
Write-Host $(if ($result.online) { 'QQ 采集已在线。' } else { 'QQ 采集已开启，需要扫码时请在登录页面中确认。' })
if (-not $NoBrowser) { Start-Process "$appUrl/qq-login" }
