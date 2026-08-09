const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { protect, authorize } = require('../middleware/authMiddleware');

// Tất cả các route quản trị đều yêu cầu xác thực JWT và quyền 'admin'
router.use(protect, authorize('admin'));

router.get('/stats', adminController.getSystemStats);
router.get('/landlords', adminController.getLandlords);
router.put('/landlords/:id/plan', adminController.updateLandlordPlan);

// Quản lý gói cước dịch vụ (Plans)
router.get('/plans', adminController.getPlans);
router.put('/plans/:id', adminController.updatePlan);

module.exports = router;
