# 安装 dsh-ecolink 服务登录自启(隐藏窗口,无 UAC 弹窗)
# 用途:adapter 自动拉起之外的第二保险——不开 DSH、只在网页端用 ecolink 时服务也在。
# 用法:右键"使用 PowerShell 运行",或:
#   powershell -ExecutionPolicy Bypass -File D:\dsh\dsh-plugins\dsh-ecolink\scripts\install-autostart.ps1
# 卸载:uninstall-autostart.ps1

$ErrorActionPreference = 'Stop'
$taskName = 'dsh-ecolink-service'
$serviceDir = Join-Path $PSScriptRoot '..\service'
$serverPath = Join-Path $serviceDir 'server.mjs'
if (-not (Test-Path $serverPath)) { Write-Error "找不到 $serverPath"; exit 1 }
$nodePath = (Get-Command node -ErrorAction Stop).Source
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>dsh-ecolink memory bridge local service (hidden, logon autostart)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$me</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$me</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"$nodePath"</Command>
      <Arguments>"$serverPath"</Arguments>
      <WorkingDirectory>$serviceDir</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
$xmlFile = Join-Path $env:TEMP 'dsh-ecolink-task.xml'
Set-Content -Path $xmlFile -Value $xml -Encoding Unicode
schtasks /Create /TN $taskName /XML $xmlFile /F
if ($LASTEXITCODE -ne 0) { Write-Error "schtasks 创建失败(exit $LASTEXITCODE)"; Remove-Item $xmlFile -ErrorAction SilentlyContinue; exit 1 }
Remove-Item $xmlFile
Write-Host "已安装登录自启任务 [$taskName](登录后自动以隐藏窗口启动,node: $nodePath)"
schtasks /Query /TN $taskName
