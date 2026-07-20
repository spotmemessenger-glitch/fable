@echo off
rem ============================================================
rem  JARVIS launcher — double-click to bring JARVIS online.
rem  Starts the server (if not already running) and opens the HUD
rem  in its own app window with audio autoplay enabled, so JARVIS
rem  speaks without needing any click.
rem ============================================================

set PY=C:\Users\yuv\fable\.venv\Scripts\python.exe
set SRC=C:\Users\yuv\fable\jarvis\src
set URL=http://localhost:8770

rem start the server only if port 8770 is not already in use
netstat -ano | findstr /r ":8770 .*LISTENING" >nul 2>&1
if errorlevel 1 (
    start "JARVIS server" /min cmd /c "cd /d %SRC% && %PY% -m jarvis.server"
    timeout /t 3 /nobreak >nul
)

rem open the HUD as an app window with autoplay allowed (Edge, else Chrome)
set EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe
set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe

if exist "%EDGE%" (
    start "" "%EDGE%" --app=%URL% --autoplay-policy=no-user-gesture-required
) else if exist "%CHROME%" (
    start "" "%CHROME%" --app=%URL% --autoplay-policy=no-user-gesture-required
) else (
    start "" %URL%
)
