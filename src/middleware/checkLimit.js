const { Op } = require('sequelize');
const Room = require('../models/Room');
const Building = require('../models/Building');
const Plan = require('../models/Plan');
const User = require('../models/User');

const { createError } = require('../utils/errors');

const getPlan = async (user, { transaction } = {}) => {
    const opts = { where: { name: user.plan } };
    if (transaction) opts.transaction = transaction;
    const plan = await Plan.findOne(opts);
    if (!plan) throw createError(500, "Không tìm thấy cấu hình gói cước của người dùng");
    return plan;
};

/** Ném 403 nếu user đã đủ số tòa nhà theo gói. Dùng chung cho middleware và buildingService. */
const assertBuildingLimit = async (user, { transaction } = {}) => {
    const plan = await getPlan(user, { transaction });
    if (plan.maxBuildings === -1) return;
    const countOpts = { where: { landlordId: user.id } };
    if (transaction) countOpts.transaction = transaction;
    const buildingCount = await Building.count(countOpts);
    if (buildingCount >= plan.maxBuildings) {
        throw createError(403, `Gói ${user.plan.toUpperCase()} chỉ cho phép tạo tối đa ${plan.maxBuildings} tòa nhà. Vui lòng nâng cấp!`);
    }
};

/** Ném 403 nếu tòa nhà đã đủ số phòng theo gói. */
const assertRoomLimit = async (user, buildingId, { transaction } = {}) => {
    const plan = await getPlan(user, { transaction });
    if (plan.maxRoomsPerBuilding === -1) return;
    const countOpts = { where: { buildingId } };
    if (transaction) countOpts.transaction = transaction;
    const roomCount = await Room.count(countOpts);
    if (roomCount >= plan.maxRoomsPerBuilding) {
        throw createError(403, `Gói ${user.plan.toUpperCase()} chỉ cho phép tối đa ${plan.maxRoomsPerBuilding} phòng mỗi tòa nhà. Vui lòng nâng cấp!`);
    }
};

// 1. KIỂM TRA GIỚI HẠN SỐ TÒA NHÀ
const checkBuildingLimit = async (req, res, next) => {
    try {
        await assertBuildingLimit(req.user);
        next();
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
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

        await assertRoomLimit(user, buildingId);
        next();
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
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

// Hàng đợi khóa theo userId để chống race condition khi gọi song song Promise.all
const userLocks = new Map();
const withUserLock = async (userId, fn) => {
    const key = String(userId);
    const prev = userLocks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    userLocks.set(key, next.finally(() => {
        if (userLocks.get(key) === next) userLocks.delete(key);
    }));
    return next;
};

/**
 * Trừ 1 lượt quét AI nguyên tử (T1.13). Gọi SAU khi AI đã trả kết quả thành công.
 * Không ném lỗi ra ngoài: đây là bước ghi nhận, hỏng nó không nên làm hỏng request.
 * @param {number} userId
 */
const consumeAILimit = async (userId) => {
    return withUserLock(userId, async () => {
        try {
            const user = await User.findByPk(userId);
            if (!user) return;

            const plan = await Plan.findOne({ where: { name: user.plan } });
            if (plan && plan.maxAICallsPerMonth === -1) return; // gói không giới hạn
            if (plan && plan.maxAICallsPerMonth === 0) return;  // gói không có AI

            const max = plan ? plan.maxAICallsPerMonth : null;
            const period = currentPeriod();

            if (user.lastAiUseMonth !== period) {
                user.lastAiUseMonth = period;
                user.aiUseCountThisMonth = 1;
                let updatedByQuery = false;
                if (typeof User.update === 'function') {
                    try {
                        await User.update(
                            { lastAiUseMonth: period, aiUseCountThisMonth: 1 },
                            {
                                where: {
                                    id: userId,
                                    [Op.or]: [
                                        { lastAiUseMonth: { [Op.ne]: period } },
                                        { lastAiUseMonth: null }
                                    ]
                                }
                            }
                        );
                        updatedByQuery = true;
                    } catch {
                        // Fallback sang user.save() nếu môi trường unit test không có kết nối DB
                    }
                }
                if (!updatedByQuery && typeof user.save === 'function') {
                    await user.save();
                }
                return;
            }

            const currentCount = user.aiUseCountThisMonth || 0;
            if (max != null && max > 0 && currentCount >= max) {
                return;
            }

            const nextCount = currentCount + 1;
            let updatedByQuery = false;
            if (typeof User.update === 'function') {
                try {
                    const whereCond = { id: userId, lastAiUseMonth: period };
                    if (max != null && max > 0) {
                        whereCond.aiUseCountThisMonth = { [Op.lt]: max };
                    }
                    const res = await User.update(
                        { aiUseCountThisMonth: nextCount },
                        { where: whereCond }
                    );
                    const affected = Array.isArray(res) ? res[0] : res;
                    if (affected > 0) {
                        user.aiUseCountThisMonth = nextCount;
                    }
                    updatedByQuery = true;
                } catch {
                    // Fallback sang user.save() nếu môi trường unit test không có kết nối DB
                }
            }

            if (!updatedByQuery) {
                user.aiUseCountThisMonth = nextCount;
                if (typeof user.save === 'function') {
                    await user.save();
                }
            }
        } catch (err) {
            console.error('[checkLimit] Lỗi ghi nhận lượt dùng AI:', err.message);
        }
    });
};

module.exports = { assertBuildingLimit, assertRoomLimit, checkBuildingLimit, checkRoomLimit, checkAILimit, consumeAILimit };
