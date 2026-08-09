const SupportRequest = require('../models/SupportRequest');
const Contract = require('../models/Contract');
const Room = require('../models/Room');
const Building = require('../models/Building');
const User = require('../models/User');
const { createError } = require('../utils/errors');

// 1. NGƯỜI THUÊ LẤY DANH SÁCH YÊU CẦU CỦA MÌNH
exports.getTenantRequests = async (tenantId) => {
    const requests = await SupportRequest.findAll({
        where: { tenantId },
        order: [['createdAt', 'DESC']]
    });
    return requests;
};

// 2. NGƯỜI THUÊ GỬI YÊU CẦU BÁO HỎNG
exports.createTenantRequest = async (tenantId, { description, severity }) => {
    if (!description) {
        throw createError(400, "Vui lòng nhập mô tả sự cố.");
    }

    const contract = await Contract.findOne({
        where: { tenantId, status: 'active' }
    });

    if (!contract) {
        throw createError(400, "Bạn phải ở trong phòng có hợp đồng kích hoạt mới có thể báo sự cố.");
    }

    const newRequest = await SupportRequest.create({
        description,
        severity: severity || 'medium',
        tenantId,
        roomId: contract.roomId,
        status: 'pending'
    });

    // Tạo thông báo cho chủ nhà
    try {
        const room = await Room.findByPk(contract.roomId, {
            include: [{ model: Building, as: 'building' }]
        });

        if (room && room.building && room.building.landlordId) {
            const tenant = await User.findByPk(tenantId);
            const landlordId = room.building.landlordId;
            const tenantName = tenant ? (tenant.name || tenant.email) : "Khách thuê";

            const notificationService = require('./notificationService');
            await notificationService.createNotification(
                landlordId,
                "Báo cáo sự cố mới",
                `Khách thuê ${tenantName} tại phòng ${room.roomNumber} (${room.building.name}) vừa báo sự cố: "${description}"`,
                'support_request',
                newRequest.id
            );
        }
    } catch (err) {
        console.error("Lỗi tạo thông báo sự cố cho chủ nhà:", err);
    }

    return {
        message: "Gửi báo cáo sự cố thành công",
        supportRequest: newRequest
    };
};

// 3. CHỦ NHÀ XEM DANH SÁCH BÁO HỎNG CỦA CÁC PHÒNG MÌNH QUẢN LÝ
exports.getLandlordRequests = async (landlordId) => {
    const requests = await SupportRequest.findAll({
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
                attributes: ['id', 'name', 'phone', 'email']
            }
        ],
        order: [['createdAt', 'DESC']]
    });
    return requests;
};

// 4. CHỦ NHÀ CẬP NHẬT TRẠNG THÁI SỬA CHỮA
exports.updateRequestStatus = async (landlordId, requestId, { status }) => {
    if (!status || !['pending', 'in_progress', 'resolved'].includes(status)) {
        throw createError(400, "Trạng thái không hợp lệ.");
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
            }
        ]
    });

    if (!request) {
        throw createError(404, "Không tìm thấy yêu cầu hoặc bạn không có quyền cập nhật");
    }

    request.status = status;
    await request.save();

    // Tạo thông báo cho khách thuê
    try {
        const notificationService = require('./notificationService');
        const statusMap = {
            'pending': 'Đang chờ',
            'in_progress': 'Đang xử lý',
            'resolved': 'Đã xử lý xong'
        };
        await notificationService.createNotification(
            request.tenantId,
            "Cập nhật trạng thái sự cố",
            `Yêu cầu báo hỏng "${request.description.substring(0, 30)}..." của bạn đã được chuyển sang trạng thái: ${statusMap[status] || status}`,
            'support_request',
            request.id
        );
    } catch (err) {
        console.error("Lỗi tạo thông báo sự cố cho khách thuê:", err);
    }

    return {
        message: "Cập nhật trạng thái xử lý sự cố thành công",
        supportRequest: request
    };
};
