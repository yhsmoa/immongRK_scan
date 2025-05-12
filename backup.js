const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// MongoDB 연결 문자열
const MONGODB_URI = "mongodb+srv://immongorder1:djajskek1@cluster0.wo05sle.mongodb.net/test?retryWrites=true&w=majority&appName=Cluster0";

// 백업 디렉토리 생성
const backupDir = path.join(__dirname, 'backup');
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir);
}

// 현재 날짜로 백업 파일명 생성
const date = new Date();
const timestamp = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}_${date.getHours().toString().padStart(2, '0')}-${date.getMinutes().toString().padStart(2, '0')}`;

// 모델 불러오기
const Order = require('./models/order');
const ChinaImport = require('./models/chinaImport');

// Inventory 스키마 정의 (server.js에서 복사)
const inventorySchema = new mongoose.Schema({
    skuId: String,
    name: String,
    barcode: String,
    orderStatus: String,
    quantity: { type: String, default: '-' },
    location: { type: String, default: '-' },
    lastUpdate: { type: Date, default: Date.now }
});

// Inventory 모델 등록
const Inventory = mongoose.model('Inventory', inventorySchema);

async function backupData() {
  try {
    console.log('MongoDB Atlas에 연결 중...');
    await mongoose.connect(MONGODB_URI);
    console.log('MongoDB Atlas 연결 성공!');

    // 모든 컬렉션 데이터 가져오기
    console.log('데이터 백업 중...');
    
    // 발주서 데이터 백업
    const orders = await Order.find({});
    if (orders.length > 0) {
      fs.writeFileSync(
        path.join(backupDir, `orders_${timestamp}.json`), 
        JSON.stringify(orders, null, 2)
      );
      console.log(`발주서 ${orders.length}개 백업 완료`);
    }
    
    // 중국입고 데이터 백업
    const chinaImports = await ChinaImport.find({});
    if (chinaImports.length > 0) {
      fs.writeFileSync(
        path.join(backupDir, `chinaImports_${timestamp}.json`), 
        JSON.stringify(chinaImports, null, 2)
      );
      console.log(`중국입고 데이터 ${chinaImports.length}개 백업 완료`);
    }
    
    // 재고 데이터 백업
    const inventory = await Inventory.find({});
    if (inventory.length > 0) {
      fs.writeFileSync(
        path.join(backupDir, `inventory_${timestamp}.json`), 
        JSON.stringify(inventory, null, 2)
      );
      console.log(`재고 데이터 ${inventory.length}개 백업 완료`);
    }
    
    console.log(`모든 데이터 백업 완료! 백업 위치: ${backupDir}`);
    
  } catch (error) {
    console.error('백업 중 오류 발생:', error);
  } finally {
    await mongoose.disconnect();
    console.log('MongoDB 연결 종료');
  }
}

// 백업 실행
backupData(); 