const meterService = require('../services/meterService');
const { sendError } = require('../utils/errors');

exports.updateRoomReadings = async (req, res) => {
    try {
        const result = await meterService.updateRoomReadings(req.user.id, req.body);
        res.status(201).json({
            message: "Đã cập nhật chỉ số điện và nước thành công",
            data: result
        });
    } catch (err) {
        sendError(res, err);
    }
};

exports.checkMeterAnomaly = async (req, res) => {
    try {
        const { roomId, electricityValue, waterValue, period } = req.body;
        const result = await meterService.checkMeterAnomaly(roomId, { electricityValue, waterValue, period });
        res.status(200).json(result);
    } catch (err) {
        sendError(res, err);
    }
};
