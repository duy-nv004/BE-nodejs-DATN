const User = require('../models/User');
const { Op } = require('sequelize');

/**
 * Đồng bộ hạn sử dụng gói cước cho MỘT người dùng.
 *
 * Trước đây quy tắc này bị chép lại ở 4 nơi (tiến trình quét định kỳ trong index.js,
 * authMiddleware, authService.loginUser, authService.getProfile) với hành vi lệch
 * nhau: chỉ một bản gửi thông báo, các bản còn lại âm thầm hạ gói. Gom về một chỗ
 * để mọi luồng xử lý giống nhau.
 *
 * @param {object} user - instance User (đã có id, plan, planExpiresAt)
 * @returns {Promise<{expired: boolean, oldPlan?: string}>}
 */
const syncExpiredPlan = async (user) => {
    if (!user || !user.plan || user.plan === 'free' || !user.planExpiresAt) {
        return { expired: false };
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const expDate = new Date(user.planExpiresAt);
    expDate.setHours(0, 0, 0, 0);

    if (expDate >= today) return { expired: false };

    const oldPlan = user.plan;
    user.plan = 'free';
    user.planExpiresAt = null;
    await user.save();

    return { expired: true, oldPlan };
};

/**
 * Quét toàn bộ tài khoản đã quá hạn và đưa về gói Miễn Phí.
 * Dùng cho tiến trình chạy nền.
 * @returns {Promise<number>} số tài khoản đã cập nhật
 */
const expireAllOverduePlans = async () => {
    const today = new Date().toISOString().split('T')[0];
    const [updatedCount] = await User.update(
        { plan: 'free', planExpiresAt: null },
        { where: { plan: { [Op.ne]: 'free' }, planExpiresAt: { [Op.lt]: today } } }
    );
    return updatedCount;
};

module.exports = { syncExpiredPlan, expireAllOverduePlans };
