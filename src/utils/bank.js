// Tài khoản ngân hàng của hệ thống (env). Dùng cho thanh toán gói cước và làm
// fallback cho QR hóa đơn khi chủ nhà chưa cấu hình tài khoản nhận tiền (I2).
exports.systemBank = () => ({
    bankId: process.env.BANK_ID || 'MB',
    bankAccount: process.env.BANK_ACCOUNT || '0383808466',
    bankName: process.env.BANK_NAME || 'EXECUTIVE LENS',
});
