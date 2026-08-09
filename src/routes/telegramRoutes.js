const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Role = require("../models/Role");
const Contract = require("../models/Contract");
const Room = require("../models/Room");
const Building = require("../models/Building");
const Invoice = require("../models/Invoice");
const SupportRequest = require("../models/SupportRequest");
const axios = require("axios");

// Lưu trữ session tạm thời cho việc báo hỏng
// Key: chatId (string), Value: { userId, roomId, step: 'WAITING_FOR_ISSUE_DESC' }
const activeSessions = new Map();

// Helper gửi tin nhắn
const sendTelegramMessage = async (chatId, text, replyMarkup = null) => {
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown",
  };
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }
  try {
    await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      payload
    );
  } catch (err) {
    console.error("Lỗi gửi tin nhắn Telegram:", err.response ? err.response.data : err.message);
  }
};

// Helper gửi ảnh (cho VietQR code)
const sendTelegramPhoto = async (chatId, photoUrl, caption, replyMarkup = null) => {
  const payload = {
    chat_id: chatId,
    photo: photoUrl,
    caption: caption,
    parse_mode: "Markdown",
  };
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }
  try {
    await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendPhoto`,
      payload
    );
  } catch (err) {
    console.error("Lỗi gửi ảnh Telegram:", err.response ? err.response.data : err.message);
  }
};

// Định nghĩa bàn phím chức năng (Menu)
const getMenuMarkup = (roleName) => {
  if (roleName === "landlord") {
    return {
      inline_keyboard: [
        [
          { text: "📊 Doanh thu tháng này", callback_data: "landlord_revenue" },
          { text: "🏢 Thống kê phòng trống", callback_data: "landlord_rooms" }
        ]
      ]
    };
  } else if (roleName === "tenant") {
    return {
      inline_keyboard: [
        [
          { text: "💵 Hóa đơn hiện tại", callback_data: "tenant_invoice" },
          { text: "📜 Chi tiết hợp đồng", callback_data: "tenant_contract" }
        ],
        [
          { text: "🔧 Báo hỏng thiết bị", callback_data: "tenant_report_issue" },
          { text: "📞 Thông tin chủ nhà", callback_data: "tenant_landlord" }
        ]
      ]
    };
  }
  return null;
};

router.post("/webhook", async (req, res) => {
  try {
    const { message, callback_query } = req.body;

    // 1. XỬ LÝ SỰ KIỆN CLICK NÚT BẤM (CALLBACK QUERY)
    if (callback_query) {
      const chatId = callback_query.message.chat.id;
      const callbackData = callback_query.data;

      // Tìm người dùng liên kết với telegramChatId này
      const user = await User.findOne({
        where: { telegramChatId: chatId.toString() },
        include: { model: Role, as: 'roleData' }
      });

      if (!user) {
        await sendTelegramMessage(chatId, "⚠️ Tài khoản Telegram của bạn chưa được liên kết. Vui lòng đăng nhập hệ thống Web và nhấn 'Kết nối Telegram'.");
        return res.status(200).send("OK");
      }

      const roleName = user.roleData ? user.roleData.name : null;

      // --- XỬ LÝ HÀNH ĐỘNG HỦY THAO TÁC ---
      if (callbackData === "cancel_action") {
        activeSessions.delete(chatId.toString());
        await sendTelegramMessage(chatId, "❌ Đã hủy thao tác.");
        return res.status(200).send("OK");
      }

      // --- XỬ LÝ HÀNH ĐỘNG CỦA KHÁCH THUÊ ---
      if (roleName === "tenant") {
        if (callbackData === "tenant_invoice") {
          const contract = await Contract.findOne({ where: { tenantId: user.id, status: 'active' } });
          if (!contract) {
            await sendTelegramMessage(chatId, "⚠️ Bạn hiện chưa có hợp đồng thuê phòng nào hoạt động trên hệ thống.");
            return res.status(200).send("OK");
          }

          const latestInvoice = await Invoice.findOne({
            where: { roomId: contract.roomId },
            order: [['year', 'DESC'], ['month', 'DESC']]
          });

          if (!latestInvoice) {
            await sendTelegramMessage(chatId, "📅 Hiện tại phòng của bạn chưa được tạo hóa đơn nào.");
            return res.status(200).send("OK");
          }

          const formatMoney = (amount) => Number(amount).toLocaleString('vi-VN');

          const msg = `🔔 **HÓA ĐƠN THÁNG ${latestInvoice.month}/${latestInvoice.year}**\n` +
            `----------------------------------\n` +
            `💰 **Tổng tiền:** ${formatMoney(latestInvoice.totalAmount)} VNĐ\n` +
            `📌 **Trạng thái:** ${latestInvoice.isPaid ? '🟢 Đã thanh toán' : '🔴 Chưa thanh toán'}\n\n` +
            `📍 **Chi tiết:**\n` +
            `- Tiền phòng: ${formatMoney(latestInvoice.roomPrice)} VNĐ\n` +
            `- Tiền điện: ${formatMoney(latestInvoice.electricityTotal)} VNĐ\n` +
            `- Tiền nước: ${formatMoney(latestInvoice.waterTotal)} VNĐ\n` +
            `- Tiền dịch vụ: ${formatMoney(latestInvoice.serviceTotal)} VNĐ`;

          if (latestInvoice.isPaid) {
            await sendTelegramMessage(chatId, msg);
          } else {
            const qrCodeUrl = latestInvoice.qrCodeUrl;
            if (qrCodeUrl) {
              await sendTelegramPhoto(chatId, qrCodeUrl, msg + `\n\n📸 *Quét mã QR để thanh toán nhanh:*`);
            } else {
              await sendTelegramMessage(chatId, msg + `\n\n*(Chưa có mã QR thanh toán)*`);
            }
          }
        } 
        
        else if (callbackData === "tenant_contract") {
          const contract = await Contract.findOne({
            where: { tenantId: user.id, status: 'active' },
            include: [{ model: Room, as: 'room', include: { model: Building, as: 'building' } }]
          });

          if (!contract) {
            await sendTelegramMessage(chatId, "⚠️ Bạn hiện chưa có hợp đồng thuê phòng nào hoạt động.");
            return res.status(200).send("OK");
          }

          const formatMoney = (amount) => Number(amount).toLocaleString('vi-VN');
          const formatDate = (dateStr) => {
            if (!dateStr) return 'N/A';
            const d = new Date(dateStr);
            return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
          };

          const msg = `📜 **THÔNG TIN HỢP ĐỒNG THUÊ**\n` +
            `----------------------------------\n` +
            `🏢 **Tòa nhà:** ${contract.room.building.name}\n` +
            `🏠 **Phòng:** ${contract.room.roomNumber}\n` +
            `📅 **Bắt đầu:** ${formatDate(contract.startDate)}\n` +
            `📅 **Kết thúc:** ${formatDate(contract.endDate)}\n` +
            `💰 **Đặt cọc:** ${formatMoney(contract.deposit)} VNĐ\n` +
            `💵 **Giá phòng:** ${formatMoney(contract.room.price)} VNĐ/tháng\n` +
            `⚡ **Đơn giá điện:** ${formatMoney(contract.electricityPrice)} VNĐ/kWh\n` +
            `💧 **Đơn giá nước:** ${formatMoney(contract.waterPrice)} VNĐ/m³`;

          await sendTelegramMessage(chatId, msg);
        } 
        
        else if (callbackData === "tenant_landlord") {
          const contract = await Contract.findOne({
            where: { tenantId: user.id, status: 'active' },
            include: [{
              model: Room,
              as: 'room',
              include: {
                model: Building,
                as: 'building',
                include: {
                  model: User,
                  as: 'landlord',
                  attributes: ['name', 'phone', 'email']
                }
              }
            }]
          });

          if (!contract || !contract.room.building.landlord) {
            await sendTelegramMessage(chatId, "⚠️ Không tìm thấy thông tin liên hệ của chủ nhà.");
            return res.status(200).send("OK");
          }

          const landlord = contract.room.building.landlord;
          const msg = `📞 **LIÊN HỆ CHỦ NHÀ**\n` +
            `----------------------------------\n` +
            `👤 **Họ tên:** ${landlord.name}\n` +
            `📞 **Số điện thoại:** ${landlord.phone || 'Chưa cập nhật'}\n` +
            `✉️ **Email:** ${landlord.email || 'Chưa cập nhật'}`;

          await sendTelegramMessage(chatId, msg);
        } 
        
        else if (callbackData === "tenant_report_issue") {
          const contract = await Contract.findOne({ where: { tenantId: user.id, status: 'active' } });
          if (!contract) {
            await sendTelegramMessage(chatId, "⚠️ Bạn hiện chưa có hợp đồng thuê phòng nào để gửi báo hỏng.");
            return res.status(200).send("OK");
          }

          // Thiết lập session trạng thái chờ nhập mô tả
          activeSessions.set(chatId.toString(), {
            userId: user.id,
            roomId: contract.roomId,
            step: 'WAITING_FOR_ISSUE_DESC'
          });

          const cancelMarkup = {
            inline_keyboard: [[{ text: "❌ Hủy bỏ", callback_data: "cancel_action" }]]
          };

          await sendTelegramMessage(
            chatId, 
            "🔧 **BÁO CÁO SỰ CỐ / HỎNG HÓC**\n\nVui lòng nhập nội dung mô tả sự cố (Ví dụ: hỏng vòi nước phòng tắm, bóng đèn cháy...):",
            cancelMarkup
          );
        }
      }

      // --- XỬ LÝ HÀNH ĐỘNG CỦA CHỦ NHÀ ---
      if (roleName === "landlord") {
        if (callbackData === "landlord_revenue") {
          const now = new Date();
          const currentMonth = now.getMonth() + 1;
          const currentYear = now.getFullYear();

          const invoices = await Invoice.findAll({
            where: { month: currentMonth, year: currentYear },
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
                    where: { landlordId: user.id },
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

          const formatMoney = (amount) => Number(amount).toLocaleString('vi-VN');

          const msg = `📊 **DOANH THU THÁNG ${currentMonth}/${currentYear}**\n` +
            `----------------------------------\n` +
            `💰 **Tổng phải thu:** ${formatMoney(totalExpected)} VNĐ\n` +
            `✅ **Đã thu:** ${formatMoney(totalCollected)} VNĐ\n` +
            `❌ **Chưa thu:** ${formatMoney(totalExpected - totalCollected)} VNĐ\n` +
            `🏠 **Phòng chưa đóng tiền:** ${unpaidRooms} phòng`;

          await sendTelegramMessage(chatId, msg);
        } 
        
        else if (callbackData === "landlord_rooms") {
          const rooms = await Room.findAll({
            include: [{
              model: Building,
              as: "building",
              where: { landlordId: user.id },
              required: true
            }]
          });

          const totalRooms = rooms.length;
          const emptyRooms = rooms.filter(r => r.status === 'empty').length;
          const occupiedRooms = rooms.filter(r => r.status === 'occupied').length;
          const maintRooms = rooms.filter(r => r.status === 'maintenance').length;

          const msg = `🏢 **THỐNG KÊ PHÒNG TRỐNG**\n` +
            `----------------------------------\n` +
            `🔑 **Tổng phòng quản lý:** ${totalRooms} phòng\n` +
            `🟢 **Đang trống:** ${emptyRooms} phòng\n` +
            `🔴 **Đang cho thuê:** ${occupiedRooms} phòng\n` +
            `🛠️ **Đang bảo trì:** ${maintRooms} phòng`;

          await sendTelegramMessage(chatId, msg);
        }
      }

      // --- CHỦ NHÀ ĐỔI TRẠNG THÁI SỰ CỐ ---
      if (callbackData.startsWith("landlord_status_")) {
        const parts = callbackData.split("_");
        const statusType = parts[2]; // repairing | resolved
        const requestId = parts[3];

        const request = await SupportRequest.findByPk(requestId, {
          include: [
            { model: User, as: 'tenant' },
            { model: Room, as: 'room', include: { model: Building, as: 'building' } }
          ]
        });

        if (!request) {
          await sendTelegramMessage(chatId, "❌ Sự cố này không tồn tại hoặc đã bị xóa khỏi hệ thống.");
          return res.status(200).send("OK");
        }

        let dbStatus = 'pending';
        let statusText = '';
        if (statusType === 'repairing') {
          dbStatus = 'in_progress';
          statusText = '🛠️ Đang sửa';
        } else if (statusType === 'resolved') {
          dbStatus = 'resolved';
          statusText = '✅ Đã hoàn thành';
        }

        await request.update({ status: dbStatus });

        // Phản hồi chủ nhà
        await sendTelegramMessage(chatId, `✅ Đã chuyển trạng thái sự cố của phòng ${request.room.roomNumber} thành: **${statusText}**.`);

        // Thông báo cho khách thuê nếu có Telegram
        if (request.tenant && request.tenant.telegramChatId) {
          const tenantMsg = `🔔 **Cập nhật trạng thái sự cố!**\n🔧 Yêu cầu báo hỏng ("${request.description}") của bạn đã được chuyển sang trạng thái: **${statusText}**.`;
          await sendTelegramMessage(request.tenant.telegramChatId, tenantMsg);
        }
      }
      return res.status(200).send("OK");
    }

    // 2. XỬ LÝ TIN NHẮN VĂN BẢN ĐẾN (MESSAGE)
    if (message && message.text) {
      const chatId = message.chat.id;
      const text = message.text.trim();

      // --- HÀNH ĐỘNG KẾT NỐI MỚI /START ---
      if (text.startsWith("/start")) {
        const userId = text.split(" ")[1];

        if (userId) {
          const user = await User.findByPk(userId, {
            include: { model: Role, as: 'roleData' }
          });

          if (user) {
            await user.update({ telegramChatId: chatId.toString() });

            let responseText = "✅ Kết nối thành công! Bạn đã liên kết với hệ thống quản lý phòng trọ.";
            const roleName = user.roleData ? user.roleData.name : null;
            
            if (roleName === "landlord") {
              responseText = "✅ Kết nối thành công! Bạn đã liên kết tài khoản Chủ nhà thành công. Bạn sẽ nhận được các thông báo báo hỏng và báo cáo quản lý tại đây.";
            } else if (roleName === "tenant") {
              responseText = "✅ Kết nối thành công! Bạn đã liên kết tài khoản Khách thuê thành công. Bạn sẽ nhận được hóa đơn và thông báo tại đây.";
            }

            const menuMarkup = getMenuMarkup(roleName);
            await sendTelegramMessage(chatId, responseText, menuMarkup);
          } else {
            await sendTelegramMessage(chatId, "❌ Người dùng không tồn tại. Vui lòng kết nối lại từ website.");
          }
        } else {
          // Lệnh /start thông thường không tham số
          const user = await User.findOne({
            where: { telegramChatId: chatId.toString() },
            include: { model: Role, as: 'roleData' }
          });

          if (user) {
            const roleName = user.roleData ? user.roleData.name : null;
            const menuMarkup = getMenuMarkup(roleName);
            await sendTelegramMessage(chatId, `👋 Xin chào ${user.name}! Dưới đây là bảng chức năng của bạn:`, menuMarkup);
          } else {
            await sendTelegramMessage(chatId, "👋 Xin chào! Vui lòng truy cập website và nhấn nút **Kết nối Telegram** để kích hoạt các chức năng.");
          }
        }
        return res.status(200).send("OK");
      }

      // --- LỆNH HỘP MENU /MENU ---
      if (text === "/menu") {
        const user = await User.findOne({
          where: { telegramChatId: chatId.toString() },
          include: { model: Role, as: 'roleData' }
        });

        if (user) {
          const roleName = user.roleData ? user.roleData.name : null;
          const menuMarkup = getMenuMarkup(roleName);
          await sendTelegramMessage(chatId, "📱 Bảng Menu Chức năng:", menuMarkup);
        } else {
          await sendTelegramMessage(chatId, "⚠️ Bạn chưa kết nối tài khoản. Vui lòng liên kết từ trang cá nhân trên web trước.");
        }
        return res.status(200).send("OK");
      }

      // --- XỬ LÝ NHẬP MÔ TẢ CHO TIẾN TRÌNH BÁO HỎNG ---
      if (activeSessions.has(chatId.toString())) {
        const session = activeSessions.get(chatId.toString());

        if (session.step === 'WAITING_FOR_ISSUE_DESC') {
          // Tạo yêu cầu báo hỏng trong database
          const newRequest = await SupportRequest.create({
            description: text,
            status: 'pending',
            severity: 'medium',
            tenantId: session.userId,
            roomId: session.roomId
          });

          // Xóa session
          activeSessions.delete(chatId.toString());

          await sendTelegramMessage(chatId, "✅ Đã gửi báo hỏng thành công đến chủ nhà!");

          // Tìm chủ nhà để gửi cảnh báo tức thời
          const room = await Room.findByPk(session.roomId, {
            include: {
              model: Building,
              as: 'building',
              include: {
                model: User,
                as: 'landlord'
              }
            }
          });

          if (room && room.building && room.building.landlord && room.building.landlord.telegramChatId) {
            const landlordChatId = room.building.landlord.telegramChatId;
            const landlordMessage = `🚨 **KHÁCH THUÊ PHÒNG ${room.roomNumber} BÁO HỎNG!**\n` +
              `🏢 Tòa nhà: ${room.building.name}\n` +
              `🔧 Nội dung sự cố: *"${text}"*\n\n` +
              `Hãy cập nhật tiến trình xử lý dưới đây:`;
            
            const landlordActionMarkup = {
              inline_keyboard: [
                [
                  { text: "🛠️ Đang tiến hành sửa", callback_data: `landlord_status_repairing_${newRequest.id}` },
                  { text: "✅ Đã giải quyết xong", callback_data: `landlord_status_resolved_${newRequest.id}` }
                ]
              ]
            };

            await sendTelegramMessage(landlordChatId, landlordMessage, landlordActionMarkup);
          }
        }
        return res.status(200).send("OK");
      }

      // Các trường hợp khác
      await sendTelegramMessage(chatId, "👋 Vui lòng gõ lệnh `/menu` để mở bảng chức năng tương tác.");
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("Lỗi Webhook Telegram:", err);
    res.status(200).send("OK");
  }
});

module.exports = router;
