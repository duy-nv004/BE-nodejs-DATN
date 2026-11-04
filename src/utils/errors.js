const createError = (statusCode, message) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
};

/**
 * Trả lỗi về client: lỗi nghiệp vụ giữ mã + thông điệp; lỗi Sequelize đổi sang 400 tiếng Việt;
 * lỗi không rõ trả 500 thông điệp chung (chi tiết chỉ ghi log server).
 */
const sendError = (res, err) => {
    if (err && err.statusCode) {
        return res.status(err.statusCode).json({ message: err.message });
    }
    if (err && err.name === 'SequelizeUniqueConstraintError') {
        return res.status(400).json({ message: 'Dữ liệu đã tồn tại trên hệ thống (trùng email, số điện thoại hoặc mã)' });
    }
    if (err && err.name === 'SequelizeValidationError') {
        return res.status(400).json({ message: 'Dữ liệu gửi lên không hợp lệ' });
    }
    console.error(err);
    return res.status(500).json({ message: 'Lỗi máy chủ, vui lòng thử lại sau' });
};

module.exports = { createError, sendError };
