const adminService = require('../services/adminService');

// 1. Lấy thống kê hệ thống (Dashboard)
exports.getSystemStats = async (req, res) => {
    try {
        const result = await adminService.getSystemStats();
        res.status(200).json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 2. Lấy danh sách các chủ nhà
exports.getLandlords = async (req, res) => {
    try {
        const result = await adminService.getLandlordsList();
        res.status(200).json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 3. Cập nhật gói cước của chủ nhà
exports.updateLandlordPlan = async (req, res) => {
    try {
        const { id } = req.params;
        const { plan } = req.body;
        const result = await adminService.updateLandlordPlan(id, plan);
        res.status(200).json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 4. Lấy cấu hình các gói dịch vụ
exports.getPlans = async (req, res) => {
    try {
        const result = await adminService.getPlans();
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 5. Cập nhật giới hạn gói dịch vụ
exports.updatePlan = async (req, res) => {
    try {
        const result = await adminService.updatePlan(req.params.id, req.body);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};
