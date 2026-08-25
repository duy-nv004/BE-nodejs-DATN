const contractService = require('../services/contractService');

// 1. TẠO HỢP ĐỒNG
exports.createContract = async (req, res) => {
    try {
        const result = await contractService.createContract(req.user.id, req.body);
        res.status(201).json(result);
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
        const result = await contractService.terminateContract(req.user.id, req.params.id);
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