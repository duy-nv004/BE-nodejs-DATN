const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const User = require('./User');

const RefreshToken = sequelize.define('RefreshToken', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: User, key: 'id' }
    },
    tokenHash: {
        type: DataTypes.STRING(255),
        allowNull: false,
        unique: true
    },
    expiresAt: {
        type: DataTypes.DATE,
        allowNull: false
    },
    isRevoked: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    revokedReason: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    ipAddress: {
        type: DataTypes.STRING(45),
        allowNull: true
    },
    userAgent: {
        type: DataTypes.STRING(255),
        allowNull: true
    }
}, {
    tableName: 'RefreshTokens',
    indexes: [
        { fields: ['tokenHash'] },
        { fields: ['userId', 'isRevoked'] }
    ]
});

module.exports = RefreshToken;

