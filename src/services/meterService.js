const MeterReading = require('../models/MeterReading');
const Room = require('../models/Room');
const Building = require('../models/Building');
const Contract = require('../models/Contract');
const Invoice = require('../models/Invoice');
const { Op } = require('sequelize');
const dayjs = require('dayjs');
const sequelize = require('../config/db');
const { createError } = require('../utils/errors');

/**
 * Kỳ chốt số dạng YYYY-MM. Bỏ trống thì lấy tháng hiện tại; truyền sai định dạng
 * (vd 2026-13) thì 400, không âm thầm ghi số vào tháng hiện tại.
 */
const resolvePeriod = (period) => {
    if (period) {
        if (/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return period;
        throw createError(400, `Kỳ chốt số "${period}" không hợp lệ, cần dạng YYYY-MM (tháng 01-12)`);
    }
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

const METER_LABELS = { electricity: 'điện', water: 'nước' };

/**
 * T2.4: Kiểm tra giá trị chỉ số so với kỳ trước, có hỗ trợ thay đồng hồ (meterReset).
 */
const validateReadingValue = (val, label, prevVal, { meterReset = false, resetReason = '' } = {}) => {
    const num = val === null || val === '' || val === undefined ? NaN : Number(val);
    if (!Number.isInteger(num) || num < 0) {
        throw createError(400, `Chỉ số ${label} phải là số nguyên không âm`);
    }
    if (meterReset) {
        const reason = typeof resetReason === 'string' ? resetReason.trim() : '';
        if (reason.length < 5) {
            throw createError(400, 'Vui lòng nhập lý do thay/reset đồng hồ (tối thiểu 5 ký tự).');
        }
        return num;
    }
    if (prevVal !== undefined && prevVal !== null && num < prevVal) {
        throw createError(
            400,
            `Chỉ số ${label} mới (${num}) nhỏ hơn chỉ số kỳ trước (${prevVal}). Nếu vừa thay đồng hồ mới, vui lòng bật tùy chọn thay đồng hồ (meterReset).`
        );
    }
    return num;
};
exports.validateReadingValue = validateReadingValue;

/**
 * Kiểm tra chỉ số mới: số nguyên >= 0, không nhỏ hơn kỳ liền trước (hoặc chỉ số
 * ban đầu của HĐ active nếu chưa có kỳ trước), không lớn hơn kỳ liền sau khi sửa
 * kỳ cũ. Trả về giá trị đã ép kiểu. Export để thanh lý HĐ (C1) dùng lại.
 */
const validateReading = async (roomId, type, value, period, options = {}) => {
    const { meterReset = false, resetReason = '', transaction = null } = options;
    const txOpt = transaction ? { transaction } : {};
    const label = METER_LABELS[type] || type;

    // Kiểm tra định dạng số trước để báo lỗi sớm
    const rawNum = value === null || value === '' || value === undefined ? NaN : Number(value);
    if (!Number.isInteger(rawNum) || rawNum < 0) {
        throw createError(400, `Chỉ số ${label} phải là số nguyên không âm`);
    }

    const previous = await MeterReading.findOne({
        where: { roomId, type, period: { [Op.lt]: period, [Op.ne]: null } },
        order: [['period', 'DESC']],
        ...txOpt,
    });
    let prevVal = previous?.readingValue;
    if (prevVal === undefined) {
        const contract = await Contract.findOne({ where: { roomId, status: 'active' }, ...txOpt });
        const initial = contract?.[type === 'electricity' ? 'initialElectricity' : 'initialWater'];
        if (initial !== undefined && initial !== null) prevVal = Number(initial);
    }

    const num = validateReadingValue(value, label, prevVal, { meterReset, resetReason });

    const next = await MeterReading.findOne({
        where: { roomId, type, period: { [Op.gt]: period } },
        order: [['period', 'ASC']],
        ...txOpt,
    });
    if (next && !next.meterReset && num > next.readingValue) {
        throw createError(400, `Chỉ số ${label} mới (${num}) lớn hơn chỉ số kỳ sau (${next.readingValue})`);
    }
    return num;
};
exports.validateReading = validateReading;

/**
 * Chốt chỉ số điện/nước cho một phòng trong một kỳ.
 * Hỗ trợ cả hai kiểu gọi:
 *   1) updateRoomReadings(landlordId, { roomId, electricityValue, waterValue, period, ... }, options)
 *   2) updateRoomReadings(roomId, electricityValue, waterValue, period, landlordId, options)
 */
exports.updateRoomReadings = async function (arg1, arg2, arg3, arg4, arg5, arg6) {
    let landlordId, roomId, electricityValue, waterValue, period, opts;
    if (arg2 && typeof arg2 === 'object' && !Array.isArray(arg2)) {
        landlordId = arg1;
        ({ roomId, electricityValue, waterValue, period } = arg2);
        opts = { ...arg2, ...(arg3 || {}) };
    } else {
        roomId = arg1;
        electricityValue = arg2;
        waterValue = arg3;
        period = arg4;
        landlordId = arg5;
        opts = arg6 || {};
    }

    const hasElec = electricityValue !== undefined && electricityValue !== null;
    const hasWater = waterValue !== undefined && waterValue !== null;
    if (!roomId || (!hasElec && !hasWater)) {
        throw createError(400, "Thiếu thông tin phòng hoặc chỉ số điện/nước");
    }

    const extTx = opts.transaction || null;
    const txOpt = extTx ? { transaction: extTx } : {};

    const room = await Room.findByPk(roomId, {
        include: [{ model: Building, as: 'building' }],
        ...txOpt,
    });

    if (!room || (landlordId && room.building.landlordId !== landlordId)) {
        throw createError(404, "Phòng trọ không tồn tại hoặc bạn không có quyền cập nhật");
    }

    const targetPeriod = resolvePeriod(period);
    const readingDate = `${targetPeriod}-01`;

    // Kỳ đã xuất hóa đơn: sửa chỉ số sẽ lệch với số đã tính tiền
    const [y, m] = targetPeriod.split('-').map(Number);
    if (await Invoice.findOne({ where: { roomId, month: m, year: y }, ...txOpt })) {
        throw createError(409, 'Kỳ này đã có hóa đơn, hãy xóa hóa đơn trước khi sửa chỉ số');
    }
    // Mốc bàn giao do ký HĐ ghi (contractService), không sửa qua chốt số hằng tháng
    if (await MeterReading.findOne({ where: { roomId, period: targetPeriod, isInitial: true }, ...txOpt })) {
        throw createError(409, `Kỳ ${targetPeriod} là chỉ số bàn giao của hợp đồng, không thể sửa`);
    }

    // T2.5: cùng điều kiện với xuất hóa đơn (invoiceService) để hai API không mâu thuẫn.
    // Kỳ chứa ngày bắt đầu/hết hạn vẫn chốt được; phòng chưa có HĐ active thì bỏ qua.
    const contract = await Contract.findOne({ where: { roomId, status: 'active' }, ...txOpt });
    const label = `${String(m).padStart(2, '0')}/${y}`;
    if (contract?.startDate && targetPeriod < dayjs(contract.startDate).format('YYYY-MM')) {
        throw createError(400, `Kỳ ${label} trước ngày bắt đầu hợp đồng (${dayjs(contract.startDate).format('DD/MM/YYYY')}), không thể chốt số.`);
    }
    if (contract?.endDate && targetPeriod > dayjs(contract.endDate).format('YYYY-MM')) {
        throw createError(400, `Kỳ ${label} sau ngày hết hạn hợp đồng (${dayjs(contract.endDate).format('DD/MM/YYYY')}), vui lòng gia hạn hoặc thanh lý.`);
    }

    // Validate các loại được gửi trước khi ghi, tránh lưu điện xong mới báo lỗi nước
    const entries = [];
    if (hasElec) {
        const isElecReset = Boolean(opts.electricityReset ?? opts.meterReset);
        const val = await validateReading(roomId, 'electricity', electricityValue, targetPeriod, {
            meterReset: isElecReset,
            resetReason: opts.resetReason,
            transaction: extTx,
        });
        entries.push({
            type: 'electricity',
            value: val,
            meterReset: isElecReset,
            resetReason: isElecReset ? String(opts.resetReason || '').trim() : null,
        });
    }
    if (hasWater) {
        const isWaterReset = Boolean(opts.waterReset ?? opts.meterReset);
        const val = await validateReading(roomId, 'water', waterValue, targetPeriod, {
            meterReset: isWaterReset,
            resetReason: opts.resetReason,
            transaction: extTx,
        });
        entries.push({
            type: 'water',
            value: val,
            meterReset: isWaterReset,
            resetReason: isWaterReset ? String(opts.resetReason || '').trim() : null,
        });
    }

    const writeReadings = async (transaction) => {
        const results = [];
        for (const item of entries) {
            const defaults = {
                roomId,
                type: item.type,
                period: targetPeriod,
                readingValue: item.value,
                isInitial: false,
                readingDate,
                ...(item.meterReset ? { meterReset: true, resetReason: item.resetReason } : {}),
            };
            const [reading, created] = await MeterReading.findOrCreate({
                where: { roomId, type: item.type, period: targetPeriod },
                defaults,
                transaction,
            });

            if (!created) {
                reading.readingValue = item.value;
                reading.readingDate = readingDate;
                reading.meterReset = item.meterReset;
                reading.resetReason = item.resetReason;
                await reading.save({ transaction });
            }
            results.push(reading);
        }
        return results;
    };

    if (extTx) {
        return writeReadings(extTx);
    }
    return sequelize.transaction(async (transaction) => writeReadings(transaction));
};

exports.resolvePeriod = resolvePeriod;

/**
 * Phát hiện bất thường tiêu thụ điện/nước so với trung bình các kỳ trước.
 */
exports.checkMeterAnomaly = async (roomId, { electricityValue, waterValue, period } = {}) => {
    const targetPeriod = resolvePeriod(period);
    const warnings = [];

    const getPastReadings = async (type) => {
        return MeterReading.findAll({
            where: {
                roomId,
                type,
                period: { [Op.lt]: targetPeriod, [Op.ne]: null }
            },
            order: [['period', 'DESC']],
            limit: 4
        });
    };

    const checkType = async (type, currentVal, minThreshold, label, unit) => {
        if (currentVal === undefined || currentVal === null || currentVal === '') return;
        const numVal = Number(currentVal);
        if (!Number.isFinite(numVal) || numVal < 0) return;

        const past = await getPastReadings(type);
        if (past.length < 2) return;

        const usages = [];
        for (let i = 0; i < past.length - 1; i++) {
            const delta = past[i].meterReset ? past[i].readingValue : (past[i].readingValue - past[i + 1].readingValue);
            if (delta >= 0) usages.push(delta);
        }

        if (usages.length === 0) return;
        const avg = usages.reduce((a, b) => a + b, 0) / usages.length;
        if (avg <= 0) return;

        const lastReading = past[0];
        const currentUsage = numVal - lastReading.readingValue;

        if (currentUsage > 1.5 * avg && currentUsage > minThreshold) {
            const percent = Math.round(((currentUsage - avg) / avg) * 100);
            warnings.push({
                type,
                label,
                unit,
                currentUsage,
                averageUsage: Math.round(avg),
                percentIncrease: percent,
                message: `Chỉ số ${label} tiêu thụ (${currentUsage} ${unit}) tăng ${percent}% so với trung bình ${usages.length} kỳ trước (${Math.round(avg)} ${unit}). Vui lòng kiểm tra lại.`
            });
        }
    };

    await checkType('electricity', electricityValue, 30, 'điện', 'kWh');
    await checkType('water', waterValue, 5, 'nước', 'm³');

    return {
        isAbnormal: warnings.length > 0,
        warnings
    };
};
