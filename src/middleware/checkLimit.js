const Room = require('../models/Room');
const Building = require('../models/Building');
const Plan = require('../models/Plan');

// 1. KIỂM TRA GIỚI HẠN SỐ TÒA NHÀ
const checkBuildingLimit = async (req, res, next) => {
    try {
        const user = req.user;
        const plan = await Plan.findOne({ where: { name: user.plan } });
        
        if (!plan) {
            return res.status(500).json({ message: "Không tìm thấy cấu hình gói cước của người dùng" });
        }

        const buildingCount = await Building.count({ where: { landlordId: user.id } });
        if (buildingCount >= plan.maxBuildings) {
            return res.status(403).json({ 
                message: `Gói ${user.plan.toUpperCase()} chỉ cho phép tạo tối đa ${plan.maxBuildings} tòa nhà. Vui lòng nâng cấp!` 
            });
        }
        next();
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// 2. KIỂM TRA GIỚI HẠN SỐ PHÒNG TRONG MỖI TÒA NHÀ
const checkRoomLimit = async (req, res, next) => {
    try {
        const { buildingId } = req.body;
        const user = req.user;

        const plan = await Plan.findOne({ where: { name: user.plan } });
        if (!plan) {
            return res.status(500).json({ message: "Không tìm thấy cấu hình gói cước của người dùng" });
        }

        const roomCount = await Room.count({ where: { buildingId } });
        if (roomCount >= plan.maxRoomsPerBuilding) {
            return res.status(403).json({ 
                message: `Gói ${user.plan.toUpperCase()} chỉ cho phép tối đa ${plan.maxRoomsPerBuilding} phòng mỗi tòa nhà. Vui lòng nâng cấp!` 
            });
        }
        next();
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// 3. KIỂM TRA GIỚI HẠN HẠN MỨC GỌI AI ĐỌC ĐỒNG HỒ HÀNG THÁNG
const checkAILimit = async (req, res, next) => {
    try {
        const user = req.user; // Lấy từ protect middleware
        const plan = await Plan.findOne({ where: { name: user.plan } });

        if (!plan) {
            return res.status(500).json({ message: "Không tìm thấy cấu hình gói cước" });
        }

        // Quyền dùng AI = 0 (tương đương false / không cho dùng)
        if (plan.maxAICallsPerMonth === 0) {
            return res.status(403).json({ 
                message: `Gói ${user.plan.toUpperCase()} hiện tại của bạn không hỗ trợ tính năng đọc số bằng AI. Vui lòng nâng cấp gói cước!` 
            });
        }

        // Không giới hạn (-1)
        if (plan.maxAICallsPerMonth === -1) {
            return next();
        }

        // Lấy tháng hiện tại dưới dạng YYYY-MM
        const now = new Date();
        const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

        // Reset bộ đếm nếu bước sang tháng mới
        if (user.lastAiUseMonth !== currentMonth) {
            user.lastAiUseMonth = currentMonth;
            user.aiUseCountThisMonth = 0;
        }

        // Kiểm tra xem đã vượt quá giới hạn chưa
        if (user.aiUseCountThisMonth >= plan.maxAICallsPerMonth) {
            return res.status(403).json({
                message: `Bạn đã sử dụng hết hạn mức quét ảnh AI trong tháng này (${plan.maxAICallsPerMonth} lượt). Vui lòng nâng cấp lên gói Pro để không giới hạn!`
            });
        }

        // Cộng dồn lượt sử dụng và tiếp tục
        user.aiUseCountThisMonth += 1;
        await user.save();
        next();
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

module.exports = { checkBuildingLimit, checkRoomLimit, checkAILimit };