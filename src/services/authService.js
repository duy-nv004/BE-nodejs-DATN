const User = require('../models/User');
const Role = require('../models/Role');
const PlanUpgradeRequest = require('../models/PlanUpgradeRequest');
const planService = require('./planService');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Op } = require('sequelize');
const { createError } = require('../utils/errors');

const signToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1d' });

/** Thời gian sống của link liên kết Telegram (phút) */
const TELEGRAM_LINK_TTL_MINUTES = 15;

exports.registerLandlord = async ({ email, password, name }) => {
    if (!email || !password) {
        throw createError(400, 'Vui lòng nhập Email và Mật khẩu');
    }

    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) {
        throw createError(400, 'Email đã tồn tại trên hệ thống');
    }

    const role = await Role.findOne({ where: { name: 'landlord' } });
    if (!role) {
        throw createError(500, 'Không tìm thấy vai trò landlord trong hệ thống');
    }

    const user = await User.create({ email, password, name: name || null, roleId: role.id });
    return {
        message: "Đăng ký chủ nhà thành công",
        token: signToken(user.id)
    };
};

/**
 * Sinh deep-link liên kết Telegram dùng token ngắn hạn thay vì user.id.
 *
 * Trước đây link là `?start=<user.id>` — ai đoán được id cũng gán được chat Telegram
 * của mình vào tài khoản đó. Token ở đây là 32 byte ngẫu nhiên, hết hạn sau 15 phút
 * và bị xoá ngay khi liên kết thành công (xem telegramRoutes POST /webhook).
 *
 * @param {number} userId
 * @returns {Promise<{telegramConnectLink: string, expiresAt: Date}>}
 */
exports.generateTelegramLink = async (userId) => {
    const user = await User.findByPk(userId);
    if (!user) throw createError(404, 'Người dùng không tồn tại');

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TELEGRAM_LINK_TTL_MINUTES * 60 * 1000);

    user.telegramLinkToken = token;
    user.telegramLinkTokenExpiresAt = expiresAt;
    await user.save();

    const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'phongtro_smart_bot';
    return {
        telegramConnectLink: `https://t.me/${botUsername}?start=${token}`,
        expiresAt
    };
};

exports.loginUser = async ({ identity, password }) => {
    if (!identity || !password) {
        throw createError(400, 'Vui lòng cung cấp đầy đủ thông tin đăng nhập');
    }

    const user = await User.findOne({ 
        where: {
            [Op.or]: [{ email: identity }, { phone: identity }]
        },
        include: [{ model: Role, as: 'roleData' }]
    });

    if (!user || !(await user.comparePassword(password))) {
        throw createError(401, 'Thông tin đăng nhập không chính xác');
    }

    if (user.status === 'locked') {
        throw createError(403, 'Tài khoản của bạn đã bị khóa bởi quản trị viên');
    }

    await planService.syncExpiredPlan(user);

    const roleName = user.roleData.name;

    return {
        token: signToken(user.id),
        id: user.id,
        role: roleName.toLowerCase(),
        name: user.name,
        email: user.email,
        phone: user.phone,
        plan: user.plan,
        planExpiresAt: user.planExpiresAt,
        cccd: user.cccd,
        dob: user.dob,
        hometown: user.hometown
    };
};

exports.createTenant = async (landlordId, { phone, password, name }) => {
    if (!phone || !password || !name) {
        throw createError(400, 'Vui lòng nhập đầy đủ thông tin cho người thuê');
    }

    const existingUser = await User.findOne({ where: { phone } });
    if (existingUser) {
        throw createError(400, 'Số điện thoại này đã được sử dụng');
    }

    const role = await Role.findOne({ where: { name: 'tenant' } });
    if (!role) {
        throw createError(500, 'Không tìm thấy vai trò tenant trong hệ thống');
    }

    const tenant = await User.create({
        phone,
        password,
        name,
        roleId: role.id,
        ownerId: landlordId
    });

    return {
        message: "Tạo tài khoản người thuê bằng SĐT thành công",
        tenantId: tenant.id
    };
};

exports.updateProfile = async (userId, { name, email, phone, cccd, dob, hometown }) => {
    const user = await User.findByPk(userId);
    if (!user) {
        throw createError(404, 'Người dùng không tồn tại');
    }

    if (email && email !== user.email) {
        const checkEmail = await User.findOne({ where: { email } });
        if (checkEmail) throw createError(400, 'Email này đã được sử dụng bởi tài khoản khác');
        user.email = email;
    }

    if (phone && phone !== user.phone) {
        const checkPhone = await User.findOne({ where: { phone } });
        if (checkPhone) throw createError(400, 'Số điện thoại này đã được sử dụng bởi tài khoản khác');
        user.phone = phone;
    }

    if (name) user.name = name;
    if (cccd !== undefined) user.cccd = cccd;
    if (dob !== undefined) user.dob = dob;
    if (hometown !== undefined) user.hometown = hometown;

    await user.save();
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        cccd: user.cccd,
        dob: user.dob,
        hometown: user.hometown,
        telegramChatId: user.telegramChatId
    };
};

/**
 * Đổi mật khẩu tài khoản người dùng sau khi xác minh mật khẩu hiện tại.
 * Frontend phải gửi lên trường `currentPassword` (đã đồng bộ với Profile.jsx).
 * @param {number} userId
 * @param {{ currentPassword: string, newPassword: string }} params
 */
exports.changePassword = async (userId, { currentPassword, newPassword }) => {
    if (!currentPassword || !newPassword) {
        throw createError(400, 'Vui lòng điền mật khẩu hiện tại và mật khẩu mới');
    }

    const user = await User.findByPk(userId);
    if (!user) throw createError(404, 'Người dùng không tồn tại');

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) throw createError(401, 'Mật khẩu hiện tại không chính xác');

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    return { message: 'Đổi mật khẩu thành công!' };
};

exports.getProfile = async (userId) => {
    const user = await User.findByPk(userId, {
        attributes: ['id', 'name', 'email', 'phone', 'cccd', 'dob', 'hometown', 'plan', 'planExpiresAt', 'telegramChatId']
    });
    if (!user) {
        throw createError(404, 'Người dùng không tồn tại');
    }

    await planService.syncExpiredPlan(user);

    // Yêu cầu nâng cấp đang chờ thanh toán (nếu có) để Frontend hiển thị trạng thái
    const pendingUpgrade = await PlanUpgradeRequest.findOne({
        where: { landlordId: user.id, status: 'pending' },
        order: [['createdAt', 'DESC']]
    });

    const profile = user.toJSON();
    profile.pendingUpgrade = pendingUpgrade ? {
        id: pendingUpgrade.id,
        planName: pendingUpgrade.planName,
        billingCycle: pendingUpgrade.billingCycle,
        amount: parseFloat(pendingUpgrade.amount),
        transferCode: pendingUpgrade.transferCode,
        status: pendingUpgrade.status,
        createdAt: pendingUpgrade.createdAt
    } : null;

    return profile;
};
