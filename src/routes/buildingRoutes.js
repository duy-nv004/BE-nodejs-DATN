const express = require('express');
const fs = require('fs');
const router = express.Router();
const { 
  createBuilding,
  updateBuilding,
  createRoom,
  getBuildings,
  getBuildingDetail,
  deleteBuilding,
  getRooms,
  updateRoom,
  deleteRoom,
  getTenants,
  updateTenant,
  deleteTenant,
  getLandlordSupportRequests,
  updateSupportRequestStatus,
  updateBuildingService
} = require('../controllers/buildingController');
const { getLandlordBookings, updateBookingStatus } = require('../controllers/publicController');
const { protect, authorize } = require('../middleware/authMiddleware');
const { checkBuildingLimit, checkRoomLimit } = require('../middleware/checkLimit');
const { updateRoomReadings, checkMeterAnomaly } = require('../controllers/meterController');
const upload = require('../middleware/upload');

const uploadRoomImages = (req, res, next) =>
  upload.rooms.array('roomImages', 5)(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message });
    next();
  });

const checkRoomLimitClean = (req, res, next) =>
  checkRoomLimit(req, res, (err) => {
    if (err) {
      for (const f of req.files || []) fs.unlink(f.path, () => {});
      return next(err);
    }
    next();
  });

// Tất cả các lệnh dưới đây chỉ dành cho Landlord
router.use(protect, authorize('landlord'));

// 1. Quản lý tòa nhà (Buildings)
router.post('/buildings', checkBuildingLimit, createBuilding);
router.get('/buildings', getBuildings);
router.get('/buildings/:id', getBuildingDetail);
router.put('/buildings/:id', updateBuilding);
router.delete('/buildings/:id', deleteBuilding);
router.put('/buildings/:id/service', updateBuildingService);

// 2. Quản lý phòng trọ (Rooms)
router.post('/rooms', uploadRoomImages, checkRoomLimitClean, createRoom);
router.get('/rooms', getRooms);
router.put('/rooms/:id', uploadRoomImages, updateRoom);
router.delete('/rooms/:id', deleteRoom);

// 3. Chốt số điện nước
router.post('/meter-readings/sync', updateRoomReadings);
router.post('/meter-readings/check-anomaly', checkMeterAnomaly);

// 4. Quản lý khách thuê (Tenants)
router.get('/tenants', getTenants);
router.put('/tenants/:id', updateTenant);
router.delete('/tenants/:id', deleteTenant);

// 5. Quản lý sự cố/báo hỏng (Support Requests)
router.get('/support-requests', getLandlordSupportRequests);
router.put('/support-requests/:id', updateSupportRequestStatus);

// 6. Quản lý lịch xem phòng & đặt cọc từ trang Public
router.get('/bookings', getLandlordBookings);
router.put('/bookings/:id/status', updateBookingStatus);

module.exports = router;