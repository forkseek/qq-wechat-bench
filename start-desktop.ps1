param([switch]$Widget, [switch]$Background, [switch]$Quit)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$appRoot = $PSScriptRoot
for ($hop = 0; $hop -lt 8; $hop++) {
    $info = Get-Item -LiteralPath $appRoot -Force
    if ($info.LinkType -notin @('Junction', 'SymbolicLink')) { break }
    $target = [string](@($info.Target)[0])
    if (-not [IO.Path]::IsPathRooted($target)) {
        $target = Join-Path ([IO.Path]::GetDirectoryName($appRoot)) $target
    }
    $appRoot = [IO.Path]::GetFullPath($target)
}

$pythonw = Join-Path $appRoot 'data\wechat\python-3.12\tools\pythonw.exe'
$python = Join-Path $appRoot 'data\wechat\python-3.12\tools\python.exe'
$desktopScript = Join-Path $appRoot 'desktop_app.py'

if (-not (Test-Path -LiteralPath $desktopScript)) {
    throw '未找到桌面程序入口 desktop_app.py。'
}

$argsList = @($desktopScript)
if ($Widget) { $argsList += '--widget' }
if ($Background) { $argsList += '--background' }
if ($Quit) { $argsList += '--quit' }

if (Test-Path -LiteralPath $pythonw) {
    Start-Process -FilePath $pythonw -ArgumentList $argsList -WorkingDirectory $appRoot -WindowStyle Hidden
} elseif (Test-Path -LiteralPath $python) {
    Start-Process -FilePath $python -ArgumentList $argsList -WorkingDirectory $appRoot -WindowStyle Hidden
} else {
    # 若独立 Python 尚未准备，回退到浏览器版启动脚本
    & (Join-Path $appRoot 'start.ps1')
}
