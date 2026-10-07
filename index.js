const express = require("express");
const sequelize = require("./src/config/db");
const setupAssociations = require("./src/models/associations");
const fs = require("fs");
require("dotenv").config();

// Import Model Role để khởi tạo dữ liệu
const Role = require("./src/models/Role");
const User = require("./src/models/User");
const Plan = require("./src/models/Plan");
const AdminLog = require("./src/models/AdminLog");
const LandlordTicket = require("./src/models/LandlordTicket");
// Bắt buộc require để sequelize.sync() tạo bảng SePayEvents (chống replay webhook)
const SePayEvent = require("./src/models/SePayEvent");

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
const sepayRoutes = require("./src/routes/sepayRoutes");

const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();

// Helmet đặt các header bảo mật cơ bản. Tắt contentSecurityPolicy vì đây là API
// thuần JSON, không phục vụ HTML — CSP ở đây không có tác dụng và dễ gây nhiễu.
app.use(helmet({ contentSecurityPolicy: false }));

// Giới hạn CORS theo biến môi trường. Mặc định `cors()` không tham số nghĩa là
// cho phép MỌI origin gọi kèm cookie/token. Đặt CORS_ORIGINS trong .env khi deploy.
const allowedOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

app.use(cors(
    allowedOrigins.length > 0
        ? { origin: allowedOrigins, credentials: true }
        : undefined // chưa cấu hình -> giữ hành vi cũ (mở) để không chặn môi trường dev
));

app.use(express.json());

// Chống dò mật khẩu: giới hạn số lần đăng nhập sai từ một địa chỉ IP.
// express-rate-limit đã có sẵn trong package.json nhưng trước đây không dùng ở đâu.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 phút
    max: 10,                  // 10 lần / IP / 15 phút
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Bạn đã thử đăng nhập quá nhiều lần. Vui lòng thử lại sau 15 phút.' }
});
app.use('/api/auth/login', loginLimiter);

// Chống spam gửi khiếu nại mở khóa tài khoản (endpoint công khai)
const appealLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 giờ
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Bạn đã gửi quá nhiều khiếu nại. Vui lòng thử lại sau.' }
});
app.use('/api/auth/appeal', appealLimiter);

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
app.use("/api/sepay", sepayRoutes);

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
    if (!tableDefinition.status) {
        await queryInterface.addColumn('Users', 'status', {
            type: require('sequelize').DataTypes.STRING,
            defaultValue: 'active'
        });
        console.log("📁 Thêm cột status vào bảng Users thành công!");
    }
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
    // Token liên kết Telegram dùng một lần, có hạn — thay cho việc truyền thẳng user.id
    if (!tableDefinition.telegramLinkToken) {
        await queryInterface.addColumn('Users', 'telegramLinkToken', {
            type: require('sequelize').DataTypes.STRING,
            allowNull: true
        });
        console.log("📁 Thêm cột telegramLinkToken vào bảng Users thành công!");
    }
    if (!tableDefinition.telegramLinkTokenExpiresAt) {
        await queryInterface.addColumn('Users', 'telegramLinkTokenExpiresAt', {
            type: require('sequelize').DataTypes.DATE,
            allowNull: true
        });
        console.log("📁 Thêm cột telegramLinkTokenExpiresAt vào bảng Users thành công!");
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
    if (!contractsTableDefinition.landlordSignature) {
        await queryInterface.addColumn('Contracts', 'landlordSignature', { type: require('sequelize').DataTypes.TEXT('long'), allowNull: true });
    }
    if (!contractsTableDefinition.landlordSignedAt) {
        await queryInterface.addColumn('Contracts', 'landlordSignedAt', { type: require('sequelize').DataTypes.DATE, allowNull: true });
    }
    if (!contractsTableDefinition.tenantSignature) {
        await queryInterface.addColumn('Contracts', 'tenantSignature', { type: require('sequelize').DataTypes.TEXT('long'), allowNull: true });
    }
    if (!contractsTableDefinition.tenantSignedAt) {
        await queryInterface.addColumn('Contracts', 'tenantSignedAt', { type: require('sequelize').DataTypes.DATE, allowNull: true });
    }
    if (!contractsTableDefinition.rejectionReason) {
        await queryInterface.addColumn('Contracts', 'rejectionReason', { type: require('sequelize').DataTypes.TEXT, allowNull: true });
    }
    if (!contractsTableDefinition.initialElectricity) {
        await queryInterface.addColumn('Contracts', 'initialElectricity', { type: require('sequelize').DataTypes.DECIMAL(10, 2), defaultValue: 0 });
    }
    if (!contractsTableDefinition.initialWater) {
        await queryInterface.addColumn('Contracts', 'initialWater', { type: require('sequelize').DataTypes.DECIMAL(10, 2), defaultValue: 0 });
    }
    console.log("📁 Đồng bộ hóa cấu trúc bảng Contracts thành công!");

    // Đồng bộ cột cho bảng Invoices (gắn hóa đơn với người thuê / hợp đồng)
    const invoicesTableDefinition = await queryInterface.describeTable('Invoices');
    if (!invoicesTableDefinition.tenantId) {
        await queryInterface.addColumn('Invoices', 'tenantId', { type: require('sequelize').DataTypes.INTEGER, allowNull: true });
        console.log("📁 Thêm cột tenantId vào bảng Invoices thành công!");
    }
    if (!invoicesTableDefinition.contractId) {
        await queryInterface.addColumn('Invoices', 'contractId', { type: require('sequelize').DataTypes.INTEGER, allowNull: true });
        console.log("📁 Thêm cột contractId vào bảng Invoices thành công!");
    }

    // Đồng bộ cột period cho bảng MeterReadings (kỳ chốt số dạng YYYY-MM)
    const readingsTableDefinition = await queryInterface.describeTable('MeterReadings');
    if (!readingsTableDefinition.period) {
        await queryInterface.addColumn('MeterReadings', 'period', { type: require('sequelize').DataTypes.STRING(7), allowNull: true });
        console.log("📁 Thêm cột period vào bảng MeterReadings thành công!");
    }

    // Đồng bộ thêm cột capacity và area cho bảng Rooms
    const roomsTableDefinition = await queryInterface.describeTable('Rooms');
    if (!roomsTableDefinition.capacity) {
        await queryInterface.addColumn('Rooms', 'capacity', { type: require('sequelize').DataTypes.INTEGER, defaultValue: 2, allowNull: true });
        console.log("📁 Thêm cột capacity vào bảng Rooms thành công!");
    }
    if (!roomsTableDefinition.area) {
        await queryInterface.addColumn('Rooms', 'area', { type: require('sequelize').DataTypes.DECIMAL(10, 2), defaultValue: 20, allowNull: true });
        console.log("📁 Thêm cột area vào bảng Rooms thành công!");
    }

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

    // Tự động kiểm tra và chuyển tất cả tài khoản hết hạn về Gói Miễn Phí (Free)
    const planService = require('./src/services/planService');
    const autoCheckExpiredPlans = async () => {
      try {
        const updatedCount = await planService.expireAllOverduePlans();
        if (updatedCount > 0) {
          console.log(`⏰ [Auto Expiration Task] Đã tự động chuyển ${updatedCount} tài khoản quá hạn về Gói Miễn Phí (Free).`);
        }
      } catch (err) {
        console.error("❌ Lỗi kiểm tra hết hạn gói cước tự động:", err);
      }
    };

    await autoCheckExpiredPlans();
    setInterval(autoCheckExpiredPlans, 3600000); // Tự động quét kiểm tra mỗi 1 giờ

    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  } catch (error) {
    console.error("❌ Server Error:", error);
  }
};

// Server started with SePay Integration
startServer();
