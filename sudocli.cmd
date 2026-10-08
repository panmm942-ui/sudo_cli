@echo off
setlocal DisableDelayedExpansion
if exist "%~dp0runtime\node.exe" goto bundled
node "%~dp0bin\sudocli.mjs" %*
exit /b %errorlevel%
:bundled
"%~dp0runtime\node.exe" "%~dp0bin\sudocli.mjs" %*
