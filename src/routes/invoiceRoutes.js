const express = require('express');
const router = express.Router();
const invoiceController = require('../controllers/invoiceController');
const { protect, authorize } = require('../middleware/authMiddleware');

// Tất cả các API hóa đơn dịch vụ yêu cầu xác thực JWT và quyền landlord
router.use(protect, authorize('landlord'));

router.post('/generate', invoiceController.generateInvoice);
router.post('/:id/payment', invoiceController.updatePaymentStatus);
router.get('/status', invoiceController.getRevenueStats);

module.exports = router;