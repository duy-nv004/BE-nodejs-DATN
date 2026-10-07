const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

/**
 * Nhật ký giao dịch SePay đã xử lý, dùng để chống replay webhook.
 *
 * SePay chủ động gửi lại webhook khi không nhận được HTTP 200 (retry), và kẻ tấn
 * công có thể tự gửi lại payload cũ. Không có bảng này thì mỗi lần gửi lại một
 * giao dịch "PLAN <id> PRO YEAR" hợp lệ sẽ cộng thêm 365 ngày vào hạn gói cước.
 *
 * `eventKey` là UNIQUE: INSERT trùng sẽ ném SequelizeUniqueConstraintError, và đó
 * chính là tín hiệu "giao dịch này đã được xử lý rồi".
 */
const SePayEvent = sequelize.define('SePayEvent', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    // ID giao dịch do SePay cấp, hoặc hash của payload nếu webhook không kèm id.
    eventKey: { type: DataTypes.STRING, allowNull: false, unique: true },
    content: { type: DataTypes.TEXT, allowNull: true },
    transferAmount: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    resultType: { type: DataTypes.STRING, allowNull: true },
    payload: { type: DataTypes.TEXT('long'), allowNull: true }
}, { timestamps: true, tableName: 'SePayEvents' });

module.exports = SePayEvent;
