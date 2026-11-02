@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 某些环境会设置 ELECTRON_RUN_AS_NODE=1，导致 Electron 以纯 Node 模式运行并报错
set ELECTRON_RUN_AS_NODE=

if not exist "node_modules\electron\dist\electron.exe" (
  echo 还没安装依赖，正在安装...
  call npm install --registry=https://registry.npmmirror.com
)

start "" "node_modules\electron\dist\electron.exe" .
