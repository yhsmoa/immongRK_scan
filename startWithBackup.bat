@echo off
cd /d D:\python\coupangRocket

echo 서버 시작 전 백업을 진행합니다...
node backup.js

echo 백업 완료. 서버를 시작합니다...
node server.js 