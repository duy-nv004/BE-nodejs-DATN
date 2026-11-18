const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const {
    getPublicRooms,
    getPublicLocations,
    getPublicRoomDetail,
    getRoomImage,
    createPublicBooking,
    getPublicBookingStatus,
    markBookingTransferred
} = require('../controllers/publicController');

const bookingLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Bạn gửi quá nhiều yêu cầu đặt phòng. Vui lòng thử lại sau ít phút.' }
});

const statusLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Bạn kiểm tra trạng thái quá nhanh, vui lòng thử lại sau ít giây.' }
});

router.get('/rooms', getPublicRooms);
router.get('/locations', getPublicLocations);
router.get('/rooms/:id', getPublicRoomDetail);
router.get('/room-images/:filename', getRoomImage);
router.post('/bookings', bookingLimiter, createPublicBooking);
router.get('/bookings/:id/status', statusLimiter, getPublicBookingStatus);
router.post('/bookings/:id/mark-transferred', bookingLimiter, markBookingTransferred);

module.exports = router;
