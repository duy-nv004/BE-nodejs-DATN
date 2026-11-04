const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const Contract = require('./Contract');

const DepositRecord = sequelize.define('DepositRecord', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    contractId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: Contract, key: 'id' }
    },
    amount: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
    status: {
        type: DataTypes.ENUM('held', 'refunded', 'deducted', 'forfeited'),
        defaultValue: 'held'
    },
    refundedAmount: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
    deductedAmount: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
    note: { type: DataTypes.TEXT, allowNull: true },
    refundedAt: { type: DataTypes.DATE, allowNull: true }
}, { tableName: 'DepositRecords' });

module.exports = DepositRecord;