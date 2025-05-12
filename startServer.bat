@echo off
cd /d D:\python\coupangRocket

:: 백업 스케줄러 시작
start node autoBackup.js

:: 서버 시작
node server.js 