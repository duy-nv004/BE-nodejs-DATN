const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");
const User = require("./User");

const Building = sequelize.define(
  "Building",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: false },
    address: { type: DataTypes.STRING, allowNull: false },
    city: { type: DataTypes.STRING, allowNull: true },
    district: { type: DataTypes.STRING, allowNull: true },
    ward: { type: DataTypes.STRING, allowNull: true },
    latitude: { type: DataTypes.DOUBLE, allowNull: true },
    longitude: { type: DataTypes.DOUBLE, allowNull: true },
    landlordId: {
      type: DataTypes.INTEGER,
      references: { model: User, key: "id" },
    },
  },
  { tableName: "Buildings" },
);

module.exports = Building;
