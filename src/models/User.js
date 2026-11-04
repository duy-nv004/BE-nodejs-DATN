const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const bcrypt = require('bcryptjs');
const Role = require('./Role');

const User = sequelize.define('User', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    email: { 
        type: DataTypes.STRING, 
        allowNull: true, 
        unique: true,
        validate: { isEmail: true } 
    },
    name: { type: DataTypes.STRING, allowNull: true },
    phone: { 
        type: DataTypes.STRING, 
        allowNull: true, 
        unique: true 
    },
    password: { type: DataTypes.STRING, allowNull: false },
    roleId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: Role, key: 'id' }
    },
    plan: { type: DataTypes.ENUM('free', 'basic', 'pro'), defaultValue: 'free' },
    planExpiresAt: { type: DataTypes.DATEONLY, allowNull: true },
    billingCycle: { type: DataTypes.ENUM('monthly', 'annual'), allowNull: true },
    planSource: { type: DataTypes.ENUM('sepay', 'admin'), allowNull: true },
    aiUseCountThisMonth: { type: DataTypes.INTEGER, defaultValue: 0 },
    lastAiUseMonth: { type: DataTypes.STRING, allowNull: true },
    ownerId: { type: DataTypes.INTEGER, allowNull: true }, // Lưu ID của Landlord tạo ra Tenant này
    telegramChatId: {
        type: DataTypes.STRING,
        allowNull: true,
        unique: true,
    },
    // Token ngắn hạn cho deep-link /start <token> của Telegram Bot.
    // Không dùng thẳng user.id: ai cũng gửi được /start <id> tới bot và như vậy
    // sẽ gán chat Telegram của họ vào bất kỳ tài khoản nào (xem telegramRoutes).
    telegramLinkToken: { type: DataTypes.STRING, allowNull: true },
    telegramLinkTokenExpiresAt: { type: DataTypes.DATE, allowNull: true },
    cccd: { type: DataTypes.STRING, allowNull: true },
    dob: { type: DataTypes.STRING, allowNull: true },
    hometown: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.ENUM('active', 'locked'), defaultValue: 'active' },
    // Lý do admin khóa tài khoản (A2), hiển thị khi đăng nhập bị chặn
    lockReason: { type: DataTypes.STRING(500), allowNull: true },
    // Tăng khi đổi/reset mật khẩu; token mang version cũ bị protect từ chối (thu hồi phiên)
    tokenVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // Tài khoản nhận tiền phòng của chủ nhà (I2). Null = dùng tài khoản hệ thống.
    bankId: { type: DataTypes.STRING(20), allowNull: true },
    bankAccount: { type: DataTypes.STRING(30), allowNull: true },
    bankAccountName: { type: DataTypes.STRING(100), allowNull: true }
}, {
    tableName: 'Users',
    hooks: {
        beforeCreate: async (user) => {
            if (user.password && !user.password.startsWith('$2')) {
                const salt = await bcrypt.genSalt(10);
                user.password = await bcrypt.hash(user.password, salt);
            }
        },
        beforeUpdate: async (user) => {
            if (user.changed('password') && user.password && !user.password.startsWith('$2')) {
                const salt = await bcrypt.genSalt(10);
                user.password = await bcrypt.hash(user.password, salt);
            }
        }
    }
});

User.prototype.comparePassword = async function(password) {
    return await bcrypt.compare(password, this.password);
};

module.exports = User;
