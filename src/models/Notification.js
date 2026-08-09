const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const User = require('./User');

const Notification = sequelize.define('Notification', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userId: { 
        type: DataTypes.INTEGER, 
        allowNull: false,
        references: { model: User, key: 'id' } 
    },
    title: { type: DataTypes.STRING, allowNull: false },
    content: { type: DataTypes.TEXT, allowNull: false },
    type: { 
        type: DataTypes.STRING, 
        allowNull: false,
        defaultValue: 'info' 
    },
    isRead: { type: DataTypes.BOOLEAN, defaultValue: false },
    relatedId: { type: DataTypes.INTEGER, allowNull: true }
}, { tableName: 'Notifications' });

module.exports = Notification;
