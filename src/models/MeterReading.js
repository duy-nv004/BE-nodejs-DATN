const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");
const Room = require("./Room");

const MeterReading = sequelize.define(
  "MeterReading",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    type: { type: DataTypes.ENUM("electricity", "water"), allowNull: false },
    readingValue: { type: DataTypes.INTEGER, allowNull: false },
    readingDate: { type: DataTypes.DATEONLY, defaultValue: DataTypes.NOW },
    isInitial: { type: DataTypes.BOOLEAN, defaultValue: false }, // Đánh dấu số đầu kỳ
    // Kỳ chốt số dạng YYYY-MM. Không có cột này thì không biết một chỉ số thuộc
    // tháng nào, phải suy ra từ "2 bản ghi mới nhất" — vừa nhân bản khi chốt số
    // nhiều lần, vừa tính sai khi xuất lại hóa đơn cho cùng một kỳ.
    period: { type: DataTypes.STRING(7), allowNull: true },
    roomId: {
      type: DataTypes.INTEGER,
      references: { model: Room, key: "id" },
    },
  },
  {
    tableName: "MeterReadings",
    timestamps: true,
    indexes: [
      // Mỗi phòng chỉ có 1 chỉ số cho mỗi loại trong mỗi kỳ; chốt lại = ghi đè
      { unique: true, fields: ['roomId', 'type', 'period'], name: 'readings_room_type_period_unique' }
    ]
  },
);

module.exports = MeterReading;
