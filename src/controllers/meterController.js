const meterService = require('../services/meterService');

exports.updateRoomReadings = async (req, res) => {
    try {
        const result = await meterService.updateRoomReadings(req.user.id, req.body);
        res.status(201).json({
            message: "Đã cập nhật chỉ số điện và nước thành công",
            data: result
        });
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};