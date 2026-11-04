@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   智库 - 网页版（本地）
echo ========================================
echo.

set NODE_EXE=node
where node >nul 2>nul
if errorlevel 1 (
  if exist "D:\Harness\_tools\node\node.exe" (
    set NODE_EXE=D:\Harness\_tools\node\node.exe
  ) else (
    echo 找不到 Node.js，请先安装 Node.js 18 以上版本
    pause
    exit /b 1
  )
)

start "" /min cmd /c "%NODE_EXE% server.js 8788"
timeout /t 2 >nul
start "" "http://127.0.0.1:8788/"

echo 浏览器已打开： http://127.0.0.1:8788/
echo 关闭服务：关掉那个最小化的命令行窗口即可。
echo.
pause
