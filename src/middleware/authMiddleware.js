const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Role = require('../models/Role');

const protect = async (req, res, next) => {
    let token;
    if (req.headers.authorization?.startsWith('Bearer')) {
        try {
            token = req.headers.authorization.split(' ')[1];
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            
            req.user = await User.findByPk(decoded.id, {
                include: [{ model: Role, as: 'roleData' }]
            });
            
            if (!req.user) return res.status(401).json({ message: 'Người dùng không tồn tại' });
            if (req.user.status === 'locked') {
                return res.status(403).json({ message: 'Tài khoản của bạn đã bị khóa bởi quản trị viên' });
            }

            // Tự động kiểm tra hết hạn gói cước -> Chuyển về Gói Miễn Phí (Free) nếu quá hạn
            if (req.user.plan && req.user.plan !== 'free' && req.user.planExpiresAt) {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const expDate = new Date(req.user.planExpiresAt);
                expDate.setHours(0, 0, 0, 0);

                if (expDate < today) {
                    const oldPlan = req.user.plan;
                    req.user.plan = 'free';
                    req.user.planExpiresAt = null;
                    await req.user.save();

                    const notificationService = require('../services/notificationService');
                    await notificationService.createNotification(
                        req.user.id,
                        'Gói dịch vụ đã hết hạn',
                        `Gói dịch vụ ${oldPlan.toUpperCase()} của bạn đã hết hạn. Hệ thống đã tự động chuyển tài khoản của bạn về Gói Miễn Phí (Free).`,
                        'plan_expiry',
                        req.user.id
                    );
                }
            }

            return next();
        } catch (error) {
            return res.status(401).json({ message: 'Token không hợp lệ' });
        }
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

module.exports = { protect, authorize };