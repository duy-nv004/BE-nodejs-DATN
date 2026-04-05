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
    roomId: {
      type: DataTypes.INTEGER,
      references: { model: Room, key: "id" },
    },
  },
  { tableName: "MeterReadings", timestamps: true },
);

module.exports = MeterReading;
