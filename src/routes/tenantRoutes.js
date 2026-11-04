const express = require('express');
const router = express.Router();
const { 
  getDashboardSummary, 
  getInvoices, 
  getSupportRequests, 
  createSupportRequest,
  signContract,
  rejectContract,
  createContractRequest,
  getContractRequests,
  listOccupants,
  addOccupant
} = require('../controllers/tenantController');
const { protect, authorize } = require('../middleware/authMiddleware');
const upload = require('../middleware/upload');

// Bọc multer để lỗi sai định dạng / quá 5MB / quá 2 ảnh trả JSON 400 thay vì 500
const uploadSupportImages = (req, res, next) =>
  upload.support.array('images', 2)(req, res, err => err ? res.status(400).json({ message: err.message }) : next());

// Áp dụng bảo mật cho toàn bộ các route bên dưới
router.use(protect);
router.use(authorize('tenant'));

router.get('/summary', getDashboardSummary);
router.get('/invoices', getInvoices);
router.get('/support', getSupportRequests);
router.post('/support', uploadSupportImages, createSupportRequest);
router.post('/contract/:id/sign', signContract);
router.post('/contract/:id/reject', rejectContract);
router.post('/contract/:id/requests', createContractRequest);
router.get('/requests', getContractRequests);
router.get('/contract/:id/occupants', listOccupants);
// Thêm người ở bắt buộc kèm ảnh CCCD 2 mặt (multipart) làm minh chứng tạm trú
router.post('/contract/:id/occupants', (req, res, next) =>
  upload.cccd.fields([{ name: 'cccdFront', maxCount: 1 }, { name: 'cccdBack', maxCount: 1 }])(req, res,
    err => err ? res.status(400).json({ message: err.message }) : next()),
  addOccupant);

module.exports = router;
