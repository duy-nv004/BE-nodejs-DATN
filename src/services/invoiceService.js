const Invoice = require('../models/Invoice');
const Contract = require('../models/Contract');
const MeterReading = require('../models/MeterReading');
const Room = require('../models/Room');
const Building = require('../models/Building');
const User = require('../models/User');
const telegramService = require('../utils/telegramService');
const axios = require('axios');
const { createError } = require('../utils/errors');

// 1. XUẤT HÓA ĐƠN
exports.generateInvoice = async ({ roomId, month, year }, reqLandlordId = null) => {
    const room = await Room.findByPk(roomId, {
        include: [{ model: Building, as: 'building' }]
    });
    if (!room || (reqLandlordId && room.building?.landlordId !== reqLandlordId)) {
        throw createError(404, "Phòng không tồn tại hoặc bạn không có quyền tạo hóa đơn cho phòng này.");
    }

    const landlordId = room.building ? room.building.landlordId : null;

    const contract = await Contract.findOne({
        where: { roomId, status: "active" },
    });
    if (!contract) {
        throw createError(404, "Phòng này chưa có hợp đồng đang hoạt động.");
    }

    // Mỗi phòng chỉ được có một hóa đơn cho mỗi kỳ. Chặn sớm ở đây để trả về thông
    // báo rõ ràng; unique index ở tầng DB là chốt chặn cuối cho trường hợp đua nhau.
    const existingInvoice = await Invoice.findOne({ where: { roomId, month, year } });
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
    const getUsage = async (type) => {
        const { Op } = require('sequelize');

        const current = await MeterReading.findOne({ where: { roomId, type, period } });
        if (!current) return { usage: 0, oldVal: 0, newVal: 0, error: true };

        const previous = await MeterReading.findOne({
            where: { roomId, type, period: { [Op.lt]: period, [Op.ne]: null } },
            order: [["period", "DESC"]],
        });

        // Kỳ đầu tiên của hợp đồng: chỉ số ban đầu do chủ nhà nhập lúc tạo hợp đồng
        const oldVal = previous ? previous.readingValue : 0;
        const newVal = current.readingValue;
        const usage = Math.max(0, newVal - oldVal);
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
    const grandTotal = Math.max(0, parseFloat(room.price || 0) + eTotal + wTotal + sTotal);

    // Gắn hóa đơn với đúng người thuê / hợp đồng của kỳ này. Không có 2 trường này
    // thì khách thuê mới vào phòng sẽ nhìn thấy công nợ của khách thuê trước.
    const invoice = await Invoice.create({
        roomId,
        landlordId,
        tenantId: contract.tenantId,
        contractId: contract.id,
        month,
        year,
        roomPrice: room.price,
        electricityTotal: eTotal,
        waterTotal: wTotal,
        serviceTotal: sTotal,
        totalAmount: grandTotal,
    });

    // Tạo đường link VietQR / SePay chuẩn hóa để SePay tự động gạch nợ
    // Cú pháp nội dung chuyển khoản: HD <INVOICE_ID> LL <LANDLORD_ID> (Ví dụ: HD 12 LL 5)
    const bankId = process.env.BANK_ID || "MB";
    const accountNo = process.env.BANK_ACCOUNT || "0383808466";
    const accountName = encodeURIComponent(process.env.BANK_NAME || "EXECUTIVE LENS");
    const sepayContent = `HD ${invoice.id} LL ${landlordId || 0}`;
    const description = encodeURIComponent(sepayContent);

    // Đường link sinh ảnh SePay VietQR thông minh
    const qrCodeUrl = `https://qr.sepay.vn/img?bank=${bankId}&acc=${accountNo}&template=compact&amount=${grandTotal}&des=${description}`;

    invoice.qrCodeUrl = qrCodeUrl;
    await invoice.save();

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
                roomPrice: room.price,
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
exports.updatePaymentStatus = async (invoiceId, { isPaid }, landlordId = null) => {
    const invoice = await Invoice.findByPk(invoiceId, {
        include: [
            {
                model: Room,
                as: "roomDetails",
                include: [{ model: Building, as: "building" }]
            }
        ],
    });

    if (!invoice) throw createError(404, "Không tìm thấy hóa đơn");

    const ownerLandlordId = invoice.landlordId || invoice.roomDetails?.building?.landlordId;
    if (landlordId && ownerLandlordId !== landlordId) {
        throw createError(404, "Hóa đơn không tồn tại hoặc bạn không có quyền cập nhật");
    }

    invoice.isPaid = isPaid;
    if (!invoice.landlordId && ownerLandlordId) {
        invoice.landlordId = ownerLandlordId;
    }
    await invoice.save();

    if (isPaid === true) {
        const contract = await Contract.findOne({
            where: { roomId: invoice.roomId, status: "active" },
        });

        if (contract && contract.tenantId) {
            const tenant = await User.findByPk(contract.tenantId);

            if (tenant && tenant.telegramChatId) {
                const token = process.env.TELEGRAM_BOT_TOKEN;
                const roomNumber = invoice.roomDetails ? invoice.roomDetails.roomNumber : "N/A";
                const message = `✅ **XÁC NHẬN THANH TOÁN**\n\nChủ nhà đã xác nhận nhận được tiền phòng tháng ${invoice.month}/${invoice.year} của phòng **${roomNumber}**.\n\nCảm ơn bạn! 🙏`;

                try {
                    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                        chat_id: tenant.telegramChatId,
                        text: message,
                        parse_mode: "Markdown",
                    });
                    console.log(`✅ Đã gửi Telegram thành công cho người thuê: ${tenant.name}`);
                } catch (err) {
                    console.error("⚠️ Lỗi gửi Telegram xác nhận thanh toán:", err.message);
                }
            }
        }
    }

    return {
        message: isPaid ? "Đã xác nhận thanh toán" : "Đã hủy thanh toán",
        isPaid: invoice.isPaid,
    };
};

// 3. THỐNG KÊ DOANH THU (Landlord-specific)
exports.getRevenueStats = async (landlordId, { month, year }) => {
    if (!year) {
        throw createError(400, "Vui lòng cung cấp ít nhất tham số Năm");
    }

    // Nếu month = 'all' hoặc không truyền, ta lọc theo year mà không lọc theo month
    const whereClause = { year };
    if (month && month !== 'all') {
        whereClause.month = month;
    }

    // Lấy toàn bộ hóa đơn thuộc các tòa nhà của landlord này trong khoảng thời gian chỉ định
    const invoices = await Invoice.findAll({
        where: whereClause,
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

    let totalExpected = 0;
    let totalCollected = 0;
    let unpaidRooms = 0;

    invoices.forEach((inv) => {
        const amt = parseFloat(inv.totalAmount || 0);
        totalExpected += amt;
        if (inv.isPaid) {
            totalCollected += amt;
        } else {
            unpaidRooms += 1;
        }
    });

    return {
        period: `${month}/${year}`,
        stats: {
            totalExpected,
            totalCollected,
            unpaidAmount: totalExpected - totalCollected,
            unpaidRooms,
        },
    };
};
