const Building = require('../models/Building');
const Room = require('../models/Room');
const User = require('../models/User');
const Contract = require('../models/Contract');
const Service = require('../models/Service');
const MeterReading = require('../models/MeterReading');
const Invoice = require('../models/Invoice');
const { createError } = require('../utils/errors');

// 1. TẠO TÒA NHÀ
exports.createBuilding = async (landlordId, { name, address }) => {
    if (!name || !address) {
        throw createError(400, 'Thiếu thông tin Tên hoặc Địa chỉ tòa nhà');
    }
    const building = await Building.create({ name, address, landlordId });
    // Tự động tạo bản ghi Service chứa đơn giá dịch vụ mặc định liên kết với tòa nhà
    await Service.create({ buildingId: building.id });
    return building;
};

// 2. TẠO PHÒNG
exports.createRoom = async ({ roomNumber, price, capacity, area, buildingId }) => {
    if (!roomNumber || !price || !buildingId) {
        throw createError(400, 'Thiếu thông tin Số phòng, Giá hoặc Tòa nhà');
    }
    const room = await Room.create({
        roomNumber,
        price,
        capacity: capacity ? parseInt(capacity) : 2,
        area: area ? parseFloat(area) : 20,
        buildingId
    });
    return room;
};

// 3. LẤY DANH SÁCH TÒA NHÀ
exports.getBuildings = async (landlordId) => {
    const buildings = await Building.findAll({
        where: { landlordId },
        include: [{ model: Service, as: 'service' }],
        order: [['createdAt', 'DESC']]
    });
    return buildings;
};

// 4. LẤY CHI TIẾT TÒA NHÀ (VÀ PHÒNG)
exports.getBuildingDetail = async (landlordId, buildingId) => {
    const building = await Building.findOne({
        where: { id: buildingId, landlordId },
        include: [{ model: Room, as: 'rooms' }]
    });

    if (!building) {
        throw createError(404, 'Tòa nhà không tồn tại hoặc bạn không có quyền truy cập');
    }
    return building;
};

// 5. XÓA TÒA NHÀ
exports.deleteBuilding = async (landlordId, buildingId) => {
    const building = await Building.findOne({ where: { id: buildingId, landlordId } });
    if (!building) {
        throw createError(404, 'Tòa nhà không tồn tại hoặc bạn không có quyền xóa');
    }

    // Kiểm tra xem tòa nhà có chứa phòng nào không
    const roomsCount = await Room.count({ where: { buildingId } });
    if (roomsCount > 0) {
        throw createError(400, 'Không thể xóa tòa nhà đang chứa phòng trọ. Hãy xóa các phòng trước.');
    }

    await building.destroy();
    return { message: 'Xóa tòa nhà thành công' };
};

// 6. LẤY DANH SÁCH TOÀN BỘ PHÒNG CỦA CHỦ NHÀ
exports.getRooms = async (landlordId) => {
    const rooms = await Room.findAll({
        include: [
            {
                model: Building,
                as: 'building',
                where: { landlordId },
                attributes: ['id', 'name']
            },
            {
                model: Contract,
                as: 'contracts',
                required: false,
                where: { status: 'active' },
                include: [
                    {
                        model: User,
                        as: 'tenant',
                        attributes: ['id', 'name', 'phone']
                    }
                ]
            },
            {
                model: Invoice,
                as: 'invoices',
                required: false
            },
            {
                model: MeterReading,
                as: 'readings',
                required: false
            }
        ],
        order: [['roomNumber', 'ASC']]
    });
    return rooms;
};

// 7. CẬP NHẬT PHÒNG
exports.updateRoom = async (landlordId, roomId, { roomNumber, price, capacity, area, status }) => {
    const room = await Room.findByPk(roomId, {
        include: [{ model: Building, as: 'building' }]
    });

    if (!room || room.building.landlordId !== landlordId) {
        throw createError(404, 'Phòng trọ không tồn tại hoặc bạn không có quyền chỉnh sửa');
    }

    if (roomNumber !== undefined) room.roomNumber = roomNumber;
    if (price !== undefined) room.price = price;
    if (capacity !== undefined) room.capacity = parseInt(capacity);
    if (area !== undefined) room.area = parseFloat(area);
    if (status !== undefined) room.status = status;

    await room.save();
    return room;
};

// 8. XÓA PHÒNG
exports.deleteRoom = async (landlordId, roomId) => {
    const room = await Room.findByPk(roomId, {
        include: [{ model: Building, as: 'building' }]
    });

    if (!room || room.building.landlordId !== landlordId) {
        throw createError(404, 'Phòng trọ không tồn tại hoặc bạn không có quyền xóa');
    }

    // Kiểm tra xem phòng có hợp đồng đang hoạt động không
    const activeContracts = await Contract.count({
        where: { roomId, status: 'active' }
    });
    if (activeContracts > 0) {
        throw createError(400, 'Không thể xóa phòng trọ đang có hợp đồng hoạt động.');
    }

    await room.destroy();
    return { message: 'Xóa phòng trọ thành công' };
};

// 9. LẤY DANH SÁCH KHÁCH THUÊ
exports.getTenants = async (landlordId) => {
    const tenants = await User.findAll({
        where: { ownerId: landlordId },
        attributes: ['id', 'name', 'phone', 'email', 'telegramChatId', 'createdAt'],
        order: [['createdAt', 'DESC']]
    });
    return tenants;
};

// 10. CẬP NHẬT THÔNG TIN KHÁCH THUÊ
exports.updateTenant = async (landlordId, tenantId, { name, phone, email }) => {
    const tenant = await User.findOne({ where: { id: tenantId, ownerId: landlordId } });
    if (!tenant) {
        throw createError(404, 'Không tìm thấy khách thuê trọ này');
    }

    if (email && email !== tenant.email) {
        const checkEmail = await User.findOne({ where: { email } });
        if (checkEmail) throw createError(400, 'Email đã được sử dụng bởi người dùng khác');
        tenant.email = email;
    }

    if (phone && phone !== tenant.phone) {
        const checkPhone = await User.findOne({ where: { phone } });
        if (checkPhone) throw createError(400, 'Số điện thoại đã được sử dụng bởi người dùng khác');
        tenant.phone = phone;
    }

    if (name) tenant.name = name;
    await tenant.save();

    return tenant;
};

// 11. XÓA/NGẮT LIÊN KẾT KHÁCH THUÊ
exports.deleteTenant = async (landlordId, tenantId) => {
    const tenant = await User.findOne({ where: { id: tenantId, ownerId: landlordId } });
    if (!tenant) {
        throw createError(404, 'Không tìm thấy khách thuê trọ này');
    }

    // Kiểm tra xem khách thuê có hợp đồng nào đang chạy không
    const activeContracts = await Contract.count({
        where: { tenantId, status: 'active' }
    });
    if (activeContracts > 0) {
        throw createError(400, 'Không thể xóa khách thuê trọ đang có hợp đồng hoạt động.');
    }

    await tenant.destroy();
    return { message: 'Xóa tài khoản khách thuê thành công' };
};

// 12. CẬP NHẬT ĐƠN GIÁ DỊCH VỤ CHUNG CỦA TÒA NHÀ
exports.updateBuildingService = async (landlordId, buildingId, serviceData) => {
    const building = await Building.findOne({ where: { id: buildingId, landlordId } });
    if (!building) {
        throw createError(404, 'Tòa nhà không tồn tại hoặc bạn không có quyền cập nhật');
    }

    let service = await Service.findOne({ where: { buildingId } });
    if (!service) {
        service = await Service.create({ buildingId });
    }

    const { electricityPrice, waterPrice, internetPrice, cleaningPrice } = serviceData;
    if (electricityPrice !== undefined) service.electricityPrice = electricityPrice;
    if (waterPrice !== undefined) service.waterPrice = waterPrice;
    if (internetPrice !== undefined) service.internetPrice = internetPrice;
    if (cleaningPrice !== undefined) service.cleaningPrice = cleaningPrice;

    await service.save();
    return service;
};
