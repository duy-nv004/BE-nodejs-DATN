const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");
const Building = require("./Building");

const Room = sequelize.define(
  "Room",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    roomNumber: { type: DataTypes.STRING, allowNull: false },
    price: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
    depositAmount: { type: DataTypes.DECIMAL(12, 2), allowNull: true, defaultValue: 0 },
    capacity: { type: DataTypes.INTEGER, defaultValue: 2, allowNull: true, validate: { min: 1, max: 50 } },
    area: { type: DataTypes.DECIMAL(10, 2), defaultValue: 20, allowNull: true, validate: { min: 1 } },
    images: { type: DataTypes.TEXT, allowNull: true },
    amenities: { type: DataTypes.TEXT, allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    status: {
      type: DataTypes.STRING,
      defaultValue: "empty",
    },
    buildingId: {
      type: DataTypes.INTEGER,
      references: { model: Building, key: "id" },
    },
  },
  {
    tableName: "Rooms",
    indexes: [
      { unique: true, fields: ["buildingId", "roomNumber"], name: "rooms_building_roomnumber_unique" },
    ],
  },
);

module.exports = Room;
