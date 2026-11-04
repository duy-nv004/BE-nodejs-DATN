const { createError } = require('./errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Đầu số di động Việt Nam: 03x, 05x, 07x, 08x, 09x
const VN_PHONE_RE = /^0[35789]\d{8}$/;

/** Trả email đã trim; ném 400 nếu sai định dạng. */
exports.validateEmail = (email) => {
    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
        throw createError(400, 'Email không hợp lệ');
    }
    return email.trim();
};

/** Bỏ khoảng trắng/dấu chấm/gạch, đổi +84/84 về 0; trả dạng 0xxxxxxxxx hoặc ném 400. */
exports.validatePhone = (phone) => {
    if (typeof phone !== 'string') {
        throw createError(400, 'Số điện thoại không hợp lệ');
    }
    let p = phone.replace(/[\s.\-]/g, '');
    if (p.startsWith('+84')) p = '0' + p.slice(3);
    else if (p.startsWith('84') && p.length === 11) p = '0' + p.slice(2);
    if (!VN_PHONE_RE.test(p)) {
        throw createError(400, 'Số điện thoại không hợp lệ (cần 10 số, bắt đầu bằng 03, 05, 07, 08 hoặc 09)');
    }
    return p;
};

/** Ném 400 nếu mật khẩu không phải chuỗi hoặc dưới 6 ký tự. */
exports.validatePassword = (password) => {
    if (typeof password !== 'string' || password.length < 6) {
        throw createError(400, 'Mật khẩu phải có ít nhất 6 ký tự');
    }
    return password;
};
