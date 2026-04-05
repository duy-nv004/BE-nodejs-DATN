const express = require("express");
const router = express.Router();
const User = require("../models/User");
const axios = require("axios");

router.post("/webhook", async (req, res) => {
  try {
    const { message } = req.body;
    if (message && message.text && message.text.startsWith("/start")) {
      const chatId = message.chat.id;
      const userId = message.text.split(" ")[1]; // Lấy ID sau lệnh /start

      if (userId) {
        await User.update(
          { telegramChatId: chatId.toString() },
          { where: { id: userId } },
        );
        await axios.post(
          `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            chat_id: chatId,
            text: "✅ Kết nối thành công! Bạn sẽ nhận được hóa đơn tại đây.",
          },
        );
      }
    }
    res.status(200).send("OK");
  } catch (err) {
    res.status(200).send("OK");
  }
});

module.exports = router;
