# 手动启动 ecolink-service(隐藏窗口;若已在运行则什么都不做)
# 日常不需要这个:DSH 的 adapter 会自动拉起,登录自启任务也会兜底。此脚本供调试用。
# 用法:powershell -ExecutionPolicy Bypass -File <仓库目录>\scripts\start-service.ps1
#
# 2026-10-09 硬化:启动哪一份 server.mjs 由 resolve-service-path.ps1 决定(与 adapter 的
# serviceGuard 候选顺序一致)——手动启动也必须跟自启任务/adapter 拉起的是同一份,
# 否则两份副本的 config.json 会漂移。

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\resolve-service-path.ps1"
$serverPath = Resolve-EcolinkServerPath
$serviceDir = Split-Path $serverPath -Parent
$configFile = Join-Path $serviceDir 'config.json'
$port = 17520
if (Test-Path $configFile) {
  try { $port = (Get-Content $configFile -Encoding UTF8 | ConvertFrom-Json).port } catch { }
}
if (-not $port) { $port = 17520 }
$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) { Write-Host "服务已在运行(端口 $port,PID $($listening.OwningProcess -join ','))"; exit 0 }
$nodePath = (Get-Command node -ErrorAction Stop).Source
Start-Process -FilePath $nodePath -ArgumentList 'server.mjs' -WorkingDirectory $serviceDir -WindowStyle Hidden
Write-Host "已隐藏窗口启动 ecolink-service(端口 $port)"
Write-Host "  server: $serverPath"
