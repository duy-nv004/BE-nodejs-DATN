const depositService = require('../services/depositService');

// Lấy lịch sử tiền cọc của một hợp đồng
exports.getDepositRecords = async (req, res) => {
    try {
        const records = await depositService.getDepositRecords(req.user.id, req.params.contractId);
        res.json(records);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// Xử lý cọc khi thanh lý: hoàn trả / khấu trừ / giữ cọc
exports.refundDeposit = async (req, res) => {
    try {
        const result = await depositService.refundDeposit(req.user.id, req.params.contractId, req.body);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};