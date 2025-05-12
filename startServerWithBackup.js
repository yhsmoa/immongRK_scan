const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// 로그 파일 준비
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

const date = new Date();
const logName = `server_${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}.log`;
const logPath = path.join(logDir, logName);
const logStream = fs.createWriteStream(logPath, { flags: 'a' });

// 콘솔 출력을 로그에도 기록
const log = (message) => {
  const timestamp = new Date().toLocaleString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(message);
  logStream.write(logMessage + '\n');
};

// 백업 실행
log('서버 시작 전 MongoDB 백업을 실행합니다...');

try {
  // 백업 스크립트 동기적으로 실행
  execSync('node backup.js', { stdio: 'inherit' });
  log('백업이 완료되었습니다.');
} catch (error) {
  log(`백업 중 오류가 발생했습니다: ${error.message}`);
  // 백업에 실패해도 서버는 시작
  log('백업 실패, 서버를 시작합니다.');
}

// 서버 시작
log('서버를 시작합니다...');
const server = spawn('node', ['server.js'], { stdio: 'inherit' });

// 서버 종료 처리
server.on('close', (code) => {
  log(`서버가 종료되었습니다. 종료 코드: ${code}`);
  logStream.end();
});

// 프로세스 종료 시그널 처리
process.on('SIGINT', () => {
  log('SIGINT 시그널을 받았습니다. 서버를 종료합니다.');
  server.kill('SIGINT');
});

process.on('SIGTERM', () => {
  log('SIGTERM 시그널을 받았습니다. 서버를 종료합니다.');
  server.kill('SIGTERM');
}); 