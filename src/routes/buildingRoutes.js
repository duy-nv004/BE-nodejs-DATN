const express = require('express');
const router = express.Router();
const { createBuilding, createRoom } = require('../controllers/buildingController');
const { protect, authorize } = require('../middleware/authMiddleware');
const { checkRoomLimit } = require('../middleware/checkLimit');
const { updateRoomReadings } = require('../controllers/meterController');


// Tất cả các lệnh dưới đây chỉ dành cho Landlord
router.use(protect, authorize('landlord'));

router.post('/buildings', createBuilding);
router.post('/rooms', checkRoomLimit, createRoom); // Kiểm tra giới hạn trước khi tạo
// Route chốt cả điện và nước trong 1 lần gửi
router.post('/meter-readings/sync', updateRoomReadings);

module.exports = router;