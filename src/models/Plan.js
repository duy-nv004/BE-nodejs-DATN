const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const Plan = sequelize.define('Plan', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: false, unique: true }, // 'free', 'basic', 'pro'
    price: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
    annualPrice: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
    maxBuildings: { type: DataTypes.INTEGER, defaultValue: 1 },
    maxRoomsPerBuilding: { type: DataTypes.INTEGER, defaultValue: 5 },
    maxAICallsPerMonth: { type: DataTypes.INTEGER, defaultValue: 0 } // -1 means unlimited
}, { tableName: 'Plans' });

module.exports = Plan;
