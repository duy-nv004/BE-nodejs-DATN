const { Op } = require('sequelize');
const authService = require('../services/authService');
const notificationService = require('../services/notificationService');
const Plan = require('../models/Plan');
const User = require('../models/User');
const PlanUpgradeRequest = require('../models/PlanUpgradeRequest');
const adminService = require('../services/adminService');
const { isAnnualCycle, normalizeCycle, planPriceVnd, buildTransferCode } = require('../utils/planPricing');

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

/**
 * Đăng ký / nâng cấp gói cước cho chủ nhà.
 *
 * - Gói Miễn Phí: hạ cấp trực tiếp, không phát sinh thanh toán.
 * - Gói trả phí: CHỈ ghi nhận yêu cầu ở trạng thái `pending` kèm số tiền phải thu
 *   và nội dung chuyển khoản. Gói cước thật trên User chỉ được kích hoạt khi
 *   Webhook SePay xác nhận đã nhận đủ tiền (sepayService.processWebhookPayload).
 */
exports.upgradeRequest = async (req, res) => {
    try {
        const { planName, billingCycle = 'monthly' } = req.body;
        if (!planName) {
            return res.status(400).json({ message: "Vui lòng chọn gói cước muốn nâng cấp" });
        }

        const plan = await Plan.findOne({ where: { name: String(planName).toLowerCase() } });
        if (!plan) {
            return res.status(404).json({ message: "Gói cước không tồn tại trong hệ thống" });
        }

        const user = await User.findByPk(req.user.id);
        if (!user) {
            return res.status(404).json({ message: "Người dùng không tồn tại" });
        }

        const cycleText = isAnnualCycle(billingCycle) ? '1 Năm' : '1 Tháng';
        const userPayload = {
            id: user.id,
            name: user.name,
            email: user.email,
            phone: user.phone,
            plan: user.plan,
            planExpiresAt: user.planExpiresAt,
            role: req.user.roleData?.name || 'landlord'
        };

        // ─── 1. GÓI MIỄN PHÍ: hạ cấp trực tiếp, không cần thanh toán ─────────────
        if (plan.name === 'free') {
            user.plan = 'free';
            user.planExpiresAt = null;
            await user.save();

            // Người dùng đổi ý về gói Miễn Phí -> huỷ mọi yêu cầu nâng cấp đang chờ
            await PlanUpgradeRequest.update(
                { status: 'cancelled' },
                { where: { landlordId: user.id, status: 'pending' } }
            );

            await notificationService.createNotification(
                user.id,
                "Chuyển về gói Miễn Phí",
                `Tài khoản của bạn đã được chuyển về gói ${plan.name.toUpperCase()} thành công.`,
                'plan_expiry',
                user.id
            );

            return res.json({
                message: `Đã chuyển về gói ${plan.name.toUpperCase()} thành công!`,
                pending: false,
                user: { ...userPayload, plan: user.plan, planExpiresAt: user.planExpiresAt }
            });
        }

        // ─── 2. GÓI TRẢ PHÍ: chỉ ghi nhận yêu cầu chờ thanh toán ────────────────
        // TUYỆT ĐỐI không gán user.plan ở đây — việc kích hoạt gói phải do
        // Webhook SePay thực hiện sau khi xác nhận đã nhận đủ tiền.
        const amount = planPriceVnd(plan, billingCycle);
        if (!amount || amount <= 0) {
            return res.status(400).json({ message: "Gói cước này chưa được cấu hình giá. Vui lòng liên hệ ban quản trị." });
        }

        const cycle = normalizeCycle(billingCycle);

        // Đổi ý chọn gói/chu kỳ khác -> huỷ các yêu cầu chờ không còn liên quan
        await PlanUpgradeRequest.update(
            { status: 'cancelled' },
            {
                where: {
                    landlordId: user.id,
                    status: 'pending',
                    [Op.or]: [{ planName: { [Op.ne]: plan.name } }, { billingCycle: { [Op.ne]: cycle } }]
                }
            }
        );

        // Tái sử dụng yêu cầu đang chờ nếu trùng gói + chu kỳ (tránh tạo trùng)
        let upgradeRequest = await PlanUpgradeRequest.findOne({
            where: { landlordId: user.id, planName: plan.name, billingCycle: cycle, status: 'pending' }
        });

        if (!upgradeRequest) {
            upgradeRequest = await PlanUpgradeRequest.create({
                landlordId: user.id,
                planName: plan.name,
                billingCycle: cycle,
                amount,
                transferCode: buildTransferCode(user.id, plan.name, cycle),
                status: 'pending'
            });

            await notificationService.createNotification(
                user.id,
                "Đã ghi nhận yêu cầu nâng cấp gói dịch vụ",
                `Hệ thống đã ghi nhận yêu cầu nâng cấp gói ${plan.name.toUpperCase()} (${cycleText}). `
                + `Vui lòng chuyển khoản ${amount.toLocaleString('vi-VN')} VNĐ với nội dung "${upgradeRequest.transferCode}" `
                + `để gói cước được kích hoạt tự động.`,
                'plan_expiry',
                upgradeRequest.id
            );
        }

        return res.json({
            message: `Đã ghi nhận yêu cầu nâng cấp gói ${plan.name.toUpperCase()} (${cycleText}). `
                + `Vui lòng hoàn tất chuyển khoản để hệ thống kích hoạt gói cước.`,
            pending: true,
            request: {
                id: upgradeRequest.id,
                planName: upgradeRequest.planName,
                billingCycle: upgradeRequest.billingCycle,
                amount: parseFloat(upgradeRequest.amount),
                transferCode: upgradeRequest.transferCode,
                status: upgradeRequest.status
            },
            user: userPayload
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