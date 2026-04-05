const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");
const Building = require("./Building");

const Room = sequelize.define(
  "Room",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    roomNumber: { type: DataTypes.STRING, allowNull: false },
    price: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
    status: {
      type: DataTypes.ENUM("empty", "occupied", "maintenance"),
      defaultValue: "empty",
    },
    buildingId: {
      type: DataTypes.INTEGER,
      references: { model: Building, key: "id" },
    },
  },
  { tableName: "Rooms" },
);


module.exports = Room;
