const axios = require("axios");

exports.sendInvoiceToTelegram = async (chatId, data) => {
  try {
    // Kiểm tra dữ liệu đầu vào
    if (!chatId || !data) {
        console.error("Thiếu chatId hoặc dữ liệu hóa đơn để gửi Telegram");
        return;
    }

    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendPhoto`;
    
    // Định dạng số tiền sang dạng VNĐ (ví dụ: 4,700,000)
    const formatMoney = (amount) => Number(amount).toLocaleString('vi-VN');

    const message = `
🔔 **THÔNG BÁO HÓA ĐƠN THÁNG ${data.month}/${data.year}**
----------------------------------
🏠 **Phòng: ${data.roomNumber}**
💰 **Tổng tiền: ${formatMoney(data.totalAmount)} VNĐ**

📍 *Chi tiết:*
- Tiền phòng: ${formatMoney(data.roomPrice)}
- Điện: ${formatMoney(data.electricityTotal)}
- Nước: ${formatMoney(data.waterTotal)}
- Dịch vụ: ${formatMoney(data.serviceTotal)}

📸 *Quét mã QR bên dưới để thanh toán:*
    `;

    await axios.post(url, {
      chat_id: chatId,
      photo: data.qrCodeUrl,
      caption: message,
      parse_mode: "Markdown",
    });
    
    console.log(`✅ Đã gửi Telegram tới ChatID: ${chatId}`);
  } catch (error) {
    // In chi tiết lỗi từ Telegram nếu có (ví dụ: sai chat_id)
    if (error.response) {
        console.error("Lỗi từ Telegram API:", error.response.data.description);
    } else {
        console.error("Lỗi kết nối Telegram:", error.message);
    }
  }
};