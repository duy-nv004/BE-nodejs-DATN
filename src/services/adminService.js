const User = require('../models/User');
const Role = require('../models/Role');
const Building = require('../models/Building');
const Room = require('../models/Room');
const Invoice = require('../models/Invoice');
const Plan = require('../models/Plan');
const AdminLog = require('../models/AdminLog');
const LandlordTicket = require('../models/LandlordTicket');
const bcrypt = require('bcryptjs');
const emailService = require('./emailService');
const { createError } = require('../utils/errors');

// ─── Constants ─────────────────────────────────────────────────────────────────
const VALID_PLANS = ['free', 'basic', 'pro'];
const VALID_STATUSES = ['active', 'locked'];
const VALID_TICKET_RESOLUTIONS = ['resolved', 'rejected'];
const BCRYPT_SALT_ROUNDS = 10;
const PASSWORD_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// ─── Private Helpers ────────────────────────────────────────────────────────────

/**
 * Sinh mật khẩu ngẫu nhiên gồm các ký tự chữ hoa/thường và chữ số.
 * @param {number} length - Độ dài mật khẩu (mặc định: 8)
 * @returns {string}
 */
const generateRandomPassword = (length = 8) => {
    let password = '';
    for (let i = 0; i < length; i++) {
        password += PASSWORD_CHARS.charAt(Math.floor(Math.random() * PASSWORD_CHARS.length));
    }
    return password;
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
 * Lấy thống kê tổng quan hệ thống cho Admin Dashboard.
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

    // Tính MRR (Monthly Recurring Revenue) từ gói cước chủ nhà đăng ký
    const planPrices = {};
    plans.forEach(p => { planPrices[p.name] = parseFloat(p.price) || 0; });
    const totalRevenue = (freeCount * (planPrices['free'] || 0))
        + (basicCount * (planPrices['basic'] || 0))
        + (proCount * (planPrices['pro'] || 0));

    return {
        stats: {
            totalRevenue: parseFloat(totalRevenue),
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
 * Lấy danh sách toàn bộ chủ nhà cùng thống kê tòa nhà và phòng.
 */
exports.getLandlordsList = async () => {
    const landlordRole = await getLandlordRole();

    const landlords = await User.findAll({
        where: { roleId: landlordRole.id },
        attributes: ['id', 'name', 'email', 'phone', 'plan', 'status', 'createdAt'],
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
            portfolio: `${buildings.length} Tòa nhà / ${totalRooms} Phòng`,
            date: new Date(l.createdAt).toLocaleDateString('vi-VN'),
            status: l.status ? l.status.toUpperCase() : 'ACTIVE',
        };
    });
};

/**
 * Cập nhật gói cước của một chủ nhà và ghi log.
 * @param {number} id - ID của chủ nhà
 * @param {string} plan - Gói cước mới ('free' | 'basic' | 'pro')
 * @param {number} adminId - ID admin thực hiện thao tác
 */
exports.updateLandlordPlan = async (id, plan, adminId) => {
    const normalizedPlan = plan?.toLowerCase();
    if (!VALID_PLANS.includes(normalizedPlan)) {
        throw createError(400, `Gói cước không hợp lệ. Chỉ chấp nhận: ${VALID_PLANS.join(', ')}`);
    }

    const landlord = await User.findByPk(id, { include: [{ model: Role, as: 'roleData' }] });
    if (!landlord || landlord.roleData.name !== 'landlord') {
        throw createError(404, 'Không tìm thấy tài khoản chủ nhà');
    }

    const oldPlan = landlord.plan;
    landlord.plan = normalizedPlan;

    if (normalizedPlan !== 'free') {
        const now = new Date();
        let baseDate = now;
        if (landlord.planExpiresAt && new Date(landlord.planExpiresAt) > now) {
            baseDate = new Date(landlord.planExpiresAt);
        }
        baseDate.setDate(baseDate.getDate() + 30);
        landlord.planExpiresAt = baseDate.toISOString().split('T')[0];
    } else {
        landlord.planExpiresAt = null;
    }

    await landlord.save();

    await AdminLog.create({
        adminId,
        action: 'UPDATE_PLAN',
        targetUserId: landlord.id,
        description: `Admin thay đổi gói cước của chủ nhà ${landlord.name || landlord.email} (${landlord.email}) từ gói ${oldPlan.toUpperCase()} sang ${normalizedPlan.toUpperCase()}`,
    });

    return {
        message: `Đã cập nhật gói cước của chủ nhà ${landlord.name || landlord.email} thành ${normalizedPlan.toUpperCase()}`,
        landlord: { id: landlord.id, email: landlord.email, plan: landlord.plan.toUpperCase() },
    };
};

/**
 * Khóa hoặc mở khóa tài khoản chủ nhà.
 * Khi mở khóa (locked → active), hệ thống sẽ tự động sinh và gửi mật khẩu mới qua email.
 * @param {number} id - ID của chủ nhà
 * @param {string} status - Trạng thái mới ('active' | 'locked')
 * @param {number} adminId - ID admin thực hiện thao tác
 */
exports.updateLandlordStatus = async (id, status, adminId) => {
    const normalizedStatus = status?.toLowerCase();
    if (!VALID_STATUSES.includes(normalizedStatus)) {
        throw createError(400, `Trạng thái không hợp lệ. Chỉ chấp nhận: ${VALID_STATUSES.join(', ')}`);
    }

    const landlord = await User.findByPk(id, { include: [{ model: Role, as: 'roleData' }] });
    if (!landlord || landlord.roleData.name !== 'landlord') {
        throw createError(404, 'Không tìm thấy tài khoản chủ nhà');
    }

    const oldStatus = landlord.status;
    landlord.status = normalizedStatus;

    // Khi mở khóa tài khoản: sinh mật khẩu mới và mã hóa
    let generatedPassword = null;
    if (oldStatus === 'locked' && normalizedStatus === 'active') {
        generatedPassword = generateRandomPassword(8);
        const salt = await bcrypt.genSalt(BCRYPT_SALT_ROUNDS);
        landlord.password = await bcrypt.hash(generatedPassword, salt);
    }

    await landlord.save();

    const action = normalizedStatus === 'locked' ? 'LOCK_USER' : 'UNLOCK_USER';
    const actionText = normalizedStatus === 'locked' ? 'khóa tài khoản' : 'mở khóa tài khoản';
    const logSuffix = generatedPassword ? ' (Đã gửi mật khẩu mới qua email)' : '';

    await AdminLog.create({
        adminId,
        action,
        targetUserId: landlord.id,
        description: `Admin đã ${actionText} của chủ nhà: ${landlord.name || landlord.email} (${landlord.email})${logSuffix}`,
    });

    // Gửi email bất đồng bộ — không chờ kết quả
    if (generatedPassword) {
        emailService.sendNewPasswordEmail(landlord.email, landlord.name, generatedPassword);
    }

    const msgSuffix = generatedPassword ? '. Mật khẩu mới đã được gửi tới email của họ.' : '';
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
 * @param {number} planId
 * @param {object} updates - Các trường cần cập nhật
 */
exports.updatePlan = async (planId, updates) => {
    const plan = await Plan.findByPk(planId);
    if (!plan) throw createError(404, 'Không tìm thấy gói cước để cập nhật');

    const { price, annualPrice, maxBuildings, maxRoomsPerBuilding, maxAICallsPerMonth } = updates;
    if (price !== undefined) plan.price = price;
    if (annualPrice !== undefined) plan.annualPrice = annualPrice;
    if (maxBuildings !== undefined) plan.maxBuildings = maxBuildings;
    if (maxRoomsPerBuilding !== undefined) plan.maxRoomsPerBuilding = maxRoomsPerBuilding;
    if (maxAICallsPerMonth !== undefined) plan.maxAICallsPerMonth = maxAICallsPerMonth;

    await plan.save();
    return plan;
};

// ─── Admin Logs ─────────────────────────────────────────────────────────────────

/**
 * Lấy toàn bộ nhật ký hoạt động của Admin, sắp xếp từ mới nhất.
 */
exports.getAdminLogs = async () => {
    return AdminLog.findAll({
        order: [['createdAt', 'DESC']],
        include: [
            { model: User, as: 'admin', attributes: ['id', 'name', 'email'] },
            { model: User, as: 'targetUser', attributes: ['id', 'name', 'email'] },
        ],
    });
};

// ─── Tickets ────────────────────────────────────────────────────────────────────

/**
 * Tạo ticket khiếu nại mở khóa tài khoản từ chủ nhà bị khóa.
 * @param {string} email - Email tài khoản bị khóa
 * @param {string} title - Tiêu đề khiếu nại
 * @param {string} message - Nội dung chi tiết
 */
exports.createLandlordTicket = async (email, title, message) => {
    if (!email || !title || !message) {
        throw createError(400, 'Vui lòng cung cấp đầy đủ: Email, Tiêu đề và Nội dung khiếu nại');
    }

    const landlord = await User.findOne({
        where: { email },
        include: [{ model: Role, as: 'roleData' }],
    });

    if (!landlord || landlord.roleData.name !== 'landlord') {
        throw createError(404, 'Không tìm thấy tài khoản chủ nhà tương ứng với email này');
    }

    if (landlord.status !== 'locked') {
        throw createError(400, 'Tài khoản của bạn đang hoạt động bình thường, không cần gửi khiếu nại.');
    }

    return LandlordTicket.create({
        landlordId: landlord.id,
        email,
        title,
        message,
        status: 'pending',
    });
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
 * Nếu duyệt (resolved): tự động mở khóa tài khoản và gửi mật khẩu mới qua email.
 * @param {number} ticketId
 * @param {string} status - 'resolved' | 'rejected'
 * @param {number} adminId
 */
exports.resolveLandlordTicket = async (ticketId, status, adminId) => {
    if (!VALID_TICKET_RESOLUTIONS.includes(status)) {
        throw createError(400, `Trạng thái giải quyết không hợp lệ. Chỉ chấp nhận: ${VALID_TICKET_RESOLUTIONS.join(', ')}`);
    }

    const ticket = await LandlordTicket.findByPk(ticketId);
    if (!ticket) throw createError(404, 'Không tìm thấy ticket khiếu nại');
    if (ticket.status !== 'pending') throw createError(400, 'Ticket khiếu nại này đã được xử lý từ trước');

    ticket.status = status;
    await ticket.save();

    if (status === 'resolved') {
        const landlord = await User.findByPk(ticket.landlordId);
        if (landlord) {
            // Tái sử dụng updateLandlordStatus để mở khóa + gửi email mật khẩu mới + ghi log
            await exports.updateLandlordStatus(landlord.id, 'active', adminId);
        }
    } else {
        await AdminLog.create({
            adminId,
            action: 'LOCK_USER',
            targetUserId: ticket.landlordId,
            description: `Admin từ chối duyệt ticket khiếu nại (ID: ${ticket.id}) của chủ nhà email: ${ticket.email}`,
        });
    }

    return {
        message: `Đã cập nhật trạng thái khiếu nại thành ${status.toUpperCase()}`,
        ticket,
    };
};
