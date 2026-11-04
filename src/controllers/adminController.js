const adminService = require('../services/adminService');

/**
 * Middleware helper để xử lý lỗi controller một cách nhất quán.
 * Tránh lặp lại try/catch ở từng handler.
 */
const asyncHandler = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch(err => {
        res.status(err.statusCode || 500).json({ message: err.message });
    });
};

// ─── Dashboard ─────────────────────────────────────────────────────────────────

/** Lấy thống kê tổng quan hệ thống */
exports.getSystemStats = asyncHandler(async (req, res) => {
    const result = await adminService.getSystemStats();
    res.status(200).json(result);
});

// ─── Landlords ──────────────────────────────────────────────────────────────────

/** Lấy danh sách tất cả chủ nhà */
exports.getLandlords = asyncHandler(async (req, res) => {
    const result = await adminService.getLandlordsList();
    res.status(200).json(result);
});

/** Cập nhật gói cước của một chủ nhà */
exports.updateLandlordPlan = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { plan, billingCycle } = req.body;
    const result = await adminService.updateLandlordPlan(id, plan, req.user.id, billingCycle);
    res.status(200).json(result);
});

/** Khóa hoặc mở khóa tài khoản chủ nhà */
exports.updateLandlordStatus = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status, reason, resetPassword } = req.body;
    const result = await adminService.updateLandlordStatus(id, status, req.user.id, { reason, resetPassword: resetPassword === true });
    res.status(200).json(result);
});

// ─── Plans ──────────────────────────────────────────────────────────────────────

/** Lấy cấu hình tất cả các gói dịch vụ */
exports.getPlans = asyncHandler(async (req, res) => {
    const result = await adminService.getPlans();
    res.status(200).json(result);
});

/** Cập nhật giới hạn và giá của một gói dịch vụ */
exports.updatePlan = asyncHandler(async (req, res) => {
    const result = await adminService.updatePlan(req.params.id, req.body, req.user.id);
    res.status(200).json(result);
});

// ─── Admin Logs & SePay Reconciliation ──────────────────────────────────────────

/** Lấy nhật ký hoạt động hệ thống */
exports.getAdminLogs = asyncHandler(async (req, res) => {
    const result = await adminService.getAdminLogs(req.query);
    res.status(200).json(result);
});

/** Lấy danh sách sự kiện SePay để đối soát (T1.3) */
exports.getSePayEvents = asyncHandler(async (req, res) => {
    const result = await adminService.getSePayEvents(req.query);
    res.status(200).json(result);
});

/** Lấy danh sách yêu cầu nâng cấp gói cước (T2.12) */
exports.getUpgradeRequests = asyncHandler(async (req, res) => {
    const result = await adminService.getUpgradeRequests(req.query);
    res.status(200).json(result);
});

// ─── Tickets ────────────────────────────────────────────────────────────────────

/** Lấy danh sách ticket khiếu nại của chủ nhà */
exports.getTickets = asyncHandler(async (req, res) => {
    const result = await adminService.getLandlordTickets();
    res.status(200).json(result);
});

/** Giải quyết ticket khiếu nại (resolved / rejected) */
exports.resolveTicket = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status, reason } = req.body;
    const result = await adminService.resolveLandlordTicket(id, status, req.user.id, { reason });
    res.status(200).json(result);
});
