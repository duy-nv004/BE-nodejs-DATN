const sepayService = require('../services/sepayService');
const { systemBank } = require('../utils/bank');

/**
 * Endpoint nhận dữ liệu Webhook từ SePay khi có biến động dư nợ / chuyển khoản ngân hàng.
 * SePay sẽ gửi POST request tới endpoint này.
 */
exports.handleWebhook = async (req, res) => {
    try {
        // Kiểm tra mã bảo mật API Key nếu được khai báo trong .env
        const sepayApiKey = process.env.SEPAY_API_KEY;
        if (!sepayApiKey) {
            // Production thiếu khoá thì đóng cổng: không có khoá ai cũng giả mạo được webhook.
            if (process.env.NODE_ENV === 'production') {
                console.error('❌ [SePay Webhook] Chưa cấu hình SEPAY_API_KEY, từ chối webhook.');
                return res.status(503).json({ success: false, message: 'Webhook SePay chưa được cấu hình.' });
            }
            console.warn('⚠️ [SePay Webhook] Chưa cấu hình SEPAY_API_KEY, bỏ qua xác thực (chỉ dùng khi phát triển).');
        } else {
            const authHeader = req.headers['authorization'] || req.headers['x-sepay-api-key'] || '';
            const token = authHeader.replace(/^(Bearer|Apikey)\s+/i, '').trim();
            // Bắt buộc phải có token: thiếu header cũng bị từ chối. Trước đây chỉ chặn khi
            // token SAI, nên request không kèm header vẫn lọt qua và có thể giả mạo webhook
            // để kích hoạt gói trả phí miễn phí.
            if (token !== sepayApiKey) {
                console.warn(`⚠️ [SePay Webhook] Truy cập không hợp lệ - Sai hoặc thiếu SEPAY_API_KEY!`);
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
    res.json(systemBank());
 };
