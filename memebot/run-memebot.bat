@echo off
REM One-click launcher for the Solana meme-coin bot (paper mode by default).
REM Uses the existing cryptobot venv, which already has httpx / solana / solders.
cd /d C:\Users\yuv\fable
"C:\Users\yuv\fable\cryptobot\.venv\Scripts\python.exe" -m memebot.run
echo.
echo (bot stopped) - press any key to close this window.
pause >nul
