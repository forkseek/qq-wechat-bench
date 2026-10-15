$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
# 只返回进程身份，不输出可能含有账号或登录参数的命令行。
$entries = @(Get-CimInstance Win32_Process -Filter "Name = 'QQ.exe' OR Name = 'NapCatWinBootMain.exe'")
$result = @($entries | ForEach-Object {
    [pscustomobject]@{
        pid = [long]$_.ProcessId
        parentPid = [long]$_.ParentProcessId
        name = $_.Name
        file = $_.ExecutablePath
        createdAt = $_.CreationDate.ToUniversalTime().ToString('o')
        auxiliary = ($_.CommandLine -match '--type(?:=|\s)|--crashpad-handler')
    }
})
ConvertTo-Json -InputObject $result -Compress
