const express = require('express');
const router = express.Router();
const invoiceController = require('../controllers/invoiceController');

// 1. API Xuất hóa đơn mới (Giai đoạn 5: Tính tiền + Gửi Telegram + VietQR)
// POST: http://localhost:5000/api/invoices/generate
router.post('/generate', invoiceController.generateInvoice);

// 2. API Cập nhật trạng thái thanh toán thủ công (Giai đoạn 6)
router.post('/:id/payment', invoiceController.updatePaymentStatus);

// 3. API Thống kê doanh thu theo tháng (Giai đoạn 7)
// GET: http://localhost:5000/api/invoices/stats?month=4&year=2026
router.get('/status', invoiceController.getRevenueStats);

module.exports = router;