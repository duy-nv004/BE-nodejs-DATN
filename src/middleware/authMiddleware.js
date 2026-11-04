const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Role = require('../models/Role');

// Cấp token cho một user: kèm tokenVersion để có thể thu hồi mọi phiên cũ.
const signToken = (user) => {
    const payload = { id: typeof user === 'object' ? user.id : user };
    if (user && typeof user === 'object' && user.tokenVersion != null) {
        payload.tokenVersion = user.tokenVersion;
    }
    return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1d' });
};

const protect = async (req, res, next) => {
    let token;
    if (req.headers.authorization?.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (error) {
            return res.status(401).json({ message: 'Token không hợp lệ' });
        }

        try {
            req.user = await User.findByPk(decoded.id, {
                include: [{ model: Role, as: 'roleData' }]
            });
        } catch (dbErr) {
            console.error('[authMiddleware] Lỗi truy vấn người dùng:', dbErr.message);
            return res.status(500).json({ message: 'Lỗi máy chủ khi xác thực phiên đăng nhập' });
        }

        if (!req.user) return res.status(401).json({ message: 'Người dùng không tồn tại' });

        // Thu hồi phiên: token mang tokenVersion cũ (hoặc không có, cấp trước tính
        // năng này) bị từ chối sau khi đổi mật khẩu / reset mật khẩu.
        const tokenVersion = decoded.tokenVersion ?? 0;
        if (tokenVersion !== (req.user.tokenVersion ?? 0)) {
            return res.status(401).json({ message: 'Phiên đăng nhập đã hết hiệu lực, vui lòng đăng nhập lại' });
        }

        if (req.user.status === 'locked') {
            return res.status(403).json({ code: 'ACCOUNT_LOCKED', message: `Tài khoản của bạn đã bị khóa bởi quản trị viên${req.user.lockReason ? `. Lý do: ${req.user.lockReason}` : ''}` });
        }

        // Tự động kiểm tra hết hạn gói cước -> Chỉ áp dụng cho tài khoản Chủ nhà (Landlord)
        // Bỏ qua với Tenant và Admin để tiết kiệm chi phí truy vấn CSDL trên mỗi request
        if (req.user.roleData?.name === 'landlord') {
            try {
                const planService = require('../services/planService');
                const { expired, oldPlan } = await planService.syncExpiredPlan(req.user);

                if (expired) {
                    const notificationService = require('../services/notificationService');
                    await notificationService.createNotification(
                        req.user.id,
                        'Gói dịch vụ đã hết hạn',
                        `Gói dịch vụ ${oldPlan.toUpperCase()} của bạn đã hết hạn. Hệ thống đã tự động chuyển tài khoản của bạn về Gói Miễn Phí (Free).`,
                        'plan_expiry',
                        req.user.id
                    );
                }
            } catch (auxErr) {
                console.error('[authMiddleware] Lỗi đồng bộ gói / gửi thông báo hết hạn:', auxErr.message);
            }
        }

        return next();
    }
    res.status(401).json({ message: 'Vui lòng đăng nhập' });
};

const authorize = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.roleData.name)) {
            return res.status(403).json({ message: 'Bạn không có quyền truy cập' });
        }
        next();
    };
};

module.exports = { protect, authorize, signToken };
