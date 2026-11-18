const express = require("express");
const sequelize = require("./src/config/db");
const setupAssociations = require("./src/models/associations");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// Import Model Role để khởi tạo dữ liệu
const Role = require("./src/models/Role");
const User = require("./src/models/User");
const Plan = require("./src/models/Plan");
const AdminLog = require("./src/models/AdminLog");
const LandlordTicket = require("./src/models/LandlordTicket");
// Bắt buộc require để sequelize.sync() tạo bảng SePayEvents (chống replay webhook)
const SePayEvent = require("./src/models/SePayEvent");
// Bắt buộc require để sequelize.sync() tạo bảng DepositRecords (theo dõi tiền cọc)
const DepositRecord = require("./src/models/DepositRecord");
// Bắt buộc require để sequelize.sync() tạo bảng ContractRequests (C5)
const ContractRequest = require("./src/models/ContractRequest");
// Bắt buộc require để sequelize.sync() tạo bảng ContractOccupants (C6)
const ContractOccupant = require("./src/models/ContractOccupant");
// Bắt buộc require để sequelize.sync() tạo bảng RefreshTokens (quản lý phiên đơn thiết bị)
const RefreshToken = require("./src/models/RefreshToken");
// Bắt buộc require để sequelize.sync() tạo bảng RoomBookings (đặt lịch xem & đặt cọc công khai)
const RoomBooking = require("./src/models/RoomBooking");

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
const chatRoutes = require("./src/routes/chatRoutes");
const depositRoutes = require("./src/routes/depositRoutes");
const supportRoutes = require("./src/routes/supportRoutes");
const publicRoutes = require("./src/routes/publicRoutes");

const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");

const app = express();

// Helmet đặt các header bảo mật cơ bản. Tắt contentSecurityPolicy vì đây là API
// thuần JSON, không phục vụ HTML — CSP ở đây không có tác dụng và dễ gây nhiễu.
app.use(helmet({ contentSecurityPolicy: false }));

const { corsOriginValidator } = require('./src/utils/cors');

app.use(cors({
    origin: corsOriginValidator,
    credentials: true
}));

app.use(express.json());
app.use(cookieParser());

// Chống dò mật khẩu: giới hạn số lần đăng nhập sai từ một địa chỉ IP.
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
app.use("/api/chat", chatRoutes);
app.use("/api/deposits", depositRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/public", publicRoutes);

// Tuyến đường truy cập file có chữ ký bảo mật (Signed URLs)
const storageService = require('./src/services/storageService');
app.get('/api/storage/access', (req, res) => {
    const { key, expires, sig } = req.query;
    if (!storageService.verifySignedUrl(key, expires, sig)) {
        return res.status(403).json({ message: 'Liên kết không hợp lệ hoặc đã hết hạn truy cập' });
    }
    const uploadsRoot = path.resolve(__dirname, './uploads');
    const safePath = path.resolve(uploadsRoot, String(key || ''));
    if (!safePath.startsWith(uploadsRoot + path.sep) || !fs.existsSync(safePath)) {
        return res.status(404).json({ message: 'File không tồn tại' });
    }
    res.sendFile(safePath);
});

// 404 handler cho các endpoint API không tồn tại
app.use("/api", (req, res) => {
    res.status(404).json({ message: 'Tuyến đường API không tồn tại' });
});

// Global Error Handler tập trung, không lộ stack trace ra ngoài
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err && err.message && err.message.includes('CORS')) {
        return res.status(403).json({ message: err.message });
    }
    console.error('❌ [Unhandled Error]:', err.message || err);
    res.status(err.statusCode || err.status || 500).json({
        message: err.statusCode ? err.message : 'Đã có lỗi máy chủ xảy ra. Vui lòng thử lại sau.'
    });
});

const PORT = process.env.PORT || 5000;

const { ensureUniqueIndex, runBootstrapMigrations } = require("./src/config/bootstrapMigrations");

const startServer = async () => {
  try {
    await sequelize.authenticate();
    console.log("✅ Connected to MySQL");

    // Kích hoạt quan hệ giữa các Model
    setupAssociations();

    // Đồng bộ database
    await sequelize.sync();
    console.log('✅ Database Synced');

    // Chạy đồng bộ cột và unique index
    await runBootstrapMigrations(sequelize);

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
    const adminRole = await Role.findOne({ where: "admin" && { name: "admin" } });
    if (adminRole) {
      const adminCount = await User.count({ where: { roleId: adminRole.id } });
      if (adminCount === 0) {
        const adminEmail = process.env.ADMIN_EMAIL || "admin@gmail.com";
        const adminPassword = process.env.ADMIN_PASSWORD;
        if (!adminPassword) {
          console.warn("⚠️  Chưa cấu hình ADMIN_PASSWORD — bỏ qua tạo tài khoản admin mặc định. Thêm ADMIN_PASSWORD vào .env rồi chạy lại.");
        } else {
          await User.create({
            email: adminEmail,
            password: adminPassword,
            name: "Super Admin",
            roleId: adminRole.id,
            plan: "pro"
          });
          console.log(`✅ Đã khởi tạo tài khoản Admin: ${adminEmail} (mật khẩu lấy từ ADMIN_PASSWORD)`);
        }
      }
    }

    // Khởi tạo các gói cước mặc định nếu chưa tồn tại
    const planCount = await Plan.count();
    if (planCount === 0) {
      await Plan.bulkCreate([
        { name: 'free', price: 0, annualPrice: 0, maxBuildings: 1, maxRoomsPerBuilding: 5, maxAICallsPerMonth: 0 },
        { name: 'basic', price: 725000, annualPrice: 7250000, maxBuildings: 5, maxRoomsPerBuilding: 20, maxAICallsPerMonth: 30 },
        { name: 'pro', price: 2475000, annualPrice: 24750000, maxBuildings: 9999, maxRoomsPerBuilding: 9999, maxAICallsPerMonth: -1 }
      ]);
      console.log("✅ Đã khởi tạo các gói dịch vụ: Free, Basic, Pro");
    }

    // Chuyển giá gói cũ lưu USD sang VND (idempotent: chỉ đổi gói có 0 < price < 1000)
    const { migrateUsdPlanPrices } = require('./src/utils/planPricing');
    for (const name of await migrateUsdPlanPrices(Plan)) {
      console.log(`💱 Đã chuyển giá gói ${name} từ USD sang VND`);
    }

    // Khởi động hệ thống tác vụ định kỳ (Cron Worker) với Distributed Lock chống trùng lặp đa pod
    const cronWorker = require('./src/jobs/cronWorker');
    cronWorker.startCronJobs();

    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  } catch (error) {
    console.error("❌ Server Error:", error);
  }
};

// Server started with SePay Integration
if (require.main === module) {
  startServer();
}

module.exports = { app, ensureUniqueIndex };
