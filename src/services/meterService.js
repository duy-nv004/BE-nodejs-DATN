const MeterReading = require('../models/MeterReading');
const Room = require('../models/Room');
const Building = require('../models/Building');
const { createError } = require('../utils/errors');

/** Kỳ chốt số dạng YYYY-MM. Mặc định là tháng hiện tại. */
const resolvePeriod = (period) => {
    if (period && /^\d{4}-\d{2}$/.test(period)) return period;
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

/**
 * Chốt chỉ số điện/nước cho một phòng trong một kỳ.
 *
 * Ghi theo kiểu upsert trên khoá (roomId, type, period): chốt lại cùng một tháng
 * sẽ SỬA số cũ chứ không tạo thêm bản ghi. Trước đây dùng bulkCreate nên mỗi lần
 * bấm "Lưu & Xuất HĐ" lại sinh thêm 2 dòng, và lần xuất hóa đơn sau lấy nhầm cặp
 * chỉ số đã lệch.
 */
exports.updateRoomReadings = async (landlordId, { roomId, electricityValue, waterValue, period }) => {
    if (!roomId || electricityValue === undefined || waterValue === undefined) {
        throw createError(400, "Thiếu thông tin phòng hoặc chỉ số điện/nước");
    }

    const room = await Room.findByPk(roomId, {
        include: [{ model: Building, as: 'building' }]
    });

    if (!room || room.building.landlordId !== landlordId) {
        throw createError(404, "Phòng trọ không tồn tại hoặc bạn không có quyền cập nhật");
    }

    const targetPeriod = resolvePeriod(period);
    const readingDate = `${targetPeriod}-01`;

    const results = [];
    for (const [type, value] of [['electricity', electricityValue], ['water', waterValue]]) {
        const [reading, created] = await MeterReading.findOrCreate({
            where: { roomId, type, period: targetPeriod },
            defaults: {
                roomId,
                type,
                period: targetPeriod,
                readingValue: value,
                isInitial: false,
                readingDate
            }
        });

        if (!created) {
            reading.readingValue = value;
            reading.readingDate = readingDate;
            await reading.save();
        }
        results.push(reading);
    }

    return results;
};

exports.resolvePeriod = resolvePeriod;
