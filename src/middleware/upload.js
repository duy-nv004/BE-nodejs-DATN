const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    // Tên ngẫu nhiên thay vì Date.now(): hai ảnh upload trong cùng một mili-giây
    // sẽ ghi đè lên nhau, và tên gốc do người dùng đặt có thể chứa ký tự phá đường dẫn.
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 2 // CCCD tối đa 2 mặt (trước + sau)
    },
    fileFilter: (req, file, cb) => {
        if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
            return cb(new Error('Chỉ chấp nhận ảnh định dạng JPG, PNG hoặc WEBP.'));
        }
        cb(null, true);
    }
});

module.exports = upload;
