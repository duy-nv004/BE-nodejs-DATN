const fs = require('fs');
const path = require('path');
const contractService = require('../services/contractService');

// 1. TẠO HỢP ĐỒNG
exports.createContract = async (req, res) => {
    try {
        const result = await contractService.createContract(req.user.id, req.body, req.files || {});
        res.status(201).json(result);
    } catch (err) {
        // Tạo HĐ lỗi -> xóa ảnh CCCD vừa upload để không để lại file mồ côi
        for (const f of Object.values(req.files || {}).flat()) fs.unlink(f.path, () => {});
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 1b. ẢNH CCCD (không public): chỉ chủ nhà sở hữu tòa nhà mới tải được
exports.getCccdImage = async (req, res) => {
    try {
        const filename = await contractService.getCccdImageName(
            { id: req.user.id, role: 'landlord' }, req.params.id, req.params.filename);
        res.sendFile(path.join(__dirname, '../../uploads/cccd', filename), (err) => {
            if (!err) return;
            if (res.headersSent) res.end();
            else res.status(404).json({ message: 'Không tìm thấy ảnh.' });
        });
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 2. LẤY DANH SÁCH HỢP ĐỒNG
exports.getContracts = async (req, res) => {
    try {
        const result = await contractService.getContracts(req.user.id);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 3. CHI TIẾT HỢP ĐỒNG
exports.getContractDetail = async (req, res) => {
    try {
        const result = await contractService.getContractDetail(req.user.id, req.params.id);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 4. THANH LÝ HỢP ĐỒNG
exports.terminateContract = async (req, res) => {
    try {
        const result = await contractService.terminateContract(req.user.id, req.params.id, req.body || {});
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 4b. XEM TRƯỚC QUYẾT TOÁN THANH LÝ (chỉ đọc)
exports.settlementPreview = async (req, res) => {
    try {
        const result = await contractService.getSettlementPreview(req.user.id, req.params.id, req.body || {});
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 4c. YÊU CẦU CỦA KHÁCH (C5)
exports.getRequests = async (req, res) => {
    try {
        res.json(await contractService.getLandlordRequests(req.user.id));
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

exports.respondRequest = async (req, res) => {
    try {
        res.json(await contractService.respondRequest(req.user.id, req.params.requestId, req.body || {}));
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 4d. NGƯỜI Ở CÙNG & TẠM TRÚ (C6)
const occupantUser = (req) => ({ id: req.user.id, role: 'landlord' });
exports.listOccupants = async (req, res) => {
    try {
        const result = await contractService.listOccupants(occupantUser(req), req.params.id);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};
exports.addOccupant = async (req, res) => {
    try {
        const result = await contractService.addOccupant(occupantUser(req), req.params.id, req.body || {}, req.files || {});
        res.json(result);
    } catch (err) {
        // Thêm người ở lỗi -> xóa ảnh CCCD vừa upload để không để lại file mồ côi
        for (const f of Object.values(req.files || {}).flat()) fs.unlink(f.path, () => {});
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};
exports.updateOccupant = async (req, res) => {
    try {
        const result = await contractService.updateOccupant(occupantUser(req), req.params.occupantId, req.body || {});
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};
exports.removeOccupant = async (req, res) => {
    try {
        const result = await contractService.removeOccupant(occupantUser(req), req.params.occupantId);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 5. HỦY HỢP ĐỒNG CHỜ KÝ
exports.cancelContract = async (req, res) => {
    try {
        const result = await contractService.cancelContractByLandlord(req.user.id, req.params.id);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// 6. GIA HẠN HỢP ĐỒNG
exports.renewContract = async (req, res) => {
    try {
        const result = await contractService.renewContract(req.user.id, req.params.id, req.body);
        res.status(201).json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};