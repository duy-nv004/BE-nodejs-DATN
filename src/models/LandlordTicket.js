const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const LandlordTicket = sequelize.define(
  "LandlordTicket",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    landlordId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "Users", key: "id" }
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    status: {
      type: DataTypes.ENUM("pending", "resolved", "rejected"),
      defaultValue: "pending"
    },
    // T2.17: lý do admin từ chối khiếu nại (gửi kèm email cho chủ nhà)
    rejectReason: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  },
  {
    timestamps: true,
    tableName: "LandlordTickets"
  }
);

module.exports = LandlordTicket;
