const User = require('../models/User');
const Role = require('../models/Role');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { createError } = require('../utils/errors');

const signToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1d' });

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

    const roleName = user.roleData.name;
    let telegramConnectLink = null;

    if (roleName.toLowerCase() === 'tenant' && !user.telegramChatId) {
        const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'phongtro_smart_bot';
        telegramConnectLink = `https://t.me/${botUsername}?start=${user.id}`;
    }

    return {
        token: signToken(user.id),
        role: roleName.toLowerCase(),
        name: user.name,
        email: user.email,
        phone: user.phone,
        cccd: user.cccd,
        dob: user.dob,
        hometown: user.hometown,
        telegramConnectLink
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

exports.changePassword = async (userId, { currentPassword, newPassword }) => {
    if (!currentPassword || !newPassword) {
        throw createError(400, 'Vui lòng điền mật khẩu hiện tại và mật khẩu mới');
    }

    const user = await User.findByPk(userId);
    if (!user) {
        throw createError(404, 'Người dùng không tồn tại');
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
        throw createError(401, 'Mật khẩu hiện tại không chính xác');
    }

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
    return user;
};
