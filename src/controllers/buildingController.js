const buildingService = require('../services/buildingService');
const supportService = require('../services/supportService');

// 1. TẠO TÒA NHÀ
exports.createBuilding = async (req, res) => {
    try {
        const result = await buildingService.createBuilding(req.user.id, req.body);
        res.status(201).json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 2. TẠO PHÒNG
exports.createRoom = async (req, res) => {
    try {
        const result = await buildingService.createRoom(req.body);
        res.status(201).json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 3. LẤY DANH SÁCH TÒA NHÀ
exports.getBuildings = async (req, res) => {
    try {
        const result = await buildingService.getBuildings(req.user.id);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 4. LẤY CHI TIẾT TÒA NHÀ
exports.getBuildingDetail = async (req, res) => {
    try {
        const result = await buildingService.getBuildingDetail(req.user.id, req.params.id);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 5. XÓA TÒA NHÀ
exports.deleteBuilding = async (req, res) => {
    try {
        const result = await buildingService.deleteBuilding(req.user.id, req.params.id);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 6. LẤY DANH SÁCH TOÀN BỘ PHÒNG
exports.getRooms = async (req, res) => {
    try {
        const result = await buildingService.getRooms(req.user.id);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 7. CẬP NHẬT PHÒNG
exports.updateRoom = async (req, res) => {
    try {
        const result = await buildingService.updateRoom(req.user.id, req.params.id, req.body);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 8. XÓA PHÒNG
exports.deleteRoom = async (req, res) => {
    try {
        const result = await buildingService.deleteRoom(req.user.id, req.params.id);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 9. LẤY DANH SÁCH KHÁCH THUÊ
exports.getTenants = async (req, res) => {
    try {
        const result = await buildingService.getTenants(req.user.id);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 10. CẬP NHẬT KHÁCH THUÊ
exports.updateTenant = async (req, res) => {
    try {
        const result = await buildingService.updateTenant(req.user.id, req.params.id, req.body);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 11. XÓA KHÁCH THUÊ
exports.deleteTenant = async (req, res) => {
    try {
        const result = await buildingService.deleteTenant(req.user.id, req.params.id);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 12. CHỦ NHÀ XEM DANH SÁCH SỰ CỐ / BÁO HỎNG
exports.getLandlordSupportRequests = async (req, res) => {
    try {
        const result = await supportService.getLandlordRequests(req.user.id);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 13. CHỦ NHÀ CẬP NHẬT TRẠNG THÁI SỰ CỐ
exports.updateSupportRequestStatus = async (req, res) => {
    try {
        const result = await supportService.updateRequestStatus(req.user.id, req.params.id, req.body);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 14. CHỦ NHÀ CẬP NHẬT ĐƠN GIÁ DỊCH VỤ CHUNG CỦA TÒA NHÀ
exports.updateBuildingService = async (req, res) => {
    try {
        const result = await buildingService.updateBuildingService(req.user.id, req.params.id, req.body);
        res.json({ message: "Cập nhật đơn giá dịch vụ tòa nhà thành công!", service: result });
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};