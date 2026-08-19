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
    }
}, { 
    tableName: 'Invoices',
    timestamps: true // Nên có để biết hóa đơn được tạo lúc nào
});

module.exports = Invoice;