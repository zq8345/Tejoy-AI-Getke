# 杀干净本项目的本地 dev 进程。
#
# ⚠️ 为什么需要这个脚本（这是一次真事故的机制）：
#   `pkill -f "wrangler dev"` 只杀 node 父进程，**workerd 子进程一个都不死**，
#   而且它**继续占着 8788**。于是新起的进程绑不上端口，我的 curl 全打在
#   **几十分钟前启动的老进程**上 —— 老进程内存里是**启动那一刻**的 .dev.vars。
#   我洗掉了 .dev.vars 里 Joe 的真群地址，然后测试，结果打在老进程上 →
#   **又推了一次 Joe 的真飞书群**。洗配置这个动作对老进程完全无效。
#
#   结论：**改完 .dev.vars 必须杀干净重起**，热重载不可信（实测 whoami 仍返回旧值）。
#   而且杀完要**验残留**，不能杀完就假定干净。
#
# 只杀命令行里带「获客」的，绝不误伤别的窗口的 dev server。

$pat = '获客'
Get-CimInstance Win32_Process -Filter "Name='workerd.exe'" -EA SilentlyContinue |
  Where-Object { $_.CommandLine -match $pat } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
  Where-Object { $_.CommandLine -match 'wrangler' -and $_.CommandLine -match $pat } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
Start-Sleep -Seconds 3

# 验残留 —— 杀完就假定干净是另一种"我以为"
$left = @(Get-CimInstance Win32_Process -Filter "Name='workerd.exe'" -EA SilentlyContinue |
          Where-Object { $_.CommandLine -match $pat }).Count
$port = @(Get-NetTCPConnection -LocalPort 8788 -State Listen -EA SilentlyContinue).Count
if ($left -gt 0 -or $port -gt 0) {
  Write-Error "❌ 没杀干净：残留 workerd=$left，8788 上仍有 $port 个 LISTENING。别继续测，你会打在老进程上。"
  exit 1
}
Write-Output "✅ 已杀干净：workerd 残留 0，8788 空闲"
