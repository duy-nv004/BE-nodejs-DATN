const User = require('../models/User');
const PlanUpgradeRequest = require('../models/PlanUpgradeRequest');
const notificationService = require('./notificationService');
const { Op } = require('sequelize');
const { todayVN, isExpiredVN, daysRemainingVN, addPlanDaysVN } = require('../utils/dateVN');
const { normalizeCycle, planPriceVnd, buildTransferCode } = require('../utils/planPricing');
const { createError } = require('../utils/errors');

const PENDING_UPGRADE_TTL_MS = 48 * 60 * 60 * 1000;
const DEFAULT_PLAN_WEIGHTS = { basic: 1, pro: 2 };

/**
 * Tính hạn gói mới theo múi giờ Việt Nam (T1.16 & T1.17):
 * - Nếu gói cũ hết hạn hoặc đang ở free: tính từ hôm nay (todayVN) + daysToAdd.
 * - Nếu gia hạn cùng gói trả phí còn hạn: cộng nối tiếp từ hạn hiện tại + daysToAdd.
 * - Nếu đổi giữa 2 gói trả phí khi gói cũ còn hạn: quy đổi số ngày còn lại theo tỷ lệ
 *   giá gói cũ / gói mới rồi cộng thêm kỳ mới từ hôm nay (không làm mất ngày đã trả).
 */
const computeConvertedPlanExpiry = ({
    oldPlan,
    oldExpiresAt,
    newPlan,
    daysToAdd,
    oldPrice,
    newPrice,
    now = new Date(),
}) => {
    const today = todayVN(now);
    const hasRemaining = oldPlan && oldPlan !== 'free' && oldExpiresAt && !isExpiredVN(oldExpiresAt, now);
    const remainingDays = hasRemaining ? daysRemainingVN(oldExpiresAt, now) : 0;

    if (remainingDays <= 0) {
        return addPlanDaysVN(today, daysToAdd, now);
    }

    if (oldPlan === newPlan) {
        return addPlanDaysVN(oldExpiresAt, daysToAdd, now);
    }

    const parsedOld = parseFloat(oldPrice) || 0;
    const parsedNew = parseFloat(newPrice) || 0;
    const ratio = (parsedOld > 0 && parsedNew > 0)
        ? (parsedOld / parsedNew)
        : ((DEFAULT_PLAN_WEIGHTS[oldPlan] || 1) / (DEFAULT_PLAN_WEIGHTS[newPlan] || 1));

    const convertedDays = Math.round(remainingDays * ratio);
    return addPlanDaysVN(today, convertedDays + (Number(daysToAdd) || 0), now);
};

/**
 * Đồng bộ hạn sử dụng gói cước cho MỘT người dùng theo múi giờ Việt Nam (T1.17).
 *
 * @param {object} user - instance User (đã có id, plan, planExpiresAt)
 * @param {Date|string} [now] - thời điểm tham chiếu
 * @returns {Promise<{expired: boolean, oldPlan?: string}>}
 */
const syncExpiredPlan = async (user, now = new Date()) => {
    if (!user || !user.plan || user.plan === 'free' || !user.planExpiresAt) {
        return { expired: false };
    }

    if (!isExpiredVN(user.planExpiresAt, now)) {
        return { expired: false };
    }

    const oldPlan = user.plan;
    user.plan = 'free';
    user.planExpiresAt = null;
    user.billingCycle = null;
    user.planSource = null;
    await user.save();

    return { expired: true, oldPlan };
};

/**
 * Quét toàn bộ tài khoản đã quá hạn theo múi giờ Việt Nam, đưa về gói Miễn Phí
 * và gửi thông báo cho từng chủ nhà bị hạ gói (T1.17).
 *
 * @param {Date|string} [now]
 * @returns {Promise<{updatedCount: number, expiredUsers: Array}>}
 */
const expireAllOverduePlans = async (now = new Date()) => {
    const today = todayVN(now);
    const whereOverdue = {
        plan: { [Op.ne]: 'free' },
        planExpiresAt: { [Op.lt]: today },
    };

    let expiredUsers = [];
    if (typeof User.findAll === 'function') {
        try {
            expiredUsers = (await User.findAll({
                where: whereOverdue,
                attributes: ['id', 'name', 'email', 'plan', 'planExpiresAt'],
            })) || [];
        } catch {
            expiredUsers = [];
        }
    }

    const [updatedCount] = await User.update(
        { plan: 'free', planExpiresAt: null, billingCycle: null, planSource: null },
        { where: whereOverdue }
    );

    if (expiredUsers.length > 0 && notificationService && typeof notificationService.createNotification === 'function') {
        await Promise.all(
            expiredUsers.map((u) =>
                Promise.resolve(
                    notificationService.createNotification(
                        u.id,
                        'Gói dịch vụ đã hết hạn',
                        `Gói ${String(u.plan || '').toUpperCase()} của bạn đã hết hạn (${u.planExpiresAt}) và được chuyển về gói Miễn Phí (FREE).`,
                        'plan_expiry',
                        u.id
                    )
                ).catch(() => {})
            )
        );
    }

    return {
        updatedCount,
        expiredUsers,
        valueOf() { return updatedCount; },
        toString() { return String(updatedCount); },
        [Symbol.toPrimitive](hint) {
            return hint === 'string' ? String(updatedCount) : updatedCount;
        },
    };
};

/**
 * Đánh dấu các yêu cầu nâng cấp gói đang pending quá 48 giờ thành expired (T2.12).
 *
 * @param {Date|string} [now]
 * @returns {Promise<number>} số bản ghi đã chuyển sang expired
 */
const expirePendingUpgradeRequests = async (now = new Date()) => {
    const cutoff = new Date(new Date(now).getTime() - PENDING_UPGRADE_TTL_MS);
    const [updatedCount] = await PlanUpgradeRequest.update(
        { status: 'expired' },
        {
            where: {
                status: 'pending',
                createdAt: { [Op.lt]: cutoff },
            },
        }
    );
    return updatedCount;
};

/**
 * Tạo mới hoặc tái sử dụng yêu cầu nâng cấp gói đang chờ trong vòng 48 giờ (T2.12).
 */
const createOrReuseUpgradeRequest = async ({ landlordId, plan, billingCycle = 'monthly', now = new Date() }) => {
    const cycle = normalizeCycle(billingCycle);
    const amount = planPriceVnd(plan, cycle);
    if (!amount || amount <= 0) {
        throw createError(400, 'Gói cước này chưa được cấu hình giá hợp lệ');
    }

    await PlanUpgradeRequest.update(
        { status: 'cancelled' },
        {
            where: {
                landlordId,
                status: 'pending',
                [Op.or]: [{ planName: { [Op.ne]: plan.name } }, { billingCycle: { [Op.ne]: cycle } }],
            },
        }
    );

    let existing = await PlanUpgradeRequest.findOne({
        where: { landlordId, planName: plan.name, billingCycle: cycle, status: 'pending' },
        order: [['createdAt', 'DESC']],
    });

    if (existing && existing.createdAt) {
        const ageMs = new Date(now).getTime() - new Date(existing.createdAt).getTime();
        if (ageMs > PENDING_UPGRADE_TTL_MS) {
            existing.status = 'expired';
            if (typeof existing.save === 'function') {
                await existing.save();
            } else {
                await PlanUpgradeRequest.update({ status: 'expired' }, { where: { id: existing.id } });
            }
            existing = null;
        }
    }

    if (existing) return existing;

    return PlanUpgradeRequest.create({
        landlordId,
        planName: plan.name,
        billingCycle: cycle,
        amount,
        transferCode: buildTransferCode(landlordId, plan.name, cycle),
        status: 'pending',
    });
};

/**
 * Chủ nhà chủ động hủy yêu cầu nâng cấp đang chờ thanh toán (T2.12, T3.7).
 */
const cancelUpgradeRequest = async (requestId, landlordId) => {
    const req = await PlanUpgradeRequest.findByPk(requestId);
    if (!req || Number(req.landlordId) !== Number(landlordId)) {
        throw createError(404, 'Không tìm thấy yêu cầu nâng cấp gói cước');
    }
    if (req.status !== 'pending') {
        throw createError(400, 'Yêu cầu nâng cấp này không còn ở trạng thái chờ thanh toán');
    }
    req.status = 'cancelled';
    if (typeof req.save === 'function') {
        await req.save();
    } else {
        await PlanUpgradeRequest.update({ status: 'cancelled' }, { where: { id: req.id } });
    }
    return req;
};

module.exports = {
    PENDING_UPGRADE_TTL_MS,
    computeConvertedPlanExpiry,
    syncExpiredPlan,
    expireAllOverduePlans,
    expirePendingUpgradeRequests,
    createOrReuseUpgradeRequest,
    cancelUpgradeRequest,
};
