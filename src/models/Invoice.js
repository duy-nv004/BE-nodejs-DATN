const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const Invoice = sequelize.define('Invoice', {
    id: { 
        type: DataTypes.INTEGER, 
        primaryKey: true, 
        autoIncrement: true 
    },
    month: { 
        type: DataTypes.INTEGER, 
        allowNull: false 
    },
    year: { 
        type: DataTypes.INTEGER, 
        allowNull: false 
    },
    roomPrice: { 
        type: DataTypes.DECIMAL(10, 2) 
    },
    electricityTotal: { 
        type: DataTypes.DECIMAL(10, 2) 
    },
    waterTotal: { 
        type: DataTypes.DECIMAL(10, 2) 
    },
    serviceTotal: { 
        type: DataTypes.DECIMAL(10, 2) 
    }, // Internet + Vệ sinh
    totalAmount: { 
        type: DataTypes.DECIMAL(10, 2) 
    },
    // --- TRƯỜNG MỚI ĐỂ LƯU MÃ QR ---
    qrCodeUrl: { 
        type: DataTypes.TEXT, // Dùng TEXT vì URL có thể dài do chứa description tiếng Việt
        allowNull: true 
    },
    // -----------------------------
    isPaid: { 
        type: DataTypes.BOOLEAN, 
        defaultValue: false 
    },
    roomId: { 
        type: DataTypes.INTEGER, 
        allowNull: false 
    },
    landlordId: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    // Gắn hóa đơn với người thuê / hợp đồng cụ thể.
    // Trước đây hóa đơn chỉ có roomId nên khách thuê mới vào phòng sẽ nhìn thấy
    // toàn bộ công nợ của khách thuê trước (xem tenantService.getInvoices).
    tenantId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'Users', key: 'id' }
    },
    contractId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'Contracts', key: 'id' }
    },
    // Hạn đóng tiền và thông tin thanh toán
    dueDate: { type: DataTypes.DATEONLY, allowNull: true },
    paidAmount: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
    paidAt: { type: DataTypes.DATE, allowNull: true },
    paymentMethod: { type: DataTypes.STRING(20), allowNull: true }, // cash | bank_transfer | sepay | deposit
    // Chỉ số và đơn giá chốt vào hóa đơn (hóa đơn cũ để null)
    electricityOld: { type: DataTypes.INTEGER, allowNull: true },
    electricityNew: { type: DataTypes.INTEGER, allowNull: true },
    waterOld: { type: DataTypes.INTEGER, allowNull: true },
    waterNew: { type: DataTypes.INTEGER, allowNull: true },
    electricityPrice: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    waterPrice: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    // T2.3: tiền phòng tính theo ngày (tháng đầu/cuối) và số ngày đã tính
    prorated: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    daysCharged: { type: DataTypes.INTEGER, allowNull: true },
    // T2.2 / T1.5: trạng thái thanh toán chi tiết (unpaid | partial | paid | voided) và xóa mềm
    status: { type: DataTypes.STRING(20), allowNull: true, defaultValue: 'unpaid' },
    deletedAt: { type: DataTypes.DATE, allowNull: true }
}, { 
    tableName: 'Invoices',
    timestamps: true, // Nên có để biết hóa đơn được tạo lúc nào
    paranoid: true, // Kích hoạt xóa mềm (soft delete): destroy() cập nhật deletedAt thay vì xóa vật lý
    indexes: [
        // Mỗi phòng chỉ có đúng 1 hóa đơn cho mỗi kỳ. Chặn ở tầng DB vì kiểm tra
        // ở tầng service vẫn có khe hở khi hai request chạy song song.
        { unique: true, fields: ['roomId', 'month', 'year'], name: 'invoices_room_period_unique' }
    ]
});

module.exports = Invoice;
