const path = require('path');
const supportService = require('../services/supportService');

exports.getLandlordRequests = async (req, res) => {
    try {
        const result = await supportService.getLandlordRequests(req.user.id, req.query);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

exports.getTenantRequests = async (req, res) => {
    try {
        const result = await supportService.getTenantRequests(req.user.id, req.query);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

exports.updateRequestStatus = async (req, res) => {
    try {
        const result = await supportService.updateRequestStatus(req.user.id, req.params.id, req.body);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// Ảnh sự cố không còn phục vụ công khai (R4): chỉ stream khi đã đăng nhập và có quyền
// xem yêu cầu (khách tạo yêu cầu hoặc chủ nhà sở hữu tòa nhà) — service lo phần kiểm tra.
exports.getSupportImage = async (req, res) => {
    try {
        const filename = await supportService.getRequestImageName(req.user, req.params.requestId, req.params.filename);
        res.sendFile(path.join(__dirname, '../../uploads/support', filename), (err) => {
            if (!err) return;
            // File không còn trên đĩa -> 404 thay vì 500
            if (res.headersSent) res.end();
            else res.status(404).json({ message: 'Không tìm thấy ảnh.' });
        });
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};
