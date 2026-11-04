const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const User = require('./User');
const Room = require('./Room');

const Contract = sequelize.define('Contract', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    startDate: { type: DataTypes.DATEONLY, allowNull: false },
    endDate: { type: DataTypes.DATEONLY, allowNull: false },
    deposit: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
    // Giá thuê chốt trong hợp đồng (I5). null = HĐ cũ, hóa đơn fallback về Room.price
    rentPrice: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    
    // Đơn giá chốt riêng cho hợp đồng này
    electricityPrice: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    waterPrice: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    internetPrice: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
    cleaningPrice: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },

    // Chỉ số điện nước ban đầu
    initialElectricity: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
    initialWater: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },

    // Thông tin Bên A (Chủ nhà)
    landlordName: { type: DataTypes.STRING, allowNull: true },
    landlordPhone: { type: DataTypes.STRING, allowNull: true },
    landlordCccd: { type: DataTypes.STRING, allowNull: true },
    landlordDob: { type: DataTypes.STRING, allowNull: true },
    landlordHometown: { type: DataTypes.TEXT, allowNull: true },
    landlordAddress: { type: DataTypes.TEXT, allowNull: true },
    
    // Thông tin Chữ ký Bên A
    landlordSignature: { type: DataTypes.TEXT('long'), allowNull: true },
    landlordSignedAt: { type: DataTypes.DATE, allowNull: true },
    
    // Thông tin Bên B (Người thuê)
    tenantCccd: { type: DataTypes.STRING, allowNull: true },
    tenantDob: { type: DataTypes.STRING, allowNull: true },
    tenantHometown: { type: DataTypes.TEXT, allowNull: true },
    tenantPhone: { type: DataTypes.STRING, allowNull: true },
    // Tên file ảnh CCCD 2 mặt chủ nhà upload khi tạo HĐ (lưu ở uploads/cccd/, không public)
    tenantCccdFront: { type: DataTypes.STRING, allowNull: true },
    tenantCccdBack: { type: DataTypes.STRING, allowNull: true },

    // Thông tin Chữ ký Bên B
    tenantSignature: { type: DataTypes.TEXT('long'), allowNull: true },
    tenantSignedAt: { type: DataTypes.DATE, allowNull: true },
    tenantSignedIp: { type: DataTypes.STRING(64), allowNull: true },
    tenantSignedUserAgent: { type: DataTypes.STRING(500), allowNull: true },
    contentHash: { type: DataTypes.STRING(64), allowNull: true },
    rejectionReason: { type: DataTypes.TEXT, allowNull: true },
    
    // Số lượng người ở & ngày thanh toán & đồ dùng bàn giao
    numTenants: { type: DataTypes.INTEGER, defaultValue: 1 },
    paymentDay: { type: DataTypes.INTEGER, defaultValue: 30 },
    // T2.3: tiền phòng tháng đầu/cuối. 'full' = tròn tháng, 'prorated' = theo số ngày ở
    firstLastMonthPolicy: {
        type: DataTypes.STRING(10), allowNull: false, defaultValue: 'full',
        validate: { isIn: [['full', 'prorated']] }
    },
    inventory: { type: DataTypes.TEXT, allowNull: true }, // Lưu chuỗi JSON của danh sách đồ dùng
    
    // Thanh lý (C1): ngày trả phòng, chỉ số cuối (khớp kiểu MeterReading.readingValue), ghi chú
    terminatedAt: { type: DataTypes.DATEONLY, allowNull: true },
    finalElectricity: { type: DataTypes.INTEGER, allowNull: true },
    finalWater: { type: DataTypes.INTEGER, allowNull: true },
    terminationNote: { type: DataTypes.TEXT, allowNull: true },
    outstandingAmount: { type: DataTypes.DECIMAL(12, 2), allowNull: true, defaultValue: 0 },

    status: { type: DataTypes.STRING, defaultValue: 'pending_tenant_signature' },
    tenantId: { type: DataTypes.INTEGER, references: { model: User, key: 'id' } },
    roomId: { type: DataTypes.INTEGER, references: { model: Room, key: 'id' } }
}, { tableName: 'Contracts' });

module.exports = Contract;
