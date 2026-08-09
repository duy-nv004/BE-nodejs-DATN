const tenantService = require('../services/tenantService');
const supportService = require('../services/supportService');

// 1. LẤY TỔNG QUAN DASHBOARD
exports.getDashboardSummary = async (req, res) => {
    try {
        const result = await tenantService.getDashboardSummary(req.user.id);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 2. LẤY DANH SÁCH HÓA ĐƠN
exports.getInvoices = async (req, res) => {
    try {
        const result = await tenantService.getInvoices(req.user.id);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 3. LẤY DANH SÁCH YÊU CẦU HỖ TRỢ
exports.getSupportRequests = async (req, res) => {
    try {
        const result = await supportService.getTenantRequests(req.user.id);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 4. GỬI YÊU CẦU HỖ TRỢ MỚI
exports.createSupportRequest = async (req, res) => {
    try {
        const result = await supportService.createTenantRequest(req.user.id, req.body);
        res.status(201).json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};
