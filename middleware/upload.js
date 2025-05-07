const multer = require('multer');

// 메모리에 파일 저장
const storage = multer.memoryStorage();

const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
            cb(null, true);
        } else {
            cb(new Error('Excel 파일만 업로드 가능합니다.'), false);
        }
    }
});

module.exports = upload; 