@echo off
REM TCG Forge launcher for Windows.
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
    py -3 launch.py %*
    goto :eof
)

where python >nul 2>nul
if %errorlevel%==0 (
    python launch.py %*
    goto :eof
)

echo Python 3.8+ is required but was not found.
echo Install it from https://www.python.org/downloads/ ^(tick "Add Python to PATH"^)
echo and then run this file again.
pause
