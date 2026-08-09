const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const User = require('./User');
const Room = require('./Room');

const Contract = sequelize.define('Contract', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    startDate: { type: DataTypes.DATEONLY, allowNull: false },
    endDate: { type: DataTypes.DATEONLY, allowNull: false },
    deposit: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
    
    // Đơn giá chốt riêng cho hợp đồng này
    electricityPrice: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    waterPrice: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    internetPrice: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
    cleaningPrice: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },

    // Thông tin Bên A (Chủ nhà)
    landlordName: { type: DataTypes.STRING, allowNull: true },
    landlordPhone: { type: DataTypes.STRING, allowNull: true },
    landlordCccd: { type: DataTypes.STRING, allowNull: true },
    landlordDob: { type: DataTypes.STRING, allowNull: true },
    landlordHometown: { type: DataTypes.TEXT, allowNull: true },
    landlordAddress: { type: DataTypes.TEXT, allowNull: true },
    
    // Thông tin Bên B (Người thuê)
    tenantCccd: { type: DataTypes.STRING, allowNull: true },
    tenantDob: { type: DataTypes.STRING, allowNull: true },
    tenantHometown: { type: DataTypes.TEXT, allowNull: true },
    tenantPhone: { type: DataTypes.STRING, allowNull: true },
    
    // Số lượng người ở & ngày thanh toán & đồ dùng bàn giao
    numTenants: { type: DataTypes.INTEGER, defaultValue: 1 },
    paymentDay: { type: DataTypes.INTEGER, defaultValue: 30 },
    inventory: { type: DataTypes.TEXT, allowNull: true }, // Lưu chuỗi JSON của danh sách đồ dùng
    
    status: { type: DataTypes.ENUM('active', 'expired', 'terminated'), defaultValue: 'active' },
    tenantId: { type: DataTypes.INTEGER, references: { model: User, key: 'id' } },
    roomId: { type: DataTypes.INTEGER, references: { model: Room, key: 'id' } }
}, { tableName: 'Contracts' });


module.exports = Contract;