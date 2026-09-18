@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js, then run this setup again.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  where py >nul 2>nul
  if not errorlevel 1 (
    py -3 -m venv ".venv"
  ) else (
    python -m venv ".venv"
  )
  if errorlevel 1 goto :failed
)

".venv\Scripts\python.exe" -m pip install --requirement "requirements.txt"
if errorlevel 1 goto :failed

node "chrome-helper\sync-extension-assets.js"
if errorlevel 1 goto :failed

node "chrome-helper\install.js"
if errorlevel 1 goto :failed

echo.
echo Setup complete. In chrome://extensions:
echo   Remove the three older job-assistant extensions. Your local data is preserved.
echo   Choose Load unpacked and select: extension
echo Then refresh job and application tabs already open.
pause
exit /b 0

:failed
echo.
echo Setup did not complete. Review the message above and try again.
pause
exit /b 1
