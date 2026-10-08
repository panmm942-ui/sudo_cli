@echo off
setlocal DisableDelayedExpansion
if exist "%~dp0runtime\node.exe" goto bundled
node "%~dp0scripts\setup.mjs" %*
exit /b %errorlevel%
:bundled
"%~dp0runtime\node.exe" "%~dp0scripts\setup.mjs" %*
