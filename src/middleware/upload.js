const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Ảnh sự cố lưu riêng ở uploads/support/ (S1). Từ R4 thư mục này KHÔNG còn public:
// ảnh chỉ tải được qua /api/support/:requestId/images/:filename sau khi kiểm quyền.
if (!fs.existsSync('./uploads/support')) fs.mkdirSync('./uploads/support', { recursive: true });
// Ảnh CCCD lưu kèm hợp đồng / tạm trú ở uploads/cccd/, cũng không public:
// chỉ tải qua API hợp đồng sau khi kiểm quyền chủ nhà.
if (!fs.existsSync('./uploads/cccd')) fs.mkdirSync('./uploads/cccd', { recursive: true });

const makeUpload = (dir) => multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, dir),
        // Tên ngẫu nhiên thay vì Date.now(): hai ảnh upload trong cùng một mili-giây
        // sẽ ghi đè lên nhau, và tên gốc do người dùng đặt có thể chứa ký tự phá đường dẫn.
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
        }
    }),
    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 2 // CCCD tối đa 2 mặt (trước + sau), ảnh sự cố tối đa 2 ảnh
    },
    fileFilter: (req, file, cb) => {
        if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
            return cb(new Error('Chỉ chấp nhận ảnh định dạng JPG, PNG hoặc WEBP.'));
        }
        cb(null, true);
    }
});

const upload = makeUpload('uploads/');
upload.support = makeUpload('uploads/support/');
upload.cccd = makeUpload('uploads/cccd/');

module.exports = upload;
