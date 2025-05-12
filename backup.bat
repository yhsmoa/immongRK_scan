@echo off
cd /d D:\python\coupangRocket
node backup.js
echo 백업 완료: %date% %time% >> backup_log.txt 