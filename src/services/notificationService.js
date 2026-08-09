const Notification = require('../models/Notification');
const User = require('../models/User');
const Contract = require('../models/Contract');
const Room = require('../models/Room');
const Building = require('../models/Building');
const { Op } = require('sequelize');

exports.createNotification = async (userId, title, content, type = 'info', relatedId = null) => {
    return await Notification.create({
        userId,
        title,
        content,
        type,
        relatedId
    });
};

exports.getNotifications = async (userId) => {
    // 1. Tự động kiểm tra và sinh thông báo trước khi lấy danh sách
    await this.checkAndGenerateNotifications(userId);

    // 2. Lấy danh sách thông báo
    return await Notification.findAll({
        where: { userId },
        order: [['createdAt', 'DESC']]
    });
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
        let contracts = [];
        if (user.roleId === 2) { // Landlord
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
        } else if (user.roleId === 3) { // Tenant
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

                    if (user.roleId === 2) {
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
