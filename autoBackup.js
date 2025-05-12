const cron = require('node-cron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('자동 백업 스케줄러가 시작되었습니다.');

// 백업 로그 디렉토리 생성
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

// 매일 오전 3시에 백업 실행 (서버 부하가 적은 시간)
// 크론 표현식: 초 분 시 일 월 요일
cron.schedule('0 0 3 * * *', () => {
  console.log('백업 시작:', new Date().toLocaleString());
  
  // backup.js 스크립트 실행
  const backup = spawn('node', ['backup.js']);
  
  // 로그 파일 생성
  const date = new Date();
  const logFileName = `backup_log_${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}.txt`;
  const logFilePath = path.join(logDir, logFileName);
  const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
  
  // 출력 기록
  backup.stdout.on('data', (data) => {
    const output = data.toString();
    console.log(output);
    logStream.write(`[${new Date().toLocaleString()}] ${output}`);
  });
  
  // 오류 기록
  backup.stderr.on('data', (data) => {
    const error = data.toString();
    console.error(error);
    logStream.write(`[${new Date().toLocaleString()}] ERROR: ${error}`);
  });
  
  // 백업 완료 처리
  backup.on('close', (code) => {
    const message = `백업 프로세스 종료 (코드: ${code})`;
    console.log(message);
    logStream.write(`[${new Date().toLocaleString()}] ${message}\n`);
    logStream.end();
  });
});

// 매주 일요일 오전 4시에 오래된 백업 정리 (2주 이상된 백업 삭제)
cron.schedule('0 0 4 * * 0', () => {
  console.log('오래된 백업 정리 시작:', new Date().toLocaleString());
  
  const backupDir = path.join(__dirname, 'backup');
  const files = fs.readdirSync(backupDir);
  
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  
  let deletedCount = 0;
  
  files.forEach(file => {
    const filePath = path.join(backupDir, file);
    const stats = fs.statSync(filePath);
    
    if (stats.isFile() && stats.mtime < twoWeeksAgo) {
      fs.unlinkSync(filePath);
      deletedCount++;
      console.log(`삭제된 파일: ${file}`);
    }
  });
  
  console.log(`총 ${deletedCount}개의 오래된 백업 파일이 삭제되었습니다.`);
});

// 프로세스가 종료되지 않도록 유지
process.stdin.resume();

console.log('백업 일정이 설정되었습니다:');
console.log('- 매일 오전 3시: 데이터베이스 백업');
console.log('- 매주 일요일 오전 4시: 오래된 백업 파일 정리 (2주 이상)'); 