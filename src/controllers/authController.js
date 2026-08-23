const authService = require('../services/authService');
const Plan = require('../models/Plan');
const User = require('../models/User');
const adminService = require('../services/adminService');

exports.registerLandlord = async (req, res) => {
    try {
        const result = await authService.registerLandlord(req.body);
        res.status(201).json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

exports.login = async (req, res) => {
    try {
        const result = await authService.loginUser(req.body);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

exports.createTenant = async (req, res) => {
    try {
        const result = await authService.createTenant(req.user.id, req.body);
        res.status(201).json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

exports.updateProfile = async (req, res) => {
    try {
        const result = await authService.updateProfile(req.user.id, req.body);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

exports.changePassword = async (req, res) => {
    try {
        const result = await authService.changePassword(req.user.id, req.body);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

// Lấy danh sách toàn bộ các gói dịch vụ
exports.getPlans = async (req, res) => {
    try {
        const plans = await Plan.findAll({ order: [['id', 'ASC']] });
        res.json(plans);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// Đăng ký/nâng cấp gói cước cho chủ nhà
exports.upgradeRequest = async (req, res) => {
    try {
        const { planName, billingCycle = 'monthly' } = req.body;
        if (!planName) {
            return res.status(400).json({ message: "Vui lòng chọn gói cước muốn nâng cấp" });
        }

        const plan = await Plan.findOne({ where: { name: planName.toLowerCase() } });
        if (!plan) {
            return res.status(404).json({ message: "Gói cước không tồn tại trong hệ thống" });
        }

        const user = await User.findByPk(req.user.id);
        user.plan = plan.name;
        
        const isAnnual = billingCycle.toLowerCase() === 'annual' || billingCycle.toLowerCase() === 'year';
        const cycleText = isAnnual ? '1 Năm' : '1 Tháng';

        if (plan.name === 'free') {
            user.planExpiresAt = null;
        } else {
            const daysToAdd = isAnnual ? 365 : 30;

            const now = new Date();
            let baseDate = now;
            if (user.planExpiresAt && new Date(user.planExpiresAt) > now) {
                baseDate = new Date(user.planExpiresAt);
            }
            baseDate.setDate(baseDate.getDate() + daysToAdd);
            user.planExpiresAt = baseDate.toISOString().split('T')[0];
        }
        
        await user.save();

        // Tạo thông báo nâng cấp / chuyển gói thành công
        const notificationService = require('../services/notificationService');
        if (plan.name === 'free') {
            await notificationService.createNotification(
                user.id,
                "Chuyển về gói Miễn Phí",
                `Tài khoản của bạn đã được chuyển về gói ${plan.name.toUpperCase()} thành công.`,
                'plan_expiry',
                user.id
            );
        } else {
            await notificationService.createNotification(
                user.id,
                "Nâng cấp gói dịch vụ thành công",
                `Chúc mừng bạn đã nâng cấp thành công gói ${plan.name.toUpperCase()} (${cycleText}). Hạn sử dụng của bạn đến ngày ${user.planExpiresAt}.`,
                'plan_expiry',
                user.id
            );
        }

        res.json({
            message: plan.name === 'free'
                ? `Đã chuyển về gói ${plan.name.toUpperCase()} thành công!`
                : `Chúc mừng! Bạn đã nâng cấp thành công lên gói ${plan.name.toUpperCase()} (${cycleText})!`,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                plan: user.plan,
                planExpiresAt: user.planExpiresAt,
                role: req.user.roleData?.name || 'landlord'
            }
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

exports.getProfile = async (req, res) => {
    try {
        const result = await authService.getProfile(req.user.id);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

exports.createAppeal = async (req, res) => {
    try {
        const { email, title, message } = req.body;
        const result = await adminService.createLandlordTicket(email, title, message);
        res.status(201).json({
            message: "Đã gửi khiếu nại tài khoản thành công! Ban quản trị sẽ sớm xem xét và phản hồi qua email.",
            ticket: result
        });
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};