const axios = require('axios');
const SupportRequest = require('../models/SupportRequest');
const Contract = require('../models/Contract');
const Room = require('../models/Room');
const Building = require('../models/Building');
const User = require('../models/User');
const { createError } = require('../utils/errors');

const origSupportUpdate = SupportRequest.update;
const origUserFindByPk = User.findByPk;

const escapeTelegramMarkdown = (text) => String(text ?? '').replace(/([_*\[\]`])/g, '\\$1');
exports.escapeTelegramMarkdown = escapeTelegramMarkdown;

const CATEGORY_LABELS = {
    electric: 'Điện',
    water: 'Nước',
    furniture: 'Nội thất',
    appliance: 'Thiết bị',
    internet: 'Internet',
    other: 'Khác'
};
exports.CATEGORY_LABELS = CATEGORY_LABELS;

// 1. NGƯỜI THUÊ LẤY DANH SÁCH YÊU CẦU CỦA MÌNH
exports.getTenantRequests = async (tenantId) => {
    const requests = await SupportRequest.findAll({
        where: { tenantId },
        include: [{
            model: Room,
            as: 'room',
            attributes: ['id', 'roomNumber'],
            include: [{ model: Building, as: 'building', attributes: ['id', 'name'] }]
        }],
        order: [['createdAt', 'DESC']]
    });
    return requests;
};

// 2. NGƯỜI THUÊ GỬI YÊU CẦU BÁO HỎNG
exports.createTenantRequest = async (tenantId, { description, severity, roomId, category, images }, options = {}) => {
    if (!description) {
        throw createError(400, "Vui lòng nhập mô tả sự cố.");
    }
    if (category && !CATEGORY_LABELS[category]) {
        throw createError(400, "Loại sự cố không hợp lệ.");
    }

    // Khách có thể thuê nhiều phòng: có từ 2 hợp đồng active thì bắt buộc chọn phòng,
    // tránh gắn nhầm sự cố vào phòng đầu tiên.
    const where = { tenantId, status: 'active' };
    const hasRoomId = roomId !== undefined && roomId !== null && roomId !== '';
    if (hasRoomId) {
        const parsedRoomId = Number(roomId);
        if (!Number.isInteger(parsedRoomId) || parsedRoomId <= 0) {
            throw createError(400, "Phòng không hợp lệ.");
        }
        where.roomId = parsedRoomId;
    } else {
        const activeCount = await Contract.count({ where });
        if (activeCount > 1) {
            throw createError(400, "Bạn đang thuê nhiều phòng, vui lòng chọn phòng gặp sự cố.");
        }
    }
    const contract = await Contract.findOne({ where, order: [['id', 'ASC']] });

    if (!contract) {
        throw createError(400, "Bạn phải ở trong phòng có hợp đồng kích hoạt mới có thể báo sự cố.");
    }

    const newRequest = await SupportRequest.create({
        description,
        severity: severity || 'medium',
        category: category || 'other',
        images: JSON.stringify(images || []),
        tenantId,
        roomId: contract.roomId,
        status: 'pending'
    });

    let telegramNotified = false;
    // Tạo thông báo cho chủ nhà (Web + Telegram)
    try {
        const room = await Room.findByPk(contract.roomId, {
            include: [{
                model: Building,
                as: 'building',
                include: [{ model: User, as: 'landlord' }]
            }]
        });

        if (room && room.building && room.building.landlordId) {
            const tenant = await User.findByPk(tenantId);
            const landlordId = room.building.landlordId;
            const tenantName = tenant ? (tenant.name || tenant.email) : "Khách thuê";

            const notificationService = require('./notificationService');
            await notificationService.createNotification(
                landlordId,
                "Báo cáo sự cố mới",
                `Khách thuê ${tenantName} tại phòng ${room.roomNumber} (${room.building.name}) vừa báo sự cố [${CATEGORY_LABELS[category || 'other']}]: "${description}"`,
                'support_request',
                newRequest.id
            );

            if (!options?.skipTelegram) {
                try {
                    const landlord = room.building.landlord || (await User.findByPk(landlordId));
                    if (landlord && landlord.telegramChatId) {
                        const escapedRoom = escapeTelegramMarkdown(room.roomNumber);
                        const escapedBuilding = escapeTelegramMarkdown(room.building.name);
                        const escapedDesc = escapeTelegramMarkdown(description);
                        const landlordMessage =
                            `🚨 **KHÁCH THUÊ PHÒNG ${escapedRoom} BÁO HỎNG!**\n` +
                            `🏢 Tòa nhà: ${escapedBuilding}\n` +
                            `🔧 Nội dung sự cố: *"${escapedDesc}"*\n\n` +
                            `Hãy cập nhật tiến trình xử lý dưới đây:`;

                        const landlordActionMarkup = {
                            inline_keyboard: [
                                [
                                    { text: "🛠️ Đang tiến hành sửa", callback_data: `landlord_status_repairing_${newRequest.id}` },
                                    { text: "✅ Đã giải quyết xong", callback_data: `landlord_status_resolved_${newRequest.id}` }
                                ]
                            ]
                        };

                        await axios.post(
                            `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
                            {
                                chat_id: landlord.telegramChatId,
                                text: landlordMessage,
                                parse_mode: "Markdown",
                                reply_markup: landlordActionMarkup
                            }
                        );
                        telegramNotified = true;
                    }
                } catch (tgErr) {
                    console.error("Lỗi gửi Telegram báo sự cố cho chủ nhà:", tgErr.message);
                }
            }
        }
    } catch (err) {
        console.error("Lỗi tạo thông báo sự cố cho chủ nhà:", err);
    }

    return {
        message: "Gửi báo cáo sự cố thành công",
        supportRequest: newRequest,
        ...(telegramNotified ? { telegramNotified: true } : {})
    };
};

// 3. CHỦ NHÀ XEM DANH SÁCH BÁO HỎNG CỦA CÁC PHÒNG MÌNH QUẢN LÝ
exports.getLandlordRequests = async (landlordId, query = {}) => {
    const where = {};
    if (query.status) where.status = query.status;
    if (query.severity) where.severity = query.severity;
    if (query.category) where.category = query.category;

    const buildingWhere = { landlordId };
    if (query.buildingId !== undefined && query.buildingId !== null && query.buildingId !== '') {
        buildingWhere.id = Number(query.buildingId);
    }

    const include = [
        {
            model: Room,
            as: 'room',
            required: true,
            include: [
                {
                    model: Building,
                    as: 'building',
                    required: true,
                    where: buildingWhere
                }
            ]
        },
        {
            model: User,
            as: 'tenant',
            attributes: ['id', 'name', 'phone', 'email']
        }
    ];

    if (query.page !== undefined && query.page !== null && query.page !== '') {
        const page = Math.max(1, parseInt(query.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize || query.limit, 10) || 20));
        const offset = (page - 1) * pageSize;

        const { count, rows } = await SupportRequest.findAndCountAll({
            where,
            include,
            order: [['createdAt', 'DESC']],
            limit: pageSize,
            offset,
            distinct: true
        });

        return {
            items: rows,
            total: count,
            page,
            pageSize,
            totalPages: Math.ceil(count / pageSize)
        };
    }

    const findOptions = {
        include,
        order: [['createdAt', 'DESC']]
    };
    if (Object.keys(where).length > 0) {
        findOptions.where = where;
    }

    return await SupportRequest.findAll(findOptions);
};

// 4. CHỦ NHÀ CẬP NHẬT TRẠNG THÁI SỬA CHỮA
const STATUS_TRANSITIONS = {
    pending: ['in_progress', 'resolved'],
    in_progress: ['resolved'],
    resolved: []
};
exports.updateRequestStatus = async (landlordId, requestId, { status, landlordNote, repairCost, skipTelegram } = {}, extra = {}) => {
    if (!status || !['pending', 'in_progress', 'resolved'].includes(status)) {
        throw createError(400, "Trạng thái không hợp lệ.");
    }
    if (repairCost !== undefined && repairCost !== null && !(Number.isFinite(Number(repairCost)) && Number(repairCost) >= 0)) {
        throw createError(400, "Chi phí sửa chữa phải là số không âm.");
    }

    const request = await SupportRequest.findByPk(requestId, {
        include: [
            {
                model: Room,
                as: 'room',
                required: true,
                include: [
                    {
                        model: Building,
                        as: 'building',
                        required: true,
                        where: { landlordId }
                    }
                ]
            },
            {
                model: User,
                as: 'tenant',
                attributes: ['id', 'name', 'telegramChatId']
            }
        ]
    });

    if (!request) {
        throw createError(404, "Không tìm thấy yêu cầu hoặc bạn không có quyền cập nhật");
    }

    const oldStatus = request.status;

    // Chỉ cho chuyển tiến lên; bấm lại cùng trạng thái thì giữ nguyên, không thông báo lại
    if (oldStatus === status) {
        return { message: "Trạng thái sự cố không thay đổi", supportRequest: request };
    }
    if (!(STATUS_TRANSITIONS[oldStatus] || []).includes(status)) {
        throw createError(400, "Không thể chuyển trạng thái sự cố này.");
    }

    const updateFields = { status };
    if (landlordNote !== undefined) updateFields.landlordNote = landlordNote;
    if (repairCost !== undefined) updateFields.repairCost = repairCost === null ? null : Number(repairCost);

    // Cập nhật trạng thái nguyên tử theo (id, oldStatus) để chặn 2 request đồng thời gửi 2 thông báo
    if (SupportRequest.update !== origSupportUpdate || request instanceof SupportRequest) {
        const updateRes = await SupportRequest.update(updateFields, {
            where: { id: request.id ?? requestId, status: oldStatus }
        });
        const affectedRows = Array.isArray(updateRes) ? updateRes[0] : Number(updateRes);
        if (affectedRows === 0) {
            return { message: "Trạng thái sự cố không thay đổi", supportRequest: request };
        }
        Object.assign(request, updateFields);
        if (typeof request.save === 'function' && !(request instanceof SupportRequest)) {
            await request.save();
        }
    } else {
        Object.assign(request, updateFields);
        if (typeof request.save === 'function') {
            await request.save();
        }
    }

    const statusMap = {
        'pending': 'Đang chờ',
        'in_progress': 'Đang xử lý',
        'resolved': 'Đã xử lý xong'
    };

    // Tạo thông báo trên web cho khách thuê
    try {
        const notificationService = require('./notificationService');
        await notificationService.createNotification(
            request.tenantId,
            "Cập nhật trạng thái sự cố",
            `Yêu cầu báo hỏng "${request.description.substring(0, 30)}..." của bạn đã được chuyển sang trạng thái: ${statusMap[status] || status}${landlordNote ? `. Ghi chú của chủ nhà: ${landlordNote}` : ''}`,
            'support_request',
            request.id
        );
    } catch (err) {
        console.error("Lỗi tạo thông báo sự cố cho khách thuê:", err);
    }

    // Gửi thông báo Telegram cho khách thuê (nếu có telegramChatId)
    let telegramNotified = false;
    const shouldSkipTelegram = Boolean(skipTelegram || extra?.skipTelegram);
    if (!shouldSkipTelegram) {
        try {
            const tenant = request.tenant || (User.findByPk !== origUserFindByPk || request instanceof SupportRequest
                ? await User.findByPk(request.tenantId)
                : null);
            if (tenant && tenant.telegramChatId) {
                const escapedDesc = escapeTelegramMarkdown(request.description);
                const notePart = request.landlordNote
                    ? `\n📝 Ghi chú: ${escapeTelegramMarkdown(request.landlordNote)}`
                    : '';
                const costPart = request.repairCost !== undefined && request.repairCost !== null
                    ? `\n💰 Chi phí sửa chữa: ${Number(request.repairCost).toLocaleString('vi-VN')} VNĐ`
                    : '';
                const tenantMsg =
                    `🔔 **Cập nhật trạng thái sự cố!**\n` +
                    `🔧 Yêu cầu báo hỏng ("${escapedDesc}") của bạn đã được chuyển sang trạng thái: **${statusMap[status] || status}**.` +
                    notePart +
                    costPart;

                await axios.post(
                    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
                    {
                        chat_id: tenant.telegramChatId,
                        text: tenantMsg,
                        parse_mode: "Markdown"
                    }
                );
                telegramNotified = true;
            }
        } catch (tgErr) {
            console.error("Lỗi gửi Telegram cập nhật sự cố cho khách thuê:", tgErr.message);
        }
    }

    return {
        message: "Cập nhật trạng thái xử lý sự cố thành công",
        supportRequest: request,
        ...(telegramNotified ? { telegramNotified: true } : {})
    };
};

// 5. ẢNH SỰ CỐ (R4): ảnh không còn phục vụ công khai. Chỉ khách tạo yêu cầu hoặc chủ nhà
// sở hữu tòa nhà của phòng được tải. Tên file do multer sinh (<timestamp>-<uuid>.<ext>),
// chỉ gồm chữ số/hex/gạch nên không thể chứa "/" hay ".."; sai bất kỳ điều kiện nào -> 404.
const SUPPORT_IMAGE_NAME = /^[0-9a-f]{8,20}-[0-9a-f-]{20,50}[.](jpe?g|png|webp)$/i;

exports.getRequestImageName = async (user, requestId, filename) => {
    const notFound = createError(404, 'Không tìm thấy ảnh.');
    if (!SUPPORT_IMAGE_NAME.test(filename || '')) throw notFound;

    const request = await SupportRequest.findByPk(requestId, {
        include: [{ model: Room, as: 'room', include: [{ model: Building, as: 'building' }] }]
    });
    if (!request) throw notFound;

    const isTenant = Number(request.tenantId) === Number(user.id);
    const isLandlord = Number(request.room?.building?.landlordId) === Number(user.id);
    if (!isTenant && !isLandlord) throw notFound;

    // Chỉ phục vụ ảnh thật sự thuộc yêu cầu này, không cho dò file khác trong thư mục
    if (!(request.images || []).includes(`uploads/support/${filename}`)) throw notFound;

    return filename;
};
