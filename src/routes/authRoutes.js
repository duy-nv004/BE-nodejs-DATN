const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

// Route công khai (không cần đăng nhập) nên giới hạn theo IP để chặn spam đơn khiếu nại
const appealLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 phút
  max: 5,                   // 5 đơn / IP / 15 phút
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Bạn gửi khiếu nại quá nhiều lần, vui lòng thử lại sau 15 phút.' }
});
const {
  registerLandlord,
  login,
  refreshToken,
  logout,
  createTenant,
  updateProfile,
  changePassword,
  getPlans,
  upgradeRequest,
  cancelUpgradeRequest,
  getProfile,
  getTelegramLink,
  createAppeal
} = require('../controllers/authController');
const { protect, authorize } = require('../middleware/authMiddleware');

router.post('/register', registerLandlord);
router.post('/login', login);
router.post('/refresh-token', refreshToken);
router.post('/logout', logout);
router.post('/appeal', appealLimiter, createAppeal);
router.post('/create-tenant', protect, authorize('landlord'), createTenant);

// Cập nhật thông tin cá nhân & đổi mật khẩu
router.get('/profile', protect, getProfile);
router.put('/profile', protect, updateProfile);
router.put('/change-password', protect, changePassword);

// Sinh link liên kết Telegram Bot (token ngắn hạn, dùng một lần)
router.get('/telegram-link', protect, getTelegramLink);

// SaaS Plans & Đăng ký gói cước mới cho chủ nhà
router.get('/plans', protect, getPlans);
router.post('/upgrade-request', protect, authorize('landlord'), upgradeRequest);
router.delete('/upgrade-request/:id', protect, authorize('landlord'), cancelUpgradeRequest);
router.delete('/upgrade-request', protect, authorize('landlord'), cancelUpgradeRequest);
router.post('/upgrade-request/cancel', protect, authorize('landlord'), cancelUpgradeRequest);

module.exports = router;