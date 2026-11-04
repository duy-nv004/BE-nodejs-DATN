const express = require('express');
const router = express.Router();
const {
  createContract,
  getContracts,
  getContractDetail,
  terminateContract,
  cancelContract,
  renewContract,
  settlementPreview,
  getRequests,
  respondRequest,
  listOccupants,
  addOccupant,
  updateOccupant,
  removeOccupant,
  getCccdImage
} = require('../controllers/contractController');
const { protect, authorize } = require('../middleware/authMiddleware');
const upload = require('../middleware/upload');
const invoiceController = require('../controllers/invoiceController');

// Tất cả các lệnh dưới đây chỉ dành cho Landlord
router.use(protect, authorize('landlord'));

// Nhận kèm ảnh CCCD 2 mặt (multipart). Request JSON không có file vẫn đi qua như cũ.
router.post('/create', (req, res, next) =>
  upload.cccd.fields([{ name: 'cccdFront', maxCount: 1 }, { name: 'cccdBack', maxCount: 1 }])(req, res,
    err => err ? res.status(400).json({ message: err.message }) : next()),
  createContract);
router.get('/', getContracts);
// Khai báo trước '/:id' để '/:id' không bắt mất 'requests'
router.get('/requests', getRequests);
router.put('/requests/:requestId', respondRequest);
router.put('/occupants/:occupantId', updateOccupant);
router.delete('/occupants/:occupantId', removeOccupant);
router.get('/:id/cccd-images/:filename', getCccdImage);
router.get('/:id', getContractDetail);
// PUT /:id giữ cho client cũ, cùng controller với POST /:id/terminate
router.put('/:id', terminateContract);
router.post('/:id/terminate', terminateContract);
router.post('/:id/settlement-preview', settlementPreview);
router.put('/:id/cancel', cancelContract);
router.post('/:id/renew', renewContract);
router.get('/:id/occupants', listOccupants);
// Thêm người ở có thể kèm ảnh CCCD 2 mặt (multipart); request JSON không file vẫn đi qua
router.post('/:id/occupants', (req, res, next) =>
  upload.cccd.fields([{ name: 'cccdFront', maxCount: 1 }, { name: 'cccdBack', maxCount: 1 }])(req, res,
    err => err ? res.status(400).json({ message: err.message }) : next()),
  addOccupant);

// Thừa hưởng phát sinh hóa đơn cho hợp đồng
router.post('/invoices/generate', invoiceController.generateInvoice);

module.exports = router;