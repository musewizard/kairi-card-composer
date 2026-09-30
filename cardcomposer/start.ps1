# 启动卡牌效果拼接器（网页版）
#
# 用法：在这个目录下执行
#     powershell -ExecutionPolicy Bypass -File .\start.ps1
# 然后浏览器打开它打印的地址。
#
# 服务端包的位置：
#   - 不传 -Package 时，用上次在界面里选的（存在 .cardcomposer.json）
#   - 都没有就用 server.js 里的默认值
#   - 进去以后也能随时点界面右上角的「当前包」换掉

param(
    [int]$Port = 8788,
    [string]$Package = '',
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "找不到 node，请先安装 node 或把它加进 PATH"
}

Write-Host ""
Write-Host "  卡牌效果拼接器" -ForegroundColor Cyan
Write-Host ""
Write-Host ("  地址：http://127.0.0.1:" + $Port + "   （浏览器会自动打开；关掉这个窗口就是关掉它）") -ForegroundColor Green
Write-Host "  ※ 拼接完点「注入」会直接改包并重签。" -ForegroundColor Yellow
Write-Host "  ※ 服务端在跑的话，改完要重启服务端才生效。" -ForegroundColor Yellow
Write-Host "  ※ 要换服务端包：点界面右上角那个显示当前包的小方块，里面第一个按钮就是系统的文件夹选择框。" -ForegroundColor DarkGray
Write-Host ""

$nodeArgs = @((Join-Path $here 'server.js'), '--port', $Port)
if ($Package -ne '') { $nodeArgs += @('--package', $Package) }

if (-not $NoBrowser) {
    # 等两秒再开浏览器，免得页面比服务端先起来
    $url = 'http://127.0.0.1:' + $Port
    Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -ArgumentList @(
        '/c', 'timeout /t 2 /nobreak >nul & start "" "' + $url + '"'
    ) | Out-Null
}

& node @nodeArgs
