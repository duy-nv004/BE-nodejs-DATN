const User = require('../models/User');
const Role = require('../models/Role');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');

const signToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1d' });

// 1. CHỦ NHÀ tự đăng ký bằng Email
exports.registerLandlord = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ message: 'Vui lòng nhập Email và Mật khẩu' });

        const role = await Role.findOne({ where: { name: 'landlord' } });
        const user = await User.create({ email, password, roleId: role.id });

        res.status(201).json({ message: "Đăng ký chủ nhà thành công", token: signToken(user.id) });
    } catch (err) {
        res.status(400).json({ message: "Email đã tồn tại trên hệ thống" });
    }
};

// 2. CHỦ NHÀ tạo tài khoản cho NGƯỜI THUÊ bằng SĐT
exports.createTenant = async (req, res) => {
    try {
        const { phone, password } = req.body;
        if (!phone || !password) return res.status(400).json({ message: 'Vui lòng nhập SĐT và Mật khẩu cho người thuê' });

        const role = await Role.findOne({ where: { name: 'tenant' } });
        const tenant = await User.create({
            phone,
            password,
            roleId: role.id,
            ownerId: req.user.id // Ràng buộc người thuê này vào chủ nhà đang đăng nhập
        });

        res.status(201).json({ message: "Tạo tài khoản người thuê bằng SĐT thành công", tenantId: tenant.id });
    } catch (err) {
        res.status(400).json({ message: "Số điện thoại này đã được sử dụng" });
    }
};

// 3. ĐĂNG NHẬP CHUNG (Linh hoạt identity là Email hoặc Phone)
// exports.login = async (req, res) => {
//     try {
//         const { identity, password } = req.body; 
//         const user = await User.findOne({ 
//             where: {
//                 [Op.or]: [{ email: identity }, { phone: identity }]
//             },
//             include: ['roleData']
//         });

//         if (user && (await user.comparePassword(password))) {
//             res.json({
//                 token: signToken(user.id),
//                 role: user.roleData.name,
//                 email: user.email,
//                 phone: user.phone
//             });
//         } else {
//             res.status(401).json({ message: "Thông tin đăng nhập không chính xác" });
//         }
//     } catch (err) {
//         res.status(500).json({ message: err.message });
//     }
// };
exports.login = async (req, res) => {
    try {
        const { identity, password } = req.body; 
        const user = await User.findOne({ 
            where: {
                [Op.or]: [{ email: identity }, { phone: identity }]
            },
            include: ['roleData']
        });

        if (user && (await user.comparePassword(password))) {
            const roleName = user.roleData.name;
            let telegramConnectLink = null;

            // Nếu là Tenant và chưa có Chat ID -> Tạo link điều hướng
            if (roleName.toLowerCase() === 'tenant' && !user.telegramChatId) {
                const botUsername = process.env.TELEGRAM_BOT_USERNAME;
                telegramConnectLink = `https://t.me/${botUsername}?start=${user.id}`;
            }

            res.json({
                token: signToken(user.id),
                role: roleName,
                email: user.email,
                phone: user.phone,
                telegramConnectLink: telegramConnectLink // Link này dùng cho Frontend
            });
        } else {
            res.status(401).json({ message: "Thông tin đăng nhập không chính xác" });
        }
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};