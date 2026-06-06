@echo off
title Upthrust Esports Camera Server
color 0A

echo.
echo  ================================================
echo   UPTHRUST ESPORTS - Camera Server
echo  ================================================
echo.

:: Check if node is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo  [ERROR] Node.js not found. Install from nodejs.org
  pause
  exit /b
)

:: Check if ngrok is installed
where ngrok >nul 2>nul
if %errorlevel% neq 0 (
  echo  [WARNING] ngrok not found in PATH
  echo  Download from: https://ngrok.com/download
  echo  Or: winget install ngrok
  echo.
)

:: Install dependencies if needed
if not exist "node_modules" (
  echo  Installing dependencies...
  call npm install
  echo.
)

:: Start server in background window
echo  Starting Camera Server on port 3000...
start "Camera Server" /min cmd /c "node server.js & pause"

:: Wait for server to start
timeout /t 2 /nobreak >nul

:: Start ngrok in background window
echo  Starting ngrok tunnel...
start "ngrok Tunnel" cmd /c "ngrok http 3000 & pause"

:: Wait for ngrok to start
timeout /t 3 /nobreak >nul

:: Open admin panel in browser
echo  Opening Admin Panel...
start http://localhost:3000/admin.html

:: Open ngrok dashboard to get public URL
start http://127.0.0.1:4040

echo.
echo  ================================================
echo   Server:  http://localhost:3000
echo   Admin:   http://localhost:3000/admin.html
echo   ngrok:   http://127.0.0.1:4040  (get public URL here)
echo  ================================================
echo.
echo  Share the ngrok URL with players instead of localhost
echo.
echo  Press any key to stop everything...
pause >nul

:: Kill server and ngrok
taskkill /f /fi "WINDOWTITLE eq Camera Server*" >nul 2>nul
taskkill /f /fi "WINDOWTITLE eq ngrok Tunnel*"  >nul 2>nul
taskkill /f /im ngrok.exe >nul 2>nul
echo  Stopped.