const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");
const Building = require("./Building");

const Service = sequelize.define(
  "Service",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    electricityPrice: { type: DataTypes.DECIMAL(10, 2), defaultValue: 3500 }, // 3.5k/số
    waterPrice: { type: DataTypes.DECIMAL(10, 2), defaultValue: 30000 }, // 30k/khối
    internetPrice: { type: DataTypes.DECIMAL(10, 2), defaultValue: 100000 }, // 100k/tháng
    cleaningPrice: { type: DataTypes.DECIMAL(10, 2), defaultValue: 50000 }, // 50k/người
    buildingId: {
      type: DataTypes.INTEGER,
      references: { model: Building, key: "id" },
    },
  },
  { tableName: "Services", timestamps: false },
);

module.exports = Service;
