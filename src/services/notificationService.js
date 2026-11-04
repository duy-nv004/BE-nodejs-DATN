const Notification = require('../models/Notification');
const User = require('../models/User');
const Contract = require('../models/Contract');
const Room = require('../models/Room');
const Building = require('../models/Building');
const Role = require('../models/Role');
const { Op } = require('sequelize');
const Invoice = require('../models/Invoice');
const telegramService = require('../utils/telegramService');
const { computeDueDate } = require('./invoiceService');
const dayjs = require('dayjs');

// Cache thời điểm kiểm tra sinh thông báo định kỳ theo từng userId (tối đa 1 lần / ngày)
const lastCheckedByUser = new Map();
const CHECK_COOLDOWN_MS = 24 * 60 * 60 * 1000;
exports._resetCheckCache = () => lastCheckedByUser.clear();

exports.createNotification = async (userId, title, content, type = 'info', relatedId = null) => {
    return await Notification.create({
        userId,
        title,
        content,
        type,
        relatedId
    });
};

exports.getNotifications = async (userId, query = {}) => {
    // 1. Chỉ kiểm tra và sinh thông báo tối đa 1 lần mỗi ngày cho mỗi userId
    const now = Date.now();
    const lastChecked = lastCheckedByUser.get(userId);
    if (!lastChecked || (now - lastChecked) >= CHECK_COOLDOWN_MS) {
        lastCheckedByUser.set(userId, now);
        await this.checkAndGenerateNotifications(userId);
    }

    // 2. Lấy danh sách thông báo (hỗ trợ phân trang tùy chọn qua limit và before)
    const where = { userId };
    const hasPagination = query && (query.limit !== undefined || query.before !== undefined);

    if (query && query.before !== undefined && query.before !== null && query.before !== '') {
        const beforeVal = String(query.before).trim();
        if (/^\d+$/.test(beforeVal)) {
            where.id = { [Op.lt]: Number(beforeVal) };
        } else {
            const parsedDate = new Date(beforeVal);
            if (!Number.isNaN(parsedDate.getTime())) {
                where.createdAt = { [Op.lt]: parsedDate };
            }
        }
    }

    const findOptions = {
        where,
        order: [['createdAt', 'DESC']]
    };

    if (hasPagination) {
        const parsedLimit = parseInt(query.limit, 10);
        findOptions.limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 20;
    }

    return await Notification.findAll(findOptions);
};

exports.markAsRead = async (userId, notificationId) => {
    const notif = await Notification.findOne({
        where: { id: notificationId, userId }
    });
    if (notif) {
        notif.isRead = true;
        await notif.save();
    }
    return notif;
};

exports.markAllAsRead = async (userId) => {
    await Notification.update(
        { isRead: true },
        { where: { userId, isRead: false } }
    );
    return { message: "Đã đánh dấu đọc tất cả thông báo" };
};

exports.checkAndGenerateNotifications = async (userId) => {
    try {
        const user = await User.findByPk(userId);
        if (!user) return;

        const today = new Date();
        
        // ----------------------------------------------------
        // A. KIỂM TRA GÓI DỊCH VỤ SẮP HẾT HẠN (Dành cho chủ nhà)
        // ----------------------------------------------------
        if (user.plan && user.plan !== 'free' && user.planExpiresAt) {
            const expiryDate = new Date(user.planExpiresAt);
            const diffTime = expiryDate - today;
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            if (diffDays <= 7 && diffDays >= -2) { // Trước 7 ngày hoặc quá hạn tối đa 2 ngày
                const existingNotif = await Notification.findOne({
                    where: {
                        userId,
                        type: 'plan_expiry',
                        relatedId: user.id,
                        createdAt: {
                            [Op.gte]: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000) // Tránh tạo lại quá gần nhau
                        }
                    }
                });

                if (!existingNotif) {
                    await this.createNotification(
                        userId,
                        "Gói dịch vụ sắp hết hạn",
                        `Gói dịch vụ ${user.plan.toUpperCase()} của bạn sẽ hết hạn vào ngày ${user.planExpiresAt}. Vui lòng gia hạn để tiếp tục sử dụng đầy đủ tính năng.`,
                        'plan_expiry',
                        user.id
                    );
                }
            }
        }

        // ----------------------------------------------------
        // B. KIỂM TRA HỢP ĐỒNG SẮP HẾT HẠN (Chủ nhà hoặc Khách thuê)
        // ----------------------------------------------------
        // So sánh theo TÊN vai trò, không theo roleId cứng. Id 2/3 chỉ đúng khi
        // bảng Roles được seed đúng thứ tự ở index.js — đổi seed là logic vỡ âm thầm.
        const role = await Role.findByPk(user.roleId);
        const roleName = role ? role.name : null;

        let contracts = [];
        if (roleName === 'landlord') {
            contracts = await Contract.findAll({
                where: { status: 'active' },
                include: [
                    {
                        model: Room,
                        as: 'room',
                        required: true,
                        include: [{
                            model: Building,
                            as: 'building',
                            required: true,
                            where: { landlordId: userId }
                        }]
                    },
                    {
                        model: User,
                        as: 'tenant',
                        attributes: ['id', 'name']
                    }
                ]
            });
        } else if (roleName === 'tenant') {
            contracts = await Contract.findAll({
                where: { tenantId: userId, status: 'active' },
                include: [
                    {
                        model: Room,
                        as: 'room',
                        attributes: ['id', 'roomNumber']
                    }
                ]
            });
        }

        for (const contract of contracts) {
            const end = new Date(contract.endDate);
            const diffTime = end - today;
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            if (diffDays <= 30 && diffDays >= -5) { // Trong vòng 30 ngày trước khi hết hạn và tối đa 5 ngày quá hạn
                // Lấy thông báo hợp đồng hết hạn gần nhất
                const latestNotif = await Notification.findOne({
                    where: {
                        userId,
                        type: 'contract_expiry',
                        relatedId: contract.id
                    },
                    order: [['createdAt', 'DESC']]
                });

                let shouldNotify = false;
                if (!latestNotif) {
                    shouldNotify = true;
                } else {
                    const daysSinceLastNotif = (today - new Date(latestNotif.createdAt)) / (1000 * 60 * 60 * 24);
                    if (daysSinceLastNotif >= 5) { // Cứ cách 5 ngày lại gửi thêm thông báo mới
                        shouldNotify = true;
                    }
                }

                if (shouldNotify) {
                    let title = "Hợp đồng sắp hết hạn";
                    let content = "";
                    const suffix = diffDays < 0 
                        ? `đã quá hạn ${Math.abs(diffDays)} ngày (hết hạn ngày ${contract.endDate})` 
                        : `sẽ hết hạn sau ${diffDays} ngày nữa (ngày ${contract.endDate})`;

                    if (roleName === 'landlord') {
                        content = `Hợp đồng của khách thuê ${contract.tenant?.name || 'chưa rõ'} tại phòng ${contract.room?.roomNumber} ${suffix}. Vui lòng liên hệ khách thuê để gia hạn hoặc chuẩn bị bàn giao.`;
                    } else {
                        content = `Hợp đồng thuê phòng ${contract.room?.roomNumber} của bạn ${suffix}. Vui lòng liên hệ chủ nhà để thực hiện gia hạn hợp đồng.`;
                    }

                    await this.createNotification(
                        userId,
                        title,
                        content,
                        'contract_expiry',
                        contract.id
                    );
                }
            }
        }

        // ----------------------------------------------------
        // C. KIỂM TRA LIÊN KẾT TELEGRAM (Chủ nhà hoặc Khách thuê)
        // ----------------------------------------------------
        if (!user.telegramChatId) {
            // Xóa thông báo thành công (nếu có)
            await Notification.destroy({
                where: {
                    userId,
                    type: 'telegram_link_success'
                }
            });

            const existingNotif = await Notification.findOne({
                where: {
                    userId,
                    type: 'telegram_link'
                }
            });

            if (!existingNotif) {
                await this.createNotification(
                    userId,
                    "Chưa liên kết Telegram",
                    "Vui lòng kết nối tài khoản với Telegram Bot để nhận thông tin hóa đơn và báo cáo sự cố tự động nhanh chóng.",
                    'telegram_link',
                    user.id
                );
            }
        } else {
            // Xóa thông báo liên kết nếu đã liên kết thành công
            await Notification.destroy({
                where: {
                    userId,
                    type: 'telegram_link'
                }
            });

            // Tạo thông báo thành công nếu chưa có
            const existingSuccessNotif = await Notification.findOne({
                where: {
                    userId,
                    type: 'telegram_link_success'
                }
            });

            if (!existingSuccessNotif) {
                await this.createNotification(
                    userId,
                    "Kết nối Telegram thành công",
                    "Tài khoản của bạn đã được liên kết thành công với Telegram Bot. Bạn sẽ tự động nhận hóa đơn và thông báo cước.",
                    'telegram_link_success',
                    user.id
                );
            }
        }
    } catch (err) {
        console.error("Lỗi tự động sinh thông báo:", err);
    }
};

// NHẮC HÓA ĐƠN QUÁ HẠN (I4) — job toàn hệ thống, chạy từ index.js mỗi giờ.
// Trước đây chỉ sinh khi người dùng mở chuông thông báo và chỉ xét HĐ đầu tiên.
// Nhắc cả khách của hóa đơn (invoice.tenantId) lẫn chủ nhà; mỗi người tối đa 1 lần / 3 ngày.
exports.remindOverdueInvoices = async (now = new Date()) => {
    const todayStr = dayjs(now).format('YYYY-MM-DD');
    const invoices = await Invoice.findAll({
        where: {
            isPaid: false,
            // dueDate null: hóa đơn cũ không có contractId nên backfill không điền được
            [Op.or]: [{ dueDate: { [Op.lt]: todayStr } }, { dueDate: null }]
        },
        include: [{ model: Room, as: 'roomDetails', include: [{ model: Building, as: 'building' }] }]
    });

    let sent = 0;
    for (const inv of invoices) {
        const due = inv.dueDate || computeDueDate(inv.year, inv.month, null);
        if (!(due < todayStr)) continue;

        const roomNumber = inv.roomDetails?.roomNumber || 'N/A';
        const amount = Number(inv.totalAmount).toLocaleString('vi-VN');
        const recipients = [...new Set([inv.tenantId, inv.landlordId || inv.roomDetails?.building?.landlordId].filter(Boolean))];

        for (const userId of recipients) {
            const latestNotif = await Notification.findOne({
                where: { userId, type: 'invoice_overdue', relatedId: inv.id },
                order: [['createdAt', 'DESC']]
            });
            if (latestNotif && (now - new Date(latestNotif.createdAt)) / (1000 * 60 * 60 * 24) < 3) continue;

            await exports.createNotification(userId, "Hóa đơn quá hạn",
                `Hóa đơn tháng ${inv.month}/${inv.year} của phòng ${roomNumber} (${amount} VNĐ) chưa được thanh toán. `
                + `Vui lòng thanh toán sớm để tránh gián đoạn dịch vụ.`,
                'invoice_overdue', inv.id);
            sent++;

            try {
                const user = await User.findByPk(userId);
                if (user?.telegramChatId) {
                    await telegramService.sendTextToTelegram(user.telegramChatId, `🔔 **NHẮC THANH TOÁN QUÁ HẠN**

`
                        + `💰 Hóa đơn tháng ${inv.month}/${inv.year}: ${amount} VNĐ
`
                        + `🏠 Phòng: ${roomNumber}

`
                        + `Hãy đăng nhập hệ thống để thanh toán ngay.`);
                }
            } catch (err) {
                console.error("⚠️ Lỗi gửi Telegram nhắc quá hạn:", err.message);
            }
        }
    }
    return sent;
};
