const User = require('../models/User');
const Role = require('../models/Role');
const Building = require('../models/Building');
const Room = require('../models/Room');
const Invoice = require('../models/Invoice');
const Plan = require('../models/Plan');
const PlanUpgradeRequest = require('../models/PlanUpgradeRequest');
const SePayEvent = require('../models/SePayEvent');
const AdminLog = require('../models/AdminLog');
const LandlordTicket = require('../models/LandlordTicket');
const Contract = require('../models/Contract');
const sequelize = require('../config/db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const emailService = require('./emailService');
const notificationService = require('./notificationService');
const { computeConvertedPlanExpiry } = require('./planService');
const { Op } = require('sequelize');
const { createError } = require('../utils/errors');
const { validateEmail } = require('../utils/validators');
const { cycleDays } = require('../utils/planPricing');
const { isExpiredVN, daysRemainingVN } = require('../utils/dateVN');

// ─── Constants ─────────────────────────────────────────────────────────────────
const VALID_PLANS = ['free', 'basic', 'pro'];
const VALID_STATUSES = ['active', 'locked'];
const VALID_TICKET_RESOLUTIONS = ['resolved', 'rejected'];
const BCRYPT_SALT_ROUNDS = 10;
const APPEAL_GENERIC_MESSAGE = 'Đã ghi nhận yêu cầu. Nếu email thuộc tài khoản chủ nhà đang bị khóa, Ban quản trị sẽ xem xét và phản hồi qua email.';

// ─── Private Helpers ────────────────────────────────────────────────────────────

/** Sinh mật khẩu ngẫu nhiên 10 ký tự bằng crypto (an toàn hơn Math.random). */
const generateRandomPassword = () => crypto.randomBytes(9).toString('base64url').slice(0, 10);

/**
 * Chạy callback trong transaction nếu DB/stub sẵn sàng; fallback an toàn cho unit test không kết nối DB.
 */
const withTransaction = async (fn) => {
    if (sequelize && typeof sequelize.transaction === 'function') {
        try {
            return await sequelize.transaction(fn);
        } catch (err) {
            if (
                err?.name === 'SequelizeConnectionRefusedError' ||
                err?.name === 'SequelizeConnectionError' ||
                err?.name === 'SequelizeHostNotReachableError'
            ) {
                return await fn(null);
            }
            throw err;
        }
    }
    return await fn(null);
};

/**
 * Gửi thông báo cho mọi khách đang thuê (HĐ active) của một chủ nhà (A7).
 * Lỗi chỉ được log, không làm hỏng thao tác khóa/mở khóa.
 */
const notifyTenantsOfLandlord = async (landlordId, title, content) => {
    try {
        const contracts = await Contract.findAll({
            where: { status: 'active' },
            attributes: ['tenantId'],
            include: [{
                model: Room, as: 'room', attributes: [], required: true,
                include: [{ model: Building, as: 'building', attributes: [], where: { landlordId }, required: true }],
            }],
        });
        const ids = [...new Set(contracts.map(c => c.tenantId).filter(Boolean))];
        await Promise.all(ids.map(id => notificationService.createNotification(id, title, content, 'landlord_status', landlordId)));
    } catch (err) {
        console.error('❌ [adminService] Lỗi gửi thông báo cho khách thuê:', err.message);
    }
};

/**
 * Tìm vai trò Landlord hoặc ném lỗi nếu không tồn tại trong hệ thống.
 * @returns {Promise<Role>}
 */
const getLandlordRole = async () => {
    const role = await Role.findOne({ where: { name: 'landlord' } });
    if (!role) throw createError(500, 'Không tìm thấy quyền Landlord trong hệ thống');
    return role;
};

/**
 * Chuyển đổi bản ghi AdminLog thành đối tượng hiển thị trên Dashboard.
 * @param {object} log
 */
const mapLogToActivity = (log) => {
    const actionLabels = {
        UPDATE_PLAN: 'Cập nhật Gói cước',
        LOCK_USER: 'Khóa Tài khoản',
        UNLOCK_USER: 'Mở khóa Tài khoản',
        UPDATE_PLAN_CONFIG: 'Cấu hình Gói cước',
    };
    return {
        label: actionLabels[log.action] || log.action,
        sub: log.description,
        time: `Bởi: ${log.admin?.name || log.admin?.email || 'Hệ thống'} • ${new Date(log.createdAt).toLocaleString('vi-VN')}`,
        isPaid: log.action !== 'LOCK_USER',
    };
};

// ─── Stats ──────────────────────────────────────────────────────────────────────

/**
 * Lấy thống kê tổng quan hệ thống cho Admin Dashboard (T2.10).
 */
exports.getSystemStats = async () => {
    const landlordRole = await getLandlordRole();

    const [landlordCount, userCount, freeCount, basicCount, proCount, plans, logs] = await Promise.all([
        User.count({ where: { roleId: landlordRole.id } }),
        User.count(),
        User.count({ where: { roleId: landlordRole.id, plan: 'free' } }),
        User.count({ where: { roleId: landlordRole.id, plan: 'basic' } }),
        User.count({ where: { roleId: landlordRole.id, plan: 'pro' } }),
        Plan.findAll(),
        AdminLog.findAll({
            limit: 5,
            order: [['createdAt', 'DESC']],
            include: [{ model: User, as: 'admin', attributes: ['name', 'email'] }],
        }),
    ]);

    const planPrices = {};
    plans.forEach(p => {
        planPrices[p.name] = {
            monthly: parseFloat(p.price) || 0,
            annual: parseFloat(p.annualPrice) || 0
        };
    });

    const activeSubscribers = await User.findAll({
        where: { roleId: landlordRole.id, plan: { [Op.ne]: 'free' }, status: { [Op.ne]: 'locked' } },
        attributes: ['plan', 'planExpiresAt', 'billingCycle', 'planSource']
    });

    let totalRevenue = 0;
    let estimatedMrr = 0;

    for (const u of activeSubscribers) {
        if (u.planExpiresAt && isExpiredVN(u.planExpiresAt)) continue;

        const price = planPrices[u.plan];
        if (!price) continue;

        // Ưu tiên cột billingCycle đã lưu; chỉ fallback daysLeft > 60 cho dữ liệu cũ chưa có billingCycle
        const isAnnual = u.billingCycle
            ? u.billingCycle === 'annual'
            : (u.planExpiresAt ? daysRemainingVN(u.planExpiresAt) > 60 : false);

        const mrrValue = isAnnual ? price.annual / 12 : price.monthly;
        estimatedMrr += mrrValue;

        // Loại trừ gói do admin cấp tay khỏi doanh thu thực thu
        if (u.planSource !== 'admin') {
            totalRevenue += mrrValue;
        }
    }

    return {
        stats: {
            totalRevenue: parseFloat(totalRevenue),
            estimatedMrr: parseFloat(estimatedMrr),
            landlordCount,
            userCount,
        },
        packages: {
            free: freeCount,
            basic: basicCount,
            pro: proCount,
            total: freeCount + basicCount + proCount,
        },
        recentActivity: logs.map(mapLogToActivity),
    };
};

// ─── Landlords ──────────────────────────────────────────────────────────────────

/**
 * Lấy danh sách toàn bộ chủ nhà cùng thống kê tòa nhà và phòng (T3.4).
 */
exports.getLandlordsList = async () => {
    const landlordRole = await getLandlordRole();

    const landlords = await User.findAll({
        where: { roleId: landlordRole.id },
        attributes: [
            'id', 'name', 'email', 'phone', 'plan',
            'planExpiresAt', 'billingCycle', 'planSource',
            'status', 'lockReason', 'createdAt',
        ],
        include: [{
            model: Building,
            as: 'buildings',
            attributes: ['id'],
            include: [{ model: Room, as: 'rooms', attributes: ['id'] }],
        }],
    });

    return landlords.map(l => {
        const buildings = l.buildings || [];
        const totalRooms = buildings.reduce((acc, b) => acc + (b.rooms?.length || 0), 0);

        return {
            id: l.id,
            name: l.name || 'Chủ nhà mới',
            email: l.email,
            phone: l.phone || 'Chưa cung cấp',
            plan: l.plan.toUpperCase(),
            planExpiresAt: l.planExpiresAt || null,
            billingCycle: l.billingCycle || null,
            planSource: l.planSource || null,
            portfolio: `${buildings.length} Tòa nhà / ${totalRooms} Phòng`,
            date: new Date(l.createdAt).toLocaleDateString('vi-VN'),
            status: l.status ? l.status.toUpperCase() : 'ACTIVE',
            lockReason: l.lockReason || null,
        };
    });
};

/**
 * Cập nhật gói cước của một chủ nhà trong transaction, hủy các yêu cầu nâng cấp
 * đang chờ và quy đổi số ngày còn lại theo tỷ lệ giá gói (T1.16, T1.17, T2.10).
 *
 * @param {number} id - ID của chủ nhà
 * @param {string} plan - Gói cước mới ('free' | 'basic' | 'pro')
 * @param {number} adminId - ID admin thực hiện thao tác
 * @param {string} billingCycle - 'monthly' | 'annual' (chỉ dùng khi cấp hạn mới)
 */
exports.updateLandlordPlan = async (id, plan, adminId, billingCycle = 'monthly') => {
    const normalizedPlan = plan?.toLowerCase();
    if (!VALID_PLANS.includes(normalizedPlan)) {
        throw createError(400, `Gói cước không hợp lệ. Chỉ chấp nhận: ${VALID_PLANS.join(', ')}`);
    }

    return withTransaction(async (t) => {
        const txOpt = t ? { transaction: t } : {};
        const landlord = await User.findByPk(id, {
            include: [{ model: Role, as: 'roleData' }],
            ...(t ? { lock: t.LOCK?.UPDATE || true, transaction: t } : {}),
        });
        if (!landlord || landlord.roleData?.name !== 'landlord') {
            throw createError(404, 'Không tìm thấy tài khoản chủ nhà');
        }

        const oldPlan = landlord.plan;
        const oldExpiresAt = landlord.planExpiresAt;
        if (normalizedPlan === 'free' && oldPlan === 'free') {
            throw createError(400, 'Chủ nhà đã ở gói này');
        }

        // Hủy mọi yêu cầu nâng cấp đang pending của chủ nhà này
        let cancelledCount = 0;
        if (PlanUpgradeRequest && typeof PlanUpgradeRequest.update === 'function') {
            try {
                const [cnt] = await PlanUpgradeRequest.update(
                    { status: 'cancelled' },
                    { where: { landlordId: landlord.id, status: 'pending' }, ...txOpt }
                );
                cancelledCount = cnt || 0;
            } catch {
                cancelledCount = 0;
            }
        }

        const cycle = billingCycle === 'annual' ? 'annual' : 'monthly';
        if (normalizedPlan === 'free') {
            landlord.plan = 'free';
            landlord.planExpiresAt = null;
            landlord.billingCycle = null;
            landlord.planSource = null;
        } else {
            let oldPrice = 0;
            let newPrice = 0;
            if (oldPlan !== normalizedPlan && oldPlan !== 'free' && typeof Plan.findAll === 'function') {
                try {
                    const allPlans = await Plan.findAll(txOpt);
                    if (Array.isArray(allPlans)) {
                        oldPrice = parseFloat(allPlans.find((p) => p.name === oldPlan)?.price) || 0;
                        newPrice = parseFloat(allPlans.find((p) => p.name === normalizedPlan)?.price) || 0;
                    }
                } catch {
                    oldPrice = 0;
                    newPrice = 0;
                }
            }

            landlord.plan = normalizedPlan;
            landlord.planExpiresAt = computeConvertedPlanExpiry({
                oldPlan,
                oldExpiresAt,
                newPlan: normalizedPlan,
                daysToAdd: cycleDays(cycle),
                oldPrice,
                newPrice,
            });
            landlord.billingCycle = cycle;
            landlord.planSource = 'admin';
        }

        await landlord.save(txOpt);

        const cancelNote = cancelledCount > 0 ? ` (Đã hủy ${cancelledCount} yêu cầu nâng cấp đang chờ)` : '';
        await AdminLog.create({
            adminId,
            action: 'UPDATE_PLAN',
            targetUserId: landlord.id,
            description: `Admin thay đổi gói cước của chủ nhà ${landlord.name || landlord.email} (${landlord.email}) từ gói ${oldPlan.toUpperCase()} sang ${normalizedPlan.toUpperCase()}. Hạn mới: ${landlord.planExpiresAt || 'không thời hạn'}${cancelNote}`,
        }, txOpt);

        return {
            message: `Đã cập nhật gói cước của chủ nhà ${landlord.name || landlord.email} thành ${normalizedPlan.toUpperCase()}`,
            landlord: {
                id: landlord.id,
                email: landlord.email,
                plan: landlord.plan.toUpperCase(),
                planExpiresAt: landlord.planExpiresAt,
                billingCycle: landlord.billingCycle,
                planSource: landlord.planSource,
            },
        };
    });
};

/**
 * Khóa hoặc mở khóa tài khoản chủ nhà (A2, A7, T1.15).
 * Khóa bắt buộc có lý do (>= 5 ký tự) và thu hồi phiên (tăng tokenVersion, xóa telegramLinkToken).
 */
exports.updateLandlordStatus = async (id, status, adminId, { reason, resetPassword = false } = {}) => {
    const normalizedStatus = status?.toLowerCase();
    if (!VALID_STATUSES.includes(normalizedStatus)) {
        throw createError(400, `Trạng thái không hợp lệ. Chỉ chấp nhận: ${VALID_STATUSES.join(', ')}`);
    }

    const landlord = await User.findByPk(id, { include: [{ model: Role, as: 'roleData' }] });
    if (!landlord || landlord.roleData.name !== 'landlord') {
        throw createError(404, 'Không tìm thấy tài khoản chủ nhà');
    }

    const isLock = normalizedStatus === 'locked';
    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    if (isLock && trimmedReason.length < 5) {
        throw createError(400, 'Vui lòng nhập lý do khóa (tối thiểu 5 ký tự)');
    }

    let passwordSent = false;
    if (!isLock && resetPassword === true) {
        const generatedPassword = generateRandomPassword();
        const ok = await emailService.sendNewPasswordEmail(landlord.email, landlord.name, generatedPassword);
        if (!ok) throw createError(502, 'Gửi email thất bại, chưa mở khóa/đổi mật khẩu. Kiểm tra cấu hình email.');
        const salt = await bcrypt.genSalt(BCRYPT_SALT_ROUNDS);
        landlord.password = await bcrypt.hash(generatedPassword, salt);
        landlord.tokenVersion = (landlord.tokenVersion || 0) + 1;
        landlord.telegramLinkToken = null;
        landlord.telegramLinkTokenExpiresAt = null;
        passwordSent = true;
    }

    if (isLock) {
        landlord.tokenVersion = (landlord.tokenVersion || 0) + 1;
        landlord.telegramLinkToken = null;
        landlord.telegramLinkTokenExpiresAt = null;
    }

    const oldStatus = landlord.status;
    landlord.status = normalizedStatus;
    landlord.lockReason = isLock ? trimmedReason : null;
    await landlord.save();

    const action = isLock ? 'LOCK_USER' : 'UNLOCK_USER';
    const actionText = isLock ? 'khóa tài khoản' : 'mở khóa tài khoản';
    const logSuffix = isLock ? `. Lý do: ${trimmedReason}` : (passwordSent ? ' (Đã gửi mật khẩu mới qua email)' : '');

    await AdminLog.create({
        adminId,
        action,
        targetUserId: landlord.id,
        description: `Admin đã ${actionText} của chủ nhà: ${landlord.name || landlord.email} (${landlord.email})${logSuffix}`,
    });

    if (oldStatus !== normalizedStatus) {
        await notifyTenantsOfLandlord(landlord.id, ...(isLock
            ? ['Chủ nhà tạm ngưng hoạt động', 'Chủ nhà tạm ngưng hoạt động trên hệ thống. Hợp đồng và hóa đơn của bạn vẫn giữ nguyên, bạn vẫn thanh toán được. Liên hệ trực tiếp chủ nhà nếu cần.']
            : ['Chủ nhà đã hoạt động trở lại', 'Chủ nhà của bạn đã hoạt động trở lại trên hệ thống.']));
    }

    const msgSuffix = passwordSent ? '. Mật khẩu mới đã được gửi tới email của họ.' : '';
    return {
        message: `Đã cập nhật trạng thái của chủ nhà thành ${normalizedStatus.toUpperCase()}${msgSuffix}`,
        landlord: { id: landlord.id, email: landlord.email, status: normalizedStatus.toUpperCase() },
    };
};

// ─── Plans ──────────────────────────────────────────────────────────────────────

/**
 * Lấy danh sách tất cả các gói dịch vụ.
 */
exports.getPlans = async () => {
    return Plan.findAll({ order: [['id', 'ASC']] });
};

/**
 * Cập nhật cấu hình giới hạn của một gói dịch vụ.
 */
exports.updatePlan = async (planId, updates, adminId) => {
    const plan = await Plan.findByPk(planId);
    if (!plan) throw createError(404, 'Không tìm thấy gói cước để cập nhật');

    const MIN_VALUES = { price: 0, annualPrice: 0, maxBuildings: 1, maxRoomsPerBuilding: 1, maxAICallsPerMonth: -1 };
    const next = {};
    for (const [field, min] of Object.entries(MIN_VALUES)) {
        if (updates[field] === undefined) continue;
        const value = Number(updates[field]);
        if (updates[field] === null || updates[field] === '' || !Number.isInteger(value) || value < min) {
            throw createError(400, `Giá trị ${field} không hợp lệ (số nguyên >= ${min})`);
        }
        next[field] = value;
    }

    const isFree = plan.name === 'free';
    if (isFree && (next.price > 0 || next.annualPrice > 0)) {
        throw createError(400, 'Gói Free phải có giá 0');
    }
    const mergedPrice = next.price ?? Number(plan.price);
    const mergedAnnual = next.annualPrice ?? Number(plan.annualPrice);
    if (!isFree && (mergedPrice === 0 || mergedAnnual === 0)) {
        throw createError(400, 'Gói trả phí phải có giá lớn hơn 0');
    }

    const changes = Object.entries(next)
        .filter(([field, value]) => Number(plan[field]) !== value)
        .map(([field, value]) => {
            const old = Number(plan[field]);
            plan[field] = value;
            return `${field} ${old}→${value}`;
        });
    if (changes.length === 0) return plan;

    await plan.save();
    await AdminLog.create({
        adminId,
        action: 'UPDATE_PLAN_CONFIG',
        targetUserId: null,
        description: `Admin cập nhật gói ${plan.name.toUpperCase()}: ${changes.join(', ')}`,
    });
    return plan;
};

// ─── Admin Logs & SePay Reconciliation ──────────────────────────────────────────

/**
 * Lấy nhật ký hoạt động của Admin có phân trang và lọc, sắp xếp từ mới nhất.
 */
exports.getAdminLogs = async ({ page, pageSize, action, from, to, q } = {}) => {
    const p = Math.max(1, parseInt(page, 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));

    const parseDay = (s, time) => {
        const d = new Date(`${s}T${time}`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s)) || isNaN(d)) throw createError(400, `Ngày không hợp lệ: ${s}`);
        return d;
    };
    const where = {};
    if (action) where.action = String(action);
    if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt[Op.gte] = parseDay(from, '00:00:00');
        if (to) where.createdAt[Op.lte] = parseDay(to, '23:59:59');
    }
    if (q) where.description = { [Op.like]: `%${String(q)}%` };

    const { rows, count } = await AdminLog.findAndCountAll({
        where,
        order: [['createdAt', 'DESC']],
        include: [
            { model: User, as: 'admin', attributes: ['id', 'name', 'email'] },
            { model: User, as: 'targetUser', attributes: ['id', 'name', 'email'] },
        ],
        limit: size,
        offset: (p - 1) * size,
        distinct: true,
    });
    return { items: rows, total: count, page: p, pageSize: size };
};

/**
 * Lấy danh sách sự kiện webhook SePay để đối soát giao dịch lỗi / từ chối / dư tiền (T1.3).
 */
exports.getSePayEvents = async ({ page, pageSize, status, resultType, q } = {}) => {
    const p = Math.max(1, parseInt(page, 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));

    const where = {};
    if (status) where.status = String(status);
    if (resultType) where.resultType = String(resultType);
    if (q) {
        where[Op.or] = [
            { content: { [Op.like]: `%${String(q)}%` } },
            { eventKey: { [Op.like]: `%${String(q)}%` } },
            { errorReason: { [Op.like]: `%${String(q)}%` } },
        ];
    }

    const { rows, count } = await SePayEvent.findAndCountAll({
        where,
        order: [['createdAt', 'DESC']],
        limit: size,
        offset: (p - 1) * size,
    });

    return { items: rows, total: count, page: p, pageSize: size };
};

/**
 * Lấy danh sách các yêu cầu nâng cấp gói cước của chủ nhà (T2.12).
 */
exports.getUpgradeRequests = async ({ page, pageSize, status } = {}) => {
    const p = Math.max(1, parseInt(page, 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));
    const where = {};
    if (status) where.status = String(status);

    const { rows, count } = await PlanUpgradeRequest.findAndCountAll({
        where,
        order: [['createdAt', 'DESC']],
        limit: size,
        offset: (p - 1) * size,
    });

    return { items: rows, total: count, page: p, pageSize: size };
};

// ─── Tickets ────────────────────────────────────────────────────────────────────

/**
 * Tạo ticket khiếu nại mở khóa tài khoản từ chủ nhà bị khóa.
 */
exports.createLandlordTicket = async (email, title, message) => {
    if (!email || !title || !message) {
        throw createError(400, 'Vui lòng cung cấp đầy đủ: Email, Tiêu đề và Nội dung khiếu nại');
    }
    email = validateEmail(email);

    const landlord = await User.findOne({
        where: { email },
        include: [{ model: Role, as: 'roleData' }],
    });

    const result = { message: APPEAL_GENERIC_MESSAGE };
    if (!landlord || landlord.roleData?.name !== 'landlord' || landlord.status !== 'locked') return result;

    const pending = await LandlordTicket.findOne({ where: { landlordId: landlord.id, status: 'pending' } });
    if (pending) return result;

    await LandlordTicket.create({
        landlordId: landlord.id,
        email,
        title,
        message,
        status: 'pending',
    });
    return result;
};

/**
 * Lấy danh sách tất cả ticket khiếu nại kèm thông tin chủ nhà.
 */
exports.getLandlordTickets = async () => {
    return LandlordTicket.findAll({
        order: [['createdAt', 'DESC']],
        include: [{ model: User, as: 'landlord', attributes: ['id', 'name', 'email', 'phone'] }],
    });
};

/**
 * Xử lý quyết định cho ticket khiếu nại (duyệt hoặc từ chối).
 */
exports.resolveLandlordTicket = async (ticketId, status, adminId, { reason } = {}) => {
    if (!VALID_TICKET_RESOLUTIONS.includes(status)) {
        throw createError(400, `Trạng thái giải quyết không hợp lệ. Chỉ chấp nhận: ${VALID_TICKET_RESOLUTIONS.join(', ')}`);
    }
    const rejectReason = typeof reason === 'string' ? reason.trim() : '';
    if (status === 'rejected' && rejectReason.length < 5) {
        throw createError(400, 'Vui lòng nhập lý do từ chối (tối thiểu 5 ký tự)');
    }

    const ticket = await LandlordTicket.findByPk(ticketId);
    if (!ticket) throw createError(404, 'Không tìm thấy ticket khiếu nại');
    if (ticket.status !== 'pending') throw createError(400, 'Ticket khiếu nại này đã được xử lý từ trước');

    const data = status === 'rejected' ? { status, rejectReason } : { status };
    const [claimed] = await LandlordTicket.update(data, { where: { id: ticket.id, status: 'pending' } });
    if (!claimed) throw createError(400, 'Ticket khiếu nại này đã được xử lý từ trước');
    Object.assign(ticket, data);

    let emailFailed = false;
    if (status === 'resolved') {
        const landlord = await User.findByPk(ticket.landlordId);
        if (landlord && landlord.status !== 'active') {
            try {
                await exports.updateLandlordStatus(landlord.id, 'active', adminId, { resetPassword: true });
            } catch (err) {
                await LandlordTicket.update({ status: 'pending' }, { where: { id: ticket.id, status: 'resolved' } });
                ticket.status = 'pending';
                throw err;
            }
        }
    } else {
        await AdminLog.create({
            adminId,
            action: 'TICKET_REJECTED',
            targetUserId: ticket.landlordId,
            description: `Admin từ chối duyệt ticket khiếu nại (ID: ${ticket.id}) của chủ nhà email: ${ticket.email}. Lý do: ${rejectReason}`,
        });
        emailFailed = !(await emailService.sendTicketRejectedEmail(ticket.email, rejectReason));
    }

    return {
        message: `Đã cập nhật trạng thái khiếu nại thành ${status.toUpperCase()}`
            + (emailFailed ? ' (gửi email thông báo cho chủ nhà thất bại)' : ''),
        ticket,
    };
};
