const crypto = require('crypto');
const Contract = require('../models/Contract');
const Room = require('../models/Room');
const Building = require('../models/Building');
const User = require('../models/User');
const MeterReading = require('../models/MeterReading');
const DepositRecord = require('../models/DepositRecord');
const sequelize = require('../config/db');
const { createError } = require('../utils/errors');
const { Op } = require('sequelize');
const dayjs = require('dayjs');
const Role = require('../models/Role');
const Notification = require('../models/Notification');
const notificationService = require('./notificationService');
const Invoice = require('../models/Invoice');
const meterService = require('./meterService');
const invoiceService = require('./invoiceService');
const depositService = require('./depositService');
const ContractRequest = require('../models/ContractRequest');
const ContractOccupant = require('../models/ContractOccupant');

// Các trường tiền / chỉ số phải là số hữu hạn >= 0 (bỏ qua nếu không gửi)
const NON_NEGATIVE_FIELDS = {
    deposit: 'Tiền cọc', rentPrice: 'Giá thuê', electricityPrice: 'Giá điện', waterPrice: 'Giá nước',
    internetPrice: 'Giá internet', cleaningPrice: 'Phí vệ sinh',
    initialElectricity: 'Chỉ số điện ban đầu', initialWater: 'Chỉ số nước ban đầu'
};
const isBlank = (v) => v === undefined || v === null || v === '';

const MAX_SIGNATURE_BYTES = 200 * 1024;
const SIGNATURE_REGEX = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/;

const validateSignatureBase64 = (sig, label = 'Chữ ký điện tử') => {
    if (typeof sig !== 'string') {
        throw createError(400, `${label} không hợp lệ`);
    }
    const match = SIGNATURE_REGEX.exec(sig.trim());
    if (!match) {
        throw createError(400, `${label} phải có định dạng data:image/png;base64 hoặc data:image/jpeg;base64 hợp lệ`);
    }
    const base64Data = match[2];
    if (base64Data.length > MAX_SIGNATURE_BYTES || Buffer.byteLength(base64Data, 'base64') > MAX_SIGNATURE_BYTES) {
        throw createError(400, `${label} vượt quá kích thước cho phép (tối đa 200KB)`);
    }
};
exports.validateSignatureBase64 = validateSignatureBase64;

const computeContractContentHash = (contract) => {
    const core = {
        id: contract.id ?? null,
        roomId: contract.roomId ?? null,
        tenantId: contract.tenantId ?? null,
        startDate: contract.startDate ?? null,
        endDate: contract.endDate ?? null,
        rentPrice: contract.rentPrice ?? null,
        deposit: contract.deposit ?? null,
        electricityPrice: contract.electricityPrice ?? null,
        waterPrice: contract.waterPrice ?? null,
    };
    return crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex');
};
exports.computeContractContentHash = computeContractContentHash;

// files từ multer: { cccdFront: [file], cccdBack: [file] }
const assertCccdImages = (files = {}) => {
    if (!files.cccdFront?.[0] || !files.cccdBack?.[0]) {
        throw createError(400, 'Vui lòng tải lên đủ ảnh CCCD mặt trước và mặt sau để khai báo tạm trú');
    }
};

// Validate ngày và số của hợp đồng (tạo mới + gia hạn). `room` kiểm tra numTenants <= capacity.
const validateContractNumbers = (data, room = null) => {
    const start = dayjs(data.startDate);
    const end = dayjs(data.endDate);
    if (!start.isValid() || !end.isValid()) {
        throw createError(400, 'Ngày bắt đầu hoặc ngày kết thúc không hợp lệ');
    }
    if (!end.isAfter(start)) {
        throw createError(400, 'Ngày kết thúc phải sau ngày bắt đầu');
    }
    for (const [field, label] of Object.entries(NON_NEGATIVE_FIELDS)) {
        if (isBlank(data[field])) continue;
        const n = Number(data[field]);
        if (!Number.isFinite(n) || n < 0) throw createError(400, `${label} phải là số không âm`);
    }
    if (!isBlank(data.paymentDay)) {
        const d = Number(data.paymentDay);
        if (!Number.isInteger(d) || d < 1 || d > 31) throw createError(400, 'Ngày thanh toán phải là số nguyên từ 1 đến 31');
    }
    if (!isBlank(data.numTenants)) {
        const n = Number(data.numTenants);
        if (!Number.isInteger(n) || n < 1) throw createError(400, 'Số người ở phải là số nguyên từ 1 trở lên');
        if (room?.capacity && n > room.capacity) {
            throw createError(400, `Phòng ${room.roomNumber} chỉ cho tối đa ${room.capacity} người ở`);
        }
    }
};

// Hợp đồng đang hiệu lực khác của cùng phòng (tức là hợp đồng gốc khi `contract` là bản gia hạn)
const findPreviousActive = (contract, transaction) => Contract.findOne({
    where: { roomId: contract.roomId, status: 'active', id: { [Op.ne]: contract.id } },
    transaction
});

// Hợp đồng chờ ký bị hủy/từ chối: trả lại cọc đang giữ (bản gia hạn không có bản ghi cọc riêng nên không ảnh hưởng)
const releaseHeldDeposit = (contractId, note, transaction) => DepositRecord.update(
    { status: 'refunded', note, refundedAmount: sequelize.col('amount'), refundedAt: new Date() },
    { where: { contractId, status: 'held' }, transaction }
);

// Kỳ 'YYYY-MM' liền trước tháng của ngày cho trước ('2027-01-15' -> '2026-12')
const previousPeriod = (date) => {
    const [year, month] = String(date).slice(0, 7).split('-').map(Number);
    return month === 1
        ? `${year - 1}-12`
        : `${year}-${String(month - 1).padStart(2, '0')}`;
};

// 1. TẠO HỢP ĐỒNG (Chủ nhà khởi tạo & ký số)
// files: { cccdFront: [file], cccdBack: [file] } từ multer (có thể rỗng nếu client gửi JSON)
exports.createContract = async (landlordId, data, files = {}) => {
    const { 
        tenantId, roomId, startDate, endDate, deposit,
        electricityPrice, waterPrice, internetPrice, cleaningPrice,
        initialElectricity, initialWater,
        landlordName, landlordPhone, landlordCccd, landlordDob, landlordHometown, landlordAddress,
        landlordSignature,
        tenantCccd, tenantDob, tenantHometown, tenantPhone,
        numTenants, paymentDay, inventory, rentPrice, firstLastMonthPolicy,
        meterReset, electricityReset, waterReset
    } = data;

    // T2.3: không gửi thì giữ tròn tháng như trước
    if (!isBlank(firstLastMonthPolicy) && !['full', 'prorated'].includes(firstLastMonthPolicy)) {
        throw createError(400, 'Cách tính tiền phòng tháng đầu/cuối không hợp lệ (chỉ nhận "full" hoặc "prorated")');
    }

    // Đơn giá 0 là hợp lệ (chủ nhà tặng kèm điện/nước) nên phải so sánh tường minh,
    // dùng `!electricityPrice` sẽ chặn nhầm và báo sai là "thiếu thông tin".
    const missingPrice = [electricityPrice, waterPrice].some(v => v === undefined || v === null || v === '');
    if (!tenantId || !roomId || !startDate || !endDate || missingPrice) {
        throw createError(400, 'Vui lòng cung cấp đầy đủ thông tin hợp đồng');
    }

    if (initialElectricity === undefined || initialWater === undefined) {
        throw createError(400, 'Vui lòng cung cấp chỉ số điện nước bắt đầu cho phòng trọ');
    }

    if (!landlordSignature) {
        throw createError(400, 'Vui lòng thực hiện ký số đại diện Bên A (Chủ nhà) trước khi khởi tạo hợp đồng');
    }
    validateSignatureBase64(landlordSignature, 'Chữ ký đại diện Bên A');

    // Ảnh CCCD 2 mặt là minh chứng khai báo tạm trú của khách chính (chép sang dòng người ở khi ký)
    assertCccdImages(files);

    // Xác nhận xem phòng có thuộc sở hữu của landlord hay không
    const room = await Room.findByPk(roomId, {
        include: [{ model: Building, as: 'building' }]
    });

    if (!room || room.building.landlordId !== landlordId) {
        throw createError(404, 'Phòng trọ không tồn tại hoặc bạn không có quyền gán hợp đồng');
    }

    // Chỉ cho tạo hợp đồng trên phòng thực sự trống.
    if (room.status !== 'empty') {
        throw createError(400, `Phòng ${room.roomNumber} hiện không ở trạng thái trống `
            + `(đang là "${room.status}"). Vui lòng kiểm tra hợp đồng hiện có trước khi tạo mới.`);
    }

    validateContractNumbers(data, room);

    // T2.7: Kiểm tra chỉ số bàn giao so với chỉ số MeterReading lớn nhất trước đó của phòng (nếu không bật meterReset)
    for (const [type, initVal, typeReset] of [
        ['electricity', initialElectricity, electricityReset],
        ['water', initialWater, waterReset],
    ]) {
        if (meterReset || typeReset) continue;
        const lastReading = await MeterReading.findOne({
            where: { roomId, type },
            order: [['readingValue', 'DESC'], ['period', 'DESC']]
        });
        if (lastReading && Number(initVal) < Number(lastReading.readingValue)) {
            throw createError(400, `Chỉ số bàn giao nhỏ hơn chỉ số cuối của phòng (${lastReading.readingValue})`);
        }
    }

    // Chỉ gán HĐ cho tài khoản khách thuê đang hoạt động do chính chủ nhà này quản lý
    const tenant = await User.findOne({
        where: { id: tenantId, ownerId: landlordId, status: 'active' },
        include: [{ model: Role, as: 'roleData', where: { name: 'tenant' } }]
    });
    if (!tenant) {
        throw createError(404, 'Khách thuê không tồn tại, đã bị khóa hoặc không thuộc quyền quản lý của bạn');
    }

    // Tạo hợp đồng ở trạng thái CHỜ KHÁCH KÝ.
    const contract = await sequelize.transaction(async (t) => {
        const lockedRoom = await Room.findByPk(roomId, { lock: true, transaction: t });
        if (!lockedRoom || lockedRoom.status !== 'empty') {
            throw createError(409, `Phòng ${room.roomNumber} vừa được giữ chỗ bởi một hợp đồng khác. Vui lòng tải lại trang.`);
        }

        const created = await Contract.create({
            tenantId,
            roomId,
            startDate,
            endDate,
            deposit: deposit || 0,
            // Giá thuê chốt trong HĐ; không gửi thì lấy giá phòng hiện tại
            rentPrice: isBlank(rentPrice) ? room.price : rentPrice,
            electricityPrice,
            waterPrice,
            internetPrice: internetPrice || 0,
            cleaningPrice: cleaningPrice || 0,
            initialElectricity: initialElectricity || 0,
            initialWater: initialWater || 0,
            landlordName,
            landlordPhone,
            landlordCccd,
            landlordDob,
            landlordHometown,
            landlordAddress,
            landlordSignature,
            landlordSignedAt: new Date(),
            tenantCccd,
            tenantDob,
            tenantHometown,
            tenantPhone,
            tenantCccdFront: files.cccdFront?.[0]?.filename || null,
            tenantCccdBack: files.cccdBack?.[0]?.filename || null,
            numTenants: numTenants || 1,
            paymentDay: paymentDay || 30,
            firstLastMonthPolicy: isBlank(firstLastMonthPolicy) ? 'full' : firstLastMonthPolicy,
            inventory: inventory ? (typeof inventory === 'string' ? inventory : JSON.stringify(inventory)) : null,
            status: 'pending_tenant_signature'
        }, { transaction: t });

        // Giữ chỗ cho phòng trọ (reserved)
        room.status = 'reserved';
        await room.save({ transaction: t });

        // Ghi nhận tiền cọc nếu có
        if (deposit && Number(deposit) > 0) {
            await DepositRecord.create({
                contractId: created.id,
                amount: deposit,
                status: 'held'
            }, { transaction: t });
        }

        return created;
    });

    return contract;
};

// 2. KÍ HỢP ĐỒNG (Dành cho Người thuê)
exports.signContractByTenant = async (tenantId, contractId, tenantSignature, meta = {}) => {
    if (!tenantSignature) {
        throw createError(400, 'Vui lòng cung cấp chữ ký điện tử để hoàn tất ký hợp đồng');
    }
    validateSignatureBase64(tenantSignature, 'Chữ ký điện tử');

    const contract = await Contract.findOne({
        where: { id: contractId, tenantId, status: 'pending_tenant_signature' },
        include: [{ model: Room, as: 'room' }]
    });

    if (!contract) {
        throw createError(404, 'Không tìm thấy hợp đồng chờ ký phù hợp.');
    }

    // T2.7: Không cho ký hợp đồng đã quá ngày kết thúc
    if (contract.endDate && dayjs(contract.endDate).isBefore(dayjs(), 'day')) {
        throw createError(400, 'Hợp đồng đã quá ngày kết thúc, không thể ký.');
    }

    // Kỳ mốc của chỉ số bàn giao = tháng liền trước tháng bắt đầu hợp đồng
    const baselinePeriod = previousPeriod(contract.startDate);

    // Ba thay đổi (hợp đồng + chỉ số đầu kỳ + trạng thái phòng) phải cùng thành công
    // hoặc cùng thất bại.
    await sequelize.transaction(async (t) => {
        const stillPending = await Contract.findOne({
            where: { id: contractId, tenantId, status: 'pending_tenant_signature' },
            lock: true,
            transaction: t
        });
        if (!stillPending) {
            throw createError(409, 'Hợp đồng này vừa được xử lý ở một phiên khác. Vui lòng tải lại trang.');
        }

        // Bản gia hạn: hợp đồng gốc vẫn active tới lúc này, giờ mới chốt sang 'renewed'
        const previous = await findPreviousActive(contract, t);

        contract.tenantSignature = tenantSignature;
        contract.tenantSignedAt = new Date();
        contract.tenantSignedIp = meta?.ip || null;
        contract.tenantSignedUserAgent = meta?.userAgent || null;
        contract.contentHash = computeContractContentHash(contract);
        contract.status = 'active';
        await contract.save({ transaction: t });

        if (previous) {
            previous.status = 'renewed';
            await previous.save({ transaction: t });
            // Chuyển khoản cọc đang giữ sang hợp đồng mới thay vì ghi nhận cọc lần hai
            await DepositRecord.update(
                { contractId: contract.id },
                { where: { contractId: previous.id, status: 'held' }, transaction: t }
            );
            // Người ở cùng (kể cả dòng khách chính) chuyển sang HĐ mới, không tạo dòng isPrimary thứ hai
            await ContractOccupant.update(
                { contractId: contract.id },
                { where: { contractId: previous.id }, transaction: t }
            );
            // Khách vẫn ở liên tục nên chuỗi chỉ số điện nước giữ nguyên, không ghi mốc đầu kỳ mới
            if (contract.room) {
                contract.room.status = 'occupied';
                await contract.room.save({ transaction: t });
            }
            return;
        }

        // Chỉ số bàn giao (isInitial: true) ghi vào kỳ LIỀN TRƯỚC tháng bắt đầu
        const initialValues = {
            electricity: contract.initialElectricity || 0,
            water: contract.initialWater || 0
        };
        for (const type of ['electricity', 'water']) {
            const [reading, created] = await MeterReading.findOrCreate({
                where: { roomId: contract.roomId, type, period: baselinePeriod },
                defaults: {
                    readingValue: initialValues[type],
                    isInitial: true,
                    readingDate: contract.startDate
                },
                transaction: t
            });
            if (!created) {
                reading.readingValue = initialValues[type];
                reading.isInitial = true;
                reading.readingDate = contract.startDate;
                await reading.save({ transaction: t });
            }
        }

        // Dòng khách chính để quản lý tạm trú (C6)
        const tenant = await User.findByPk(tenantId, { attributes: ['name'], transaction: t });
        await ContractOccupant.create({
            contractId: contract.id,
            fullName: tenant?.name || 'Khách thuê',
            cccd: contract.tenantCccd,
            dob: contract.tenantDob,
            phone: contract.tenantPhone,
            cccdFrontImage: contract.tenantCccdFront,
            cccdBackImage: contract.tenantCccdBack,
            isPrimary: true
        }, { transaction: t });

        // Cập nhật trạng thái phòng thành occupied
        if (contract.room) {
            contract.room.status = 'occupied';
            await contract.room.save({ transaction: t });
        }
    });

    return contract;
};

// 3. TỪ CHỐI KÍ HỢP ĐỒNG (Dành cho Người thuê)
exports.rejectContractByTenant = async (tenantId, contractId, reason) => {
    const contract = await Contract.findOne({
        where: { id: contractId, tenantId, status: 'pending_tenant_signature' },
        include: [{ model: Room, as: 'room' }]
    });

    if (!contract) {
        throw createError(404, 'Không tìm thấy hợp đồng chờ ký phù hợp.');
    }

    await sequelize.transaction(async (t) => {
        contract.status = 'rejected';
        contract.rejectionReason = reason || 'Người thuê từ chối ký hợp đồng.';
        await contract.save({ transaction: t });
        await releaseHeldDeposit(contract.id, 'Khách thuê từ chối ký hợp đồng', t);

        // Từ chối bản gia hạn thì hợp đồng gốc vẫn hiệu lực, phòng giữ nguyên 'occupied'
        const previous = await findPreviousActive(contract, t);
        if (contract.room && !previous) {
            contract.room.status = 'empty';
            await contract.room.save({ transaction: t });
        }
    });

    return contract;
};

// 4. HỦY HỢP ĐỒNG CHỜ (Dành cho Chủ nhà)
exports.cancelContractByLandlord = async (landlordId, id) => {
    const contract = await Contract.findByPk(id, {
        include: [{ model: Room, as: 'room', include: [{ model: Building, as: 'building' }] }]
    });

    if (!contract || contract.room.building.landlordId !== landlordId) {
        throw createError(404, 'Hợp đồng không tồn tại hoặc bạn không có quyền thao tác');
    }

    if (contract.status !== 'pending_tenant_signature') {
        throw createError(400, 'Chỉ có thể hủy hợp đồng đang ở trạng thái Chờ khách ký');
    }

    let keptOccupied = false;
    await sequelize.transaction(async (t) => {
        contract.status = 'cancelled';
        await contract.save({ transaction: t });
        await releaseHeldDeposit(contract.id, 'Chủ nhà hủy hợp đồng chờ ký', t);

        // Hủy bản gia hạn thì hợp đồng gốc vẫn hiệu lực, phòng giữ nguyên 'occupied'
        keptOccupied = !!(await findPreviousActive(contract, t));
        if (contract.room && !keptOccupied) {
            contract.room.status = 'empty';
            await contract.room.save({ transaction: t });
        }
    });

    return {
        message: keptOccupied
            ? 'Đã hủy bản gia hạn. Hợp đồng hiện tại vẫn còn hiệu lực.'
            : 'Đã hủy hợp đồng chờ thành công. Phòng trọ đã giải phóng về Trạng thái Trống.',
        contract
    };
};

// 5. LẤY DANH SÁCH HỢP ĐỒNG (Dành cho Chủ nhà)
exports.getContracts = async (landlordId) => {
    const contracts = await Contract.findAll({
        include: [
            {
                model: Room,
                as: 'room',
                required: true,
                include: [
                    {
                        model: Building,
                        as: 'building',
                        where: { landlordId }
                    }
                ]
            },
            {
                model: User,
                as: 'tenant',
                attributes: ['id', 'name', 'phone', 'email']
            }
        ],
        order: [['createdAt', 'DESC']]
    });
    return contracts;
};

// 6. CHI TIẾT HỢP ĐỒNG
exports.getContractDetail = async (landlordId, id) => {
    const contract = await Contract.findByPk(id, {
        include: [
            {
                model: Room,
                as: 'room',
                include: [
                    {
                        model: Building,
                        as: 'building'
                    }
                ]
            },
            {
                model: User,
                as: 'tenant',
                attributes: ['id', 'name', 'phone', 'email']
            }
        ]
    });

    if (!contract || contract.room.building.landlordId !== landlordId) {
        throw createError(404, 'Hợp đồng không tồn tại hoặc bạn không có quyền xem');
    }

    return contract;
};

// 7. THANH LÝ HỢP ĐỒNG (C1 / T1.8 / T2.6)
const loadOwnedActiveContract = async (landlordId, id) => {
    const contract = await Contract.findByPk(id, {
        include: [{ model: Room, as: 'room', include: [{ model: Building, as: 'building' }] }]
    });
    if (!contract || contract.room.building.landlordId !== landlordId) {
        throw createError(404, 'Hợp đồng không tồn tại hoặc bạn không có quyền thanh lý');
    }
    if (contract.status !== 'active') {
        throw createError(400, 'Hợp đồng này đã kết thúc hoặc chưa được kích hoạt');
    }
    return contract;
};

const formatVnd = (n) => Number(n || 0).toLocaleString('vi-VN');

// Tính quyết toán ở server (dùng chung cho preview và thanh lý, không tin số client gửi).
// requireReadings: thanh lý thật thì bắt buộc chỉ số cuối khi chưa có hóa đơn tháng cuối.
const computeSettlement = async (contract, body = {}, { requireReadings = false, transaction = null } = {}) => {
    const txOpt = transaction ? { transaction } : {};
    const { finalElectricity, finalWater, damageAmount, forfeit = false, allowDebt = false } = body;
    const terminationDate = isBlank(body.terminationDate) ? dayjs().format('YYYY-MM-DD') : body.terminationDate;
    const date = dayjs(terminationDate);
    if (!date.isValid()) throw createError(400, 'Ngày trả phòng không hợp lệ');
    if (date.isBefore(dayjs(contract.startDate), 'day')) {
        throw createError(400, 'Ngày trả phòng không được trước ngày bắt đầu hợp đồng');
    }
    const damage = isBlank(damageAmount) ? 0 : Number(damageAmount);
    if (!Number.isFinite(damage) || damage < 0) throw createError(400, 'Tiền hư hỏng phải là số không âm');

    // HĐ quá hạn vẫn 'active': kỳ hóa đơn cuối kẹp về tháng endDate, kỳ sau đó generateInvoice chặn
    const billDate = contract.endDate && date.isAfter(dayjs(contract.endDate), 'day') ? dayjs(contract.endDate) : date;
    const month = billDate.month() + 1;
    const year = billDate.year();
    const period = `${year}-${String(month).padStart(2, '0')}`;
    const { roomId, tenantId } = contract;

    // Chuỗi gia hạn của chính khách này trên phòng (như tenantService.getDashboardSummary)
    const chain = await Contract.findAll({ where: { roomId, tenantId, status: 'renewed' }, attributes: ['id'], ...txOpt });
    const contractIds = [contract.id, ...chain.map(c => c.id)];

    // Lọc theo chuỗi hợp đồng để không dùng nhầm hóa đơn cùng kỳ của khách cũ
    const finalInvoice = await Invoice.findOne({
        where: { roomId, month, year, [Op.or]: [{ contractId: contractIds }, { tenantId, contractId: null }] },
        ...txOpt,
    });
    let readings = null;
    let finalInvoiceEstimate = null;
    if (!finalInvoice) {
        if (isBlank(finalElectricity) || isBlank(finalWater)) {
            if (requireReadings) {
                const err = createError(400, `Chưa có hóa đơn tháng ${month}/${year}: vui lòng nhập chỉ số cuối điện và nước`);
                // code để tool chat nhận ra và hỏi lại chủ nhà thay vì trả lỗi thô
                err.code = 'FINAL_READINGS_REQUIRED';
                throw err;
            }
        } else {
            readings = {
                electricity: await meterService.validateReading(roomId, 'electricity', finalElectricity, period, txOpt),
                water: await meterService.validateReading(roomId, 'water', finalWater, period, txOpt)
            };
            // Ước tính hóa đơn tháng cuối theo đúng công thức của generateInvoice
            const usage = async (type, value) => {
                const prev = await MeterReading.findOne({
                    where: { roomId, type, period: { [Op.lt]: period, [Op.ne]: null } },
                    order: [['period', 'DESC']],
                    ...txOpt,
                });
                const initial = type === 'electricity' ? contract.initialElectricity : contract.initialWater;
                return value - (prev ? prev.readingValue : Number(initial || 0));
            };
            const fullRent = Number(contract.rentPrice ?? contract.room?.price ?? 0);
            finalInvoiceEstimate = invoiceService.computeRoomCharge(contract, fullRent, year, month, date.format('YYYY-MM-DD')).amount
                + (await usage('electricity', readings.electricity)) * Number(contract.electricityPrice || 0)
                + (await usage('water', readings.water)) * Number(contract.waterPrice || 0)
                + Number(contract.internetPrice || 0) + Number(contract.cleaningPrice || 0);
        }
    }

    // Nhánh contractId null để bắt hóa đơn cũ chưa gắn hợp đồng
    const unpaid = await Invoice.findAll({
        where: { isPaid: false, [Op.or]: [{ contractId: contractIds }, { roomId, tenantId, contractId: null }] },
        ...txOpt,
    });
    const unpaidTotal = unpaid.reduce((s, i) => s + Math.max(0, Number(i.totalAmount || 0) - Number(i.paidAmount || 0)), 0);

    // Mỗi HĐ chỉ có 1 bản ghi cọc 'held' (gia hạn chuyển bản ghi bằng update)
    const deposit = await DepositRecord.findOne({
        where: { contractId: contract.id, status: 'held' },
        order: [['createdAt', 'DESC']],
        ...txOpt,
    });
    const held = Number(deposit?.amount || 0);
    const deduct = unpaidTotal + (finalInvoiceEstimate || 0) + damage;
    const outstandingAmount = Math.max(0, deduct - held);
    const blocked = deduct > held && !allowDebt;

    return {
        terminationDate: date.format('YYYY-MM-DD'), month, year, period,
        held, deposit, unpaid,
        unpaidInvoices: unpaid.map(i => ({ id: i.id, month: i.month, year: i.year, totalAmount: Number(i.totalAmount) })),
        unpaidTotal,
        needsReadings: !finalInvoice,
        finalInvoice: finalInvoice
            ? { id: finalInvoice.id, totalAmount: Number(finalInvoice.totalAmount), isPaid: finalInvoice.isPaid,
                electricityNew: finalInvoice.electricityNew, waterNew: finalInvoice.waterNew }
            : null,
        readings, finalInvoiceEstimate, damageAmount: damage, forfeit: !!forfeit,
        allowDebt: !!allowDebt,
        deduct,
        outstandingAmount,
        refund: deduct > held || forfeit ? 0 : held - deduct,
        blocked,
        blockMessage: deduct > held
            ? `Công nợ ${formatVnd(deduct)} đ vượt tiền cọc ${formatVnd(held)} đ, yêu cầu khách thanh toán trước khi thanh lý`
            : null
    };
};

// Bỏ các object model khỏi kết quả trả về client
const publicSettlement = ({ deposit, unpaid, ...rest }) => rest;

exports.getSettlementPreview = async (landlordId, id, body = {}) => {
    const contract = await loadOwnedActiveContract(landlordId, id);
    return publicSettlement(await computeSettlement(contract, body));
};

exports.terminateContract = async (landlordId, id, body = {}) => {
    const contract = await loadOwnedActiveContract(landlordId, id);

    let s = await computeSettlement(contract, body, { requireReadings: true });
    if (s.blocked) throw createError(400, s.blockMessage);

    // T2.6: Mở một transaction bao trọn cả chốt số cuối, xuất hóa đơn tháng cuối và quyết toán cọc
    await sequelize.transaction(async (t) => {
        // Đọc lại HĐ có khóa dòng: hai lần bấm "Thanh lý" song song không được cấn trừ
        // cọc và gạch hóa đơn hai lần.
        const locked = await Contract.findByPk(contract.id, { lock: true, transaction: t });
        if (!locked || locked.status !== 'active') {
            throw createError(409, 'Hợp đồng này vừa được thanh lý ở một phiên khác. Vui lòng tải lại trang.');
        }

        if (s.needsReadings) {
            await meterService.updateRoomReadings(landlordId, {
                roomId: contract.roomId,
                electricityValue: s.readings.electricity,
                waterValue: s.readings.water,
                period: s.period,
            }, { transaction: t });

            // T2.3: HĐ tính theo ngày thì tháng cuối chỉ tính tới ngày trả phòng
            await invoiceService.generateInvoice({
                roomId: contract.roomId,
                month: s.month,
                year: s.year,
                ...(contract.firstLastMonthPolicy === 'prorated' ? { terminationDate: s.terminationDate } : {}),
            }, landlordId, { transaction: t });

            s = await computeSettlement(contract, body, { requireReadings: true, transaction: t });
            if (s.blocked) throw createError(400, s.blockMessage);
        }

        const { finalInvoice } = s;
        const deductNote = [
            `Thanh lý HĐ #${contract.id}`,
            s.unpaid.length ? `cấn trừ hóa đơn ${s.unpaid.map(i => `#${i.id}`).join(', ')}` : null,
            s.damageAmount ? `hư hỏng ${formatVnd(s.damageAmount)} đ` : null,
            s.forfeit ? 'khách mất cọc (trả phòng không báo trước)' : null,
            s.outstandingAmount > 0 ? `còn nợ ${formatVnd(s.outstandingAmount)} đ` : null,
            body.note || null
        ].filter(Boolean).join('; ');

        if (s.deduct > s.held && body.allowDebt) {
            // T1.8: Cấn trừ tiền cọc held theo thứ tự hóa đơn cũ nhất trước
            const sortedUnpaid = [...s.unpaid].sort(
                (a, b) => ((a.year || 0) - (b.year || 0)) || ((a.month || 0) - (b.month || 0)) || ((a.id || 0) - (b.id || 0))
            );
            let remainingDeposit = s.held;
            for (const inv of sortedUnpaid) {
                const total = Number(inv.totalAmount || 0);
                const alreadyPaid = Number(inv.paidAmount || 0);
                const needed = Math.max(0, total - alreadyPaid);
                if (remainingDeposit >= needed && needed > 0) {
                    inv.isPaid = true;
                    inv.paidAt = new Date();
                    inv.paidAmount = total;
                    inv.status = 'paid';
                    inv.paymentMethod = 'deposit';
                    remainingDeposit -= needed;
                    await inv.save({ transaction: t });
                } else if (remainingDeposit > 0 && needed > 0) {
                    inv.isPaid = false;
                    inv.paidAt = new Date();
                    inv.paidAmount = alreadyPaid + remainingDeposit;
                    inv.status = 'partial';
                    inv.paymentMethod = 'deposit';
                    remainingDeposit = 0;
                    await inv.save({ transaction: t });
                } else {
                    inv.isPaid = false;
                }
            }
        } else {
            // Hóa đơn chưa trả được cấn trừ đủ vào cọc
            for (const inv of s.unpaid) {
                inv.isPaid = true;
                inv.paidAt = new Date();
                inv.paidAmount = Number(inv.totalAmount);
                inv.status = 'paid';
                inv.paymentMethod = 'deposit';
                await inv.save({ transaction: t });
            }
        }

        if (s.deposit) {
            const actualDeducted = s.deduct > s.held ? s.held : (s.held - s.refund);
            await depositService.settleHeldDeposit(s.deposit, {
                amount: s.refund,
                deductAmount: actualDeducted,
                note: deductNote,
                status: s.forfeit ? 'forfeited' : (s.deduct > 0 ? 'deducted' : 'refunded')
            }, t);
        }

        locked.outstandingAmount = s.outstandingAmount || 0;
        contract.outstandingAmount = s.outstandingAmount || 0;
        contract.status = 'terminated';
        contract.terminatedAt = s.terminationDate;
        contract.finalElectricity = finalInvoice?.electricityNew ?? null;
        contract.finalWater = finalInvoice?.waterNew ?? null;
        contract.terminationNote = body.note || null;
        await contract.save({ transaction: t });

        // Bản gia hạn còn chờ ký của phòng này không còn ý nghĩa khi hợp đồng gốc đã thanh lý
        await Contract.update(
            { status: 'cancelled' },
            { where: { roomId: contract.roomId, status: 'pending_tenant_signature' }, transaction: t }
        );

        // Yêu cầu còn chờ của HĐ: báo trả phòng coi như đã thực hiện, đề nghị gia hạn không còn ý nghĩa
        await ContractRequest.update({ status: 'approved' },
            { where: { contractId: contract.id, status: 'pending', type: 'move_out' }, transaction: t });
        await ContractRequest.update({ status: 'rejected' },
            { where: { contractId: contract.id, status: 'pending', type: 'renewal' }, transaction: t });

        if (contract.room) {
            contract.room.status = 'empty';
            await contract.room.save({ transaction: t });
        }
    });

    try {
        const actualDeducted = s.deduct > s.held ? s.held : (s.held - s.refund);
        await notificationService.createNotification(contract.tenantId, 'Hợp đồng đã thanh lý',
            `Hợp đồng phòng ${contract.room?.roomNumber || ''} đã thanh lý. Hoàn cọc ${formatVnd(s.refund)} đ, `
            + `khấu trừ ${formatVnd(actualDeducted)} đ.`
            + (s.outstandingAmount > 0 ? ` Công nợ còn lại: ${formatVnd(s.outstandingAmount)} đ.` : ''),
            'contract', contract.id);
    } catch (err) {
        console.error('⚠️ Lỗi gửi thông báo thanh lý:', err.message);
    }

    return {
        message: 'Thanh lý hợp đồng thành công và phòng trọ đã chuyển sang trạng thái Trống.',
        contract,
        depositRecord: s.deposit || null,
        settlement: publicSettlement(s)
    };
};

// 8. GIA HẠN HỢP ĐỒNG (Dành cho Chủ nhà)
// Kế thừa thông tin hợp đồng cũ, tạo hợp đồng mới để khách ký lại.
// Giữ nguyên trạng thái phòng (occupied) — không qua empty như tạo mới.
exports.renewContract = async (landlordId, id, data) => {
    const oldContract = await Contract.findByPk(id, {
        include: [{ model: Room, as: 'room', include: [{ model: Building, as: 'building' }] }]
    });

    if (!oldContract || oldContract.room.building.landlordId !== landlordId) {
        throw createError(404, 'Hợp đồng không tồn tại hoặc bạn không có quyền thao tác');
    }
    if (oldContract.status !== 'active') {
        throw createError(400, 'Chỉ có thể gia hạn hợp đồng đang hoạt động (active)');
    }
    if (!data.startDate || !data.endDate) {
        throw createError(400, 'Vui lòng cung cấp ngày bắt đầu và ngày kết thúc mới');
    }
    validateContractNumbers(
        { startDate: data.startDate, endDate: data.endDate, rentPrice: data.rentPrice, numTenants: data.numTenants },
        oldContract.room
    );
    if (!isBlank(data.firstLastMonthPolicy) && !['full', 'prorated'].includes(data.firstLastMonthPolicy)) {
        throw createError(400, 'Cách tính tiền phòng tháng đầu/cuối không hợp lệ (chỉ nhận "full" hoặc "prorated")');
    }
    if (oldContract.startDate && !dayjs(data.startDate).isAfter(dayjs(oldContract.startDate), 'day')) {
        throw createError(400, `Ngày bắt đầu gia hạn phải sau ngày bắt đầu hợp đồng hiện tại`);
    }
    if (oldContract.endDate && !dayjs(data.startDate).isAfter(dayjs(oldContract.endDate), 'day')) {
        throw createError(400, `Ngày bắt đầu gia hạn phải sau ngày kết thúc hợp đồng hiện tại `
            + `(${dayjs(oldContract.endDate).format('DD/MM/YYYY')})`);
    }
    if (oldContract.endDate && dayjs(data.startDate).diff(dayjs(oldContract.endDate), 'day') > 1) {
        throw createError(400, `Ngày bắt đầu gia hạn phải nối tiếp ngay sau ngày kết thúc hợp đồng hiện tại `
            + `(${dayjs(oldContract.endDate).add(1, 'day').format('DD/MM/YYYY')})`);
    }

    const pendingRenewals = await Contract.count({
        where: { roomId: oldContract.roomId, status: 'pending_tenant_signature' }
    });
    if (pendingRenewals > 0) {
        throw createError(400, 'Phòng này đã có một bản gia hạn đang chờ khách ký. Vui lòng xử lý bản đó trước.');
    }

    // Hợp đồng cũ GIỮ NGUYÊN 'active' cho tới khi khách ký bản mới (xem signContractByTenant).
    const created = await sequelize.transaction(async (t) => {
        const contract = await Contract.create({
            tenantId: oldContract.tenantId,
            roomId: oldContract.roomId,
            startDate: data.startDate,
            endDate: data.endDate,
            // Cọc được chuyển từ hợp đồng cũ khi khách ký, không thu thêm lần nữa
            deposit: oldContract.deposit,
            // Gia hạn được đổi giá thuê; không gửi thì giữ giá cũ
            rentPrice: isBlank(data.rentPrice) ? oldContract.rentPrice : data.rentPrice,
            electricityPrice: oldContract.electricityPrice,
            waterPrice: oldContract.waterPrice,
            internetPrice: oldContract.internetPrice,
            cleaningPrice: oldContract.cleaningPrice,
            // Chỉ lưu để tham chiếu; khi ký bản gia hạn không ghi lại mốc chỉ số đầu kỳ
            initialElectricity: oldContract.initialElectricity,
            initialWater: oldContract.initialWater,
            landlordName: oldContract.landlordName,
            landlordPhone: oldContract.landlordPhone,
            landlordCccd: oldContract.landlordCccd,
            landlordDob: oldContract.landlordDob,
            landlordHometown: oldContract.landlordHometown,
            landlordAddress: oldContract.landlordAddress,
            landlordSignature: oldContract.landlordSignature,
            landlordSignedAt: new Date(),
            tenantCccd: oldContract.tenantCccd,
            tenantDob: oldContract.tenantDob,
            tenantHometown: oldContract.tenantHometown,
            tenantPhone: oldContract.tenantPhone,
            tenantCccdFront: oldContract.tenantCccdFront,
            tenantCccdBack: oldContract.tenantCccdBack,
            numTenants: data.numTenants || oldContract.numTenants,
            paymentDay: oldContract.paymentDay,
            // Gia hạn được đổi cách tính tháng đầu/cuối; không gửi thì giữ của HĐ cũ
            firstLastMonthPolicy: isBlank(data.firstLastMonthPolicy)
                ? (oldContract.firstLastMonthPolicy || 'full')
                : data.firstLastMonthPolicy,
            inventory: oldContract.inventory,
            status: 'pending_tenant_signature'
        }, { transaction: t });

        return contract;
    });

    return { message: 'Đã tạo hợp đồng gia hạn. Hợp đồng mới đang chờ khách thuê ký xác nhận.', contract: created };
};

// 9. NHẮC HỢP ĐỒNG SẮP / ĐÃ HẾT HẠN (job 24h trong index.js)
exports.notifyExpiringContracts = async () => {
    const contracts = await Contract.findAll({
        where: { status: 'active', endDate: { [Op.lte]: dayjs().add(7, 'day').format('YYYY-MM-DD') } },
        include: [{ model: Room, as: 'room', include: [{ model: Building, as: 'building' }] }]
    });

    let count = 0;
    for (const c of contracts) {
        const notified = await Notification.findOne({ where: { type: 'contract_expiry', relatedId: c.id } });
        if (notified) continue;

        const ended = dayjs(c.endDate).isBefore(dayjs(), 'day');
        const title = ended ? 'Hợp đồng đã quá hạn' : 'Hợp đồng sắp hết hạn';
        const content = `Hợp đồng phòng ${c.room?.roomNumber || ''} ${ended ? 'đã hết hạn' : 'sẽ hết hạn'} ngày `
            + `${dayjs(c.endDate).format('DD/MM/YYYY')}. Vui lòng gia hạn hoặc thanh lý hợp đồng.`;
        const landlordId = c.room?.building?.landlordId;
        if (landlordId) await notificationService.createNotification(landlordId, title, content, 'contract_expiry', c.id);
        if (c.tenantId) await notificationService.createNotification(c.tenantId, title, content, 'contract_expiry', c.id);
        count++;
    }
    return count;
};

// 9b. T2.7: TỰ ĐỘNG HỦY HỢP ĐỒNG CHỜ KÝ QUÁ 7 NGÀY
exports.expireStalePendingContracts = async (now = new Date()) => {
    const cutoff = dayjs(now).subtract(7, 'day').toDate();
    const staleContracts = await Contract.findAll({
        where: {
            status: 'pending_tenant_signature',
            createdAt: { [Op.lt]: cutoff }
        },
        include: [{ model: Room, as: 'room' }]
    });

    let count = 0;
    for (const c of staleContracts) {
        await sequelize.transaction(async (t) => {
            c.status = 'cancelled';
            await c.save({ transaction: t });
            await releaseHeldDeposit(c.id, 'Hợp đồng chờ ký quá 7 ngày tự động hủy', t);

            const previous = await findPreviousActive(c, t);
            if (c.room && !previous) {
                c.room.status = 'empty';
                await c.room.save({ transaction: t });
            }
        });
        count++;
    }
    return count;
};

// 10. YÊU CẦU CỦA KHÁCH: BÁO TRẢ PHÒNG / ĐỀ NGHỊ GIA HẠN (C5)
const REQUEST_LABELS = { move_out: 'báo trả phòng', renewal: 'đề nghị gia hạn' };
const MIN_NOTICE_DAYS = 30;
// Báo trả phòng dưới 30 ngày: chỉ cảnh báo chủ nhà, không chặn
const isShortNotice = (r) => r.type === 'move_out' && r.desiredDate
    && dayjs(r.desiredDate).diff(dayjs(r.createdAt || undefined).startOf('day'), 'day') < MIN_NOTICE_DAYS;
const plain = (m) => (m && typeof m.toJSON === 'function' ? m.toJSON() : m);

exports.createTenantRequest = async (tenantId, contractId, { type, desiredDate, note } = {}) => {
    if (!REQUEST_LABELS[type]) throw createError(400, 'Loại yêu cầu không hợp lệ');

    const contract = await Contract.findOne({
        where: { id: contractId, tenantId, status: 'active' },
        include: [{ model: Room, as: 'room', include: [{ model: Building, as: 'building' }] }]
    });
    if (!contract) throw createError(404, 'Không tìm thấy hợp đồng đang hiệu lực của bạn');

    const pending = await ContractRequest.findOne({ where: { contractId: contract.id, type, status: 'pending' } });
    if (pending) throw createError(400, `Bạn đã có yêu cầu ${REQUEST_LABELS[type]} đang chờ chủ nhà xử lý`);

    const today = dayjs().startOf('day');
    let date;
    if (type === 'move_out') {
        // Khách ở tới hết kỳ thanh toán: mặc định trả phòng ngày cuối tháng hiện tại
        date = isBlank(desiredDate) ? today.endOf('month') : dayjs(desiredDate);
        if (!date.isValid() || date.isBefore(today, 'day')) throw createError(400, 'Ngày trả phòng phải từ hôm nay trở đi');
    } else {
        date = dayjs(desiredDate);
        if (isBlank(desiredDate) || !date.isValid() || !date.isAfter(dayjs(contract.endDate), 'day')) {
            throw createError(400, 'Ngày kết thúc mong muốn phải sau ngày kết thúc hợp đồng hiện tại');
        }
    }

    const request = await ContractRequest.create({
        contractId: contract.id, tenantId, type, desiredDate: date.format('YYYY-MM-DD'), note: note || null, status: 'pending'
    });
    const shortNotice = isShortNotice({ type, desiredDate: date.format('YYYY-MM-DD') });

    const landlordId = contract.room?.building?.landlordId;
    if (landlordId) {
        const content = `Khách phòng ${contract.room?.roomNumber || ''} gửi yêu cầu ${REQUEST_LABELS[type]}, `
            + `ngày ${date.format('DD/MM/YYYY')}.`
            + (shortNotice ? ` Lưu ý: báo trước dưới ${MIN_NOTICE_DAYS} ngày.` : '');
        try {
            await notificationService.createNotification(landlordId, 'Yêu cầu mới từ khách thuê', content, 'contract_request', request.id);
        } catch (err) {
            console.error('⚠️ Lỗi gửi thông báo yêu cầu:', err.message);
        }
    }

    return { message: 'Đã gửi yêu cầu tới chủ nhà', request: { ...plain(request), shortNotice } };
};

exports.getTenantRequests = async (tenantId) => {
    const rows = await ContractRequest.findAll({ where: { tenantId }, order: [['createdAt', 'DESC']] });
    return rows.map(r => ({ ...plain(r), shortNotice: isShortNotice(r) }));
};

exports.getLandlordRequests = async (landlordId) => {
    const rows = await ContractRequest.findAll({
        include: [
            {
                model: Contract, as: 'contract', required: true,
                attributes: ['id', 'roomId', 'tenantId', 'status', 'startDate', 'endDate', 'deposit', 'rentPrice'],
                include: [{
                    model: Room, as: 'room', required: true, attributes: ['id', 'roomNumber'],
                    include: [{ model: Building, as: 'building', where: { landlordId }, attributes: ['id', 'name', 'landlordId'] }]
                }]
            },
            { model: User, as: 'tenant', attributes: ['id', 'name', 'phone'] }
        ],
        order: [['createdAt', 'DESC']]
    });
    return rows.map(r => ({ ...plain(r), shortNotice: isShortNotice(r) }));
};

// Chỉ đổi trạng thái yêu cầu; KHÔNG tự thanh lý hay gia hạn
exports.respondRequest = async (landlordId, requestId, { status, responseNote } = {}) => {
    if (!['approved', 'rejected'].includes(status)) throw createError(400, 'Trạng thái phản hồi không hợp lệ');

    const request = await ContractRequest.findByPk(requestId, {
        include: [{ model: Contract, as: 'contract', include: [{ model: Room, as: 'room', include: [{ model: Building, as: 'building' }] }] }]
    });
    if (!request || request.contract?.room?.building?.landlordId !== landlordId) {
        throw createError(404, 'Yêu cầu không tồn tại hoặc bạn không có quyền xử lý');
    }
    if (request.status !== 'pending') throw createError(400, 'Yêu cầu này đã được xử lý');

    request.status = status;
    request.responseNote = responseNote || null;
    await request.save();

    try {
        await notificationService.createNotification(request.tenantId,
            status === 'approved' ? 'Chủ nhà đã đồng ý yêu cầu' : 'Chủ nhà đã từ chối yêu cầu',
            `Yêu cầu ${REQUEST_LABELS[request.type] || ''} phòng ${request.contract?.room?.roomNumber || ''} `
            + `${status === 'approved' ? 'đã được đồng ý' : 'bị từ chối'}.${responseNote ? ` Ghi chú: ${responseNote}` : ''}`,
            'contract_request', request.id);
    } catch (err) {
        console.error('⚠️ Lỗi gửi thông báo phản hồi yêu cầu:', err.message);
    }

    return { message: status === 'approved' ? 'Đã duyệt yêu cầu' : 'Đã từ chối yêu cầu', request };
};

// 11. NGƯỜI Ở CÙNG & TẠM TRÚ (C6)
const assertContractAccess = async (user, contractId) => {
    const contract = await Contract.findByPk(contractId, {
        include: [{ model: Room, as: 'room', include: [{ model: Building, as: 'building' }] }]
    });
    const allowed = contract && (user.role === 'landlord'
        ? contract.room?.building?.landlordId === user.id
        : contract.tenantId === user.id);
    if (!allowed) throw createError(404, 'Hợp đồng không tồn tại hoặc bạn không có quyền thao tác');
    return contract;
};

const OCCUPANT_FIELDS = ['fullName', 'cccd', 'dob', 'phone', 'relation', 'note'];
const pickOccupant = (user, data) => {
    const fields = user.role === 'landlord' ? [...OCCUPANT_FIELDS, 'residenceStatus', 'registeredAt'] : OCCUPANT_FIELDS;
    const out = {};
    for (const f of fields) if (data[f] !== undefined) out[f] = data[f] === '' ? null : data[f];
    if (out.residenceStatus !== undefined && !['not_registered', 'registered'].includes(out.residenceStatus)) {
        throw createError(400, 'Trạng thái tạm trú không hợp lệ');
    }
    return out;
};

const pendingExtraOccupants = async (contract) => {
    if (contract.status !== 'pending_tenant_signature') return 0;
    const previous = await findPreviousActive(contract);
    return previous ? ContractOccupant.count({ where: { contractId: previous.id } }) : 1;
};

const syncNumTenants = async (contract) => {
    const own = await ContractOccupant.count({ where: { contractId: contract.id } });
    contract.numTenants = Math.max(1, own + await pendingExtraOccupants(contract));
    await contract.save();
};

const assertOccupantEditable = (contract) => {
    if (!['active', 'pending_tenant_signature'].includes(contract.status)) {
        throw createError(400, 'Chỉ thao tác người ở cho hợp đồng đang hiệu lực hoặc chờ ký');
    }
};

exports.listOccupants = async (user, contractId) => {
    await assertContractAccess(user, contractId);
    return ContractOccupant.findAll({ where: { contractId }, order: [['isPrimary', 'DESC'], ['id', 'ASC']] });
};

exports.getCccdImageName = async (user, contractId, filename) => {
    const contract = await assertContractAccess(user, contractId);
    const occupants = await ContractOccupant.findAll({
        where: { contractId }, attributes: ['cccdFrontImage', 'cccdBackImage']
    });
    const owned = [contract.tenantCccdFront, contract.tenantCccdBack,
        ...occupants.flatMap(o => [o.cccdFrontImage, o.cccdBackImage])].filter(Boolean);
    if (!owned.includes(filename)) throw createError(404, 'Không tìm thấy ảnh.');
    return filename;
};

exports.addOccupant = async (user, contractId, data = {}, files = {}) => {
    const contract = await assertContractAccess(user, contractId);
    assertOccupantEditable(contract);
    const fields = pickOccupant(user, data);
    if (isBlank(fields.fullName) || !String(fields.fullName).trim()) throw createError(400, 'Vui lòng nhập họ tên người ở');
    assertCccdImages(files);

    const count = await ContractOccupant.count({ where: { contractId: contract.id } })
        + await pendingExtraOccupants(contract);
    const capacity = contract.room?.capacity;
    if (capacity && count + 1 > capacity) {
        throw createError(400, `Phòng ${contract.room.roomNumber} chỉ cho tối đa ${capacity} người ở`);
    }

    const occupant = await ContractOccupant.create({
        ...fields,
        cccdFrontImage: files.cccdFront?.[0]?.filename || null,
        cccdBackImage: files.cccdBack?.[0]?.filename || null,
        contractId: contract.id,
        isPrimary: false
    });
    await syncNumTenants(contract);
    return { message: 'Đã thêm người ở cùng', occupant };
};

const loadOccupant = async (user, occupantId) => {
    const occupant = await ContractOccupant.findByPk(occupantId);
    if (!occupant) throw createError(404, 'Không tìm thấy người ở');
    const contract = await assertContractAccess(user, occupant.contractId);
    return { occupant, contract };
};

exports.updateOccupant = async (user, occupantId, data = {}) => {
    const { occupant, contract } = await loadOccupant(user, occupantId);
    assertOccupantEditable(contract);
    Object.assign(occupant, pickOccupant(user, data));
    if (isBlank(occupant.fullName)) throw createError(400, 'Vui lòng nhập họ tên người ở');
    await occupant.save();
    return { message: 'Đã cập nhật người ở', occupant };
};

exports.removeOccupant = async (user, occupantId) => {
    const { occupant, contract } = await loadOccupant(user, occupantId);
    assertOccupantEditable(contract);
    if (occupant.isPrimary) throw createError(400, 'Không thể xóa khách chính của hợp đồng');
    await occupant.destroy();
    await syncNumTenants(contract);
    return { message: 'Đã xóa người ở' };
};
