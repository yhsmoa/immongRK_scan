require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const Order = require('./models/order');
const upload = require('./middleware/upload');
const XlsxPopulate = require('xlsx-populate');
const fs = require('fs');
const ChinaImport = require('./models/chinaImport');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = 3001;

// MongoDB Atlas 연결
mongoose.connect(process.env.MONGODB_URI)
.then(() => console.log('MongoDB Atlas 연결 성공'))
.catch(err => console.error('MongoDB Atlas 연결 실패:', err));

app.use(express.static(__dirname));
app.use(express.static(__dirname + '/public'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ✅ 이 부분이 꼭 있어야 /rocket 페이지가 열림!
app.get('/rocket', (req, res) => {
  res.sendFile(path.join(__dirname, 'rocket.html'));
});

// ✅ 스캔 페이지 라우트 추가
app.get('/scan', (req, res) => {
  res.sendFile(path.join(__dirname, 'scan.html'));
});

// ✅ 쉽먼트 페이지 라우트 추가
app.get('/shipment', (req, res) => {
  res.sendFile(path.join(__dirname, 'shipment.html'));
});

app.get('/header', (req, res) => {
    res.sendFile(path.join(__dirname, 'header.html'));
});

// 발주서 목록 가져오기
app.get('/api/orders', async (req, res) => {
    try {
        const orders = await Order.find().sort({ 입고예정일: 1, 물류센터: 1, 발주번호: 1 });
        
        // 각 발주서에 대해 중복 바코드 제거 처리
        const processedOrders = orders.map(order => {
            const orderObj = order.toObject();
            
            // 쉽먼트 페이지에서 호출된 경우 박스정보가 있는 상품만 반환
            const referer = req.headers.referer || '';
            if (referer.includes('/shipment')) {
                // 박스정보가 있는 상품만 필터링
                orderObj.상품정보 = orderObj.상품정보.filter(product => 
                    product.박스정보 && product.박스정보 !== 'undefined' && product.스캔수량 > 0
                );
                return orderObj;
            }
            
            // 다른 페이지에서 호출된 경우 중복 제거된 데이터 제공
            // 중복 바코드 제거 및 스캔 수량 합산
            const uniqueProducts = [];
            const processedBarcodes = new Set();
            
            // 원본 상품 항목 먼저 추가 (박스정보 없는 항목)
            orderObj.상품정보.filter(p => !p.박스정보).forEach(product => {
                uniqueProducts.push({
                    ...product,
                    입고1: product.입고1 || '-',
                    입고2: product.입고2 || '-'
                });
                processedBarcodes.add(product.상품바코드);
            });
            
            // 첫 번째 순회에서 처리하지 않은 상품 확인 (원본이 없는 경우)
            orderObj.상품정보.forEach(product => {
                if (!processedBarcodes.has(product.상품바코드)) {
                    // 이 바코드에 대한 원본 상품이 없는 경우, 박스정보를 제거하고 추가
                    const newProduct = {...product};
                    delete newProduct.박스정보;
                    uniqueProducts.push({
                        ...newProduct,
                        입고1: newProduct.입고1 || '-',
                        입고2: newProduct.입고2 || '-'
                    });
                    processedBarcodes.add(product.상품바코드);
                }
            });
            
            // 응답에서 중복 제거된 상품 정보로 교체
            orderObj.상품정보 = uniqueProducts;
            
            return orderObj;
        });
        
        res.json(processedOrders);
    } catch (error) {
        console.error('발주서 목록 조회 중 오류 발생:', error);
        res.status(500).json({ error: '발주서 목록을 불러오는데 실패했습니다.' });
    }
});

// 발주서 상세 조회 API
app.get('/api/orders/:orderNumber', async (req, res) => {
    try {
        const orderNumber = req.params.orderNumber;
        const order = await Order.findOne({ 발주번호: orderNumber });
        
        if (!order) {
            return res.status(404).json({ error: '발주서를 찾을 수 없습니다.' });
        }
        
        // 발주서 데이터 복사
        const responseOrder = JSON.parse(JSON.stringify(order));
        
        // 쉽먼트 페이지에서 호출된 경우
        const referer = req.headers.referer || '';
        if (referer.includes('/shipment')) {
            // 박스정보가 있는 스캔된 상품만 반환
            responseOrder.상품정보 = responseOrder.상품정보.filter(product => 
                product.박스정보 && product.박스정보 !== '-' && product.스캔수량 > 0
            );
            return res.json(responseOrder);
        }
        
        // 다른 페이지에서 호출된 경우 중복 제거된 데이터 제공
        const uniqueProducts = [];
        const processedBarcodes = new Set();
        
        // 원본 상품 항목 먼저 추가 (박스정보 없는 항목)
        responseOrder.상품정보.filter(p => !p.박스정보).forEach(product => {
            uniqueProducts.push(product);
            processedBarcodes.add(product.상품바코드);
        });
        
        // 첫 번째 순회에서 처리하지 않은 상품 확인 (원본이 없는 경우)
        responseOrder.상품정보.forEach(product => {
            if (!processedBarcodes.has(product.상품바코드)) {
                // 이 바코드에 대한 원본 상품이 없는 경우, 박스정보를 제거하고 추가
                const newProduct = {...product};
                delete newProduct.박스정보;
                uniqueProducts.push(newProduct);
                processedBarcodes.add(product.상품바코드);
            }
        });
        
        // 응답에서 중복 제거된 상품 정보로 교체
        responseOrder.상품정보 = uniqueProducts;
        
        // 전송할 응답 데이터 준비
        // 박스 정보가 있는 항목은 쉽먼트 페이지에서만 표시되도록 필터링
        const scanResponseOrder = JSON.parse(JSON.stringify(order));

        // rocket.html 페이지나 scan.html 페이지에서 호출된 경우 데이터 가공
        if (referer.includes('/rocket')) {
            // 중복 바코드 제거 및 스캔 수량 합산 (rocket 페이지용)
            const uniqueProducts = [];
            const processedBarcodes = new Set();
            
            // 원본 상품 항목 먼저 추가 (박스정보 없는 항목)
            scanResponseOrder.상품정보.filter(p => !p.박스정보).forEach(product => {
                uniqueProducts.push(product);
                processedBarcodes.add(product.상품바코드);
            });
            
            // 첫 번째 순회에서 처리하지 않은 상품 확인 (원본이 없는 경우)
            scanResponseOrder.상품정보.forEach(product => {
                if (!processedBarcodes.has(product.상품바코드)) {
                    // 이 바코드에 대한 원본 상품이 없는 경우, 박스정보를 제거하고 추가
                    const newProduct = {...product};
                    delete newProduct.박스정보;
                    uniqueProducts.push(newProduct);
                    processedBarcodes.add(product.상품바코드);
                }
            });
            
            // 응답에서 중복 제거된 상품 정보로 교체
            scanResponseOrder.상품정보 = uniqueProducts;
        } else if (referer.includes('/scan')) {
            // scan 페이지용 - 박스 정보가 포함된 모든 상품 목록 제공
            // 원본 상품(박스정보 없는)과 박스별 상품 모두 포함
            
            // 원본 상품 목록
            const originalProducts = scanResponseOrder.상품정보.filter(p => !p.박스정보);
            
            // 박스별 상품 목록 (정렬 및 그룹화)
            const boxProducts = scanResponseOrder.상품정보.filter(p => p.박스정보)
                .sort((a, b) => {
                    // 박스 번호 기준 정렬
                    const boxNumberA = a.박스정보.split('-')[0];
                    const boxNumberB = b.박스정보.split('-')[0];
                    return boxNumberA.localeCompare(boxNumberB);
                });
            
            // 모든 상품 목록 통합 (원본 + 박스별)
            scanResponseOrder.상품정보 = [...originalProducts, ...boxProducts];
        }
        
        res.json(scanResponseOrder);
    } catch (error) {
        console.error('발주서 상세 조회 중 오류 발생:', error);
        res.status(500).json({ error: '발주서를 불러오는데 실패했습니다.' });
    }
});

// Excel 파일 업로드 처리
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '파일이 업로드되지 않았습니다.' });
        }

        // 파일 버퍼에서 직접 읽기
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = xlsx.utils.sheet_to_json(worksheet, { header: 'A' });

        // 1행(헤더)을 제외하고 2행부터 데이터 처리
        const dataRows = data.slice(1);

        // 발주번호로 그룹화
        const groupedData = {};
        dataRows.forEach(row => {
            const orderNumber = row['A']; // 발주번호
            if (!orderNumber) return;

            if (!groupedData[orderNumber]) {
                groupedData[orderNumber] = {
                    발주번호: orderNumber,
                    입고예정일: row['U'] || '', // 입고예정일 (U열로 수정)
                    물류센터: row['B'] || '', // 물류센터
                    상품수: 0,
                    발주수량: 0,
                    확정수량: 0,
                    스캔수량: 0,
                    상품정보: []
                };
            }
            groupedData[orderNumber].상품수++;
            groupedData[orderNumber].발주수량 += parseInt(row['H']) || 0; // 발주수량
            groupedData[orderNumber].확정수량 += parseInt(row['I']) || 0; // 확정수량
            
            // 상품 정보 추가 (A~V열 모두 저장)
            groupedData[orderNumber].상품정보.push({
                상품번호: row['E'] || '', // 상품번호
                상품바코드: row['F'] || '', // 상품바코드
                상품이름: row['G'] || '', // 상품명
                발주수량: parseInt(row['H']) || 0, // 발주수량
                확정수량: parseInt(row['I']) || 0, // 확정수량
                스캔수량: 0, // 초기 스캔수량은 0
                '유통(소비)기한': row['J'] || '', // 유통(소비)기한
                제조일자: row['K'] || '', // 제조일자
                생산년도: row['L'] || '', // 생산년도
                납품부족사유: row['M'] || '', // 납품부족사유
                회송담당자: row['N'] || '', // 회송담당자
                '회송담당자 연락처': row['O'] || '', // 회송담당자 연락처
                회송지주소: row['P'] || '', // 회송지주소
                매입가: parseFloat(row['Q']) || 0, // 매입가
                공급가: parseFloat(row['R']) || 0, // 공급가
                부가세: parseFloat(row['S']) || 0, // 부가세
                '총발주 매입금': parseFloat(row['T']) || 0, // 총발주 매입금
                입고유형: row['C'] || '', // 입고유형
                발주상태: row['D'] || '', // 발주상태
                발주등록일시: row['V'] || '' // 발주등록일시
            });
        });

        // 중복 체크 및 저장
        const duplicateOrders = [];
        const newOrders = [];
        
        for (const orderNumber in groupedData) {
            const existingOrder = await Order.findOne({ 발주번호: orderNumber });
            if (existingOrder) {
                duplicateOrders.push(orderNumber);
            } else {
                newOrders.push(groupedData[orderNumber]);
            }
        }

        // 새로운 발주서만 저장
        if (newOrders.length > 0) {
            await Order.insertMany(newOrders);
        }

        // 응답 메시지 구성
        let message = '';
        if (newOrders.length > 0) {
            message += `${newOrders.length}개의 발주서가 추가되었습니다.`;
        }
        if (duplicateOrders.length > 0) {
            message += `\n다음 발주서는 이미 존재합니다:\n${duplicateOrders.join(', ')}`;
        }

        res.json({ 
            message: message,
            added: newOrders.length,
            duplicates: duplicateOrders
        });

    } catch (error) {
        console.error('파일 처리 중 오류 발생:', error);
        res.status(500).json({ error: '파일 처리 중 오류가 발생했습니다.' });
    }
});

// 발주서 삭제 API
app.post('/api/orders/delete', async (req, res) => {
    try {
        const { orderNumbers, password } = req.body;
        
        // 패스워드 검증
        if (password !== 'djajskek1!') {
            return res.status(403).json({ error: '패스워드가 올바르지 않습니다.' });
        }
        
        await Order.deleteMany({ 발주번호: { $in: orderNumbers } });
        res.json({ message: '발주서가 성공적으로 삭제되었습니다.' });
    } catch (error) {
        console.error('발주서 삭제 실패:', error);
        res.status(500).json({ error: '발주서 삭제에 실패했습니다.' });
    }
});

// 바코드 스캔 API
app.post('/api/scan', async (req, res) => {
    try {
        const { orderNumber, barcode, boxNumber, boxSize, quantity } = req.body;
        // quantity 값이 없으면 기본값 1 사용
        const scanQuantity = quantity ? parseInt(quantity) : 1;
        
        // 발주서 조회
        const order = await Order.findOne({ 발주번호: orderNumber });
        if (!order) {
            return res.status(404).json({ message: '발주서를 찾을 수 없습니다.' });
        }
        
        // 박스 정보
        const boxInfo = boxNumber && boxSize ? `${boxNumber}-${boxSize}` : null;
        if (!boxInfo) {
            return res.status(400).json({ message: '박스 정보가 필요합니다.' });
        }
        
        // 바코드로 상품 찾기 (원본 상품)
        const productIndex = order.상품정보.findIndex(p => p.상품바코드 === barcode && !p.박스정보);
        if (productIndex === -1) {
            return res.status(404).json({ message: '해당 바코드의 상품을 찾을 수 없습니다.' });
        }
        
        // 확정 수량 초과 체크
        const product = order.상품정보[productIndex];
        const confirmedCount = product.확정수량 || 0;
        
        // 이미 스캔된 동일 바코드의 스캔수량 계산 (쉽먼트 항목에서)
        const scannedItems = order.상품정보.filter(
            p => p.상품바코드 === barcode && p.박스정보
        );
        const scannedTotal = scannedItems.reduce((sum, p) => sum + (p.스캔수량 || 0), 0);
        
        // 원본 상품의 스캔수량
        const originalScanCount = product.스캔수량 || 0;
        
        // 추가할 수량으로 인해 확정 수량을 초과하는지 체크
        if (scannedTotal + scanQuantity > confirmedCount) {
            return res.status(400).json({ message: `추가할 수량(${scanQuantity})으로 인해 확정 수량(${confirmedCount})을 초과합니다. 현재 스캔 수량: ${scannedTotal}` });
        }
        
        // 해당 박스에 이미 같은 바코드 상품이 있는지 확인
        const existingBoxProductIndex = order.상품정보.findIndex(
            p => p.상품바코드 === barcode && p.박스정보 === boxInfo
        );
        
        if (existingBoxProductIndex !== -1) {
            // 이미 같은 박스에 같은 바코드가 있으면 스캔수량 증가
            order.상품정보[existingBoxProductIndex].스캔수량 += scanQuantity;
        } else {
            // 같은 박스에 없으면 새로운 항목 추가 (쉽먼트 전용 항목)
            // 이 항목은 _id를 바꿔서 발주서 상세리스트에서 제외되도록 함
            const newProduct = {
                ...JSON.parse(JSON.stringify(product)), // 깊은 복사
                스캔수량: scanQuantity,
                박스정보: boxInfo,
                _id: new mongoose.Types.ObjectId() // 새 ID 할당으로 쉽먼트 전용 항목 표시
            };
            
            // 쉽먼트용 항목으로 추가
            order.상품정보.push(newProduct);
        }
        
        // 원본 상품의 스캔수량 업데이트 (모든 박스의 스캔수량 합계)
        const updatedScannedItems = order.상품정보.filter(
            p => p.상품바코드 === barcode && p.박스정보
        );
        const updatedScannedTotal = updatedScannedItems.reduce((sum, p) => sum + (p.스캔수량 || 0), 0);
        
        // 원본 상품에 전체 스캔수량 반영
        order.상품정보[productIndex].스캔수량 = updatedScannedTotal;
        
        // 발주서의 총 스캔수량 업데이트 (모든 원본 상품의 스캔수량 합계)
        const totalUniqueScans = order.상품정보
            .filter(p => !p.박스정보) // 원본 상품만 선택
            .reduce((sum, p) => sum + (p.스캔수량 || 0), 0);
        
        order.스캔수량 = totalUniqueScans;
        
        // 저장
        await order.save();
        
        // 실시간 업데이트
        io.emit('scan-update', {
            orderNumber,
            productBarcode: barcode,
            boxInfo: boxInfo,
            newScanCount: updatedScannedTotal
        });
        
        // 전송할 응답 데이터 준비
        // 박스 정보가 있는 항목은 쉽먼트 페이지에서만 표시되도록 필터링
        const scanResponseOrder = JSON.parse(JSON.stringify(order));

        // rocket.html 페이지나 scan.html 페이지에서 호출된 경우 데이터 가공
        const referer = req.headers.referer || '';
        if (referer.includes('/rocket')) {
            // 중복 바코드 제거 및 스캔 수량 합산 (rocket 페이지용)
            const uniqueProducts = [];
            const processedBarcodes = new Set();
            
            // 원본 상품 항목 먼저 추가 (박스정보 없는 항목)
            scanResponseOrder.상품정보.filter(p => !p.박스정보).forEach(product => {
                uniqueProducts.push(product);
                processedBarcodes.add(product.상품바코드);
            });
            
            // 첫 번째 순회에서 처리하지 않은 상품 확인 (원본이 없는 경우)
            scanResponseOrder.상품정보.forEach(product => {
                if (!processedBarcodes.has(product.상품바코드)) {
                    // 이 바코드에 대한 원본 상품이 없는 경우, 박스정보를 제거하고 추가
                    const newProduct = {...product};
                    delete newProduct.박스정보;
                    uniqueProducts.push(newProduct);
                    processedBarcodes.add(product.상품바코드);
                }
            });
            
            // 응답에서 중복 제거된 상품 정보로 교체
            scanResponseOrder.상품정보 = uniqueProducts;
        } else if (referer.includes('/scan')) {
            // scan 페이지용 - 박스 정보가 포함된 모든 상품 목록 제공
            // 원본 상품(박스정보 없는)과 박스별 상품 모두 포함
            
            // 원본 상품 목록
            const originalProducts = scanResponseOrder.상품정보.filter(p => !p.박스정보);
            
            // 박스별 상품 목록 (정렬 및 그룹화)
            const boxProducts = scanResponseOrder.상품정보.filter(p => p.박스정보)
                .sort((a, b) => {
                    // 박스 번호 기준 정렬
                    const boxNumberA = a.박스정보.split('-')[0];
                    const boxNumberB = b.박스정보.split('-')[0];
                    return boxNumberA.localeCompare(boxNumberB);
                });
            
            // 모든 상품 목록 통합 (원본 + 박스별)
            scanResponseOrder.상품정보 = [...originalProducts, ...boxProducts];
        }
        
        res.json(scanResponseOrder);
    } catch (error) {
        console.error('바코드 스캔 처리 중 오류 발생:', error);
        res.status(500).json({ message: '바코드 스캔 처리 중 오류가 발생했습니다.' });
    }
});

// 스캔수량 업데이트 API
app.post('/api/scan/update', async (req, res) => {
    try {
        const { orderNumber, barcode, boxInfo, scanCount } = req.body;
        
        // 발주서 조회
        const order = await Order.findOne({ 발주번호: orderNumber });
        if (!order) {
            return res.status(404).json({ message: '발주서를 찾을 수 없습니다.' });
        }
        
        // 해당 상품 찾기 (박스정보가 있는 상품)
        const boxProductIndex = order.상품정보.findIndex(p => 
            p.상품바코드 === barcode && p.박스정보 === boxInfo
        );
        
        if (boxProductIndex === -1) {
            return res.status(404).json({ message: '해당 상품을 찾을 수 없습니다.' });
        }
        
        // 원본 상품 찾기 (박스정보가 없는 상품)
        const originalProductIndex = order.상품정보.findIndex(p => 
            p.상품바코드 === barcode && !p.박스정보
        );
        
        if (originalProductIndex === -1) {
            return res.status(404).json({ message: '원본 상품을 찾을 수 없습니다.' });
        }
        
        // 확정 수량 초과 체크
        const originalProduct = order.상품정보[originalProductIndex];
        const confirmedCount = originalProduct.확정수량 || 0;
        
        if (scanCount > confirmedCount) {
            return res.status(400).json({ message: '확정 수량을 초과할 수 없습니다.' });
        }
        
        // 스캔수량이 0이면 해당 박스 상품 삭제
        if (scanCount <= 0) {
            // 배열에서 해당 항목 제거
            order.상품정보.splice(boxProductIndex, 1);
        } else {
            // 박스 상품의 스캔수량 업데이트
            order.상품정보[boxProductIndex].스캔수량 = scanCount;
        }
        
        // 모든 박스의 스캔수량 합계 계산
        const totalBoxScanCount = order.상품정보
            .filter(p => p.상품바코드 === barcode && p.박스정보)
            .reduce((sum, p) => sum + (p.스캔수량 || 0), 0);
        
        // 원본 상품의 스캔수량 업데이트
        order.상품정보[originalProductIndex].스캔수량 = totalBoxScanCount;
        
        // 발주서의 총 스캔수량 업데이트
        const totalUniqueScans = order.상품정보
            .filter(p => !p.박스정보) // 원본 상품만 선택
            .reduce((sum, p) => sum + (p.스캔수량 || 0), 0);
        
        order.스캔수량 = totalUniqueScans;
        
        // 저장
        await order.save();
        
        res.json({ 
            message: scanCount <= 0 ? '항목이 삭제되었습니다.' : '스캔수량이 업데이트되었습니다.',
            deleted: scanCount <= 0
        });
    } catch (error) {
        console.error('스캔수량 업데이트 중 오류 발생:', error);
        res.status(500).json({ error: '스캔수량 업데이트에 실패했습니다.' });
    }
});

// 쉽먼트 데이터 내보내기 API
app.post('/api/shipment/export', async (req, res) => {
    try {
        const { orderNumbers, invoiceNumbers } = req.body;
        
        // 선택된 발주서만 조회 (또는 전체 발주서)
        const query = orderNumbers && orderNumbers.length > 0 
            ? { 발주번호: { $in: orderNumbers }, 스캔수량: { $gt: 0 } }
            : { 스캔수량: { $gt: 0 } };
            
        const orders = await Order.find(query);

        // xlsx-populate를 사용하여 새 워크북 생성
        const workbook = await XlsxPopulate.fromBlankAsync();
        
        // 메인 시트 설정
        const mainSheet = workbook.sheet(0);
        mainSheet.name("상품목록");

        // 송장번호입력 시트 추가
        const invoiceSheet = workbook.addSheet("송장번호입력");
        invoiceSheet.cell("A1").value("송장번호");

        // 모든 송장번호를 순서대로 수집
        const uniqueInvoiceNumbers = [];
        Object.values(invoiceNumbers).forEach(boxInvoices => {
            Object.values(boxInvoices).forEach(invoiceNumber => {
                // 중복되지 않은 송장번호만 추가
                if (!uniqueInvoiceNumbers.includes(invoiceNumber)) {
                    uniqueInvoiceNumbers.push(invoiceNumber);
                }
            });
        });

        // 송장번호를 2행부터 입력 순서대로 입력
        uniqueInvoiceNumbers.forEach((invoiceNumber, index) => {
            invoiceSheet.cell(`A${index + 2}`).value(invoiceNumber);
        });

        // 헤더 추가 (이미지의 헤더 값들)
        const headers = [
            '발주번호(PO ID)', '물류센터(FC)', '입고유형(Transport Type)', '입고예정일(EDD)', 
            '상품번호(SKU ID)', '상품바코드(SKU Barcode)', '상품이름(SKU Name)', 
            '확정수량(Confirmed Qty)', '송장번호(Invoice Number)', '납품수량(Shipped Qty)'
        ];

        // 헤더 행 추가
        headers.forEach((header, index) => {
            mainSheet.cell(1, index + 1).value(header);
        });

        // 데이터 행 추가 (2행부터)
        let rowIndex = 2;
        orders.forEach(order => {
            // 박스정보가 있는 스캔된 상품만 필터링
            const scannedProducts = order.상품정보.filter(product => 
                product.스캔수량 > 0 && product.박스정보 && product.박스정보 !== '-'
            );
            
            scannedProducts.forEach(product => {
                // 박스정보에서 박스번호 추출 (예: "BOX1-10" -> "BOX1")
                const boxNumber = product.박스정보.split('-')[0];
                // 송장번호 가져오기
                const invoiceNumber = invoiceNumbers[order.발주번호]?.[boxNumber] || '';
                
                mainSheet.cell(rowIndex, 1).value(order.발주번호);
                mainSheet.cell(rowIndex, 2).value(order.물류센터);
                mainSheet.cell(rowIndex, 3).value('쉽먼트');
                mainSheet.cell(rowIndex, 4).value(order.입고예정일);
                mainSheet.cell(rowIndex, 5).value(product.상품번호);
                mainSheet.cell(rowIndex, 6).value(product.상품바코드);
                mainSheet.cell(rowIndex, 7).value(product.상품이름);
                mainSheet.cell(rowIndex, 8).value(product.확정수량);
                mainSheet.cell(rowIndex, 9).value(invoiceNumber);
                mainSheet.cell(rowIndex, 10).value(product.스캔수량);
                
                rowIndex++;
            });
        });

        // 파일명 생성
        let filename;
        if (orderNumbers && orderNumbers.length === 1) {
            filename = `shipment (${orderNumbers[0]})`;
        } else if (orderNumbers && orderNumbers.length > 1) {
            const remainingCount = orderNumbers.length - 1;
            filename = `shipment (${orderNumbers[0]} 외 ${remainingCount}건)`;
        } else {
            filename = `shipment (전체)`;
        }

        // 엑셀 파일 생성
        const buffer = await workbook.outputAsync();
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=${encodeURIComponent(filename + '.xlsx')}`);
        res.send(buffer);

    } catch (error) {
        console.error('데이터 내보내기 중 오류 발생:', error);
        res.status(500).json({ error: '데이터 내보내기에 실패했습니다.' });
    }
});

// 발주서 내보내기 API
app.post('/api/orders/export', async (req, res) => {
    try {
        const { orderNumbers } = req.body;
        const query = orderNumbers && orderNumbers.length > 0 
            ? { 발주번호: { $in: orderNumbers } }
            : {};

        const orders = await Order.find(query);
        
        // 드롭다운 옵션 정의
        const dropdownOptions = [
            "제조사 생산중단 혹은 공급사 취급중단 - 제품 리뉴얼/모델 변경",
            "제조사 생산중단 혹은 공급사 취급중단 - 시장 단종",
            "제조사 생산중단 혹은 공급사 취급중단 - 사업자변경",
            "협력사 재고부족 - 수요예측 오류",
            "협력사 재고부족 - 생산캐파 부족 (설비라인/원자재/인력/휴무… 등등)",
            "협력사 재고부족 - 품질적 이슈 (유해물질 발견 / 유통기한 미달)",
            "협력사 재고부족 - 재고 할당정책",
            "협력사 재고부족 - 수입상품 입고지연 (선적/통관지연)",
            "FC 입고기준 미달로 회송",
            "가격 이슈 (Price) - 매입가 인하 협상 중",
            "가격 이슈 (Price) - 매입가 인상 협상 중",
            "가격 이슈 (Price) - 쿠팡 최저가 매칭",
            "최소발주량 변경 필요 (MOQ)",
            "쿠팡 요청 미납",
            "시즌상품으로 다음 시즌전까지 생산 혹은 취급중단",
            "천재지변/재난과 같은 불가항력적인 사유로 미납",
            "업체 휴무",
            "재무 관련 사유",
            "FC 입고 이슈 - FC 슬롯 예약 불가",
            "FC 입고 이슈 - 밀크런 예약불가"
        ];

        // 데이터 준비
        const exportData = [];
        orders.forEach(order => {
            order.상품정보.forEach(product => {
                if (product.박스정보) return;
                
                exportData.push({
                    발주번호: order.발주번호,
                    물류센터: order.물류센터,
                    입고유형: product.입고유형 || '',
                    발주상태: product.발주상태 || '',
                    상품번호: product.상품번호,
                    상품바코드: product.상품바코드,
                    상품이름: product.상품이름,
                    발주수량: product.발주수량,
                    확정수량: product.스캔수량 || 0,
                    '유통(소비)기한': product['유통(소비)기한'] || '',
                    제조일자: product.제조일자 || '',
                    생산년도: product.생산년도 || '',
                    납품부족사유: product.납품부족사유 || '',
                    회송담당자: product.회송담당자 || '',
                    '회송담당자 연락처': product['회송담당자 연락처'] || '',
                    회송지주소: product.회송지주소 || '',
                    매입가: product.매입가 || 0,
                    공급가: product.공급가 || 0,
                    부가세: product.부가세 || 0,
                    '총발주 매입금': product['총발주 매입금'] || 0,
                    입고예정일: order.입고예정일 || '',
                    발주등록일시: product.발주등록일시 || '',
                    입고1: product.입고1 || '-',
                    입고2: product.입고2 || '-',
                    위치: product.위치 || '-'
                });
            });
        });

        // xlsx-populate를 사용하여 새 워크북 생성
        const workbook = await XlsxPopulate.fromBlankAsync();
        
        // 메인 시트 생성
        const mainSheet = workbook.sheet(0);
        mainSheet.name("발주리스트");

        // hiddenSheet 생성
        const hiddenSheet = workbook.addSheet("hiddenSheet");
        
        // hiddenSheet에 드롭다운 옵션 추가
        dropdownOptions.forEach((option, index) => {
            hiddenSheet.cell(index + 1, 1).value(option);
        });

        // 헤더 추가
        const headers = [
            '발주번호', '물류센터', '입고유형', '발주상태', '상품번호', 
            '상품바코드', '상품이름', '발주수량', '확정수량', '유통(소비)기한',
            '제조일자', '생산년도', '납품부족사유', '회송담당자', '회송담당자 연락처',
            '회송지주소', '매입가', '공급가', '부가세', '총발주 매입금',
            '입고예정일', '발주등록일시', '입고1', '입고2', '위치'
        ];

        // 헤더 행 추가
        headers.forEach((header, index) => {
            mainSheet.cell(1, index + 1).value(header);
        });

        // 데이터 행 추가
        exportData.forEach((row, rowIndex) => {
            Object.values(row).forEach((value, colIndex) => {
                mainSheet.cell(rowIndex + 2, colIndex + 1).value(value);
            });
        });

        // M열(13번째 열)에 드롭다운 추가
        const lastRow = exportData.length + 1;
        const dropdownRange = mainSheet.range(`M2:M${lastRow}`);
        dropdownRange.dataValidation({
            type: 'list',
            formula1: 'hiddenSheet!$A$1:$A$20', // hiddenSheet의 A1:A20 범위를 참조
            allowBlank: true
        });

        // hiddenSheet를 숨김 처리
        hiddenSheet.hidden(true);

        // 파일명 생성
        let filename;
        if (orderNumbers && orderNumbers.length === 1) {
            filename = `발주리스트 확정 (${orderNumbers[0]}).xlsx`;
        } else if (orderNumbers && orderNumbers.length > 1) {
            filename = `발주리스트 확정 (${orderNumbers[0]} 외 ${orderNumbers.length - 1}건).xlsx`;
        } else {
            filename = `발주리스트 확정 (전체).xlsx`;
        }

        // 엑셀 파일 생성
        const buffer = await workbook.outputAsync();
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=${encodeURIComponent(filename)}`);
        res.send(buffer);

    } catch (error) {
        console.error('발주서 내보내기 중 오류:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

app.get('/importChina', (req, res) => {
    res.sendFile(path.join(__dirname, 'importChina.html'));
});

// 중국입고 엑셀 파일 업로드 처리
app.post('/api/importChina/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: '파일이 업로드되지 않았습니다.' });
        }

        const shipmentCode = req.body.shipmentCode;
        if (!shipmentCode) {
            return res.status(400).json({ message: '출고코드가 입력되지 않았습니다.' });
        }

        // 파일 버퍼에서 직접 읽기
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        
        // Sheet3가 있는지 확인
        if (!workbook.SheetNames.includes('Sheet3')) {
            return res.status(400).json({ message: 'Sheet3를 찾을 수 없습니다.' });
        }

        const worksheet = workbook.Sheets['Sheet3'];
        const data = xlsx.utils.sheet_to_json(worksheet, { header: 'A' });

        // BR로 시작하는 박스만 필터링
        const filteredData = data.filter(row => {
            const boxName = row['B'];
            return boxName && boxName.toString().startsWith('BR');
        });

        // 새로운 데이터 저장 전에 기존 데이터 삭제 (동일 shipmentCode)
        await ChinaImport.deleteMany({ shipmentCode });
        
        // 새로운 데이터 저장
        const importData = filteredData.map(row => ({
            shipmentCode: shipmentCode,
            pallet: row['A'] || '',
            boxName: row['B'] || '',
            orderNumber: row['C'] || '',
            productName: row['H'] || '',
            quantity: row['J'] ? row['J'].toString() : '0',
            barcode: row['K'] || ''
        }));

        // 대량 삽입 (인덱스 활용)
        await ChinaImport.insertMany(importData, { ordered: true });

        res.json({ 
            message: '파일이 성공적으로 업로드되었습니다.',
            count: filteredData.length
        });
    } catch (error) {
        console.error('파일 처리 중 오류:', error);
        res.status(500).json({ message: '파일 처리 중 오류가 발생했습니다.' });
    }
});

// 중국입고 데이터 조회
app.get('/api/importChina/data', async (req, res) => {
    try {
        const data = await ChinaImport.find().sort({ boxName: 1 });
        res.json(data);
    } catch (error) {
        console.error('데이터 조회 중 오류:', error);
        res.status(500).json({ message: '데이터 조회 중 오류가 발생했습니다.' });
    }
});

// 중국입고 데이터 삭제
app.delete('/api/importChina/delete/:shipmentCode', async (req, res) => {
    try {
        const { shipmentCode } = req.params;
        await ChinaImport.deleteMany({ shipmentCode: shipmentCode });
        res.json({ message: '데이터가 성공적으로 삭제되었습니다.' });
    } catch (error) {
        console.error('데이터 삭제 중 오류:', error);
        res.status(500).json({ message: '데이터 삭제 중 오류가 발생했습니다.' });
    }
});

// 발주서 정리 API
app.post('/api/importChina/organize', async (req, res) => {
    try {
        // 1. 중국입고 데이터 가져오기
        const chinaImports = await ChinaImport.find({});
        console.log(`총 ${chinaImports.length}개의 중국입고 데이터를 조회했습니다.`);
        
        // 2. 모든 바코드 추출 (중복 제거)
        const allBarcodes = [...new Set(chinaImports.map(item => item.barcode))];
        console.log(`총 ${allBarcodes.length}개의 고유 바코드가 발견되었습니다.`);
        
        // 3. 필요한 바코드를 가진 발주서만 조회
        const orders = await Order.find({ 
            '상품정보.상품바코드': { $in: allBarcodes } 
        });
        console.log(`총 ${orders.length}개의 관련 발주서를 조회했습니다.`);
        
        // 4. 바코드별 발주서 정보 맵 생성
        const orderProductMap = new Map();
        
        orders.forEach(order => {
            order.상품정보.forEach(product => {
                if (!product.상품바코드 || product.박스정보) return; // 박스정보가 있는 상품은 제외
                
                if (!orderProductMap.has(product.상품바코드)) {
                    orderProductMap.set(product.상품바코드, []);
                }
                
                // 출고 가능 수량 계산 (확정수량 - 스캔수량)
                const availableQuantity = product.확정수량 - (product.스캔수량 || 0);
                
                // 출고 가능 수량이 있는 경우만 추가
                if (availableQuantity > 0) {
                    orderProductMap.get(product.상품바코드).push({
                        order: {
                            발주번호: order.발주번호,
                            물류센터: order.물류센터,
                            입고예정일: order.입고예정일
                        },
                        product: product,
                        availableQuantity: availableQuantity
                    });
                }
            });
        });
        
        // 각 바코드별 출고 가능 발주서 정보 출력
        orderProductMap.forEach((entries, barcode) => {
            console.log(`바코드 ${barcode}의 출고 가능 발주서: ${entries.length}개`);
            entries.forEach(entry => {
                console.log(`  - ${entry.order.발주번호} (${entry.order.물류센터}): ${entry.availableQuantity}개`);
            });
        });
        
        // 5. 결과 배열 생성
        const finalResults = [];
        
        // 6. 중국입고 데이터 처리
        for (const chinaImport of chinaImports) {
            const barcode = chinaImport.barcode;
            const totalQuantity = parseInt(chinaImport.quantity) || 0;
            
            console.log(`중국입고 처리: ${chinaImport.boxName}, 바코드 ${barcode}, 수량 ${totalQuantity}`);
            
            // 해당 바코드의 발주서가 없거나 모든 발주서의 수량이 0인 경우 - 창고 행만 생성
            if (!orderProductMap.has(barcode) || orderProductMap.get(barcode).length === 0) {
                console.log(`  - 해당 바코드의 발주서 없음: 전체 수량 ${totalQuantity}개를 창고로 지정`);
                finalResults.push({
                    shipmentCode: chinaImport.shipmentCode,
                    pallet: chinaImport.pallet,
                    boxName: chinaImport.boxName,
                    orderNumber: chinaImport.orderNumber,
                    productName: chinaImport.productName,
                    quantity: chinaImport.quantity,
                    barcode: barcode,
                    availableOrders: `000000000-창고-${totalQuantity}`
                });
                continue;
            }
            
            // 발주서 목록을 입고예정일 순으로 정렬
            const matchingEntries = [...orderProductMap.get(barcode)]
                .sort((a, b) => new Date(a.order.입고예정일) - new Date(b.order.입고예정일));
            
            let remainingQuantity = totalQuantity;
            let hasDistributed = false;
            
            // 각 발주서에 대해 처리
            for (const entry of matchingEntries) {
                if (remainingQuantity <= 0) break;
                
                const assignQuantity = Math.min(remainingQuantity, entry.availableQuantity);
                
                if (assignQuantity > 0) {
                    console.log(`  - 발주서 ${entry.order.발주번호} (${entry.order.물류센터})에 ${assignQuantity}개 할당`);
                    
                    // 새 문서 생성
                    finalResults.push({
                        shipmentCode: chinaImport.shipmentCode,
                        pallet: chinaImport.pallet,
                        boxName: chinaImport.boxName,
                        orderNumber: chinaImport.orderNumber,
                        productName: chinaImport.productName,
                        quantity: chinaImport.quantity,
                        barcode: barcode,
                        availableOrders: `${entry.order.발주번호}-${entry.order.물류센터}-${assignQuantity}`,
                        shippingDate: entry.order.입고예정일 || ''
                    });
                    
                    // 발주서의 가용 수량 감소
                    entry.availableQuantity -= assignQuantity;
                    remainingQuantity -= assignQuantity;
                    hasDistributed = true;
                }
            }
            
            // 남은 수량이 있으면 창고 행 추가
            if (remainingQuantity > 0) {
                console.log(`  - 남은 수량 ${remainingQuantity}개를 창고로 지정`);
                finalResults.push({
                    shipmentCode: chinaImport.shipmentCode,
                    pallet: chinaImport.pallet,
                    boxName: chinaImport.boxName,
                    orderNumber: chinaImport.orderNumber,
                    productName: chinaImport.productName,
                    quantity: chinaImport.quantity,
                    barcode: barcode,
                    availableOrders: `000000000-창고-${remainingQuantity}`,
                    shippingDate: ''
                });
            }
        }
        
        // 7. 결과 저장
        await ChinaImport.deleteMany({});
        console.log(`기존 데이터 삭제 완료. 새로운 데이터 ${finalResults.length}개 저장 시작`);
        
        // 기존 insertMany로는 중복키 문제가 발생할 수 있으므로 for 루프로 하나씩 저장
        if (finalResults.length > 0) {
            await ChinaImport.insertMany(finalResults, { ordered: false });
        }
        
        console.log(`데이터 저장 완료. 총 ${finalResults.length}개 항목 처리됨`);
        res.json(finalResults);
    } catch (error) {
        console.error('발주서 정리 중 오류:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

// 출고예정 업데이트 API
app.post('/api/importChina/updateAvailableOrders', async (req, res) => {
    try {
        const { shipmentCode, barcode, availableOrders } = req.body;
        
        if (!shipmentCode || !barcode) {
            return res.status(400).json({ error: '필수 데이터가 누락되었습니다.' });
        }

        const result = await ChinaImport.updateOne(
            { shipmentCode, barcode },
            { $set: { availableOrders } }
        );
        
        if (result.matchedCount === 0) {
            return res.status(404).json({ error: '해당 데이터를 찾을 수 없습니다.' });
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: '데이터 업데이트 실패' });
    }
});

// 발주서 입고1 필드 업데이트 API
app.post('/api/orders/updateImport1', async (req, res) => {
    try {
        const updateData = req.body;
        
        if (!Array.isArray(updateData) || updateData.length === 0) {
            return res.status(400).json({ error: '유효하지 않은 데이터' });
        }

        for (const item of updateData) {
            const { orderNumber, barcode, importValue } = item;
            
            if (!orderNumber || !barcode || !importValue) {
                console.error('필수 데이터 누락:', item);
                continue;
            }

            const order = await Order.findOne({ '발주번호': orderNumber });
            if (!order) {
                console.error('주문을 찾을 수 없음:', orderNumber);
                continue;
            }

            const product = order.상품정보.find(p => p.상품바코드 === barcode);
            if (!product) {
                console.error('상품을 찾을 수 없음:', barcode);
                continue;
            }

            // 입고1 필드만 업데이트
            product.입고1 = importValue;
            await order.save();
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: '입고1 업데이트 실패' });
    }
});

// 발주서 입고2 필드 업데이트 API
app.post('/api/orders/updateImport2', async (req, res) => {
    try {
        const updateData = req.body;
        
        if (!Array.isArray(updateData) || updateData.length === 0) {
            return res.status(400).json({ error: '유효하지 않은 데이터' });
        }

        for (const item of updateData) {
            const { orderNumber, barcode, importValue } = item;
            
            if (!orderNumber || !barcode || !importValue) {
                console.error('필수 데이터 누락:', item);
                continue;
            }

            const order = await Order.findOne({ '발주번호': orderNumber });
            if (!order) {
                console.error('주문을 찾을 수 없음:', orderNumber);
                continue;
            }

            const product = order.상품정보.find(p => p.상품바코드 === barcode);
            if (!product) {
                console.error('상품을 찾을 수 없음:', barcode);
                continue;
            }

            // 입고2 필드만 업데이트
            product.입고2 = importValue;
            await order.save();
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: '입고2 업데이트 실패' });
    }
});

// 입고1/2 초기화 API
app.post('/api/orders/resetImport12', async (req, res) => {
    try {
        await Order.updateMany(
            {},
            { $set: { '상품정보.$[].입고1': '-', '상품정보.$[].입고2': '-' } }
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: '초기화 실패' });
    }
});

// 재고관리 페이지 라우트
app.get('/inventory', (req, res) => {
    res.sendFile(path.join(__dirname, 'inventory.html'));
});

// 재고 데이터 모델
const inventorySchema = new mongoose.Schema({
    skuId: String,
    name: String,
    barcode: String,
    orderStatus: String,
    quantity: { type: String, default: '-' },
    location: { type: String, default: '-' },
    lastUpdate: { type: Date, default: Date.now }
});

const Inventory = mongoose.model('Inventory', inventorySchema);

// 재고 목록 조회 API
app.get('/api/inventory/list', async (req, res) => {
    try {
        const inventory = await Inventory.find({});
        res.json(inventory);
    } catch (error) {
        console.error('재고 목록 조회 중 오류:', error);
        res.status(500).json({ error: '재고 목록을 불러오는 중 오류가 발생했습니다.' });
    }
});

// 엑셀 파일 업로드 API
app.post('/api/inventory/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '파일이 업로드되지 않았습니다.' });
        }

        // 파일 버퍼에서 직접 읽기
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = xlsx.utils.sheet_to_json(worksheet, { header: 'A' });

        // 1행(헤더)을 제외하고 2행부터 데이터 처리
        const dataRows = data.slice(1);

        // 기존 데이터 조회
        const existingInventory = await Inventory.find({});
        const existingSkuIds = new Set(existingInventory.map(item => item.skuId));

        // 새 데이터 삽입 (중복 SKU ID 제외)
        const inventoryData = [];
        for (const row of dataRows) {
            const skuId = row['A'] || '';
            if (skuId && !existingSkuIds.has(skuId)) {
                inventoryData.push({
                    skuId: skuId,
                    name: row['C'] || '',
                    barcode: row['D'] || '',
                    orderStatus: row['E'] || '',
                    quantity: '-',
                    location: '-'
                });
                existingSkuIds.add(skuId);
            }
        }

        if (inventoryData.length > 0) {
            await Inventory.insertMany(inventoryData);
        }

        res.json({ 
            success: true, 
            message: '재고 데이터가 성공적으로 업로드되었습니다.',
            added: inventoryData.length
        });
    } catch (error) {
        console.error('재고 데이터 업로드 중 오류:', error);
        res.status(500).json({ error: '재고 데이터 업로드 중 오류가 발생했습니다.' });
    }
});

// 선택된 재고 데이터 삭제 API
app.post('/api/inventory/delete-selected', async (req, res) => {
    try {
        const { skuIds } = req.body;
        if (!Array.isArray(skuIds) || skuIds.length === 0) {
            return res.status(400).json({ error: '삭제할 항목이 선택되지 않았습니다.' });
        }

        await Inventory.deleteMany({ skuId: { $in: skuIds } });
        res.json({ success: true, message: '선택된 재고 데이터가 성공적으로 삭제되었습니다.' });
    } catch (error) {
        console.error('재고 데이터 삭제 중 오류:', error);
        res.status(500).json({ error: '재고 데이터 삭제 중 오류가 발생했습니다.' });
    }
});

// 재고 검색 API
app.post('/api/inventory/search', async (req, res) => {
    try {
        const { orderStatus, searchTerm } = req.body;
        const query = {};

        // 발주가능상태 필터링
        if (orderStatus) {
            query.orderStatus = orderStatus;
        }

        // 검색어가 있는 경우 SKU ID, 바코드, 상품명에서 검색
        if (searchTerm) {
            query.$or = [
                { skuId: new RegExp(searchTerm, 'i') },
                { barcode: new RegExp(searchTerm, 'i') },
                { name: new RegExp(searchTerm, 'i') }
            ];
        }

        const results = await Inventory.find(query);
        res.json(results);
    } catch (error) {
        console.error('재고 검색 중 오류:', error);
        res.status(500).json({ error: '재고 검색 중 오류가 발생했습니다.' });
    }
});

// 로케이션 업데이트 API
app.post('/api/inventory/update-location', async (req, res) => {
    try {
        const { skuId, location } = req.body;
        if (!skuId) {
            return res.status(400).json({ error: 'SKU ID가 필요합니다.' });
        }

        const result = await Inventory.updateOne(
            { skuId: skuId },
            { $set: { location: location } }
        );

        if (result.modifiedCount === 0) {
            return res.status(404).json({ error: '해당 SKU ID를 찾을 수 없습니다.' });
        }

        res.json({ success: true, message: '로케이션이 성공적으로 업데이트되었습니다.' });
    } catch (error) {
        console.error('로케이션 업데이트 중 오류:', error);
        res.status(500).json({ error: '로케이션 업데이트 중 오류가 발생했습니다.' });
    }
});

// 바코드로 위치 정보 조회 API
app.post('/api/inventory/locations', async (req, res) => {
    try {
        const { barcodes } = req.body;
        
        if (!Array.isArray(barcodes) || barcodes.length === 0) {
            return res.status(400).json({ error: '바코드 목록이 제공되지 않았습니다.' });
        }

        console.log('위치 정보 조회 요청 바코드:', barcodes);

        // 바코드 목록에 해당하는 재고 데이터 조회
        const inventoryItems = await Inventory.find({ barcode: { $in: barcodes } });
        
        console.log('조회된 재고 데이터:', inventoryItems);

        // 결과 형식 변환: [{ barcode: '123', location: 'A-1' }, ...]
        const locations = inventoryItems.map(item => ({
            barcode: item.barcode,
            location: item.location || '-'
        }));

        console.log('반환할 위치 정보:', locations);

        res.json(locations);
    } catch (error) {
        console.error('위치 정보 조회 중 오류:', error);
        res.status(500).json({ error: '위치 정보 조회 중 오류가 발생했습니다.' });
    }
});

// 바코드-로케이션 엑셀 업로드 API
app.post('/api/inventory/upload-locations', async (req, res) => {
    try {
        const { items } = req.body;
        
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: '업로드할 데이터가 없습니다.' });
        }

        console.log(`로케이션 업로드: 총 ${items.length}개 데이터 처리 시작`);
        let updatedCount = 0;
        let processedCount = 0;

        // 각 항목에 대해 로케이션 업데이트
        for (const item of items) {
            processedCount++;
            if (processedCount % 100 === 0) {
                console.log(`처리 진행 중: ${processedCount}/${items.length} (${Math.round(processedCount/items.length*100)}%)`);
            }
            
            if (!item.barcode || !item.location) continue;

            // 해당 바코드를 가진 모든 인벤토리 항목 찾기
            const result = await Inventory.updateMany(
                { barcode: item.barcode },
                { $set: { location: item.location } }
            );

            if (result.modifiedCount > 0) {
                updatedCount += result.modifiedCount;
            }
        }
        
        console.log(`로케이션 업로드 완료: 총 ${updatedCount}개 항목 업데이트됨`);

        res.json({ 
            success: true, 
            message: '위치 정보가 성공적으로 업데이트되었습니다.',
            updated: updatedCount
        });
    } catch (error) {
        console.error('위치 정보 업로드 중 오류:', error);
        res.status(500).json({ error: '위치 정보 업로드 중 오류가 발생했습니다.' });
    }
});

// 직접 등록 API
app.post('/api/inventory/register', async (req, res) => {
    try {
        const { skuId, name, barcode, orderStatus, quantity, location } = req.body;
        
        // 필수 필드 검증
        if (!name || !barcode) {
            return res.status(400).json({ 
                success: false, 
                error: '상품명과 바코드는 필수 입력 항목입니다.'
            });
        }
        
        // 기존 SKU ID 또는 바코드 중복 체크
        const existingItem = await Inventory.findOne({
            $or: [
                { skuId: skuId },
                { barcode: barcode }
            ]
        });
        
        if (existingItem) {
            let errorMessage = '';
            if (existingItem.skuId === skuId) {
                errorMessage = '이미 등록된 SKU ID입니다.';
            } else {
                errorMessage = '이미 등록된 바코드입니다.';
            }
            return res.status(400).json({ success: false, error: errorMessage });
        }
        
        // 새 상품 등록
        const newItem = new Inventory({
            skuId: skuId,
            name: name,
            barcode: barcode,
            orderStatus: orderStatus || '정상',
            quantity: quantity || '-',
            location: location || '-',
            lastUpdate: new Date()
        });
        
        await newItem.save();
        
        res.json({
            success: true,
            message: '상품이 성공적으로 등록되었습니다.',
            item: newItem
        });
    } catch (error) {
        console.error('상품 등록 중 오류:', error);
        res.status(500).json({ 
            success: false, 
            error: '상품 등록 중 오류가 발생했습니다.' 
        });
    }
});

// 스캔 기록 삭제 API
app.post('/api/scan/delete', async (req, res) => {
    try {
        const { orderNumber, barcode } = req.body;
        
        // 발주서 찾기
        const order = await Order.findOne({ 발주번호: orderNumber });
        if (!order) {
            return res.status(404).json({ message: '발주서를 찾을 수 없습니다.' });
        }

        // 상품 찾기
        const product = order.상품정보.find(p => p.상품바코드 === barcode && !p.박스정보);
        if (!product) {
            return res.status(404).json({ message: '상품을 찾을 수 없습니다.' });
        }

        // 스캔 수량 초기화
        product.스캔수량 = 0;

        // 박스 정보가 있는 상품들의 스캔 수량도 초기화
        order.상품정보
            .filter(p => p.상품바코드 === barcode && p.박스정보)
            .forEach(p => {
                p.스캔수량 = 0;
            });

        // 발주서 저장
        await order.save();

        // 실시간 업데이트
        io.emit('scan-update', {
            orderNumber: order.발주번호,
            message: '스캔 기록이 삭제되었습니다.'
        });

        res.json({ message: '스캔 기록이 삭제되었습니다.' });
    } catch (error) {
        console.error('스캔 기록 삭제 중 오류 발생:', error);
        res.status(500).json({ message: '스캔 기록 삭제 중 오류가 발생했습니다.' });
    }
});

// 박스 정보 수정 API
app.post('/api/scan/updateBox', async (req, res) => {
    try {
        const { orderNumber, oldBoxNumber, oldBoxSize, newBoxNumber, newBoxSize } = req.body;
        
        // 발주서 조회
        const order = await Order.findOne({ 발주번호: orderNumber });
        if (!order) {
            return res.status(404).json({ message: '발주서를 찾을 수 없습니다.' });
        }
        
        // 기존 박스 정보
        const oldBoxInfo = `${oldBoxNumber}-${oldBoxSize}`;
        const newBoxInfo = `${newBoxNumber}-${newBoxSize}`;
        
        // 같은 박스번호가 이미 존재하는지 확인 (자기 자신 제외)
        const hasDuplicate = order.상품정보.some(product => 
            product.박스정보 && 
            product.박스정보.split('-')[0] === newBoxNumber && 
            product.박스정보 !== oldBoxInfo
        );
        
        if (hasDuplicate) {
            return res.status(400).json({ message: '이미 존재하는 박스번호입니다.' });
        }
        
        // 박스 정보 업데이트
        order.상품정보.forEach(product => {
            if (product.박스정보 === oldBoxInfo) {
                product.박스정보 = newBoxInfo;
            }
        });
        
        // 저장
        await order.save();
        
        // 실시간 업데이트
        io.emit('scan-update', {
            orderNumber: order.발주번호,
            message: '박스 정보가 업데이트되었습니다.'
        });
        
        res.json({ message: '박스 정보가 성공적으로 수정되었습니다.' });
    } catch (error) {
        console.error('박스 정보 수정 중 오류 발생:', error);
        res.status(500).json({ message: '박스 정보 수정 중 오류가 발생했습니다.' });
    }
});

// 발주서 위치 정보 업데이트 API
app.post('/api/orders/update-location', async (req, res) => {
    try {
        const { orderNumber, barcode, location } = req.body;
        console.log('위치 정보 업데이트 요청:', { orderNumber, barcode, location });

        const order = await Order.findOne({ 발주번호: orderNumber });
        if (!order) {
            console.error('발주서를 찾을 수 없음:', orderNumber);
            return res.status(404).json({ error: '발주서를 찾을 수 없습니다.' });
        }

        // 상품 정보 업데이트
        const productIndex = order.상품정보.findIndex(p => p.상품바코드 === barcode);
        if (productIndex === -1) {
            console.error('상품을 찾을 수 없음:', barcode);
            return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });
        }

        console.log('업데이트 전 상품 정보:', order.상품정보[productIndex]);
        order.상품정보[productIndex].위치 = location;
        console.log('업데이트 후 상품 정보:', order.상품정보[productIndex]);

        await order.save();
        console.log('위치 정보 업데이트 완료');
        res.json({ success: true });
    } catch (error) {
        console.error('위치 정보 업데이트 중 오류:', error);
        res.status(500).json({ error: '위치 정보 업데이트 중 오류가 발생했습니다.' });
    }
});

// 신규 발주서 등록 페이지
app.get('/newOrder', (req, res) => {
    res.sendFile(path.join(__dirname, 'newOrder.html'));
});

// 엑셀 파일 분석 API (메모리에만 저장)
app.post('/api/orders/parse-excel', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: '파일이 없습니다.' });
        }

        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        
        // 여기에 엑셀 파일 분석 로직 구현
        // 실제 저장은 하지 않고 분석 결과만 반환
        
        // 예시 분석 로직
        const orders = [];
        const sheetNames = workbook.SheetNames;
        
        for (const sheetName of sheetNames) {
            const worksheet = workbook.Sheets[sheetName];
            const json = xlsx.utils.sheet_to_json(worksheet);
            
            if (json.length > 0) {
                // 발주서 정보 분석 및 구조화
                // 여기서는 간단한 예시만 제공하며, 실제 로직은 기존 코드를 참고하여 구현해야 함
                const orderNumber = json[0].발주번호 || `ORDER-${Date.now()}`;
                const center = json[0].물류센터 || '미지정';
                const expectedDate = json[0].입고예정일 || new Date().toISOString().split('T')[0];
                
                const orderProducts = json.map(row => ({
                    상품번호: row.상품번호 || '',
                    상품바코드: row.상품바코드 || '',
                    상품이름: row.상품이름 || '',
                    발주수량: row.발주수량 || 0,
                    확정수량: row.확정수량 || row.발주수량 || 0,
                    스캔수량: 0,
                    위치: ''
                }));
                
                orders.push({
                    발주번호: orderNumber,
                    물류센터: center,
                    입고예정일: expectedDate,
                    상품수: orderProducts.length,
                    발주수량: orderProducts.reduce((sum, p) => sum + p.발주수량, 0),
                    확정수량: orderProducts.reduce((sum, p) => sum + p.확정수량, 0),
                    스캔수량: 0,
                    상품정보: orderProducts
                });
            }
        }
        
        return res.status(200).json({ orders });
    } catch (error) {
        console.error('엑셀 파일 분석 오류:', error);
        return res.status(500).json({ message: '엑셀 파일 분석 중 오류가 발생했습니다.' });
    }
});

// 발주서 등록 API (실제 DB에 저장)
app.post('/api/orders/register', async (req, res) => {
    try {
        const { orders } = req.body;
        if (!orders || !Array.isArray(orders) || orders.length === 0) {
            return res.status(400).json({ message: '등록할 발주서 정보가 없습니다.' });
        }

        let registered = 0;
        let duplicates = 0;

        for (const order of orders) {
            // 중복 체크
            const existingOrder = await Order.findOne({ 발주번호: order.발주번호 });
            if (existingOrder) {
                duplicates++;
                continue;
            }

            // 새 발주서 저장
            const newOrder = new Order(order);
            await newOrder.save();
            registered++;
        }

        return res.status(200).json({ registered, duplicates });
    } catch (error) {
        console.error('발주서 등록 오류:', error);
        return res.status(500).json({ message: '발주서 등록 중 오류가 발생했습니다.' });
    }
});

// 바코드로 상품 정보 조회 API
app.get('/api/products/barcode/:barcode', async (req, res) => {
    try {
        const barcode = req.params.barcode;
        console.log('바코드로 상품 정보 조회 요청:', barcode);
        
        // 모든 발주서 가져오기 (더 효율적인 검색을 위해)
        const allOrders = await Order.find({});
        console.log(`전체 발주서 개수:`, allOrders.length);
        
        // 모든 발주서의 모든 상품을 검색
        let foundProduct = null;
        
        // 각 발주서에서 상품 찾기
        for (const order of allOrders) {
            // 원본 상품 중 해당 바코드를 가진 상품 찾기
            const product = order.상품정보.find(p => p.상품바코드 === barcode && !p.박스정보);
            if (product) {
                console.log('원본 상품 정보 발견:', product.상품이름);
                foundProduct = product;
                break;
            }
        }
        
        // 원본 상품에서 찾지 못한 경우 박스정보가 있는 상품 중에서 찾기
        if (!foundProduct) {
            for (const order of allOrders) {
                const product = order.상품정보.find(p => p.상품바코드 === barcode);
                if (product) {
                    console.log('박스정보가 있는 상품 발견:', product.상품이름);
                    foundProduct = product;
                    break;
                }
            }
        }
        
        // 상품을 찾은 경우
        if (foundProduct) {
            return res.json({
                상품바코드: foundProduct.상품바코드,
                상품이름: foundProduct.상품이름,
                상품번호: foundProduct.상품번호 || ''
            });
        }
        
        // 상품을 찾지 못한 경우
        console.log(`${barcode}에 대한 상품 정보를 찾을 수 없음`);
        return res.status(404).json({ message: "해당 바코드의 상품을 찾을 수 없습니다." });
    } catch (error) {
        console.error('바코드로 상품 조회 중 오류 발생:', error);
        res.status(500).json({ error: '상품 정보를 조회하는데 실패했습니다.' });
    }
});

app.get('/api/importChina', async (req, res) => {
    try {
        const data = await ChinaImport.find({}, {
            shipmentCode: 1,
            pallet: 1,
            boxName: 1,
            orderNumber: 1,
            productName: 1,
            quantity: 1,
            barcode: 1,
            availableOrders: 1,
            shippingDate: 1,
            _id: 0
        }).sort({ boxName: 1, barcode: 1 });
        
        console.log(`조회된 데이터: 총 ${data.length}개 항목`);
        res.json(data);
    } catch (error) {
        console.error('Error fetching data:', error);
        res.status(500).json({ error: '데이터 조회 중 오류가 발생했습니다.' });
    }
});

server.listen(PORT, () => {
  console.log(`서버 실행 중 👉 http://localhost:${PORT}`);
});
