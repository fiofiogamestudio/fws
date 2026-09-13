@echo off
setlocal
set "FWS_START_PAUSE=1"
for %%A in (%*) do if /I "%%~A"=="--check" set "FWS_START_PAUSE=0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start.ps1" %*
set "FWS_START_EXIT=%ERRORLEVEL%"
if not defined FW_START_NO_PAUSE if not "%FWS_START_EXIT%"=="0" if "%FWS_START_PAUSE%"=="1" pause
if not defined FW_START_NO_PAUSE if "%~1"=="" if "%FWS_START_EXIT%"=="0" pause
endlocal & exit /b %FWS_START_EXIT%
