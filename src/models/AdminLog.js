const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const AdminLog = sequelize.define(
  "AdminLog",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    adminId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "Users", key: "id" }
    },
    action: {
      type: DataTypes.STRING,
      allowNull: false
    },
    targetUserId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "Users", key: "id" }
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: false
    }
  },
  {
    timestamps: true,
    tableName: "AdminLogs"
  }
);

module.exports = AdminLog;
