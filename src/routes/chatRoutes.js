const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const chatController = require('../controllers/chatController');
const { protect } = require('../middleware/authMiddleware');

// Giới hạn theo tài khoản (chạy sau protect nên đã có req.user) để chặn spam tốn chi phí AI
const chatLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 phút
    max: 10,             // 10 câu hỏi / người dùng / phút
    keyGenerator: (req) => `chat:${req.user.id}`,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Bạn hỏi hơi nhanh, vui lòng đợi một chút rồi thử lại.' }
});

// Giới hạn tần suất thực thi thao tác qua chatbot (T2.16)
const executeLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 phút
    max: 15,             // 15 thao tác / người dùng / phút
    keyGenerator: (req) => `chat-execute:${req.user.id}`,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Bạn xác nhận thao tác quá nhanh, vui lòng đợi một chút rồi thử lại.' }
});

router.post('/', protect, chatLimiter, chatController.chat);

// Thực thi tool sau xác nhận của người dùng (mỗi lần bấm Xác nhận = 1 call có chủ đích)
router.post('/execute', protect, executeLimiter, chatController.execute);

module.exports = router;
