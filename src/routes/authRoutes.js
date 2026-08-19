const express = require('express');
const router = express.Router();
const { 
  registerLandlord, 
  login, 
  createTenant, 
  updateProfile, 
  changePassword,
  getPlans,
  upgradeRequest,
  getProfile,
  createAppeal
} = require('../controllers/authController');
const { protect, authorize } = require('../middleware/authMiddleware');

router.post('/register', registerLandlord);
router.post('/login', login);
router.post('/appeal', createAppeal);
router.post('/create-tenant', protect, authorize('landlord'), createTenant);

// Cập nhật thông tin cá nhân & đổi mật khẩu
router.get('/profile', protect, getProfile);
router.put('/profile', protect, updateProfile);
router.put('/change-password', protect, changePassword);

// SaaS Plans & Đăng ký gói cước mới cho chủ nhà
router.get('/plans', protect, getPlans);
router.post('/upgrade-request', protect, upgradeRequest);

module.exports = router;