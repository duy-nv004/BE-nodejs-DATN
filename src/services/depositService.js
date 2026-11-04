const DepositRecord = require('../models/DepositRecord');
const Contract = require('../models/Contract');
const Room = require('../models/Room');
const Building = require('../models/Building');
const { createError } = require('../utils/errors');

// Tạo bản ghi cọc "đang giữ" khi tạo/gia hạn hợp đồng
exports.createHeldRecord = async (contractId, amount) => {
    if (!amount || Number(amount) <= 0) return null;
    return await DepositRecord.create({
        contractId,
        amount,
        status: 'held'
    });
};

// Kiểm tra chủ nhà có quyền với hợp đồng không
const assertOwnership = async (landlordId, contractId) => {
    const contract = await Contract.findByPk(contractId, {
        include: [{ model: Room, as: 'room', include: [{ model: Building, as: 'building' }] }]
    });
    if (!contract || contract.room?.building?.landlordId !== landlordId) {
        throw createError(404, 'Hợp đồng không tồn tại hoặc bạn không có quyền thao tác');
    }
    return contract;
};

exports.getDepositRecords = async (landlordId, contractId) => {
    await assertOwnership(landlordId, contractId);
    return await DepositRecord.findAll({
        where: { contractId },
        order: [['createdAt', 'DESC']]
    });
};

// Ghi kết quả xử lý một bản ghi cọc đang giữ. Dùng chung cho refundDeposit (dữ liệu cũ)
// và thanh lý HĐ (C1, chạy trong transaction). status không truyền thì tự phân loại.
const settleHeldDeposit = async (record, { amount = 0, deductAmount = 0, note = null, status } = {}, transaction) => {
    const held = Number(record.amount);
    record.refundedAmount = Number(amount || 0);
    record.deductedAmount = Number(deductAmount || 0);
    record.note = note || null;
    record.refundedAt = new Date();
    // Phân loại: forfeited (giữ toàn bộ cọc) / deducted (hoàn một phần) / refunded (hoàn toàn bộ)
    record.status = status || (record.deductedAmount === held ? 'forfeited'
        : record.deductedAmount > 0 ? 'deducted' : 'refunded');
    await record.save({ transaction });
    return record;
};
exports.settleHeldDeposit = settleHeldDeposit;

// Xử lý cọc của HĐ đã kết thúc (dữ liệu cũ thanh lý trước khi có quyết toán C1).
// amount: số tiền hoàn trả thực nhận; deductAmount: số tiền khấu trừ/giữ lại.
exports.refundDeposit = async (landlordId, contractId, { amount = 0, deductAmount = 0, note = null } = {}) => {
    const contract = await assertOwnership(landlordId, contractId);
    if (!['terminated', 'cancelled', 'rejected'].includes(contract.status)) {
        throw createError(400, 'Chỉ xử lý cọc sau khi thanh lý hợp đồng');
    }

    const record = await DepositRecord.findOne({
        where: { contractId, status: 'held' },
        order: [['createdAt', 'DESC']]
    });
    if (!record) {
        throw createError(404, 'Hợp đồng này không có tiền cọc đang giữ để xử lý');
    }

    const refund = Number(amount ?? 0);
    const deduct = Number(deductAmount ?? 0);
    if (!Number.isFinite(refund) || !Number.isFinite(deduct) || refund < 0 || deduct < 0) {
        throw createError(400, 'Số tiền hoàn trả và khấu trừ phải là số không âm');
    }
    const total = refund + deduct;
    const held = Number(record.amount);
    if (total !== held) {
        throw createError(400, `Tổng hoàn trả và khấu trừ (${total}) phải bằng số cọc đang giữ (${held})`);
    }

    await settleHeldDeposit(record, { amount, deductAmount, note });
    return { message: 'Xử lý tiền cọc thành công.', record };
};
