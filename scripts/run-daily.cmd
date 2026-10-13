@echo off
rem Daily run for Windows Task Scheduler. Output is appended to data\run.log.
cd /d "%~dp0.."
if not exist data mkdir data
echo. >> data\run.log
echo ===== %date% %time% ===== >> data\run.log
"C:\Program Files\nodejs\node.exe" src\index.js --once >> data\run.log 2>&1
