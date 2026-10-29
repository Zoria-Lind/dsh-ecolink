# 安装 dsh-ecolink 服务登录自启(隐藏窗口,无 UAC 弹窗)
# 用途:adapter 自动拉起之外的第二保险——不开 DSH、只在网页端用 ecolink 时服务也在。
# 用法:右键"使用 PowerShell 运行",或:
#   powershell -ExecutionPolicy Bypass -File D:\dsh\dsh-plugins\dsh-ecolink\scripts\install-autostart.ps1
# 可加 -ServerPath <server.mjs 路径> 强制指定要跑哪一份。
# 卸载:uninstall-autostart.ps1
#
# 2026-10-09 硬化:任务必须跑「adapter 的 serviceGuard 会拉起的那一份 server.mjs」——
# 两份副本各带各的 config.json(端口先到先得)→ token/autoConfirm 漂移 → 记忆推入静默失败。
# 解析顺序见 scripts/resolve-service-path.ps1(与 serviceGuard.js 的候选顺序一致)。

param([string]$ServerPath = '')

$ErrorActionPreference = 'Stop'
$taskName = 'dsh-ecolink-service'
. "$PSScriptRoot\resolve-service-path.ps1"
$serverPath = Resolve-EcolinkServerPath -ServerPath $ServerPath
$serviceDir = Split-Path $serverPath -Parent
$nodePath = (Get-Command node -ErrorAction Stop).Source
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

# 用 Register-ScheduledTask 建任务:与原 XML 等价(隐藏窗口、无 UAC、登录触发、
# IgnoreNew、无执行时限)。改用 cmdlet 而非 XML 文本块,避免静态引号检查把
# here-string 的终止行误判成未闭合字符串。
$action = New-ScheduledTaskAction -Execute $nodePath -Argument ('"' + $serverPath + '"') -WorkingDirectory $serviceDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'dsh-ecolink memory bridge local service (hidden, logon autostart)' -Force | Out-Null
Write-Host "已安装登录自启任务 [$taskName](登录后自动以隐藏窗口启动)"
Write-Host "  node:   $nodePath"
Write-Host "  server: $serverPath"
schtasks /Query /TN $taskName
