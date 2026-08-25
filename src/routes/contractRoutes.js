const express = require('express');
const router = express.Router();
const { 
  createContract, 
  getContracts, 
  getContractDetail, 
  terminateContract,
  cancelContract 
} = require('../controllers/contractController');
const { protect, authorize } = require('../middleware/authMiddleware');
const invoiceController = require('../controllers/invoiceController');

// Tất cả các lệnh dưới đây chỉ dành cho Landlord
router.use(protect, authorize('landlord'));

router.post('/create', createContract);
router.get('/', getContracts);
router.get('/:id', getContractDetail);
router.put('/:id', terminateContract);
router.put('/:id/cancel', cancelContract);

// Thừa hưởng phát sinh hóa đơn cho hợp đồng
router.post('/invoices/generate', invoiceController.generateInvoice);

module.exports = router;