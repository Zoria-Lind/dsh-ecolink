# 卸载 dsh-ecolink 登录自启任务(不杀当前正在运行的服务,只管计划任务)
# 用法:powershell -ExecutionPolicy Bypass -File D:\dsh\dsh-plugins\dsh-ecolink\scripts\uninstall-autostart.ps1

$ErrorActionPreference = 'Continue'
$taskName = 'dsh-ecolink-service'
schtasks /Delete /TN $taskName /F
if ($LASTEXITCODE -eq 0) { Write-Host "已删除自启任务 [$taskName]" }
else { Write-Host "任务不存在或已删除,无需操作(exit $LASTEXITCODE)" }
