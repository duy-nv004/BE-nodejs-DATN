const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const aiController = require('../controllers/aiController');
const upload = require('../middleware/upload');
const { protect } = require('../middleware/authMiddleware');
const { checkAILimit } = require('../middleware/checkLimit');

// Giới hạn tần suất gọi AI theo IP/user để tránh lạm dụng (T1.13)
const aiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 phút
    max: 20,             // tối đa 20 requests / phút
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Bạn thao tác quét AI quá nhanh, vui lòng thử lại sau 1 phút.' }
});

// Chỉ cho phép người dùng đã đăng nhập sử dụng AI
router.post('/read-meter', protect, aiLimiter, checkAILimit, upload.single('meterImage'), aiController.readMeter);
router.post('/scan-cccd', protect, aiLimiter, checkAILimit, upload.any(), aiController.scanCccd);

module.exports = router;
