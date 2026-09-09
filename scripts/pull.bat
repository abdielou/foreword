@echo off
REM Updates this checkout to the latest commit on the extension's branch.
cd /d "%~dp0.."
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%b
echo Branch: %BRANCH%
git pull --ff-only origin %BRANCH%
for /f "delims=" %%h in ('git rev-parse --short HEAD') do set HASH=%%h
echo.
echo Now at %HASH%
echo Reload Author Lens on chrome://extensions, then check the options page shows commit %HASH%.
pause
