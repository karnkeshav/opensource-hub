@echo off
title DocStudio Word Pro - Ultra-Light Native Office
setlocal

set "APP_FILE=%~dp0DocStudio-Word-Pro.html"
if not exist "%APP_FILE%" set "APP_FILE=%~dp0dist\index.html"

:: Replace backslashes with slashes for file:// URL
set "URL_PATH=%APP_FILE:\=/%"

echo =========================================================
echo   Starting DocStudio Word Pro (Native Engine)
echo   One 3.7 MB file  ^|  Offline  ^|  No account  ^|  No install
echo =========================================================

:: 1. Check 64-bit Program Files Edge
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app="file:///%URL_PATH%" --window-size=1300,880
    exit /b
)

:: 2. Check standard Program Files Edge
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
    start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" --app="file:///%URL_PATH%" --window-size=1300,880
    exit /b
)

:: 3. Check Local AppData Edge
if exist "%LocalAppData%\Microsoft\Edge\Application\msedge.exe" (
    start "" "%LocalAppData%\Microsoft\Edge\Application\msedge.exe" --app="file:///%URL_PATH%" --window-size=1300,880
    exit /b
)

:: 4. Try msedge from system PATH
where msedge.exe >nul 2>&1
if %ERRORLEVEL% equ 0 (
    start "" msedge.exe --app="file:///%URL_PATH%" --window-size=1300,880
    exit /b
)

:: 5. Universal fallback: open directly in system default browser
start "" "%APP_FILE%"
exit /b
