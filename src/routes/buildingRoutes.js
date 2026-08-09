const express = require('express');
const router = express.Router();
const { 
  createBuilding, 
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
const { protect, authorize } = require('../middleware/authMiddleware');
const { checkBuildingLimit, checkRoomLimit } = require('../middleware/checkLimit');
const { updateRoomReadings } = require('../controllers/meterController');

// Tất cả các lệnh dưới đây chỉ dành cho Landlord
router.use(protect, authorize('landlord'));

// 1. Quản lý tòa nhà (Buildings)
router.post('/buildings', checkBuildingLimit, createBuilding);
router.get('/buildings', getBuildings);
router.get('/buildings/:id', getBuildingDetail);
router.delete('/buildings/:id', deleteBuilding);
router.put('/buildings/:id/service', updateBuildingService);

// 2. Quản lý phòng trọ (Rooms)
router.post('/rooms', checkRoomLimit, createRoom);
router.get('/rooms', getRooms);
router.put('/rooms/:id', updateRoom);
router.delete('/rooms/:id', deleteRoom);

// 3. Chốt số điện nước
router.post('/meter-readings/sync', updateRoomReadings);

// 4. Quản lý khách thuê (Tenants)
router.get('/tenants', getTenants);
router.put('/tenants/:id', updateTenant);
router.delete('/tenants/:id', deleteTenant);

// 5. Quản lý sự cố/báo hỏng (Support Requests)
router.get('/support-requests', getLandlordSupportRequests);
router.put('/support-requests/:id', updateSupportRequestStatus);

module.exports = router;