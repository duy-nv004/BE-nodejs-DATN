const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

// Yêu cầu của khách trên hợp đồng (C5): báo trả phòng / đề nghị gia hạn.
// Chủ nhà duyệt rồi tự thực hiện tiếp bằng luồng thanh lý (C1) hoặc gia hạn có sẵn.
const ContractRequest = sequelize.define('ContractRequest', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    contractId: { type: DataTypes.INTEGER, allowNull: false },
    tenantId: { type: DataTypes.INTEGER, allowNull: false },
    type: { type: DataTypes.ENUM('move_out', 'renewal'), allowNull: false },
    // move_out: ngày dự kiến trả phòng; renewal: ngày kết thúc mong muốn
    desiredDate: { type: DataTypes.DATEONLY, allowNull: true },
    note: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.ENUM('pending', 'approved', 'rejected'), defaultValue: 'pending' },
    responseNote: { type: DataTypes.TEXT, allowNull: true }
}, { tableName: 'ContractRequests' });

module.exports = ContractRequest;
