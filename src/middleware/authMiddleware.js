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