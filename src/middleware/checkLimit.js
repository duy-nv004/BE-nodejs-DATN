const Room = require('../models/Room');
const Building = require('../models/Building');
const Plan = require('../models/Plan');
const User = require('../models/User');

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

        if (!buildingId) {
            return res.status(400).json({ message: "Thiếu thông tin Tòa nhà" });
        }

        // Xác minh tòa nhà có tồn tại và thuộc landlord đang gọi hay không
        const building = await Building.findOne({ where: { id: buildingId, landlordId: user.id } });
        if (!building) {
            return res.status(404).json({ message: "Tòa nhà không tồn tại hoặc bạn không có quyền truy cập" });
        }

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

// 3. KIỂM TRA HẠN MỨC GỌI AI ĐỌC ĐỒNG HỒ HÀNG THÁNG
//
// Middleware này CHỈ kiểm tra, KHÔNG trừ lượt. Việc trừ lượt nằm ở consumeAILimit()
// và chỉ được gọi sau khi AI xử lý thành công — nếu trừ ngay ở đây thì upload thiếu
// file, ảnh quá nặng hay AI không đọc được số vẫn làm người dùng mất một lượt.

/** Tháng hiện tại dạng YYYY-MM */
const currentPeriod = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

/** Số lượt AI đã dùng trong tháng hiện tại (0 nếu đã sang tháng mới) */
const getUsedThisMonth = (user) =>
    user.lastAiUseMonth === currentPeriod() ? (user.aiUseCountThisMonth || 0) : 0;

const checkAILimit = async (req, res, next) => {
    try {
        const user = req.user;
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

        if (getUsedThisMonth(user) >= plan.maxAICallsPerMonth) {
            return res.status(403).json({
                message: `Bạn đã sử dụng hết hạn mức quét ảnh AI trong tháng này (${plan.maxAICallsPerMonth} lượt). Vui lòng nâng cấp lên gói Pro để không giới hạn!`
            });
        }

        next();
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

/**
 * Trừ 1 lượt quét AI. Gọi SAU khi AI đã trả kết quả thành công.
 * Không ném lỗi ra ngoài: đây là bước ghi nhận, hỏng nó không nên làm hỏng request.
 * @param {number} userId
 */
const consumeAILimit = async (userId) => {
    try {
        const user = await User.findByPk(userId);
        if (!user) return;

        const plan = await Plan.findOne({ where: { name: user.plan } });
        if (plan && plan.maxAICallsPerMonth === -1) return; // gói không giới hạn

        const period = currentPeriod();
        if (user.lastAiUseMonth !== period) {
            user.lastAiUseMonth = period;
            user.aiUseCountThisMonth = 1;
        } else {
            user.aiUseCountThisMonth = (user.aiUseCountThisMonth || 0) + 1;
        }
        await user.save();
    } catch (err) {
        console.error('[checkLimit] Lỗi ghi nhận lượt dùng AI:', err.message);
    }
};

module.exports = { checkBuildingLimit, checkRoomLimit, checkAILimit, consumeAILimit };