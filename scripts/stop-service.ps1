# 停掉 ecolink-service(无论谁拉起的:adapter 自动拉起 / 登录自启任务 / 手动 node)
# 注意:adapter 会在下一轮 DSH 请求时自动补起(pre-step 节流 60s),想彻底停用请同时
# 把 adapter 配置的 serviceAutoStart 设为 false 或卸载自启任务。
# 用法:powershell -ExecutionPolicy Bypass -File D:\dsh\dsh-plugins\dsh-ecolink\scripts\stop-service.ps1

$ErrorActionPreference = 'Stop'
$serviceDir = Join-Path $PSScriptRoot '..\service'
$configFile = Join-Path $serviceDir 'config.json'
$port = 17520
if (Test-Path $configFile) {
  try { $port = (Get-Content $configFile -Encoding UTF8 | ConvertFrom-Json).port } catch { }
}
$pids = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique
if (-not $pids) { Write-Host "服务未在运行(端口 $port 无监听)"; exit 0 }
foreach ($pid_ in $pids) {
  Stop-Process -Id $pid_ -Force
  Write-Host "已停止 PID $pid_(端口 $port)"
}
