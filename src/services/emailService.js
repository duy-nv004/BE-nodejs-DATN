const nodemailer = require('nodemailer');

// ─── Kiểm tra biến môi trường bắt buộc ─────────────────────────────────────────
if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('⚠️  [emailService] EMAIL_USER hoặc EMAIL_PASS chưa được cấu hình trong .env. Tính năng gửi email sẽ không hoạt động.');
}

// ─── Cấu hình SMTP Transporter (tái sử dụng kết nối) ──────────────────────────
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

// ─── Templates ─────────────────────────────────────────────────────────────────

/**
 * Tạo nội dung HTML cho email cấp mật khẩu mới.
 * @param {string} name - Tên hoặc email của người nhận
 * @param {string} newPassword - Mật khẩu mới được cấp
 * @returns {string} HTML string
 */
const buildNewPasswordHtml = (name, newPassword) => `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; color: #1a202c;">
        <h2 style="color: #0f172a; margin-top: 0; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px;">
            Mở khóa tài khoản thành công!
        </h2>
        <p>Xin chào <b>${name}</b>,</p>
        <p>Tài khoản chủ nhà của bạn trên hệ thống quản lý <b>Executive Lens</b> đã được phê duyệt mở khóa bởi quản trị viên.</p>
        <p>Chúng tôi đã cấp lại một mật khẩu ngẫu nhiên mới để bạn có thể đăng nhập lại vào hệ thống:</p>
        <div style="background-color: #f8fafc; border: 1px solid #cbd5e1; padding: 16px; border-radius: 8px; font-size: 20px; font-weight: bold; text-align: center; letter-spacing: 1.5px; color: #f5222d; margin: 24px 0;">
            ${newPassword}
        </div>
        <p style="color: #64748b; font-size: 13px;">
            <i>* Lưu ý: Vui lòng đăng nhập bằng mật khẩu này và đổi lại mật khẩu cá nhân trong phần Hồ sơ cá nhân để bảo mật tài khoản.</i>
        </p>
        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <p style="color: #64748b; font-size: 12px; margin-bottom: 0;">
            Trân trọng,<br/>Ban quản trị Executive Lens
        </p>
    </div>
`;

// ─── Public API ─────────────────────────────────────────────────────────────────

/**
 * Gửi email thông báo mật khẩu mới khi tài khoản chủ nhà được mở khóa.
 * @param {string} toEmail - Địa chỉ email người nhận
 * @param {string} landlordName - Tên chủ nhà (dùng làm lời chào)
 * @param {string} newPassword - Mật khẩu mới được cấp
 * @returns {Promise<boolean>} true nếu gửi thành công, false nếu có lỗi
 */
exports.sendNewPasswordEmail = async (toEmail, landlordName, newPassword) => {
    const displayName = landlordName || toEmail;

    const mailOptions = {
        from: `"Executive Lens Support" <${process.env.EMAIL_USER}>`,
        to: toEmail,
        subject: 'Mở khóa tài khoản & Cấp mật khẩu mới - Executive Lens',
        html: buildNewPasswordHtml(displayName, newPassword),
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✉️  [emailService] Gửi email mật khẩu mới tới ${toEmail} thành công.`);
        return true;
    } catch (error) {
        console.error(`❌ [emailService] Lỗi khi gửi email tới ${toEmail}:`, error.message);
        return false;
    }
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * T2.17: báo cho chủ nhà biết khiếu nại mở khóa bị từ chối và lý do.
 * Tài khoản đang bị khóa nên không đăng nhập xem thông báo được, email là kênh duy nhất.
 * @returns {Promise<boolean>} true nếu gửi thành công, false nếu có lỗi
 */
exports.sendTicketRejectedEmail = async (toEmail, reason) => {
    const mailOptions = {
        from: `"Executive Lens Support" <${process.env.EMAIL_USER}>`,
        to: toEmail,
        subject: 'Khiếu nại mở khóa tài khoản bị từ chối - Executive Lens',
        html: `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; color: #1a202c;">
        <h2 style="color: #0f172a; margin-top: 0;">Khiếu nại chưa được chấp nhận</h2>
        <p>Quản trị viên đã xem xét và từ chối yêu cầu mở khóa tài khoản chủ nhà của bạn.</p>
        <p><b>Lý do:</b> ${escapeHtml(reason)}</p>
        <p>Bạn có thể gửi khiếu nại mới kèm thông tin bổ sung.</p>
        <p style="color: #64748b; font-size: 12px; margin-bottom: 0;">Trân trọng,<br/>Ban quản trị Executive Lens</p>
    </div>`,
    };

    try {
        await transporter.sendMail(mailOptions);
        return true;
    } catch (error) {
        console.error(`❌ [emailService] Lỗi khi gửi email từ chối khiếu nại tới ${toEmail}:`, error.message);
        return false;
    }
};
