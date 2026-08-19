const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { protect, authorize } = require('../middleware/authMiddleware');

// Tất cả các route quản trị đều yêu cầu xác thực JWT và quyền 'admin'
router.use(protect, authorize('admin'));

router.get('/stats', adminController.getSystemStats);
router.get('/landlords', adminController.getLandlords);
router.put('/landlords/:id/plan', adminController.updateLandlordPlan);
router.put('/landlords/:id/status', adminController.updateLandlordStatus);

// Quản lý gói cước dịch vụ (Plans)
router.get('/plans', adminController.getPlans);
router.put('/plans/:id', adminController.updatePlan);

// Nhật ký hoạt động
router.get('/logs', adminController.getAdminLogs);

// Quản lý ticket khiếu nại
router.get('/tickets', adminController.getTickets);
router.put('/tickets/:id/resolve', adminController.resolveTicket);

module.exports = router;
