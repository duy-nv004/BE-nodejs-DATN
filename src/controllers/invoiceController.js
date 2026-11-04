const invoiceService = require('../services/invoiceService');

// 1. XUẤT HÓA ĐƠN
exports.generateInvoice = async (req, res) => {
    try {
        // Chỉ nhận kỳ hóa đơn từ client; terminationDate (T2.3) dành riêng cho luồng thanh lý
        const { roomId, month, year } = req.body || {};
        const result = await invoiceService.generateInvoice({ roomId, month, year }, req.user.id);
        res.status(201).json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 2. XÁC NHẬN THANH TOÁN
exports.updatePaymentStatus = async (req, res) => {
    try {
        const result = await invoiceService.updatePaymentStatus(req.params.id, req.body, req.user.id);
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

// 4. DANH SÁCH HÓA ĐƠN CỦA CHỦ NHÀ
exports.listInvoices = async (req, res) => {
    try {
        res.json(await invoiceService.listInvoices(req.user.id, req.query));
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 5. XÓA HÓA ĐƠN CHƯA THU
exports.deleteInvoice = async (req, res) => {
    try {
        res.json(await invoiceService.deleteInvoice(Number(req.params.id), req.user.id));
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};
