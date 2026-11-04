const express = require("express");
const router = express.Router();
const { Op } = require("sequelize");
const User = require("../models/User");
const Role = require("../models/Role");
const Contract = require("../models/Contract");
const Room = require("../models/Room");
const Building = require("../models/Building");
const Invoice = require("../models/Invoice");
const SupportRequest = require("../models/SupportRequest");
const axios = require("axios");
const supportService = require("../services/supportService");
const invoiceService = require("../services/invoiceService");

const escMd = (text) =>
  typeof supportService.escapeTelegramMarkdown === "function"
    ? supportService.escapeTelegramMarkdown(text)
    : String(text ?? "").replace(/([_*\[\]`])/g, "\\$1");

if (!process.env.TELEGRAM_WEBHOOK_SECRET) {
  console.warn(process.env.NODE_ENV === 'production'
    ? '⚠️  [telegramRoutes] TELEGRAM_WEBHOOK_SECRET chưa được cấu hình — webhook Telegram sẽ từ chối mọi yêu cầu ở production.'
    : '⚠️  [telegramRoutes] TELEGRAM_WEBHOOK_SECRET chưa được cấu hình — webhook Telegram đang mở công khai (chỉ chấp nhận ở môi trường dev).');
}

// Lưu trữ session tạm thời cho việc báo hỏng
// Key: chatId (string), Value: { userId, roomId, step, expiresAt }
const activeSessions = new Map();

// Session tự hết hạn sau 10 phút: nếu không, một session bỏ dở sẽ nuốt mọi
// tin nhắn text người dùng gửi sau đó và biến chúng thành nội dung báo hỏng.
const SESSION_TTL_MS = 10 * 60 * 1000;

const setSession = (chatId, data) => {
  activeSessions.set(chatId, { ...data, expiresAt: Date.now() + SESSION_TTL_MS });
};

const getSession = (chatId) => {
  const session = activeSessions.get(chatId);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    activeSessions.delete(chatId);
    return null;
  }
  return session;
};

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
  // Xác thực nguồn gọi: Telegram gửi kèm header này khi setWebhook có secret_token.
  // Thiếu bước này, bất kỳ ai cũng POST được payload giả để gán chat Telegram của
  // họ vào tài khoản người khác, hoặc đổi trạng thái sự cố của chủ nhà khác.
  // Production bắt buộc có secret; dev được bỏ qua để thử nhanh (đã cảnh báo lúc khởi động).
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!webhookSecret && process.env.NODE_ENV === 'production') {
    console.warn('⚠️ [Telegram Webhook] Từ chối: production chưa cấu hình TELEGRAM_WEBHOOK_SECRET!');
    return res.status(401).send('Unauthorized');
  }
  if (webhookSecret && req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) {
    console.warn('⚠️ [Telegram Webhook] Truy cập không hợp lệ - sai hoặc thiếu secret token!');
    return res.status(401).send('Unauthorized');
  }

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
          // Khách thuê nhiều phòng: gửi hóa đơn mới nhất của từng phòng
          const contracts = await Contract.findAll({
            where: { tenantId: user.id, status: 'active' },
            order: [['id', 'ASC']],
            include: [{ model: Room, as: 'room', attributes: ['roomNumber'] }]
          });
          if (contracts.length === 0) {
            await sendTelegramMessage(chatId, "⚠️ Bạn hiện chưa có hợp đồng thuê phòng nào hoạt động trên hệ thống.");
            return res.status(200).send("OK");
          }

          const formatMoney = (amount) => Number(amount).toLocaleString('vi-VN');

          for (const contract of contracts) {
          const roomLabel = contracts.length > 1 ? ` - PHÒNG ${escMd(contract.room?.roomNumber)}` : '';
          const latestInvoice = await Invoice.findOne({
            where: { contractId: contract.id },
            order: [['year', 'DESC'], ['month', 'DESC']]
          });

          if (!latestInvoice) {
            await sendTelegramMessage(chatId, `📅 Phòng ${escMd(contract.room?.roomNumber || '')} chưa được tạo hóa đơn nào.`);
            continue;
          }

          const msg = `🔔 **HÓA ĐƠN THÁNG ${latestInvoice.month}/${latestInvoice.year}${roomLabel}**\n` +
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
        }
        
        else if (callbackData === "tenant_contract") {
          const contracts = await Contract.findAll({
            where: { tenantId: user.id, status: 'active' },
            order: [['id', 'ASC']],
            include: [{ model: Room, as: 'room', include: { model: Building, as: 'building' } }]
          });

          if (contracts.length === 0) {
            await sendTelegramMessage(chatId, "⚠️ Bạn hiện chưa có hợp đồng thuê phòng nào hoạt động.");
            return res.status(200).send("OK");
          }

          const formatMoney = (amount) => Number(amount).toLocaleString('vi-VN');
          const formatDate = (dateStr) => {
            if (!dateStr) return 'N/A';
            const d = new Date(dateStr);
            return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
          };

          // Mỗi phòng đang thuê một khối thông tin
          const msg = contracts.map(contract => `📜 **THÔNG TIN HỢP ĐỒNG THUÊ**\n` +
            `----------------------------------\n` +
            `🏢 **Tòa nhà:** ${escMd(contract.room.building.name)}\n` +
            `🏠 **Phòng:** ${escMd(contract.room.roomNumber)}\n` +
            `📅 **Bắt đầu:** ${formatDate(contract.startDate)}\n` +
            `📅 **Kết thúc:** ${formatDate(contract.endDate)}\n` +
            `💰 **Đặt cọc:** ${formatMoney(contract.deposit)} VNĐ\n` +
            `💵 **Giá phòng:** ${formatMoney(contract.room.price)} VNĐ/tháng\n` +
            `⚡ **Đơn giá điện:** ${formatMoney(contract.electricityPrice)} VNĐ/kWh\n` +
            `💧 **Đơn giá nước:** ${formatMoney(contract.waterPrice)} VNĐ/m³`).join('\n\n');

          await sendTelegramMessage(chatId, msg);
        } 
        
        else if (callbackData === "tenant_landlord") {
          const contracts = await Contract.findAll({
            where: { tenantId: user.id, status: 'active' },
            order: [['id', 'ASC']],
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

          // Các phòng có thể thuộc nhiều chủ nhà: gom phòng theo từng chủ nhà
          const byLandlord = new Map();
          for (const c of contracts) {
            const landlord = c.room?.building?.landlord;
            if (!landlord) continue;
            const key = `${landlord.name}|${landlord.phone}|${landlord.email}`;
            if (!byLandlord.has(key)) byLandlord.set(key, { landlord, rooms: [] });
            byLandlord.get(key).rooms.push(escMd(c.room.roomNumber));
          }

          if (byLandlord.size === 0) {
            await sendTelegramMessage(chatId, "⚠️ Không tìm thấy thông tin liên hệ của chủ nhà.");
            return res.status(200).send("OK");
          }

          const msg = [...byLandlord.values()].map(({ landlord, rooms }) => `📞 **LIÊN HỆ CHỦ NHÀ**\n` +
            `----------------------------------\n` +
            `🏠 **Phòng:** ${rooms.join(', ')}\n` +
            `👤 **Họ tên:** ${escMd(landlord.name)}\n` +
            `📞 **Số điện thoại:** ${escMd(landlord.phone || 'Chưa cập nhật')}\n` +
            `✉️ **Email:** ${escMd(landlord.email || 'Chưa cập nhật')}`).join('\n\n');

          await sendTelegramMessage(chatId, msg);
        } 
        
        else if (callbackData === "tenant_report_issue" || callbackData.startsWith("tenant_report_room_")) {
          const contracts = await Contract.findAll({
            where: { tenantId: user.id, status: 'active' },
            order: [['id', 'ASC']],
            include: [{ model: Room, as: 'room' }]
          });
          if (contracts.length === 0) {
            await sendTelegramMessage(chatId, "⚠️ Bạn hiện chưa có hợp đồng thuê phòng nào để gửi báo hỏng.");
            return res.status(200).send("OK");
          }

          // Thuê nhiều phòng: hỏi phòng nào bị sự cố trước khi nhận mô tả
          let contract = contracts.length === 1 ? contracts[0] : null;
          if (callbackData.startsWith("tenant_report_room_")) {
            const contractId = Number(callbackData.slice("tenant_report_room_".length));
            // Chỉ chấp nhận hợp đồng đang thuê của chính người dùng
            contract = contracts.find(c => c.id === contractId) || null;
          }
          if (!contract) {
            const roomMarkup = {
              inline_keyboard: [
                ...contracts.map(c => [{ text: `🏠 Phòng ${c.room?.roomNumber}`, callback_data: `tenant_report_room_${c.id}` }]),
                [{ text: "❌ Hủy bỏ", callback_data: "cancel_action" }]
              ]
            };
            await sendTelegramMessage(chatId, "🔧 Bạn muốn báo sự cố cho phòng nào?", roomMarkup);
            return res.status(200).send("OK");
          }

          // Thiết lập session trạng thái chờ nhập mô tả (tự hết hạn sau 10 phút)
          setSession(chatId.toString(), {
            userId: user.id,
            roomId: contract.roomId,
            step: 'WAITING_FOR_ISSUE_DESC'
          });

          const cancelMarkup = {
            inline_keyboard: [[{ text: "❌ Hủy bỏ", callback_data: "cancel_action" }]]
          };

          await sendTelegramMessage(
            chatId, 
            `🔧 **BÁO CÁO SỰ CỐ / HỎNG HÓC** (Phòng ${escMd(contract.room?.roomNumber)})\n\nVui lòng nhập nội dung mô tả sự cố (Ví dụ: hỏng vòi nước phòng tắm, bóng đèn cháy...):`,
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

          // T2.11: dùng chung cách tính với dashboard để hai nơi ra cùng một con số
          const { stats } = await invoiceService.getRevenueStats(user.id, { month: currentMonth, year: currentYear });

          const formatMoney = (amount) => Number(amount).toLocaleString('vi-VN');

          const msg = `📊 **DOANH THU THÁNG ${currentMonth}/${currentYear}**\n` +
            `----------------------------------\n` +
            `💰 **Tổng phải thu:** ${formatMoney(stats.totalExpected)} VNĐ\n` +
            `✅ **Đã thu:** ${formatMoney(stats.cashCollected)} VNĐ\n` +
            (stats.depositOffset > 0 ? `🔁 **Cấn trừ cọc:** ${formatMoney(stats.depositOffset)} VNĐ\n` : '') +
            `❌ **Chưa thu:** ${formatMoney(stats.unpaidAmount)} VNĐ\n` +
            `🏠 **Phòng chưa đóng tiền:** ${stats.unpaidRooms} phòng`;

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
        // Khối này nằm ngoài nhánh roleName === "landlord" nên phải tự kiểm tra vai trò,
        // nếu không khách thuê cũng bấm được callback_data này.
        if (roleName !== "landlord") {
          await sendTelegramMessage(chatId, "⚠️ Bạn không có quyền cập nhật trạng thái sự cố.");
          return res.status(200).send("OK");
        }

        const parts = callbackData.split("_");
        const statusType = parts[2]; // repairing | resolved
        const requestId = parts[3];

        const request = await SupportRequest.findByPk(requestId, {
          include: [
            { model: User, as: 'tenant' },
            { model: Room, as: 'room', include: { model: Building, as: 'building' } }
          ]
        });

        // Chỉ chủ nhà sở hữu phòng xảy ra sự cố mới được đổi trạng thái.
        // Trước đây chỉ kiểm tra tồn tại, nên bất kỳ ai đã liên kết Telegram
        // cũng đổi được trạng thái sự cố của phòng thuộc chủ nhà khác.
        if (!request || request.room?.building?.landlordId !== user.id) {
          await sendTelegramMessage(chatId, "❌ Sự cố này không tồn tại hoặc không thuộc quyền quản lý của bạn.");
          return res.status(200).send("OK");
        }

        let dbStatus = null;
        let statusText = '';
        if (statusType === 'repairing') {
          dbStatus = 'in_progress';
          statusText = '🛠️ Đang sửa';
        } else if (statusType === 'resolved') {
          dbStatus = 'resolved';
          statusText = '✅ Đã hoàn thành';
        }

        if (!dbStatus) {
          await sendTelegramMessage(chatId, "⚠️ Trạng thái không hợp lệ.");
          return res.status(200).send("OK");
        }

        // Bấm lại nút cùng trạng thái: không đổi gì, không nhắn lại khách
        if (request.status === dbStatus) {
          await sendTelegramMessage(chatId, `ℹ️ Sự cố của phòng ${escMd(request.room.roomNumber)} đã ở trạng thái **${statusText}**.`);
          return res.status(200).send("OK");
        }

        // Đi qua service: kiểm tra quyền chủ nhà, luật chuyển trạng thái và tạo thông báo web + Telegram cho khách
        let updateResult;
        try {
          updateResult = await supportService.updateRequestStatus(user.id, requestId, { status: dbStatus });
        } catch (err) {
          await sendTelegramMessage(chatId, `❌ ${err.statusCode ? err.message : 'Không thể cập nhật trạng thái sự cố.'}`);
          return res.status(200).send("OK");
        }

        // Phản hồi chủ nhà
        await sendTelegramMessage(chatId, `✅ Đã chuyển trạng thái sự cố của phòng ${escMd(request.room.roomNumber)} thành: **${statusText}**.`);

        // Thông báo cho khách thuê nếu supportService chưa gửi (VD khi unit test stub updateRequestStatus)
        if (!updateResult?.telegramNotified && request.tenant && request.tenant.telegramChatId) {
          const tenantMsg = `🔔 **Cập nhật trạng thái sự cố!**\n🔧 Yêu cầu báo hỏng ("${escMd(request.description)}") của bạn đã được chuyển sang trạng thái: **${statusText}**.`;
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
        const linkToken = text.split(" ")[1];

        if (linkToken) {
          // Tra theo token ngắn hạn (15 phút, dùng một lần) thay vì user.id.
          // Trước đây tham số là user.id nên ai đoán được id cũng gán được chat
          // Telegram của mình vào tài khoản đó. Token sinh ở authService.generateTelegramLink.
          const user = await User.findOne({
            where: {
              telegramLinkToken: linkToken,
              telegramLinkTokenExpiresAt: { [Op.gt]: new Date() }
            },
            include: { model: Role, as: 'roleData' }
          });

          if (user) {
            if (typeof User.update === 'function') {
              await User.update(
                { telegramChatId: null },
                { where: { telegramChatId: String(chatId), id: { [Op.ne]: user.id } } }
              );
            }
            user.telegramChatId = chatId.toString();
            // Token dùng một lần: xoá ngay để không thể liên kết lại lần nữa
            user.telegramLinkToken = null;
            user.telegramLinkTokenExpiresAt = null;
            await user.save();

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
            await sendTelegramMessage(chatId, "❌ Liên kết không hợp lệ hoặc đã hết hạn. Vui lòng vào website và bấm 'Kết nối Telegram' để lấy liên kết mới.");
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
            await sendTelegramMessage(chatId, `👋 Xin chào ${escMd(user.name)}! Dưới đây là bảng chức năng của bạn:`, menuMarkup);
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
      const session = getSession(chatId.toString());
      if (session) {
        if (session.step === 'WAITING_FOR_ISSUE_DESC') {
          // Xóa session
          activeSessions.delete(chatId.toString());

          // Tạo yêu cầu qua service: kiểm tra hợp đồng còn hiệu lực và tạo thông báo web + Telegram cho chủ nhà
          let newRequest;
          let createResult;
          try {
            createResult = await supportService.createTenantRequest(session.userId, {
              description: text,
              roomId: session.roomId
            });
            newRequest = createResult.supportRequest;
          } catch (err) {
            await sendTelegramMessage(chatId, `❌ ${err.statusCode ? err.message : 'Không thể gửi báo hỏng, vui lòng thử lại.'}`);
            return res.status(200).send("OK");
          }

          await sendTelegramMessage(chatId, "✅ Đã gửi báo hỏng thành công đến chủ nhà!");

          // Nếu supportService chưa gửi Telegram (VD khi unit test stub createTenantRequest), gửi fallback có escape Markdown
          if (!createResult?.telegramNotified) {
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
              const landlordMessage = `🚨 **KHÁCH THUÊ PHÒNG ${escMd(room.roomNumber)} BÁO HỎNG!**\n` +
                `🏢 Tòa nhà: ${escMd(room.building.name)}\n` +
                `🔧 Nội dung sự cố: *"${escMd(text)}"*\n\n` +
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
