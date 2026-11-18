/**
 * Bộ kiểm tra nguồn gốc CORS (Origin Validator)
 * Đảm bảo không phản chiếu tùy tiện origin khi credentials = true
 */
const getAllowedOrigins = () => (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

const corsOriginValidator = (origin, callback) => {
    if (!origin) return callback(null, true);
    const origins = getAllowedOrigins();
    if (origins.length === 0) {
        if (process.env.NODE_ENV === 'production') {
            return callback(new Error('Chặn bởi chính sách CORS: CORS_ORIGINS chưa được cấu hình'));
        }
        return callback(null, true);
    }
    if (origins.includes(origin)) {
        return callback(null, true);
    }
    return callback(new Error('Chặn bởi chính sách CORS: Origin không được phép'));
};

module.exports = { corsOriginValidator, getAllowedOrigins };

