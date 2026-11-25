@echo off
echo ============================================
echo   Uploading CORE site to GitHub...
echo ============================================
echo.
cd /d D:\buddywork\2026-11-23-10-28-49\core-trader
set GITEXE=D:\buddywork\WorkBuddy\resources\vendor\PortableGit\mingw64\bin\git.exe
"%GITEXE%" push -u origin main
echo.
echo ============================================
echo   If you see errors above, take a screenshot
echo   and send it to me. Otherwise it is done.
echo ============================================
pause
