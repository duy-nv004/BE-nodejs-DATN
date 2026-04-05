const express = require('express');
const router = express.Router();
const { createContract } = require('../controllers/contractController');
const { protect, authorize } = require('../middleware/authMiddleware');
const invoiceController = require('../controllers/invoiceController');

router.post('/create', protect, authorize('landlord'), createContract);
router.post('/invoices/generate', protect, authorize('landlord'), invoiceController.generateInvoice);

module.exports = router;