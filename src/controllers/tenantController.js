const fs = require('fs');
const tenantService = require('../services/tenantService');
const supportService = require('../services/supportService');
const contractService = require('../services/contractService');

// 1. LẤY TỔNG QUAN DASHBOARD
exports.getDashboardSummary = async (req, res) => {
    try {
        const result = await tenantService.getDashboardSummary(req.user.id, req.query.contractId || null);
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

// 5. KÍ HỢP ĐỒNG (Dành cho Người thuê)
exports.signContract = async (req, res) => {
    try {
        const { id } = req.params;
        const { signature } = req.body;
        const result = await contractService.signContractByTenant(req.user.id, id, signature, {
            ip: req.ip,
            userAgent: typeof req.get === 'function' ? req.get('user-agent') : req.headers?.['user-agent'],
        });
        res.json({ message: 'Ký hợp đồng thành công! Hợp đồng đã có hiệu lực.', contract: result });
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 5b. YÊU CẦU TRẢ PHÒNG / GIA HẠN (C5)
exports.createContractRequest = async (req, res) => {
    try {
        const result = await contractService.createTenantRequest(req.user.id, req.params.id, req.body || {});
        res.status(201).json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

exports.getContractRequests = async (req, res) => {
    try {
        res.json(await contractService.getTenantRequests(req.user.id));
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 5c. NGƯỜI Ở CÙNG (C6): khách chỉ xem / thêm, không đổi trạng thái tạm trú
exports.listOccupants = async (req, res) => {
    try {
        res.json(await contractService.listOccupants({ id: req.user.id, role: 'tenant' }, req.params.id));
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

exports.addOccupant = async (req, res) => {
    try {
        const result = await contractService.addOccupant({ id: req.user.id, role: 'tenant' }, req.params.id, req.body || {}, req.files || {});
        res.status(201).json(result);
    } catch (err) {
        // Thêm người ở lỗi -> xóa ảnh CCCD vừa upload để không để lại file mồ côi
        for (const f of Object.values(req.files || {}).flat()) fs.unlink(f.path, () => {});
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 6. TỪ CHỐI KÍ HỢP ĐỒNG (Dành cho Người thuê)
exports.rejectContract = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        const result = await contractService.rejectContractByTenant(req.user.id, id, reason);
        res.json({ message: 'Đã từ chối ký hợp đồng.', contract: result });
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 4. TẠO YÊU CẦU HỖ TRỢ MỚI
exports.createSupportRequest = async (req, res) => {
    const files = req.files || [];
    try {
        const images = files.map(f => 'uploads/support/' + f.filename);
        const result = await supportService.createTenantRequest(req.user.id, { ...req.body, images });
        res.status(201).json({ message: 'Tạo yêu cầu hỗ trợ thành công', data: result });
    } catch (err) {
        // Không lưu được yêu cầu thì xóa ảnh vừa upload để không để lại file mồ côi
        files.forEach(f => fs.unlink(f.path, () => {}));
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};
