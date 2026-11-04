const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

// Người ở trên hợp đồng + khai báo tạm trú (C6). Khách chính là dòng isPrimary: true,
// tự tạo khi khách ký HĐ mới; gia hạn thì chuyển các dòng sang HĐ mới.
const ContractOccupant = sequelize.define('ContractOccupant', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    contractId: { type: DataTypes.INTEGER, allowNull: false },
    fullName: { type: DataTypes.STRING, allowNull: false },
    cccd: { type: DataTypes.STRING, allowNull: true },
    dob: { type: DataTypes.STRING, allowNull: true }, // cùng kiểu với Contract.tenantDob
    phone: { type: DataTypes.STRING, allowNull: true },
    relation: { type: DataTypes.STRING, allowNull: true },
    // Ảnh CCCD 2 mặt (tên file trong uploads/cccd/), chép từ HĐ sang dòng khách chính khi ký
    cccdFrontImage: { type: DataTypes.STRING, allowNull: true },
    cccdBackImage: { type: DataTypes.STRING, allowNull: true },
    isPrimary: { type: DataTypes.BOOLEAN, defaultValue: false },
    residenceStatus: { type: DataTypes.ENUM('not_registered', 'registered'), defaultValue: 'not_registered' },
    registeredAt: { type: DataTypes.DATEONLY, allowNull: true },
    note: { type: DataTypes.TEXT, allowNull: true }
}, { tableName: 'ContractOccupants' });

module.exports = ContractOccupant;
