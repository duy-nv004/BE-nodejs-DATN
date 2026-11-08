const express = require('express');
const router = express.Router();
const { 
  getNotifications, 
  markAsRead, 
  markAllAsRead,
  streamNotifications
} = require('../controllers/notificationController');
const { protect } = require('../middleware/authMiddleware');

// Bảo vệ tất cả các tuyến đường thông báo
router.use(protect);

router.get('/stream', streamNotifications);
router.get('/', getNotifications);
router.put('/read-all', markAllAsRead);
router.put('/:id/read', markAsRead);

module.exports = router;
