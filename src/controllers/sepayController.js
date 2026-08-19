const sepayService = require('../services/sepayService');

/**
 * Endpoint nhận dữ liệu Webhook từ SePay khi có biến động dư nợ / chuyển khoản ngân hàng.
 * SePay sẽ gửi POST request tới endpoint này.
 */
exports.handleWebhook = async (req, res) => {
    try {
        // Kiểm tra mã bảo mật API Key nếu được khai báo trong .env
        const sepayApiKey = process.env.SEPAY_API_KEY;
        if (sepayApiKey) {
            const authHeader = req.headers['authorization'] || req.headers['x-sepay-api-key'] || '';
            const token = authHeader.replace(/^(Bearer|Apikey)\s+/i, '').trim();
            if (token && token !== sepayApiKey) {
                console.warn(`⚠️ [SePay Webhook] Truy cập không hợp lệ - Sai SEPAY_API_KEY! (Nhận được: "${token}")`);
                return res.status(401).json({ success: false, message: 'Xác thực SePay API Key thất bại!' });
            }
        }

        const result = await sepayService.processWebhookPayload(req.body);
        res.status(200).json(result);
    } catch (error) {
        console.error('❌ [SePay Webhook Error]:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Lấy cấu hình Ngân hàng công khai để hiển thị mã QR SePay phía Frontend
 */
exports.getPaymentConfig = (req, res) => {
    res.json({
        bankId: process.env.BANK_ID || 'MB',
        bankAccount: process.env.BANK_ACCOUNT || '0985408685',
        bankName: process.env.BANK_NAME || 'NGUYEN VAN DUY'
    });
};
