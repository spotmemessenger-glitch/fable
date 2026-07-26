@echo off
REM ybot Server Engineer launcher — double-click this after filling in deploy-config.txt.
setlocal enabledelayedexpansion
cd /d "%~dp0"

if not exist "deploy-config.txt" (
  echo deploy-config.txt is missing. It should sit next to this file.
  pause & exit /b 1
)

REM Load KEY=VALUE lines from deploy-config.txt into environment variables (skip # comments).
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("deploy-config.txt") do set "%%A=%%B"

if "%SSH_HOST%"=="" (
  echo Please open deploy-config.txt and fill in SSH_HOST ^(your server's IP^), then save and try again.
  pause & exit /b 1
)

echo Connecting to %SSH_USER%@%SSH_HOST% ...
echo.
python -m ybot.deploy
echo.
echo ============================================================
echo  Done. You can close this window.
pause
