const express = require('express');
const router = express.Router();
const { 
  getDashboardSummary, 
  getInvoices, 
  getSupportRequests, 
  createSupportRequest 
} = require('../controllers/tenantController');
const { protect, authorize } = require('../middleware/authMiddleware');

// Áp dụng bảo mật cho toàn bộ các route bên dưới
router.use(protect);
router.use(authorize('tenant'));

router.get('/summary', getDashboardSummary);
router.get('/invoices', getInvoices);
router.get('/support', getSupportRequests);
router.post('/support', createSupportRequest);

module.exports = router;
