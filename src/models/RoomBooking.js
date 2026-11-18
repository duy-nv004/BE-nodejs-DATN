const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const Room = require('./Room');
const Building = require('./Building');
const User = require('./User');

const RoomBooking = sequelize.define('RoomBooking', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    roomId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: Room, key: 'id' }
    },
    buildingId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: Building, key: 'id' }
    },
    landlordId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: User, key: 'id' }
    },
    tenantId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: User, key: 'id' }
    },
    guestName: { type: DataTypes.STRING, allowNull: false },
    guestPhone: { type: DataTypes.STRING, allowNull: false },
    guestEmail: { type: DataTypes.STRING, allowNull: true },
    type: {
        type: DataTypes.ENUM('viewing', 'deposit'),
        allowNull: false,
        defaultValue: 'viewing'
    },
    viewingDate: { type: DataTypes.DATE, allowNull: true },
    moveInDate: { type: DataTypes.DATEONLY, allowNull: true },
    note: { type: DataTypes.TEXT, allowNull: true },
    depositAmount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    paymentStatus: {
        type: DataTypes.ENUM('unpaid', 'pending', 'paid'),
        allowNull: false,
        defaultValue: 'unpaid'
    },
    transferCode: { type: DataTypes.STRING, allowNull: true },
    transactionReference: { type: DataTypes.STRING, allowNull: true },
    paidAt: { type: DataTypes.DATE, allowNull: true },
    status: {
        type: DataTypes.ENUM('pending', 'confirmed', 'deposit_paid', 'contract_created', 'cancelled', 'rejected', 'deposit_conflict'),
        allowNull: false,
        defaultValue: 'pending'
    },
    lookupToken: { type: DataTypes.STRING(64), allowNull: true },
    holdExpiresAt: { type: DataTypes.DATE, allowNull: true },
    contractId: { type: DataTypes.INTEGER, allowNull: true }
}, {
    tableName: 'RoomBookings',
    timestamps: true
});

module.exports = RoomBooking;
