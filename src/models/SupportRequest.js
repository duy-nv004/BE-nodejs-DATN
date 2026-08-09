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
    roomId: { type: DataTypes.INTEGER, references: { model: Room, key: 'id' } }
}, { tableName: 'SupportRequests' });

module.exports = SupportRequest;
