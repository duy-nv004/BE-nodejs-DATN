const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

/**
 * Yêu cầu nâng cấp / gia hạn gói cước do chủ nhà tạo.
 *
 * Bản ghi này CHỈ mang tính "chờ thanh toán": gói cước thật trên User chỉ được
 * kích hoạt khi SePay xác nhận đã nhận đủ tiền (xem sepayService.processWebhookPayload).
 */
const PlanUpgradeRequest = sequelize.define('PlanUpgradeRequest', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    landlordId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'Users', key: 'id' }
    },
    planName: { type: DataTypes.STRING, allowNull: false },
    billingCycle: {
        type: DataTypes.ENUM('monthly', 'annual'),
        allowNull: false,
        defaultValue: 'monthly'
    },
    amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 }, // Số tiền phải thu (VND)
    transferCode: { type: DataTypes.STRING, allowNull: false }, // Nội dung chuyển khoản để SePay tự khớp
    status: {
        type: DataTypes.ENUM('pending', 'paid', 'cancelled', 'expired'),
        allowNull: false,
        defaultValue: 'pending'
    },
    paidAt: { type: DataTypes.DATE, allowNull: true },
    transactionReference: { type: DataTypes.STRING, allowNull: true } // Mã giao dịch SePay trả về
}, { timestamps: true, tableName: 'PlanUpgradeRequests' });

module.exports = PlanUpgradeRequest;
