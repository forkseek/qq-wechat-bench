function Get-WorkbenchRuntime {
    param([Parameter(Mandatory=$true)][string]$Root)
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw '请先安装 Node.js 24 或更高版本。' }
    $versionText = (& $nodeCommand.Source --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) { throw '请先将 Node.js 升级到 24 或更高版本。' }
    $runtimeText = & $nodeCommand.Source (Join-Path $Root 'scripts\runtime-config.mjs')
    if ($LASTEXITCODE -ne 0) { throw '程序配置无效，请检查 config\workbench.json 和 PORT 设置。' }
    return ($runtimeText | ConvertFrom-Json)
}
