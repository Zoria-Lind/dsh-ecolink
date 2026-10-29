# 解析「应当启动的 ecolink-service server.mjs」——候选顺序与 adapter 的 serviceGuard.js 对齐,
# 保证「登录自启任务拉起的服务」就是「adapter 自动拉起、并且读同一份 config.json 的那一份」。
#
# 2026-10-09 硬化背景:机器上曾有两份 server.mjs 副本(本仓 ../service 与 DSH profile 里
# adapter 包内的 service/),各带各的 config.json(端口取用先到先得)→ token / autoConfirm
# 两份漂移 → 记忆推入静默失败(收割进"待确认队列"、DSH /ecolink-push 401)。
# 收敛为单一副本后,config.json 只有一份,adapter 的 serviceToken:'' 自动读到它,不会再漂移。
#
# 解析顺序(命中即用;可用 -ServerPath 显式覆盖):
#   ① @zoria-lind/dsh-ecolink-service 独立包(独立发布形态)
#   ② DSH profile 里 @zoria-lind/dsh-ecolink-adapter 包内的 service/(npm 安装形态;
#      serviceGuard 的首选,config.json 就在同目录)
#   ③ 本仓 ../service(开发挂载形态 / npm 前形态)
#
# 用法(点源后调用函数,不要直接执行):
#   . "$PSScriptRoot\resolve-service-path.ps1"
#   $serverPath = Resolve-EcolinkServerPath

function Resolve-EcolinkServerPath {
  param([string]$ServerPath = '')

  if ($ServerPath) {
    if (-not (Test-Path $ServerPath)) { throw "指定的 ServerPath 不存在:$ServerPath" }
    return (Resolve-Path $ServerPath).Path
  }

  $profilesRoot = Join-Path $env:USERPROFILE '.dsh\profiles'
  $profiles = @('desktop', 'web', 'headless')
  $cands = @()

  # ① 独立 service 包(profile 内优先,再试 profiles 共享 node_modules)
  foreach ($p in $profiles) {
    $cands += (Join-Path $profilesRoot "$p\node_modules\@zoria-lind\dsh-ecolink-service\server.mjs")
  }
  $cands += (Join-Path $profilesRoot 'node_modules\@zoria-lind\dsh-ecolink-service\server.mjs')

  # ② adapter 包内 service/(serviceGuard 的首选,config.json 同目录)
  foreach ($p in $profiles) {
    $cands += (Join-Path $profilesRoot "$p\node_modules\@zoria-lind\dsh-ecolink-adapter\service\server.mjs")
  }

  # ③ 本仓(开发挂载)
  $cands += (Join-Path $PSScriptRoot '..\service\server.mjs')

  foreach ($c in $cands) {
    if ($c -and (Test-Path $c)) { return (Resolve-Path $c).Path }
  }
  throw "找不到 server.mjs(已试:npm service 包 / adapter 包内 service / 本仓 service)。可以用 -ServerPath 显式指定。"
}
