const Invoice = require("../models/Invoice");
const Contract = require("../models/Contract");
const MeterReading = require("../models/MeterReading");
const Room = require("../models/Room");
const User = require("../models/User");
const telegramService = require("../utils/telegramService");
const axios = require("axios");

// --- 1. HÀM XUẤT HÓA ĐƠN ---
exports.generateInvoice = async (req, res) => {
  try {
    const { roomId, month, year } = req.body;

    const contract = await Contract.findOne({
      where: { roomId, status: "active" },
    });
    if (!contract) {
      return res
        .status(404)
        .json({ message: "Phòng này chưa có hợp đồng đang hoạt động." });
    }

    const getUsage = async (type) => {
      const readings = await MeterReading.findAll({
        where: { roomId, type },
        order: [["readingDate", "DESC"]],
        limit: 2,
      });
      if (readings.length < 2)
        return { usage: 0, oldVal: 0, newVal: 0, error: true };

      const newVal = readings[0].readingValue;
      const oldVal = readings[1].readingValue;
      return { usage: newVal - oldVal, oldVal, newVal, error: false };
    };

    const eData = await getUsage("electricity");
    const wData = await getUsage("water");

    if (eData.error || wData.error) {
      return res
        .status(400)
        .json({ message: "Thiếu dữ liệu chỉ số (Cần ít nhất 2 lần chốt số)." });
    }

    const room = await Room.findByPk(roomId);
    if (!room)
      return res.status(404).json({ message: "Không tìm thấy phòng." });

    const eTotal = eData.usage * contract.electricityPrice;
    const wTotal = wData.usage * contract.waterPrice;
    const sTotal =
      parseFloat(contract.internetPrice || 0) +
      parseFloat(contract.cleaningPrice || 0);
    const grandTotal = parseFloat(room.price) + eTotal + wTotal + sTotal;

    const bankId = process.env.BANK_ID || "MB";
    const accountNo = process.env.BANK_ACCOUNT;
    const accountName = encodeURIComponent(process.env.BANK_NAME || "");
    const description = encodeURIComponent(
      `Thanh toan tien phong ${room.roomNumber} thang ${month}`,
    );

    const qrCodeUrl = `https://img.vietqr.io/image/${bankId}-${accountNo}-compact2.png?amount=${grandTotal}&addInfo=${description}&accountName=${accountName}`;

    const invoice = await Invoice.create({
      roomId,
      month,
      year,
      roomPrice: room.price,
      electricityTotal: eTotal,
      waterTotal: wTotal,
      serviceTotal: sTotal,
      totalAmount: grandTotal,
      qrCodeUrl: qrCodeUrl,
    });

    try {
      const tenant = await User.findOne({ where: { id: contract.tenantId } });
      const targetChatId =
        tenant?.telegramChatId || process.env.TELEGRAM_CHAT_ID;

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
      }
    } catch (teleErr) {
      console.error("⚠️ Lỗi gửi Telegram:", teleErr.message);
    }

    res.status(201).json({
      message: `Xuất hóa đơn tháng ${month}/${year} thành công`,
      invoice: {
        id: invoice.id,
        roomNumber: room.roomNumber,
        qrCode: qrCodeUrl,
        total: grandTotal,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// --- 2. HÀM CẬP NHẬT THANH TOÁN (ĐÃ ĐƯA RA NGOÀI) ---
exports.updatePaymentStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isPaid } = req.body;

    // SỬA LẠI CẤU TRÚC INCLUDE: as phải nằm trong object của model
    const invoice = await Invoice.findByPk(id, {
      include: [
        {
          model: Room,
          as: "roomDetails", // Khớp với alias trong setupAssociations
        },
      ],
    });

    if (!invoice)
      return res.status(404).json({ message: "Không tìm thấy hóa đơn" });

    invoice.isPaid = isPaid;
    await invoice.save();

    if (isPaid === true) {
      const contract = await Contract.findOne({
        where: {
          roomId: invoice.roomId,
          status: "active",
        },
      });

      if (contract && contract.tenantId) {
        // 2. Từ tenantId trong hợp đồng, tìm thông tin User để lấy Chat ID
        const tenant = await User.findByPk(contract.tenantId);

        if (tenant && tenant.telegramChatId) {
          const token = process.env.TELEGRAM_BOT_TOKEN;
          const roomNumber = invoice.roomDetails
            ? invoice.roomDetails.roomNumber
            : "N/A";

          const message = `✅ **XÁC NHẬN THANH TOÁN**\n\nChủ nhà đã xác nhận nhận được tiền phòng tháng ${invoice.month}/${invoice.year} của phòng **${roomNumber}**.\n\nCảm ơn bạn! 🙏`;

          await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: tenant.telegramChatId,
            text: message,
            parse_mode: "Markdown",
          });
          console.log(
            `✅ Đã gửi Telegram thành công cho người thuê: ${tenant.fullName}`,
          );
        } else {
          console.log(
            "⚠️ Người thuê chưa kết nối Telegram (telegramChatId is null)",
          );
        }
      } else {
        console.log(
          "⚠️ Không tìm thấy hợp đồng 'active' cho phòng này để xác định người thuê",
        );
      }
    }

    res.json({
      message: isPaid ? "Đã xác nhận thanh toán" : "Đã hủy thanh toán",
      isPaid: invoice.isPaid,
    });
  } catch (err) {
    console.error("Lỗi cập nhật thanh toán:", err.message);
    res.status(500).json({ message: err.message });
  }
};

// --- 3. HÀM THỐNG KÊ (ĐÃ ĐƯA RA NGOÀI) ---
exports.getRevenueStats = async (req, res) => {
  try {
    const { month, year } = req.query;

    const totalExpected =
      (await Invoice.sum("totalAmount", { where: { month, year } })) || 0;
    const totalCollected =
      (await Invoice.sum("totalAmount", {
        where: { month, year, isPaid: true },
      })) || 0;
    const unpaidCount = await Invoice.count({
      where: { month, year, isPaid: false },
    });

    res.json({
      period: `${month}/${year}`,
      stats: {
        totalExpected: parseFloat(totalExpected),
        totalCollected: parseFloat(totalCollected),
        unpaidAmount: parseFloat(totalExpected - totalCollected),
        unpaidRooms: unpaidCount,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
