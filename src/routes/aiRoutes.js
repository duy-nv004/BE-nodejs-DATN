const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');
const upload = require('../middleware/upload');
const { protect } = require('../middleware/authMiddleware');

// Chỉ cho phép người dùng đã đăng nhập sử dụng AI
router.post('/read-meter', protect, upload.single('meterImage'), aiController.readMeter);

module.exports = router;