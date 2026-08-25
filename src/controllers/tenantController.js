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

const contractService = require('../services/contractService');

// 5. KÍ HỢP ĐỒNG (Dành cho Người thuê)
exports.signContract = async (req, res) => {
    try {
        const { id } = req.params;
        const { signature } = req.body;
        const result = await contractService.signContractByTenant(req.user.id, id, signature);
        res.json({ message: 'Ký hợp đồng thành công! Hợp đồng đã có hiệu lực.', contract: result });
    } catch (err) {
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
    try {
        // req.body chứa thông tin người thuê gửi lên (ví dụ: tiêu đề, nội dung)
        const requestData = req.body; 
        
        // Gọi service để tạo yêu cầu (tùy thuộc vào hàm trong supportService của bạn)
        const result = await supportService.createRequest(req.user.id, requestData); 
        
        res.status(201).json({ message: 'Tạo yêu cầu hỗ trợ thành công', data: result });
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};
