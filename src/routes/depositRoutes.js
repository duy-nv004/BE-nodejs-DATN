const express = require('express');
const router = express.Router();
const { getDepositRecords, refundDeposit } = require('../controllers/depositController');
const { protect, authorize } = require('../middleware/authMiddleware');

// Quản lý tiền cọc dành cho chủ nhà
router.use(protect, authorize('landlord'));

router.get('/contract/:contractId', getDepositRecords);
router.post('/contract/:contractId/refund', refundDeposit);

module.exports = router;