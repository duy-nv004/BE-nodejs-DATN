const Invoice = require('../models/Invoice');
const sequelize = require('../config/db');
const Contract = require('../models/Contract');
const MeterReading = require('../models/MeterReading');
const Room = require('../models/Room');
const Building = require('../models/Building');
const User = require('../models/User');
const SePayEvent = require('../models/SePayEvent');
const AdminLog = require('../models/AdminLog');
const telegramService = require('../utils/telegramService');
const { createError } = require('../utils/errors');
const { systemBank } = require('../utils/bank');
const { Op } = require('sequelize');
const dayjs = require('dayjs');

// Cách thanh toán hợp lệ của hóa đơn. 'deposit' = cấn trừ tiền cọc khi thanh lý (C1).
const PAYMENT_METHODS = ['cash', 'bank_transfer', 'sepay', 'deposit'];

// Hạn đóng tiền = ngày paymentDay của hợp đồng trong tháng hóa đơn, kẹp về ngày
// cuối tháng (paymentDay 30 với tháng 2 thành 28/29). Trả về chuỗi YYYY-MM-DD.
const computeDueDate = (year, month, paymentDay) => {
    const day = Math.min(paymentDay || 30, new Date(year, month, 0).getDate());
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};
exports.computeDueDate = computeDueDate;

// T2.3: tiền phòng của kỳ. HĐ 'prorated' tính theo ngày ở thực tế trong tháng đầu
// (từ startDate, kể cả ngày vào) và tháng cuối (tới endDate hoặc ngày trả phòng, lấy
// ngày sớm hơn). Làm tròn tới 1.000đ. Ở đủ cả tháng thì giữ nguyên giá tròn tháng.
const computeRoomCharge = (contract, rent, year, month, terminationDate = null) => {
    const full = { amount: rent, prorated: false, daysCharged: null };
    if (contract.firstLastMonthPolicy !== 'prorated') return full;

    const monthStart = dayjs(`${year}-${String(month).padStart(2, '0')}-01`);
    const daysInMonth = monthStart.daysInMonth();
    let firstDay = 1;
    let lastDay = daysInMonth;

    if (contract.startDate && dayjs(contract.startDate).isSame(monthStart, 'month')) {
        firstDay = dayjs(contract.startDate).date();
    }
    const ends = [contract.endDate, terminationDate].filter(Boolean).map(d => dayjs(d));
    if (ends.some(d => !d.isValid())) throw createError(400, 'Ngày kết thúc không hợp lệ');
    const end = ends.length ? ends.reduce((a, b) => (b.isBefore(a) ? b : a)) : null;
    if (end && end.isSame(monthStart, 'month')) lastDay = end.date();

    const days = Math.max(0, lastDay - firstDay + 1);
    if (days >= daysInMonth) return full;
    return { amount: Math.round((rent * days) / daysInMonth / 1000) * 1000, prorated: true, daysCharged: days };
};
exports.computeRoomCharge = computeRoomCharge;

// 1. XUẤT HÓA ĐƠN
// terminationDate chỉ do luồng thanh lý truyền vào (controller không chuyển tiếp từ body)
exports.generateInvoice = async (arg1, reqLandlordId = null, options = {}) => {
    let roomId, rawMonth, rawYear, terminationDate = null, opts = options || {};
    if (arg1 && typeof arg1 === 'object') {
        ({ roomId, month: rawMonth, year: rawYear, terminationDate = null } = arg1);
        if (arg1.transaction && !opts.transaction) {
            opts = { ...opts, transaction: arg1.transaction };
        }
    } else {
        roomId = arg1;
        rawMonth = arguments[1];
        rawYear = arguments[2];
        reqLandlordId = arguments[3] ?? null;
        opts = arguments[4] || {};
    }
    const extTx = opts.transaction || null;
    const txOpt = extTx ? { transaction: extTx } : {};

    // Ép chuỗi số ("11") về số; null/'' thành NaN để bị chặn bên dưới
    const month = rawMonth === null || rawMonth === '' ? NaN : Number(rawMonth);
    const year = rawYear === null || rawYear === '' ? NaN : Number(rawYear);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
        throw createError(400, "Tháng phải là số nguyên từ 1 đến 12");
    }
    if (!Number.isInteger(year) || year < 1) {
        throw createError(400, "Năm không hợp lệ");
    }

    const room = await Room.findByPk(roomId, {
        include: [{ model: Building, as: 'building' }],
        ...txOpt,
    });
    if (!room || (reqLandlordId && room.building?.landlordId !== reqLandlordId)) {
        throw createError(404, "Phòng không tồn tại hoặc bạn không có quyền tạo hóa đơn cho phòng này.");
    }

    const landlordId = room.building ? room.building.landlordId : null;

    // Chọn hợp đồng PHỦ kỳ hóa đơn. Ký gia hạn sớm làm HĐ cũ thành 'renewed' trước
    // khi HĐ mới bắt đầu, nếu chỉ tìm 'active' thì tháng cuối của HĐ cũ không xuất được.
    // Không HĐ nào phủ kỳ thì lấy HĐ active để giữ các thông báo hết hạn/chưa bắt đầu.
    const periodStart = dayjs(`${year}-${String(month).padStart(2, '0')}-01`);
    const contract = await Contract.findOne({
        where: {
            roomId,
            status: { [Op.in]: ["active", "renewed"] },
            startDate: { [Op.lte]: periodStart.endOf('month').format('YYYY-MM-DD') },
            [Op.or]: [{ endDate: null }, { endDate: { [Op.gte]: periodStart.format('YYYY-MM-DD') } }],
        },
        order: [['startDate', 'DESC']],
        ...txOpt,
    }) || await Contract.findOne({
        where: { roomId, status: "active" },
        ...txOpt,
    });
    if (!contract) {
        throw createError(404, "Phòng này chưa có hợp đồng đang hoạt động.");
    }

    // HĐ quá hạn vẫn 'active' (không có status expired). Kỳ chứa endDate vẫn xuất được,
    // kỳ sau đó thì chặn để chủ nhà gia hạn hoặc thanh lý.
    if (contract.endDate && dayjs(`${year}-${String(month).padStart(2, '0')}-01`).isAfter(dayjs(contract.endDate))) {
        throw createError(400, `Hợp đồng đã hết hạn ngày ${dayjs(contract.endDate).format('DD/MM/YYYY')}, vui lòng gia hạn hoặc thanh lý.`);
    }

    // Kỳ trước tháng bắt đầu HĐ thì khách chưa ở, không được xuất hóa đơn
    if (contract.startDate && `${year}-${String(month).padStart(2, '0')}` < dayjs(contract.startDate).format('YYYY-MM')) {
        throw createError(400, `Kỳ ${month}/${year} trước ngày bắt đầu hợp đồng (${dayjs(contract.startDate).format('DD/MM/YYYY')}).`);
    }

    // Mỗi phòng chỉ được có một hóa đơn cho mỗi kỳ. Chặn sớm ở đây để trả về thông
    // báo rõ ràng; unique index ở tầng DB là chốt chặn cuối cho trường hợp đua nhau.
    const existingInvoice = await Invoice.findOne({ where: { roomId, month, year }, ...txOpt });
    if (existingInvoice) {
        throw createError(409, `Phòng ${room.roomNumber} đã có hóa đơn tháng ${month}/${year}. `
            + `Vui lòng xóa hóa đơn cũ nếu muốn xuất lại.`);
    }

    // Chỉ số phải thuộc ĐÚNG kỳ của hóa đơn. Trước đây lấy 2 bản ghi mới nhất bất kể
    // ngày, nên xuất hóa đơn cho tháng đã chốt số từ trước sẽ tính ra số tiêu thụ sai.
    const period = `${year}-${String(month).padStart(2, '0')}`;

    // Tiêu thụ của kỳ = chỉ số chốt cuối kỳ này - chỉ số chốt cuối kỳ liền trước.
    // Mỗi kỳ chỉ có đúng 1 bản ghi (ràng buộc unique ở model MeterReading), nên
    // "số cũ" phải là bản ghi gần nhất có kỳ NHỎ HƠN kỳ đang xuất hóa đơn.
    // T2.4: Nếu bản ghi kỳ này có meterReset === true thì lượng tiêu thụ = readingValue (tính từ 0).
    const getUsage = async (type) => {
        const current = await MeterReading.findOne({ where: { roomId, type, period }, ...txOpt });
        if (!current) return { usage: 0, oldVal: 0, newVal: 0, error: true };

        if (current.meterReset) {
            const newVal = current.readingValue;
            return { usage: newVal, oldVal: 0, newVal, error: false };
        }

        const previous = await MeterReading.findOne({
            where: { roomId, type, period: { [Op.lt]: period, [Op.ne]: null } },
            order: [["period", "DESC"]],
            ...txOpt,
        });

        // Kỳ đầu tiên của hợp đồng: chỉ số ban đầu do chủ nhà nhập lúc tạo hợp đồng
        const initial = type === "electricity" ? contract.initialElectricity : contract.initialWater;
        const oldVal = previous ? previous.readingValue : Number(initial || 0);
        const newVal = current.readingValue;
        if (newVal < oldVal) {
            const label = type === "electricity" ? "điện" : "nước";
            throw createError(400, `Chỉ số ${label} kỳ ${month}/${year} (${newVal}) nhỏ hơn chỉ số kỳ trước (${oldVal}). `
                + `Vui lòng sửa lại chỉ số trước khi xuất hóa đơn.`);
        }
        const usage = newVal - oldVal;
        return { usage, oldVal, newVal, error: false };
    };

    const eData = await getUsage("electricity");
    const wData = await getUsage("water");

    if (eData.error || wData.error) {
        throw createError(400, `Chưa chốt đủ chỉ số cho kỳ ${month}/${year}. `
            + `Vui lòng nhập chỉ số điện và nước của kỳ này trước khi xuất hóa đơn.`);
    }

    const eTotal = Math.max(0, eData.usage * parseFloat(contract.electricityPrice || 0));
    const wTotal = Math.max(0, wData.usage * parseFloat(contract.waterPrice || 0));
    const sTotal = parseFloat(contract.internetPrice || 0) + parseFloat(contract.cleaningPrice || 0);

    // Quét các yêu cầu sửa chữa do khách thuê chịu phí chưa kết chuyển vào hóa đơn
    const SupportRequest = require('../models/SupportRequest');
    const pendingRepairs = await SupportRequest.findAll({
        where: { roomId, chargeToTenant: true, invoiceId: null },
        ...txOpt
    });
    const repairFee = pendingRepairs.reduce((sum, r) => sum + Math.max(0, parseFloat(r.repairCost || 0)), 0);

    // Giá thuê chốt trong HĐ; HĐ cũ chưa có rentPrice thì dùng giá phòng hiện tại
    const fullRent = parseFloat(contract.rentPrice ?? room.price ?? 0);
    const roomCharge = computeRoomCharge(contract, fullRent, year, month, terminationDate);
    const rent = roomCharge.amount;
    const grandTotal = Math.max(0, rent + eTotal + wTotal + sTotal + repairFee);

    const createInvoiceWithQr = async (t) => {
        const created = await Invoice.create({
            roomId,
            landlordId,
            tenantId: contract.tenantId,
            contractId: contract.id,
            month,
            year,
            dueDate: computeDueDate(year, month, contract.paymentDay),
            roomPrice: rent,
            prorated: roomCharge.prorated,
            daysCharged: roomCharge.daysCharged,
            // Lưu chỉ số và đơn giá vào hóa đơn để khách xem chi tiết, và để hóa đơn cũ
            // vẫn đúng khi hợp đồng đổi giá sau này.
            electricityOld: eData.oldVal,
            electricityNew: eData.newVal,
            waterOld: wData.oldVal,
            waterNew: wData.newVal,
            electricityPrice: contract.electricityPrice,
            waterPrice: contract.waterPrice,
            electricityTotal: eTotal,
            waterTotal: wTotal,
            serviceTotal: sTotal,
            repairFee,
            totalAmount: grandTotal,
        }, { transaction: t });

        if (pendingRepairs.length > 0) {
            await SupportRequest.update(
                { invoiceId: created.id },
                { where: { id: pendingRepairs.map((r) => r.id) }, transaction: t }
            );
        }

        // Tạo đường link VietQR / SePay chuẩn hóa để SePay tự động gạch nợ
        // Cú pháp nội dung chuyển khoản: HD <INVOICE_ID> LL <LANDLORD_ID>
        const bank = systemBank();
        const bankId = encodeURIComponent(bank.bankId);
        const accountNo = encodeURIComponent(bank.bankAccount);
        const sepayContent = `HD ${created.id} LL ${landlordId || 0}`;
        const description = encodeURIComponent(sepayContent);
        const url = `https://qr.sepay.vn/img?bank=${bankId}&acc=${accountNo}&template=compact&amount=${Math.round(grandTotal)}&des=${description}`;

        created.qrCodeUrl = url;
        await created.save({ transaction: t });
        return { invoice: created, qrCodeUrl: url, activeTx: t };
    };

    let invoice;
    let qrCodeUrl;
    let activeTx = extTx;
    try {
        if (extTx) {
            ({ invoice, qrCodeUrl } = await createInvoiceWithQr(extTx));
        } else {
            ({ invoice, qrCodeUrl, activeTx } = await sequelize.transaction(async (t) => createInvoiceWithQr(t)));
        }
    } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') {
            throw createError(409, `Phòng ${room.roomNumber} đã có hóa đơn tháng ${month}/${year}. `
                + `Vui lòng xóa hóa đơn cũ nếu muốn xuất lại.`);
        }
        throw err;
    }

    const sendTelegramNotification = async () => {
        try {
            const tenant = await User.findOne({ where: { id: contract.tenantId } });
            // Chỉ gửi tới chat riêng của người thuê. KHÔNG fallback về TELEGRAM_CHAT_ID
            // của hệ thống: làm vậy sẽ đẩy hóa đơn kèm số phòng và số tiền vào nhóm chat
            // chung khi người thuê chưa liên kết Telegram.
            const targetChatId = tenant?.telegramChatId;

            if (targetChatId) {
                await telegramService.sendInvoiceToTelegram(targetChatId, {
                    month,
                    year,
                    roomNumber: room.roomNumber,
                    totalAmount: grandTotal,
                    roomPrice: rent,
                    electricityTotal: eTotal,
                    waterTotal: wTotal,
                    serviceTotal: sTotal,
                    qrCodeUrl: qrCodeUrl,
                });
            } else {
                console.log(`ℹ️ [Invoice] Người thuê ID ${contract.tenantId} chưa liên kết Telegram — bỏ qua gửi hóa đơn.`);
            }
        } catch (teleErr) {
            console.error("⚠️ Lỗi gửi Telegram:", teleErr.message);
        }
    };

    if (activeTx && typeof activeTx.afterCommit === 'function') {
        activeTx.afterCommit(() => {
            sendTelegramNotification();
        });
    } else {
        await sendTelegramNotification();
    }

    return {
        message: `Xuất hóa đơn tháng ${month}/${year} thành công`,
        invoice: {
            id: invoice.id,
            roomNumber: room.roomNumber,
            qrCode: qrCodeUrl,
            total: grandTotal,
        },
    };
};

// 2. XÁC NHẬN THANH TOÁN
exports.updatePaymentStatus = async (
    invoiceId,
    { isPaid, paymentMethod, paidAmount, cancelReason, allowPartial, status } = {},
    landlordId = null,
    options = {}
) => {
    const tx = options?.transaction || null;
    const txOpt = tx ? { transaction: tx } : {};
    const isPartialRequest = Boolean(allowPartial || status === 'partial' || (!isPaid && paidAmount != null && Number(paidAmount) > 0));

    if (!isPartialRequest && typeof isPaid !== 'boolean') {
        throw createError(400, "isPaid phải là true hoặc false");
    }
    const method = paymentMethod || 'cash';
    if ((isPaid || isPartialRequest) && !PAYMENT_METHODS.includes(method)) {
        throw createError(400, "Cách thanh toán không hợp lệ");
    }
    if ((isPaid || isPartialRequest) && paidAmount != null && !(Number.isFinite(Number(paidAmount)) && Number(paidAmount) >= 0)) {
        throw createError(400, "Số tiền đã thu phải là số không âm");
    }

    const invoice = await Invoice.findByPk(invoiceId, {
        include: [
            {
                model: Room,
                as: "roomDetails",
                include: [{ model: Building, as: "building" }]
            }
        ],
        ...txOpt,
    });

    if (!invoice) throw createError(404, "Không tìm thấy hóa đơn");

    // Kiểm tra quyền sở hữu TRƯỚC mọi thông báo nghiệp vụ, để chủ trọ khác không
    // dò được tổng tiền hóa đơn qua câu lỗi 400 (IDOR).
    const ownerLandlordId = invoice.landlordId || invoice.roomDetails?.building?.landlordId;
    if (landlordId && ownerLandlordId !== landlordId) {
        throw createError(404, "Hóa đơn không tồn tại hoặc bạn không có quyền cập nhật");
    }

    const totalAmount = parseFloat(invoice.totalAmount || 0);

    // T2.2: Hỗ trợ thanh toán một phần (partial)
    if (isPartialRequest && paidAmount != null && Number(paidAmount) > 0 && Number(paidAmount) < totalAmount) {
        invoice.isPaid = false;
        invoice.status = 'partial';
        invoice.paidAt = new Date();
        invoice.paidAmount = Number(paidAmount);
        invoice.paymentMethod = method;
        if (!invoice.landlordId && ownerLandlordId) {
            invoice.landlordId = ownerLandlordId;
        }
        await invoice.save(txOpt);
        return {
            message: "Đã ghi nhận thanh toán một phần",
            isPaid: false,
            status: 'partial',
            paidAmount: invoice.paidAmount,
        };
    }

    // Giống SePay: không xác nhận đã thu đủ khi số tiền nhận ít hơn tổng hóa đơn
    if (isPaid && !invoice.isPaid && paidAmount != null && Number(paidAmount) < totalAmount) {
        throw createError(400, `Số tiền đã thu (${Number(paidAmount)}) ít hơn tổng tiền hóa đơn (${totalAmount})`);
    }

    // Hóa đơn đã cấn trừ tiền cọc khi thanh lý (C1) thì không hủy ở đây được.
    if (!isPaid && invoice.isPaid && invoice.paymentMethod === 'deposit') {
        throw createError(400, "Hóa đơn đã được cấn trừ vào tiền cọc, không thể hủy xác nhận");
    }

    // T1.5: Hóa đơn thanh toán qua SePay muốn hủy xác nhận phải có cancelReason >= 5 ký tự
    if (!isPaid && invoice.isPaid && invoice.paymentMethod === 'sepay') {
        const trimmedReason = typeof cancelReason === 'string' ? cancelReason.trim() : '';
        if (trimmedReason.length < 5) {
            throw createError(409, "Hóa đơn đã thanh toán tự động qua SePay, vui lòng nhập lý do hủy xác nhận (tối thiểu 5 ký tự).");
        }
        await AdminLog.create({
            adminId: landlordId || ownerLandlordId || null,
            action: 'INVOICE_SEPAY_UNPAID',
            target: `Invoice #${invoice.id}`,
            details: trimmedReason,
        }, txOpt);
    }

    // Đã ở đúng trạng thái yêu cầu: không ghi đè thời điểm/cách thanh toán cũ và
    // không gửi Telegram lần nữa.
    if (!!invoice.isPaid === isPaid && invoice.status !== 'partial') {
        return { message: isPaid ? "Hóa đơn đã được thanh toán từ trước" : "Hóa đơn chưa được thanh toán", isPaid };
    }

    invoice.isPaid = isPaid;
    invoice.status = isPaid ? 'paid' : 'unpaid';
    invoice.paidAt = isPaid ? new Date() : null;
    invoice.paidAmount = isPaid ? (paidAmount != null ? Number(paidAmount) : totalAmount) : 0;
    invoice.paymentMethod = isPaid ? method : null;
    if (!invoice.landlordId && ownerLandlordId) {
        invoice.landlordId = ownerLandlordId;
    }
    await invoice.save(txOpt);

    if (isPaid) {
        try {
            // Gửi cho đúng người thuê của hóa đơn. Chỉ hóa đơn cũ chưa có tenantId mới
            // fallback về người đang thuê phòng.
            let tenantId = invoice.tenantId;
            if (!tenantId) {
                const contract = await Contract.findOne({
                    where: { roomId: invoice.roomId, status: "active" },
                    ...txOpt,
                });
                tenantId = contract?.tenantId;
            }
            const tenant = tenantId ? await User.findByPk(tenantId, txOpt) : null;
            if (tenant?.telegramChatId) {
                const roomNumber = invoice.roomDetails ? invoice.roomDetails.roomNumber : "N/A";
                const message = `✅ **XÁC NHẬN THANH TOÁN**

Chủ nhà đã xác nhận nhận được tiền phòng tháng ${invoice.month}/${invoice.year} của phòng **${roomNumber}**.

Cảm ơn bạn! 🙏`;
                await telegramService.sendTextToTelegram(tenant.telegramChatId, message);
            }
        } catch (err) {
            console.error("⚠️ Lỗi gửi Telegram xác nhận thanh toán:", err.message);
        }
    }

    return {
        message: isPaid ? "Đã xác nhận thanh toán" : "Đã hủy thanh toán",
        isPaid: invoice.isPaid,
        status: invoice.status,
    };
};

// Include phòng + tòa của đúng chủ nhà (required) để chủ nhà khác không thấy hóa đơn.
const ownedRoomInclude = (landlordId, buildingWhere = {}) => ({
    model: Room,
    as: "roomDetails",
    required: true,
    attributes: ['id', 'roomNumber'],
    include: [{
        model: Building,
        as: "building",
        required: true,
        attributes: ['id', 'name', 'landlordId'],
        where: { landlordId, ...buildingWhere },
    }],
});

// DANH SÁCH HÓA ĐƠN CỦA CHỦ NHÀ (I1)
exports.listInvoices = async (landlordId, { month, year, status, buildingId } = {}) => {
    const where = {};
    if (month && month !== 'all') where.month = Number(month);
    if (year) where.year = Number(year);
    if (status === 'paid') where.isPaid = true;
    if (status === 'unpaid') where.isPaid = false;
    if (status === 'partial') where.status = 'partial';
    if (status === 'overdue') {
        where.isPaid = false;
        where.dueDate = { [Op.lt]: dayjs().format('YYYY-MM-DD') };
    }

    return Invoice.findAll({
        where,
        include: [
            ownedRoomInclude(landlordId, buildingId ? { id: Number(buildingId) } : {}),
            { model: User, as: 'tenant', attributes: ['id', 'name', 'phone'] },
        ],
        order: [['year', 'DESC'], ['month', 'DESC']],
    });
};

// XÓA HÓA ĐƠN CHƯA THU (I1 / T1.5) — để chủ nhà xuất lại khi nhập sai chỉ số.
exports.deleteInvoice = async (invoiceId, landlordId) => {
    const invoice = await Invoice.findByPk(invoiceId, {
        include: [{ model: Room, as: "roomDetails", include: [{ model: Building, as: "building" }] }],
    });
    const owner = invoice && (invoice.landlordId || invoice.roomDetails?.building?.landlordId);
    if (!invoice || owner !== landlordId) {
        throw createError(404, "Hóa đơn không tồn tại hoặc bạn không có quyền xóa");
    }
    if (invoice.isPaid || Number(invoice.paidAmount || 0) > 0) {
        throw createError(409, "Hóa đơn đã thanh toán hoặc đã thu một phần, không thể xóa. Hãy hủy xác nhận trước.");
    }

    const recentSepay = await SePayEvent.findOne({
        where: {
            [Op.or]: [
                { invoiceId: invoice.id },
                { content: { [Op.like]: `%HD ${invoice.id}%` } }
            ],
            createdAt: { [Op.gte]: dayjs().subtract(24, 'hour').toDate() }
        }
    });
    if (recentSepay) {
        throw createError(409, "Đang có giao dịch SePay liên quan đến hóa đơn này, không thể xóa.");
    }

    invoice.status = 'voided';
    invoice.deletedAt = new Date();
    if (typeof invoice.save === 'function') {
        await invoice.save();
    }
    await invoice.destroy();
    return { message: `Đã xóa hóa đơn tháng ${invoice.month}/${invoice.year}` };
};

// 3. THỐNG KÊ DOANH THU (Landlord-specific)
exports.getRevenueStats = async (landlordId, { month, year }) => {
    if (!year) {
        throw createError(400, "Vui lòng cung cấp ít nhất tham số Năm");
    }

    const numericYear = Number(year);
    const numericMonth = month && month !== 'all' ? Number(month) : null;

    // Lấy toàn bộ hóa đơn thuộc các tòa nhà của landlord này trong năm chỉ định để tính cả kỳ và trend 12 tháng
    const allInvoicesInYear = await Invoice.findAll({
        where: { year: numericYear },
        include: [
            {
                model: Room,
                as: "roomDetails",
                required: true,
                include: [
                    {
                        model: Building,
                        as: "building",
                        required: true,
                        where: { landlordId },
                    },
                ],
            },
        ],
    });

    // Lấy các chi phí sửa chữa do chủ trọ chịu (chargeToTenant === false) trong năm
    const SupportRequest = require('../models/SupportRequest');
    const allSupportRequests = await SupportRequest.findAll({
        where: {
            chargeToTenant: false,
            repairCost: { [Op.gt]: 0 },
            status: 'resolved'
        },
        include: [
            {
                model: Room,
                as: "room",
                required: true,
                include: [
                    {
                        model: Building,
                        as: "building",
                        required: true,
                        where: { landlordId }
                    }
                ]
            }
        ]
    });

    // Lọc hóa đơn theo kỳ được chọn (hỗ trợ cả mock object trong test không truyền month)
    const invoices = numericMonth
        ? allInvoicesInYear.filter((inv) => inv.month == null || Number(inv.month) === numericMonth)
        : allInvoicesInYear;

    let totalExpected = 0;
    let totalCollected = 0;
    let unpaidAmount = 0;
    // T2.11: tiền cấn trừ cọc khi thanh lý không phải tiền mới thu vào, tách riêng
    let depositOffset = 0;
    const unpaidRoomIds = new Set();

    invoices.forEach((inv) => {
        const amt = parseFloat(inv.totalAmount || 0);
        const paid = parseFloat(inv.paidAmount || 0);
        totalExpected += amt;
        if (inv.isPaid) {
            // "Đã thu" phải là tiền thực nhận. Hóa đơn cũ (trước khi có paidAmount)
            // mặc định 0 nên fallback về totalAmount để không tụt doanh thu.
            const collected = paid > 0 ? paid : amt;
            totalCollected += collected;
            if (inv.paymentMethod === 'deposit') depositOffset += collected;
        } else {
            if (paid > 0) {
                totalCollected += paid;
                if (inv.paymentMethod === 'deposit') depositOffset += paid;
            }
            unpaidAmount += Math.max(0, amt - paid);
            unpaidRoomIds.add(inv.roomId);
        }
    });

    // Tính chi phí sửa chữa do chủ trọ chịu trong kỳ
    const repairsInPeriod = allSupportRequests.filter((r) => {
        const d = r.updatedAt ? new Date(r.updatedAt) : (r.createdAt ? new Date(r.createdAt) : null);
        if (!d) return true;
        const matchYear = d.getFullYear() === numericYear;
        const matchMonth = numericMonth ? (d.getMonth() + 1 === numericMonth) : true;
        return matchYear && matchMonth;
    });
    const totalRepairCost = repairsInPeriod.reduce((sum, r) => sum + parseFloat(r.repairCost || 0), 0);
    const netProfit = Math.max(0, totalCollected - totalRepairCost);

    // Tính dữ liệu xu hướng 12 tháng liên tục
    const trend12Months = Array.from({ length: 12 }, (_, i) => {
        const m = i + 1;
        const mInvs = allInvoicesInYear.filter((inv) => Number(inv.month) === m);
        let exp = 0;
        let col = 0;
        mInvs.forEach((inv) => {
            const a = parseFloat(inv.totalAmount || 0);
            const p = parseFloat(inv.paidAmount || 0);
            exp += a;
            col += inv.isPaid ? (p > 0 ? p : a) : (p > 0 ? p : 0);
        });

        const mRepairs = allSupportRequests.filter((r) => {
            const d = r.updatedAt ? new Date(r.updatedAt) : (r.createdAt ? new Date(r.createdAt) : null);
            return d && d.getFullYear() === numericYear && (d.getMonth() + 1 === m);
        });
        const repCost = mRepairs.reduce((sum, r) => sum + parseFloat(r.repairCost || 0), 0);

        return {
            month: m,
            year: numericYear,
            expected: exp,
            collected: col,
            repairCost: repCost,
            profit: Math.max(0, col - repCost)
        };
    });

    // Tính tỷ lệ lấp đầy phòng (%)
    let occupancyRate = 0;
    let totalRooms = 0;
    let occupiedRooms = 0;
    try {
        totalRooms = await Room.count({
            include: [{ model: Building, as: "building", required: true, where: { landlordId } }]
        });
        occupiedRooms = await Room.count({
            where: { status: 'occupied' },
            include: [{ model: Building, as: "building", required: true, where: { landlordId } }]
        });
        if (!occupiedRooms) {
            occupiedRooms = await Room.count({
                where: { status: 'rented' },
                include: [{ model: Building, as: "building", required: true, where: { landlordId } }]
            });
        }
        occupancyRate = totalRooms > 0 ? Number(((occupiedRooms / totalRooms) * 100).toFixed(1)) : 0;
    } catch (e) {
        // Fallback
    }

    return {
        period: `${month || 'all'}/${year}`,
        stats: {
            totalExpected,
            totalCollected,
            cashCollected: totalCollected - depositOffset,
            depositOffset,
            unpaidAmount,
            unpaidRooms: unpaidRoomIds.size,
            invoiceCount: invoices.length,
            totalRepairCost,
            netProfit,
            totalRooms,
            occupiedRooms,
            occupancyRate,
            trend12Months
        },
    };
};
