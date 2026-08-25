const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');
const upload = require('../middleware/upload');
const { protect } = require('../middleware/authMiddleware');
const { checkAILimit } = require('../middleware/checkLimit');

// Chỉ cho phép người dùng đã đăng nhập sử dụng AI
router.post('/read-meter', protect, checkAILimit, upload.single('meterImage'), aiController.readMeter);
router.post('/scan-cccd', protect, checkAILimit, upload.any(), aiController.scanCccd);

module.exports = router;