const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const User = require('./User');
const Room = require('./Room');

const SupportRequest = sequelize.define('SupportRequest', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    description: { type: DataTypes.TEXT, allowNull: false },
    severity: { 
        type: DataTypes.ENUM('low', 'medium', 'high'), 
        defaultValue: 'medium' 
    },
    status: { 
        type: DataTypes.ENUM('pending', 'in_progress', 'resolved'), 
        defaultValue: 'pending' 
    },
    tenantId: { type: DataTypes.INTEGER, references: { model: User, key: 'id' } },
    roomId: { type: DataTypes.INTEGER, references: { model: Room, key: 'id' } },
    // Loại sự cố: electric | water | furniture | appliance | internet | other (kiểm tra trong service)
    category: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'other' },
    // Mảng đường dẫn ảnh lưu dạng JSON, getter luôn trả về mảng
    images: {
        type: DataTypes.TEXT,
        allowNull: true,
        get() {
            try { return JSON.parse(this.getDataValue('images') || '[]'); } catch { return []; }
        }
    },
    landlordNote: { type: DataTypes.TEXT, allowNull: true },
    repairCost: { type: DataTypes.DECIMAL(12, 0), allowNull: true },
    chargeToTenant: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    invoiceId: { type: DataTypes.INTEGER, allowNull: true }
}, { tableName: 'SupportRequests' });

module.exports = SupportRequest;
