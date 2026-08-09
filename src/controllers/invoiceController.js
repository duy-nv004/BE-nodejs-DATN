const invoiceService = require('../services/invoiceService');

// 1. XUẤT HÓA ĐƠN
exports.generateInvoice = async (req, res) => {
    try {
        const result = await invoiceService.generateInvoice(req.body);
        res.status(201).json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 2. XÁC NHẬN THANH TOÁN
exports.updatePaymentStatus = async (req, res) => {
    try {
        const result = await invoiceService.updatePaymentStatus(req.params.id, req.body);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 3. THỐNG KÊ DOANH THU
exports.getRevenueStats = async (req, res) => {
    try {
        const result = await invoiceService.getRevenueStats(req.user.id, req.query);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};
