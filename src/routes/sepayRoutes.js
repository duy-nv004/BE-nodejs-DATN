const express = require('express');
const router = express.Router();
const sepayController = require('../controllers/sepayController');

// Webhook endpoint nhận từ SePay (không yêu cầu JWT auth để server SePay có thể gửi POST)
router.post('/webhook', sepayController.handleWebhook);

// Endpoint lấy cấu hình tài khoản ngân hàng nhận tiền công khai
router.get('/config', sepayController.getPaymentConfig);

module.exports = router;
