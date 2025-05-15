const mongoose = require('mongoose');

const newOrderSchema = new mongoose.Schema({
    발주번호: String,
    입고예정일: String,
    물류센터: String,
    상품수: Number,
    발주수량: Number,
    확정수량: Number,
    스캔수량: { type: Number, default: 0 },
    상품정보: [{
        상품번호: String,
        상품바코드: String,
        상품이름: String,
        발주수량: Number,
        확정수량: Number,
        스캔수량: { type: Number, default: 0 },
        '유통(소비)기한': String,
        제조일자: String,
        생산년도: String,
        납품부족사유: String,
        회송담당자: String,
        '회송담당자 연락처': String,
        회송지주소: String,
        매입가: Number,
        공급가: Number,
        부가세: Number,
        '총발주 매입금': Number,
        입고유형: String,
        발주상태: String,
        발주등록일시: String,
        입고1: { type: String, default: '-' },
        입고2: { type: String, default: '-' },
        위치: { type: String, default: '-' },
        박스정보: String
    }]
});

module.exports = mongoose.model('NewOrder', newOrderSchema, 'newOrders'); 