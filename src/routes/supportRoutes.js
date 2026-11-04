const express = require('express');
const router = express.Router();
const { getSupportImage } = require('../controllers/supportController');
const { protect } = require('../middleware/authMiddleware');

// Ảnh sự cố là dữ liệu riêng: bắt buộc đăng nhập, quyền xét theo từng yêu cầu trong service
router.use(protect);
router.get('/:requestId/images/:filename', getSupportImage);

module.exports = router;
