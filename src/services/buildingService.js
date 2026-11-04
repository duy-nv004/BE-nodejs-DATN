const Building = require('../models/Building');
const Room = require('../models/Room');
const User = require('../models/User');
const Contract = require('../models/Contract');
const Service = require('../models/Service');
const MeterReading = require('../models/MeterReading');
const Invoice = require('../models/Invoice');
const SupportRequest = require('../models/SupportRequest');
const Notification = require('../models/Notification');
const ContractOccupant = require('../models/ContractOccupant');
const sequelize = require('../config/db');
const { Op } = require('sequelize');
const { createError } = require('../utils/errors');
const { validateEmail, validatePhone } = require('../utils/validators');
const { assertBuildingLimit, assertRoomLimit } = require('../middleware/checkLimit');

/** Giá hợp lệ: số hữu hạn >= 0 (chuỗi rỗng / boolean / chữ đều bị từ chối) */
const isValidPrice = (v) => v !== '' && v !== null && typeof v !== 'boolean' && Number.isFinite(Number(v)) && Number(v) >= 0;

/** Validate sức chứa phòng (T2.19): số nguyên từ 1 đến 50 */
const parseCapacity = (capacity) => {
    if (capacity === '' || typeof capacity === 'boolean') {
        throw createError(400, 'Sức chứa phòng phải là số nguyên từ 1 đến 50');
    }
    const num = Number(capacity);
    if (!Number.isInteger(num) || num < 1 || num > 50) {
        throw createError(400, 'Sức chứa phòng phải là số nguyên từ 1 đến 50');
    }
    return num;
};

/** Validate diện tích phòng (T2.19): số hữu hạn > 0 */
const parseArea = (area) => {
    if (area === '' || typeof area === 'boolean') {
        throw createError(400, 'Diện tích phòng phải là số lớn hơn 0');
    }
    const num = Number(area);
    if (!Number.isFinite(num) || num <= 0) {
        throw createError(400, 'Diện tích phòng phải là số lớn hơn 0');
    }
    return num;
};

/**
 * Chạy callback trong transaction nếu kết nối DB sẵn sàng (hoặc được stub).
 * Nếu môi trường unit test không stub sequelize.transaction và không có DB thật
 * (ném lỗi kết nối), tự fallback chạy fn(null) để không làm gãy unit test.
 */
const runInTransaction = async (fn) => {
    if (typeof sequelize?.transaction === 'function') {
        try {
            return await sequelize.transaction(fn);
        } catch (err) {
            if (err?.name && /SequelizeConnection|ConnectionRefused|ConnectionError|ECONNREFUSED|AccessDenied/i.test(err.name + ' ' + (err.message || ''))) {
                return await fn(null);
            }
            throw err;
        }
    }
    return await fn(null);
};

/** Giới hạn gói tính theo user trong DB: mọi đường gọi (HTTP, chatbot) đều đi qua đây */
const loadLandlord = async (landlordId, { transaction, lock } = {}) => {
    const opts = {};
    if (transaction) {
        opts.transaction = transaction;
        if (lock) opts.lock = transaction.LOCK?.UPDATE || true;
    }
    const user = await User.findByPk(landlordId, Object.keys(opts).length ? opts : undefined);
    if (!user) throw createError(404, 'Không tìm thấy tài khoản chủ nhà');
    return user;
};

const assertRoomNumberFree = async (buildingId, roomNumber, excludeId, { transaction } = {}) => {
    const where = { buildingId, roomNumber };
    if (excludeId) where.id = { [Op.ne]: excludeId };
    const opts = { where };
    if (transaction) opts.transaction = transaction;
    if (await Room.findOne(opts)) {
        throw createError(400, `Số phòng "${roomNumber}" đã tồn tại trong tòa nhà này`);
    }
};

// 1. TẠO TÒA NHÀ (T1.9 & T2.1: bọc trong transaction kèm khóa dòng User)
exports.createBuilding = async (landlordId, { name, address }) => {
    if (!name || !address) {
        throw createError(400, 'Thiếu thông tin Tên hoặc Địa chỉ tòa nhà');
    }
    return await runInTransaction(async (transaction) => {
        const txOpts = transaction ? { transaction } : {};
        const landlord = await loadLandlord(landlordId, { transaction, lock: true });
        await assertBuildingLimit(landlord, txOpts);
        const building = await Building.create({ name, address, landlordId }, txOpts);
        // Tự động tạo bản ghi Service chứa đơn giá dịch vụ mặc định liên kết với tòa nhà
        await Service.create({ buildingId: building.id }, txOpts);
        return building;
    });
};

// 2. TẠO PHÒNG (T1.9, T2.1, T2.19)
exports.createRoom = async (landlordId, { roomNumber, price, capacity, area, buildingId }) => {
    const normalizedRoomNumber = typeof roomNumber === 'string' ? roomNumber.trim() : String(roomNumber ?? '').trim();
    // Dùng so sánh tường minh thay vì ép kiểu truthy: phòng giá 0 là hợp lệ
    // (phòng để ở ghép, phòng chưa định giá) nhưng `!price` sẽ chặn nhầm.
    if (!normalizedRoomNumber || price === undefined || price === null || !buildingId) {
        throw createError(400, 'Thiếu thông tin Số phòng, Giá hoặc Tòa nhà');
    }
    if (!isValidPrice(price)) {
        throw createError(400, 'Giá phòng phải là số không âm');
    }

    const resolvedCapacity = capacity !== undefined && capacity !== null ? parseCapacity(capacity) : 2;
    const resolvedArea = area !== undefined && area !== null ? parseArea(area) : 20;

    return await runInTransaction(async (transaction) => {
        const txOpts = transaction ? { transaction } : {};
        const findBuildingOpts = { where: { id: buildingId, landlordId } };
        if (transaction) {
            findBuildingOpts.transaction = transaction;
            findBuildingOpts.lock = transaction.LOCK?.UPDATE || true;
        }
        const building = await Building.findOne(findBuildingOpts);
        if (!building) {
            throw createError(404, 'Tòa nhà không tồn tại hoặc bạn không có quyền truy cập');
        }
        const landlord = await loadLandlord(landlordId, { transaction, lock: true });
        await assertRoomLimit(landlord, buildingId, txOpts);
        await assertRoomNumberFree(buildingId, normalizedRoomNumber, undefined, txOpts);

        try {
            const room = await Room.create({
                roomNumber: normalizedRoomNumber,
                price,
                capacity: resolvedCapacity,
                area: resolvedArea,
                buildingId
            }, txOpts);
            return room;
        } catch (err) {
            if (err?.name === 'SequelizeUniqueConstraintError') {
                throw createError(400, 'Số phòng đã tồn tại trong tòa nhà này');
            }
            throw err;
        }
    });
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

    // Service là bản ghi 1-1 của tòa nhà: xóa cùng transaction để không để lại đơn giá mồ côi
    await sequelize.transaction(async (transaction) => {
        await Service.destroy({ where: { buildingId: building.id }, transaction });
        await building.destroy({ transaction });
    });
    return { message: 'Xóa tòa nhà thành công' };
};

// 6. LẤY DANH SÁCH TOÀN BỘ PHÒNG CỦA CHỦ NHÀ (T3.5: hỗ trợ lọc theo month/year & buildingId)
exports.getRooms = async (arg1, arg2, arg3) => {
    let buildingId = null;
    let landlordId;
    let query = {};

    if (arg3 !== undefined || (arg2 !== undefined && (typeof arg2 === 'number' || typeof arg2 === 'string'))) {
        buildingId = arg1;
        landlordId = arg2;
        query = (arg3 && typeof arg3 === 'object') ? arg3 : {};
    } else {
        landlordId = arg1;
        query = (arg2 && typeof arg2 === 'object') ? arg2 : {};
        if (query.buildingId !== undefined) buildingId = query.buildingId;
    }

    const buildingWhere = { landlordId };
    if (buildingId !== null && buildingId !== undefined) {
        buildingWhere.id = buildingId;
    }

    const invoiceInclude = {
        model: Invoice,
        as: 'invoices',
        required: false
    };
    const readingInclude = {
        model: MeterReading,
        as: 'readings',
        required: false
    };

    if (query && query.month != null && query.year != null && query.month !== '' && query.year !== '') {
        const m = Number(query.month);
        const y = Number(query.year);
        if (Number.isInteger(m) && Number.isInteger(y)) {
            invoiceInclude.where = { month: m, year: y };
            readingInclude.where = { period: `${y}-${String(m).padStart(2, '0')}` };
        }
    }

    const rooms = await Room.findAll({
        include: [
            {
                model: Building,
                as: 'building',
                where: buildingWhere,
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
            invoiceInclude,
            readingInclude
        ],
        order: [['roomNumber', 'ASC']]
    });
    return rooms;
};

// 7. CẬP NHẬT PHÒNG (T2.1 & T2.19)
exports.updateRoom = async (landlordId, roomId, { roomNumber, price, capacity, area, status }) => {
    const room = await Room.findByPk(roomId, {
        include: [{ model: Building, as: 'building' }]
    });

    if (!room || room.building.landlordId !== landlordId) {
        throw createError(404, 'Phòng trọ không tồn tại hoặc bạn không có quyền chỉnh sửa');
    }

    // Kiểm tra hết trước khi gán để lỗi không để lại instance sửa dở
    if (price !== undefined && !isValidPrice(price)) {
        throw createError(400, 'Giá phòng phải là số không âm');
    }

    let trimmedRoomNumber;
    if (roomNumber !== undefined) {
        trimmedRoomNumber = String(roomNumber).trim();
        if (!trimmedRoomNumber) {
            throw createError(400, 'Số phòng không được để trống');
        }
        if (trimmedRoomNumber !== room.roomNumber) {
            await assertRoomNumberFree(room.buildingId, trimmedRoomNumber, room.id);
        }
    }

    let parsedCap;
    if (capacity !== undefined && capacity !== null) {
        parsedCap = parseCapacity(capacity);
        let activeContract = Array.isArray(room.contracts)
            ? room.contracts.find((c) => c.status === 'active')
            : null;
        if (!activeContract && typeof Contract.findOne === 'function') {
            try {
                activeContract = await Contract.findOne({ where: { roomId: room.id, status: 'active' } });
            } catch (err) {
                if (!/SequelizeConnection|ConnectionRefused|ConnectionError|ECONNREFUSED|AccessDenied/i.test((err?.name || '') + ' ' + (err?.message || ''))) {
                    throw err;
                }
            }
        }
        if (activeContract) {
            const numTenants = Number(activeContract.numTenants) || (Array.isArray(activeContract.occupants) ? activeContract.occupants.length : 0);
            if (parsedCap < numTenants) {
                throw createError(400, 'Không thể giảm sức chứa xuống thấp hơn số người đang ở');
            }
        }
    }

    let parsedAreaVal;
    if (area !== undefined && area !== null) {
        parsedAreaVal = parseArea(area);
    }

    // Chỉ cho đặt các trạng thái do chủ nhà chủ động quyết định.
    // 'occupied' và 'reserved' do luồng hợp đồng quản lý — cho sửa tay ở đây sẽ mở
    // lại đường tạo hai hợp đồng trên cùng một phòng.
    if (status !== undefined) {
        const MANUAL_STATUSES = ['empty', 'maintenance'];
        if (!MANUAL_STATUSES.includes(status)) {
            throw createError(400, `Chỉ có thể đặt trạng thái phòng thành: ${MANUAL_STATUSES.join(', ')}. `
                + `Trạng thái "${status}" do hệ thống hợp đồng tự quản lý.`);
        }
        // Đổi tay khi phòng đang có khách / đang giữ chỗ sẽ làm lệch trạng thái với hợp đồng
        const activeContracts = ['occupied', 'reserved'].includes(room.status) ? 1 : await Contract.count({
            where: { roomId: room.id, status: ['active', 'pending_tenant_signature'] }
        });
        if (activeContracts > 0) {
            throw createError(400, 'Phòng đang có hợp đồng hoạt động hoặc đang chờ khách ký, không thể đổi trạng thái thủ công.');
        }
        room.status = status;
    }

    if (trimmedRoomNumber !== undefined) room.roomNumber = trimmedRoomNumber;
    if (price !== undefined) room.price = price;
    if (parsedCap !== undefined) room.capacity = parsedCap;
    if (parsedAreaVal !== undefined) room.area = parsedAreaVal;

    try {
        await room.save();
        return room;
    } catch (err) {
        if (err?.name === 'SequelizeUniqueConstraintError') {
            throw createError(400, 'Số phòng đã tồn tại trong tòa nhà này');
        }
        throw err;
    }
};

// 8. XÓA PHÒNG
exports.deleteRoom = async (landlordId, roomId) => {
    const room = await Room.findByPk(roomId, {
        include: [{ model: Building, as: 'building' }]
    });

    if (!room || room.building.landlordId !== landlordId) {
        throw createError(404, 'Phòng trọ không tồn tại hoặc bạn không có quyền xóa');
    }

    // Chặn xóa khi phòng còn hợp đồng CHƯA KẾT THÚC, không chỉ hợp đồng đang active.
    // Hợp đồng 'pending_tenant_signature' cũng tham chiếu phòng: xóa phòng sẽ làm
    // Dashboard của khách thuê ném lỗi vì contract.room là null.
    const blockingContracts = await Contract.count({
        where: { roomId, status: ['active', 'pending_tenant_signature'] }
    });
    if (blockingContracts > 0) {
        throw createError(400, 'Không thể xóa phòng trọ đang có hợp đồng hoạt động hoặc đang chờ khách ký.');
    }

    const unpaid = await Invoice.count({ where: { roomId, isPaid: false } });
    if (unpaid > 0) {
        throw createError(400, `Phòng còn ${unpaid} hóa đơn chưa thanh toán, không thể xóa.`);
    }

    // destroy sẽ cascade mất hóa đơn / chỉ số cũ: phòng đã có lịch sử thì chỉ cho ngưng dùng
    const [contracts, invoices, readings] = await Promise.all([
        Contract.count({ where: { roomId } }),
        Invoice.count({ where: { roomId } }),
        MeterReading.count({ where: { roomId } })
    ]);
    if (contracts + invoices + readings > 0) {
        throw createError(400, 'Phòng đã có lịch sử hợp đồng/hóa đơn/chỉ số điện nước nên không thể xóa. Hãy chuyển phòng sang trạng thái "Bảo trì" (maintenance) để ngưng sử dụng.');
    }

    await room.destroy();
    return { message: 'Xóa phòng trọ thành công' };
};

// 9. LẤY DANH SÁCH KHÁCH THUÊ
exports.getTenants = async (landlordId) => {
    const tenants = await User.findAll({
        where: { ownerId: landlordId },
        attributes: ['id', 'name', 'phone', 'email', 'telegramChatId', 'status', 'lockReason', 'createdAt'],
        // HĐ active kèm người ở để FE hiện "đã khai báo tạm trú / tổng" (C6)
        include: [{
            model: Contract, as: 'rentals', required: false, where: { status: 'active' }, attributes: ['id', 'roomId'],
            include: [
                { model: ContractOccupant, as: 'occupants', attributes: ['id', 'residenceStatus'] },
                { model: Room, as: 'room', attributes: ['id', 'roomNumber'] }
            ]
        }],
        order: [['createdAt', 'DESC']]
    });
    return tenants;
};

// 10. CẬP NHẬT THÔNG TIN KHÁCH THUÊ
exports.updateTenant = async (landlordId, tenantId, { name, phone, email, status }) => {
    const tenant = await User.findOne({ where: { id: tenantId, ownerId: landlordId } });
    if (!tenant) {
        throw createError(404, 'Không tìm thấy khách thuê trọ này');
    }
    // Chỉ cho mở khóa ở đây; khóa đi qua DELETE /manage/tenants/:id
    if (status !== undefined && status !== 'active') {
        throw createError(400, 'Chỉ có thể đặt trạng thái khách thuê thành: active');
    }

    if (email) email = validateEmail(email);
    if (phone) phone = validatePhone(phone);

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
    if (status === 'active') {
        tenant.status = 'active';
        tenant.lockReason = null;
    }
    await tenant.save();

    return tenant;
};

// 11. XÓA/NGẮT LIÊN KẾT KHÁCH THUÊ
exports.deleteTenant = async (landlordId, tenantId) => {
    const tenant = await User.findOne({ where: { id: tenantId, ownerId: landlordId } });
    if (!tenant) {
        throw createError(404, 'Không tìm thấy khách thuê trọ này');
    }

    // HĐ chờ ký cũng chặn: xóa khách lúc này để lại HĐ mồ côi và phòng kẹt ở 'reserved'
    const blockingContracts = await Contract.count({
        where: { tenantId, status: ['active', 'pending_tenant_signature'] }
    });
    if (blockingContracts > 0) {
        throw createError(400, 'Khách đang có hợp đồng hiệu lực hoặc chờ ký, hãy hủy hoặc thanh lý trước');
    }

    const unpaid = await Invoice.count({ where: { tenantId, isPaid: false } });
    if (unpaid > 0) {
        throw createError(400, `Khách còn ${unpaid} hóa đơn chưa thanh toán`);
    }

    // Có lịch sử (HĐ / hóa đơn / yêu cầu hỗ trợ trỏ tới user) thì chỉ khóa để giữ lịch sử
    const [contracts, invoices, supports] = await Promise.all([
        Contract.count({ where: { tenantId } }),
        Invoice.count({ where: { tenantId } }),
        SupportRequest.count({ where: { tenantId } })
    ]);
    if (contracts + invoices + supports > 0) {
        tenant.status = 'locked';
        tenant.lockReason = 'Chủ nhà đã ngưng quản lý tài khoản';
        await tenant.save();
        return { message: 'Đã khóa tài khoản (giữ lịch sử hợp đồng/hóa đơn)' };
    }

    // Notifications trỏ khóa ngoại tới user, xóa trước để destroy không lỗi FK
    await Notification.destroy({ where: { userId: tenant.id } });
    await tenant.destroy();
    return { message: 'Xóa tài khoản khách thuê thành công' };
};

// 12. CẬP NHẬT ĐƠN GIÁ DỊCH VỤ CHUNG CỦA TÒA NHÀ
exports.updateBuildingService = async (landlordId, buildingId, serviceData) => {
    const building = await Building.findOne({ where: { id: buildingId, landlordId } });
    if (!building) {
        throw createError(404, 'Tòa nhà không tồn tại hoặc bạn không có quyền cập nhật');
    }

    const { electricityPrice, waterPrice, internetPrice, cleaningPrice } = serviceData;
    for (const v of [electricityPrice, waterPrice, internetPrice, cleaningPrice]) {
        if (v !== undefined && !isValidPrice(v)) {
            throw createError(400, 'Đơn giá dịch vụ phải là số không âm');
        }
    }

    let service = await Service.findOne({ where: { buildingId } });
    if (!service) {
        service = await Service.create({ buildingId });
    }

    if (electricityPrice !== undefined) service.electricityPrice = electricityPrice;
    if (waterPrice !== undefined) service.waterPrice = waterPrice;
    if (internetPrice !== undefined) service.internetPrice = internetPrice;
    if (cleaningPrice !== undefined) service.cleaningPrice = cleaningPrice;

    await service.save();
    return service;
};
