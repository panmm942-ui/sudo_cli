@echo off
if /i "%1"=="cli" goto cli
echo Usage: .\sudo cli [options]
exit /b 1
:cli
if exist "%~dp0runtime\node.exe" goto bundled
node "%~dp0bin\sudo-cli.mjs" %*
exit /b %errorlevel%
:bundled
"%~dp0runtime\node.exe" "%~dp0bin\sudo-cli.mjs" %*
