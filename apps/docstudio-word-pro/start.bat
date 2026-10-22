@echo off
title DocStudio Word Pro - Open-Source Office
echo =====================================================
echo    DocStudio Word Pro - Open-Source Office Suite    
echo =====================================================
echo [*] Starting DocStudio Office Application...

where python >nul 2>nul
if %errorlevel% equ 0 (
    echo [*] Starting local conversion engine...
    start /b python converter_server.py
)

echo [*] Opening in your default web browser...
start http://localhost:5173
npx vite --port 5173
pause
