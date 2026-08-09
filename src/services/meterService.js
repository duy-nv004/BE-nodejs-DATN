const MeterReading = require('../models/MeterReading');
const Room = require('../models/Room');
const Building = require('../models/Building');
const { createError } = require('../utils/errors');

exports.updateRoomReadings = async (landlordId, { roomId, electricityValue, waterValue }) => {
    if (!roomId || electricityValue === undefined || waterValue === undefined) {
        throw createError(400, "Thiếu thông tin phòng hoặc chỉ số điện/nước");
    }

    const room = await Room.findByPk(roomId, {
        include: [{ model: Building, as: 'building' }]
    });

    if (!room || room.building.landlordId !== landlordId) {
        throw createError(404, "Phòng trọ không tồn tại hoặc bạn không có quyền cập nhật");
    }

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

    const newReadings = await MeterReading.bulkCreate(readingsData);
    return newReadings;
};
