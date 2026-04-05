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
    
    status: { type: DataTypes.ENUM('active', 'expired', 'terminated'), defaultValue: 'active' },
    tenantId: { type: DataTypes.INTEGER, references: { model: User, key: 'id' } },
    roomId: { type: DataTypes.INTEGER, references: { model: Room, key: 'id' } }
}, { tableName: 'Contracts' });


module.exports = Contract;