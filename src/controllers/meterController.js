const MeterReading = require('../models/MeterReading');
const Room = require('../models/Room');

exports.updateRoomReadings = async (req, res) => {
    try {
        const { roomId, electricityValue, waterValue } = req.body;

        // 1. Kiểm tra phòng
        const room = await Room.findByPk(roomId);
        if (!room) return res.status(404).json({ message: "Không tìm thấy phòng" });

        // 2. Tạo mảng dữ liệu để lưu đồng thời
        const readingsData = [
            {
                roomId,
                type: 'electricity',
                readingValue: electricityValue,
                isInitial: false,
                readingDate: new Date()
            },
            {
                roomId,
                type: 'water',
                readingValue: waterValue,
                isInitial: false,
                readingDate: new Date()
            }
        ];

        // 3. Lưu vào Database
        const newReadings = await MeterReading.bulkCreate(readingsData);

        res.status(201).json({
            message: "Đã cập nhật chỉ số điện và nước thành công",
            data: newReadings
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};