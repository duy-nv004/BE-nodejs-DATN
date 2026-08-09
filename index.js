const express = require("express");
const sequelize = require("./src/config/db");
const setupAssociations = require("./src/models/associations");
const fs = require("fs");
require("dotenv").config();

// Import Model Role để khởi tạo dữ liệu
const Role = require("./src/models/Role");
const User = require("./src/models/User");
const Plan = require("./src/models/Plan");

// Route imports
const authRoutes = require("./src/routes/authRoutes");
const buildingRoutes = require("./src/routes/buildingRoutes");
const contractRoutes = require("./src/routes/contractRoutes");
const aiRoutes = require("./src/routes/aiRoutes");
const telegramRoutes = require("./src/routes/telegramRoutes");
const invoiceRoutes = require("./src/routes/invoiceRoutes");
const adminRoutes = require("./src/routes/adminRoutes");
const tenantRoutes = require("./src/routes/tenantRoutes");
const notificationRoutes = require("./src/routes/notificationRoutes");

const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

if (!fs.existsSync("./uploads")) {
  fs.mkdirSync("./uploads");
  console.log("📁 Thư mục /uploads đã được tạo tự động.");
}

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/manage", buildingRoutes);
app.use("/api/contracts", contractRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/telegram", telegramRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/tenant", tenantRoutes);
app.use("/api/notifications", notificationRoutes);

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await sequelize.authenticate();
    console.log("✅ Connected to MySQL");

    // Kích hoạt quan hệ giữa các Model
    setupAssociations();

    // Đồng bộ database
    await sequelize.sync();
    console.log('✅ Database Synced');

    // Thêm cột aiUseCountThisMonth và lastAiUseMonth vào bảng Users nếu chưa có
    const queryInterface = sequelize.getQueryInterface();
    const tableDefinition = await queryInterface.describeTable('Users');
    if (!tableDefinition.aiUseCountThisMonth) {
        await queryInterface.addColumn('Users', 'aiUseCountThisMonth', {
            type: require('sequelize').DataTypes.INTEGER,
            defaultValue: 0
        });
        console.log("📁 Thêm cột aiUseCountThisMonth vào bảng Users thành công!");
    }
    if (!tableDefinition.lastAiUseMonth) {
        await queryInterface.addColumn('Users', 'lastAiUseMonth', {
            type: require('sequelize').DataTypes.STRING,
            allowNull: true
        });
        console.log("📁 Thêm cột lastAiUseMonth vào bảng Users thành công!");
    }
    if (!tableDefinition.cccd) {
        await queryInterface.addColumn('Users', 'cccd', {
            type: require('sequelize').DataTypes.STRING,
            allowNull: true
        });
        console.log("📁 Thêm cột cccd vào bảng Users thành công!");
    }
    if (!tableDefinition.dob) {
        await queryInterface.addColumn('Users', 'dob', {
            type: require('sequelize').DataTypes.STRING,
            allowNull: true
        });
        console.log("📁 Thêm cột dob vào bảng Users thành công!");
    }
    if (!tableDefinition.hometown) {
        await queryInterface.addColumn('Users', 'hometown', {
            type: require('sequelize').DataTypes.TEXT,
            allowNull: true
        });
        console.log("📁 Thêm cột hometown vào bảng Users thành công!");
    }
    if (!tableDefinition.planExpiresAt) {
        await queryInterface.addColumn('Users', 'planExpiresAt', {
            type: require('sequelize').DataTypes.DATEONLY,
            allowNull: true
        });
        console.log("📁 Thêm cột planExpiresAt vào bảng Users thành công!");
    }

    // Đồng bộ thêm cột cho bảng Contracts
    const contractsTableDefinition = await queryInterface.describeTable('Contracts');
    if (!contractsTableDefinition.landlordName) {
        await queryInterface.addColumn('Contracts', 'landlordName', { type: require('sequelize').DataTypes.STRING, allowNull: true });
    }
    if (!contractsTableDefinition.landlordPhone) {
        await queryInterface.addColumn('Contracts', 'landlordPhone', { type: require('sequelize').DataTypes.STRING, allowNull: true });
    }
    if (!contractsTableDefinition.landlordCccd) {
        await queryInterface.addColumn('Contracts', 'landlordCccd', { type: require('sequelize').DataTypes.STRING, allowNull: true });
    }
    if (!contractsTableDefinition.landlordDob) {
        await queryInterface.addColumn('Contracts', 'landlordDob', { type: require('sequelize').DataTypes.STRING, allowNull: true });
    }
    if (!contractsTableDefinition.landlordHometown) {
        await queryInterface.addColumn('Contracts', 'landlordHometown', { type: require('sequelize').DataTypes.TEXT, allowNull: true });
    }
    if (!contractsTableDefinition.landlordAddress) {
        await queryInterface.addColumn('Contracts', 'landlordAddress', { type: require('sequelize').DataTypes.TEXT, allowNull: true });
    }
    if (!contractsTableDefinition.tenantCccd) {
        await queryInterface.addColumn('Contracts', 'tenantCccd', { type: require('sequelize').DataTypes.STRING, allowNull: true });
    }
    if (!contractsTableDefinition.tenantDob) {
        await queryInterface.addColumn('Contracts', 'tenantDob', { type: require('sequelize').DataTypes.STRING, allowNull: true });
    }
    if (!contractsTableDefinition.tenantHometown) {
        await queryInterface.addColumn('Contracts', 'tenantHometown', { type: require('sequelize').DataTypes.TEXT, allowNull: true });
    }
    if (!contractsTableDefinition.tenantPhone) {
        await queryInterface.addColumn('Contracts', 'tenantPhone', { type: require('sequelize').DataTypes.STRING, allowNull: true });
    }
    if (!contractsTableDefinition.numTenants) {
        await queryInterface.addColumn('Contracts', 'numTenants', { type: require('sequelize').DataTypes.INTEGER, defaultValue: 1 });
    }
    if (!contractsTableDefinition.paymentDay) {
        await queryInterface.addColumn('Contracts', 'paymentDay', { type: require('sequelize').DataTypes.INTEGER, defaultValue: 30 });
    }
    if (!contractsTableDefinition.inventory) {
        await queryInterface.addColumn('Contracts', 'inventory', { type: require('sequelize').DataTypes.TEXT, allowNull: true });
    }
    console.log("📁 Đồng bộ hóa cấu trúc bảng Contracts thành công!");

    // sequelize.sync({ alter: false }).then(() => {
    //   console.log("Database synced");
    // });

    const roleCount = await Role.count();
    if (roleCount === 0) {
      await Role.bulkCreate([
        { id: 1, name: "admin" },
        { id: 2, name: "landlord" },
        { id: 3, name: "tenant" },
      ]);
      console.log("✅ Đã khởi tạo các quyền: Admin, Landlord, Tenant");
    }

    // Khởi tạo tài khoản Admin mặc định nếu chưa tồn tại
    const adminRole = await Role.findOne({ where: { name: "admin" } });
    if (adminRole) {
      const adminCount = await User.count({ where: { roleId: adminRole.id } });
      if (adminCount === 0) {
        await User.create({
          email: "admin@gmail.com",
          password: "admin",
          name: "Super Admin",
          roleId: adminRole.id,
          plan: "pro"
        });
        console.log("✅ Đã khởi tạo tài khoản Admin mặc định: admin@gmail.com / admin");
      }
    }

    // Khởi tạo các gói cước mặc định nếu chưa tồn tại
    const planCount = await Plan.count();
    if (planCount === 0) {
      await Plan.bulkCreate([
        { name: 'free', price: 0, annualPrice: 0, maxBuildings: 1, maxRoomsPerBuilding: 5, maxAICallsPerMonth: 0 },
        { name: 'basic', price: 29, annualPrice: 290, maxBuildings: 5, maxRoomsPerBuilding: 20, maxAICallsPerMonth: 30 },
        { name: 'pro', price: 99, annualPrice: 990, maxBuildings: 9999, maxRoomsPerBuilding: 9999, maxAICallsPerMonth: -1 }
      ]);
      console.log("✅ Đã khởi tạo các gói dịch vụ: Free, Basic, Pro");
    }
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  } catch (error) {
    console.error("❌ Server Error:", error);
  }
};

startServer();
