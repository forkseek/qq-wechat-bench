# Download only pinned, reviewed versions into this workbench; no system Python changes.
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$dataRoot = Join-Path $taskRoot 'data'
$research = Join-Path $dataRoot 'research'
$pythonRoot = Join-Path $dataRoot 'wechat\python-3.12'
$pythonFile = Join-Path $pythonRoot 'tools\python.exe'
$packageFile = Join-Path $research 'python.3.12.10.nupkg'
$sdkRoot = Join-Path $research 'wechat-replica'
$sdkCommit = '62503d76a0db069171cb4e42e87090ad285db489'
New-Item -ItemType Directory -Force -Path $research | Out-Null
if (-not (Test-Path -LiteralPath $pythonFile)) {
    if (-not (Test-Path -LiteralPath $packageFile)) {
        Invoke-WebRequest -Uri 'https://www.nuget.org/api/v2/package/python/3.12.10' -OutFile $packageFile
    }
    if ((Get-FileHash -LiteralPath $packageFile -Algorithm SHA256).Hash -ne '0EB85C2DFCCCCF1B17352DE4C397F69194035B7D37149EACC16F1147D93DE3B8') { throw 'Python 包校验不一致，停止安装' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($packageFile, $pythonRoot)
}
if (-not (Test-Path -LiteralPath $sdkRoot)) {
    git clone --no-checkout 'https://github.com/fanyuantaier/wechatauto-replica.git' $sdkRoot
    if ($LASTEXITCODE -ne 0) { throw '微信 SDK 下载失败' }
    git -C $sdkRoot checkout --detach $sdkCommit
    if ($LASTEXITCODE -ne 0) { throw '微信 SDK 固定提交不可用' }
}
$actualCommit = (& git -C $sdkRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $sdkCommit) { throw 'SDK 版本与已审查提交不同，不覆盖现有源码' }
$cache = Join-Path $dataRoot 'package-cache\pip'
& $pythonFile -m pip install --cache-dir $cache --disable-pip-version-check -r (Join-Path $taskRoot 'requirements-wechat.txt')
if ($LASTEXITCODE -ne 0) { throw '微信依赖安装失败' }
& $pythonFile -m pip install --cache-dir $cache --disable-pip-version-check --no-deps $sdkRoot
if ($LASTEXITCODE -ne 0) { throw '微信 SDK 安装失败' }
Write-Host '微信组件就绪。正常登录电脑微信后，工作台将自动识别账号。'
