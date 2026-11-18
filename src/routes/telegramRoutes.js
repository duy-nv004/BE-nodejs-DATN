const express = require("express");
const router = express.Router();
const telegramController = require("../controllers/telegramController");

// Định tuyến webhook Telegram Bot - xử lý chi tiết tại telegramController
router.post("/webhook", telegramController.handleWebhook);

module.exports = router;
