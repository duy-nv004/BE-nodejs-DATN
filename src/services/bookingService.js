const crypto = require('crypto');
const { Op } = require('sequelize');
const Room = require('../models/Room');
const Building = require('../models/Building');
const Service = require('../models/Service');
const User = require('../models/User');
const Role = require('../models/Role');
const Contract = require('../models/Contract');
const RoomBooking = require('../models/RoomBooking');
const sequelize = require('../config/db');
const notificationService = require('./notificationService');
const { signAccessToken } = require('../middleware/authMiddleware');
const { createError, isOfflineOrMockTxError } = require('../utils/errors');
const { validatePhone, validateEmail, validatePassword } = require('../utils/validators');
const { systemBank } = require('../utils/bank');
const {
    normalizeText,
    canonicalCityName,
    DEFAULT_VN_LOCATIONS,
    inferLocationFromAddress
} = require('../utils/vnLocations');

const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Tính khoảng cách Haversine (km) làm tròn 1 chữ số thập phân */
const calculateDistanceKm = (lat1, lng1, lat2, lng2) => {
    const nums = [lat1, lng1, lat2, lng2].map(Number);
    if (nums.some((n) => !Number.isFinite(n))) return null;
    const [aLat, aLng, bLat, bLng] = nums;
    const dLat = toRad(bLat - aLat);
    const dLng = toRad(bLng - aLng);
    const sinLat = Math.sin(dLat / 2);
    const sinLng = Math.sin(dLng / 2);
    const h = sinLat * sinLat + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * sinLng * sinLng;
    const dist = 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    return Math.round(dist * 10) / 10;
};
exports.calculateDistanceKm = calculateDistanceKm;

const parseJsonArray = (val) => {
    if (Array.isArray(val)) return val.map((x) => String(x || '').trim()).filter(Boolean);
    if (typeof val === 'string') {
        const trimmed = val.trim();
        if (!trimmed) return [];
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parsed.map((x) => String(x || '').trim()).filter(Boolean);
        } catch {
            return trimmed.split(',').map((x) => x.trim()).filter(Boolean);
        }
    }
    return [];
};
exports.parseJsonArray = parseJsonArray;

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

const toPublicRoomDto = (roomRecord, distanceKm = null) => {
    const r = typeof roomRecord?.toJSON === 'function' ? roomRecord.toJSON() : { ...roomRecord };
    const price = Number(r.price || 0);
    const configuredDeposit = Number(r.depositAmount || 0);
    const b = r.building || {};
    return {
        id: r.id,
        roomNumber: r.roomNumber,
        price,
        depositAmount: configuredDeposit > 0 ? configuredDeposit : price,
        area: Number(r.area || 20),
        capacity: Number(r.capacity || 2),
        status: r.status,
        description: r.description || '',
        images: parseJsonArray(r.images),
        amenities: parseJsonArray(r.amenities),
        distanceKm,
        createdAt: r.createdAt || null,
        building: {
            id: b.id,
            name: b.name,
            address: b.address,
            city: b.city || '',
            district: b.district || '',
            ward: b.ward || '',
            latitude: b.latitude != null ? Number(b.latitude) : null,
            longitude: b.longitude != null ? Number(b.longitude) : null,
            service: b.service || null,
            landlord: b.landlord ? {
                id: b.landlord.id,
                name: b.landlord.name,
                phone: b.landlord.phone
            } : null
        }
    };
};

const buildDepositPaymentInfo = (bookingId, landlordId, depositAmount) => {
    const bank = systemBank();
    const transferCode = `COC ${bookingId} LL ${landlordId}`;
    const amountVnd = Math.round(Number(depositAmount || 0));
    const qrCodeUrl = `https://qr.sepay.vn/img?bank=${encodeURIComponent(bank.bankId)}&acc=${encodeURIComponent(bank.bankAccount)}&template=compact&amount=${amountVnd}&des=${encodeURIComponent(transferCode)}`;
    return {
        bankId: bank.bankId,
        bankAccount: bank.bankAccount,
        bankName: bank.bankName,
        amount: amountVnd,
        transferCode,
        qrCodeUrl
    };
};
exports.buildDepositPaymentInfo = buildDepositPaymentInfo;

// 1. DANH SÁCH PHÒNG TRỐNG CÔNG KHAI & TÌM KIẾM VỊ TRÍ / GPS
exports.getPublicRooms = async (query = {}) => {
    const minPrice = query.minPrice !== undefined && query.minPrice !== '' ? Number(query.minPrice) : null;
    const maxPrice = query.maxPrice !== undefined && query.maxPrice !== '' ? Number(query.maxPrice) : null;
    const minArea = query.minArea !== undefined && query.minArea !== '' ? Number(query.minArea) : null;
    const capacityFilter = query.capacity !== undefined && query.capacity !== '' ? Number(query.capacity) : null;

    // Đẩy các điều kiện lọc phạm vi giá, diện tích, sức chứa xuống SQL trước để tránh tải thừa dữ liệu
    const roomWhere = { status: 'empty' };
    if (Number.isFinite(minPrice) || Number.isFinite(maxPrice)) {
        roomWhere.price = {};
        if (Number.isFinite(minPrice)) roomWhere.price[Op.gte] = minPrice;
        if (Number.isFinite(maxPrice)) roomWhere.price[Op.lte] = maxPrice;
    }
    if (Number.isFinite(minArea)) {
        roomWhere.area = { [Op.gte]: minArea };
    }
    if (Number.isFinite(capacityFilter)) {
        roomWhere.capacity = { [Op.gte]: capacityFilter };
    }

    const buildingWhere = {};
    const andConds = [];
    if (query.city && String(query.city).trim()) {
        const rawCity = String(query.city).trim();
        const canonCity = canonicalCityName(rawCity);
        const cityLikes = [{ city: { [Op.like]: `%${rawCity}%` } }, { address: { [Op.like]: `%${rawCity}%` } }];
        if (canonCity && canonCity !== rawCity) {
            cityLikes.push({ city: { [Op.like]: `%${canonCity}%` } }, { address: { [Op.like]: `%${canonCity}%` } });
        }
        if (canonCity === 'ho chi minh') {
            cityLikes.push({ city: { [Op.like]: '%HCM%' } }, { address: { [Op.like]: '%HCM%' } });
        }
        andConds.push({ [Op.or]: cityLikes });
    }
    if (query.district && String(query.district).trim()) {
        const rawDist = String(query.district).trim();
        andConds.push({
            [Op.or]: [
                { district: { [Op.like]: `%${rawDist}%` } },
                { address: { [Op.like]: `%${rawDist}%` } }
            ]
        });
    }
    if (query.ward && String(query.ward).trim()) {
        const rawWard = String(query.ward).trim();
        andConds.push({
            [Op.or]: [
                { ward: { [Op.like]: `%${rawWard}%` } },
                { address: { [Op.like]: `%${rawWard}%` } }
            ]
        });
    }
    if (andConds.length > 0) {
        buildingWhere[Op.and] = andConds;
    }

    const rawRooms = await Room.findAll({
        where: roomWhere,
        include: [
            {
                model: Building,
                as: 'building',
                required: true,
                ...(andConds.length > 0 ? { where: buildingWhere } : {}),
                include: [
                    { model: Service, as: 'service', required: false },
                    { model: User, as: 'landlord', attributes: ['id', 'name', 'phone'], required: false }
                ]
            }
        ],
        order: [['createdAt', 'DESC']]
    });

    const userLat = query.lat !== undefined && query.lat !== '' ? Number(query.lat) : null;
    const userLng = query.lng !== undefined && query.lng !== '' ? Number(query.lng) : null;
    const hasUserCoords = Number.isFinite(userLat) && Number.isFinite(userLng);
    const radiusKm = query.radiusKm !== undefined && query.radiusKm !== '' ? Number(query.radiusKm) : null;

    const cityFilter = normalizeText(query.city);
    const cityCanonFilter = normalizeText(canonicalCityName(query.city));
    const districtFilter = normalizeText(query.district);
    const wardFilter = normalizeText(query.ward);
    const searchFilter = normalizeText(query.search || query.q);

    const requestedAmenities = parseJsonArray(query.amenity || query.amenities).map(normalizeText);

    let items = rawRooms.map((r) => {
        const b = r.building || {};
        const dist = hasUserCoords && b.latitude != null && b.longitude != null
            ? calculateDistanceKm(userLat, userLng, b.latitude, b.longitude)
            : null;
        return toPublicRoomDto(r, dist);
    });

    items = items.filter((item) => {
        const b = item.building;
        const inferred = (!b.city || !b.district || !b.ward) && b.address
            ? inferLocationFromAddress(b.address)
            : {};
        const addrNorm = normalizeText(b.address);
        const effCity = b.city || inferred.city || '';
        const effDistrict = b.district || inferred.district || '';
        const effWard = b.ward || inferred.ward || '';

        if (cityFilter) {
            const cityMatched = normalizeText(effCity).includes(cityFilter)
                || addrNorm.includes(cityFilter)
                || (cityCanonFilter && normalizeText(canonicalCityName(effCity)).includes(cityCanonFilter));
            if (!cityMatched) return false;
        }
        if (districtFilter && !normalizeText(effDistrict).includes(districtFilter) && !addrNorm.includes(districtFilter)) {
            return false;
        }
        if (wardFilter && !normalizeText(effWard).includes(wardFilter) && !addrNorm.includes(wardFilter)) {
            return false;
        }
        if (searchFilter) {
            const haystack = normalizeText(
                `${item.roomNumber} ${item.description} ${b.name} ${b.address} ${b.ward} ${b.district} ${b.city}`
            );
            if (!haystack.includes(searchFilter)) return false;
        }
        if (Number.isFinite(minPrice) && item.price < minPrice) return false;
        if (Number.isFinite(maxPrice) && item.price > maxPrice) return false;
        if (Number.isFinite(minArea) && item.area < minArea) return false;
        if (Number.isFinite(capacityFilter) && item.capacity < capacityFilter) return false;
        if (requestedAmenities.length > 0) {
            const itemAmenities = item.amenities.map(normalizeText);
            const hasAll = requestedAmenities.every((reqAm) => itemAmenities.some((a) => a.includes(reqAm)));
            if (!hasAll) return false;
        }
        if (hasUserCoords && Number.isFinite(radiusKm) && radiusKm > 0) {
            if (item.distanceKm === null || item.distanceKm > radiusKm) return false;
        }
        return true;
    });

    const sortBy = query.sort || (hasUserCoords ? 'nearest' : 'newest');
    items.sort((a, b) => {
        if (sortBy === 'nearest') {
            if (a.distanceKm === null && b.distanceKm === null) return 0;
            if (a.distanceKm === null) return 1;
            if (b.distanceKm === null) return -1;
            return a.distanceKm - b.distanceKm;
        }
        if (sortBy === 'price_asc') return a.price - b.price;
        if (sortBy === 'price_desc') return b.price - a.price;
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    });

    const total = items.length;
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 50));
    const offset = (page - 1) * limit;
    const pagedRooms = items.slice(offset, offset + limit);

    return {
        rooms: pagedRooms,
        total,
        page,
        totalPages: Math.max(1, Math.ceil(total / limit))
    };
};

// 2. TỔNG HỢP DANH MỤC ĐỊA ĐIỂM CÓ PHÒNG TRỐNG (KẾT HỢP DANH MỤC MẶC ĐỊNH + DB)
exports.getPublicLocations = async () => {
    const emptyRooms = await Room.findAll({
        where: { status: 'empty' },
        include: [{ model: Building, as: 'building', required: true }]
    });

    const citiesSet = new Set();
    const districtsMap = {};
    const wardsMap = {};

    const addLocation = (cityRaw, districtRaw, wardRaw) => {
        const city = String(cityRaw || '').trim();
        const district = String(districtRaw || '').trim();
        const ward = String(wardRaw || '').trim();
        if (!city) return;
        citiesSet.add(city);
        if (!districtsMap[city]) districtsMap[city] = new Set();
        if (district) {
            districtsMap[city].add(district);
            if (ward) {
                const key = `${city}|${district}`;
                if (!wardsMap[key]) wardsMap[key] = new Set();
                wardsMap[key].add(ward);
            }
        }
    };

    for (const c of DEFAULT_VN_LOCATIONS.cities || []) {
        addLocation(c, '', '');
    }
    for (const [c, list] of Object.entries(DEFAULT_VN_LOCATIONS.districtsByCity || {})) {
        for (const d of list || []) addLocation(c, d, '');
    }
    for (const [k, list] of Object.entries(DEFAULT_VN_LOCATIONS.wardsByDistrict || {})) {
        const [c, d] = k.split('|');
        for (const w of list || []) addLocation(c, d, w);
    }

    for (const r of emptyRooms) {
        const b = r.building || {};
        const rawCity = String(b.city || '').trim();
        const rawDistrict = String(b.district || '').trim();
        const rawWard = String(b.ward || '').trim();
        const inferred = (!rawCity || !rawDistrict || !rawWard) && b.address
            ? inferLocationFromAddress(b.address)
            : {};
        addLocation(
            rawCity || inferred.city || '',
            rawDistrict || inferred.district || '',
            rawWard || inferred.ward || ''
        );
    }

    const sortVi = (arr) => arr.sort((a, b) => a.localeCompare(b, 'vi'));
    const cities = sortVi(Array.from(citiesSet));
    const districtsByCity = {};
    for (const [c, set] of Object.entries(districtsMap)) {
        districtsByCity[c] = sortVi(Array.from(set));
    }
    const wardsByDistrict = {};
    for (const [k, set] of Object.entries(wardsMap)) {
        wardsByDistrict[k] = sortVi(Array.from(set));
    }

    return { cities, districtsByCity, wardsByDistrict };
};

// 3. CHI TIẾT 1 PHÒNG CÔNG KHAI
exports.getPublicRoomDetail = async (roomId) => {
    const room = await Room.findByPk(roomId, {
        include: [
            {
                model: Building,
                as: 'building',
                include: [
                    { model: Service, as: 'service', required: false },
                    { model: User, as: 'landlord', attributes: ['id', 'name', 'phone'], required: false }
                ]
            }
        ]
    });
    if (!room) {
        throw createError(404, 'Không tìm thấy thông tin phòng trọ');
    }
    return toPublicRoomDto(room, null);
};

const isDbConnectionError = (err) =>
    Boolean(err?.name && /SequelizeConnection|ConnectionRefused|ConnectionError|ECONNREFUSED|AccessDenied/i.test(err.name + ' ' + (err.message || '')));

const verifyBookingLookupToken = (booking, lookupToken) => {
    if (!booking || !booking.lookupToken || !lookupToken || typeof lookupToken !== 'string') {
        return false;
    }
    const expected = Buffer.from(String(booking.lookupToken));
    const provided = Buffer.from(String(lookupToken));
    if (expected.length !== provided.length) return false;
    return crypto.timingSafeEqual(expected, provided);
};

// 4. TẠO YÊU CẦU XEM PHÒNG HOẶC ĐẶT CỌC GIỮ PHÒNG (CẤP TÀI KHOẢN NGƯỜI THUÊ TỰ ĐỘNG)
const findOrProvisionTenant = async ({ guestName, guestPhone, guestEmail, password, landlordId, authenticatedUserId = null }, txOpts = {}) => {
    const normalizedPhone = validatePhone(guestPhone);
    const normalizedEmail = guestEmail ? validateEmail(guestEmail) : null;
    if (password) validatePassword(password);

    let tenant = await User.findOne({
        where: { phone: normalizedPhone },
        include: [{ model: Role, as: 'roleData' }],
        ...txOpts
    });

    let isNewAccount = false;
    let generatedPassword = null;
    if (tenant) {
        if (tenant.roleData?.name && tenant.roleData.name !== 'tenant') {
            throw createError(400, 'Số điện thoại này thuộc tài khoản Chủ nhà/Quản trị viên, vui lòng dùng số điện thoại khác');
        }
        if (tenant.status === 'locked') {
            throw createError(403, 'Tài khoản gắn với số điện thoại này đang bị khóa');
        }
        if (!tenant.ownerId && landlordId) {
            tenant.ownerId = landlordId;
            await tenant.save(txOpts);
        }
    } else {
        const tenantRole = await Role.findOne({ where: { name: 'tenant' }, ...txOpts });
        if (!tenantRole) {
            throw createError(500, 'Không tìm thấy vai trò người thuê trong hệ thống');
        }
        const initialPassword = password || `Hs@${crypto.randomBytes(4).toString('hex')}`;
        if (!password) {
            generatedPassword = initialPassword;
        }
        tenant = await User.create({
            name: guestName,
            phone: normalizedPhone,
            email: normalizedEmail,
            password: initialPassword,
            roleId: tenantRole.id,
            ownerId: landlordId,
            status: 'active'
        }, txOpts);
        isNewAccount = true;
    }

    // Chống Account Takeover (ATO): chỉ tự động cấp JWT cho tài khoản vừa tạo mới,
    // không bao giờ trả token của tài khoản có sẵn khi đặt phòng theo SĐT công khai.
    const isAuthenticatedOwner = Boolean(authenticatedUserId && Number(authenticatedUserId) === Number(tenant.id));
    const token = isNewAccount ? signAccessToken(tenant) : null;
    const requiresLogin = !isNewAccount && !isAuthenticatedOwner;

    return {
        tenant,
        isNewAccount,
        requiresLogin,
        token,
        generatedPassword,
        user: {
            id: tenant.id,
            name: tenant.name || guestName,
            phone: tenant.phone || normalizedPhone,
            email: tenant.email || normalizedEmail,
            role: 'tenant'
        }
    };
};

exports.createPublicBooking = async (data = {}, { authenticatedUserId = null } = {}) => {
    const { roomId, guestName, guestPhone, guestEmail, type, viewingDate, moveInDate, note, password } = data;
    const trimmedName = String(guestName || '').trim();
    if (!roomId || !trimmedName || !guestPhone || !type) {
        throw createError(400, 'Vui lòng cung cấp đầy đủ thông tin phòng, họ tên, số điện thoại và loại yêu cầu');
    }
    if (!['viewing', 'deposit'].includes(type)) {
        throw createError(400, 'Loại yêu cầu không hợp lệ (chỉ hỗ trợ xem phòng hoặc đặt cọc)');
    }

    const normalizedPhone = validatePhone(String(guestPhone));
    if (guestEmail) validateEmail(String(guestEmail));
    if (password) validatePassword(password);

    return runInTransaction(async (transaction) => {
        const txOpts = transaction ? { transaction } : {};
        const room = await Room.findByPk(roomId, {
            include: [{ model: Building, as: 'building' }],
            ...(transaction ? { lock: transaction.LOCK?.UPDATE || true, transaction } : {})
        });
        if (!room || !room.building) {
            throw createError(404, 'Phòng trọ không tồn tại');
        }
        if (room.status !== 'empty') {
            throw createError(400, `Phòng ${room.roomNumber} hiện không còn trống để đặt lịch hoặc đặt cọc`);
        }

        // Soft-Hold 15 phút cho đặt cọc: chặn 2 người tạo phiên thanh toán cọc đồng thời trên cùng phòng
        if (type === 'deposit' && typeof RoomBooking.findOne === 'function') {
            try {
                const activeHold = await RoomBooking.findOne({
                    where: {
                        roomId: room.id,
                        type: 'deposit',
                        status: 'pending',
                        holdExpiresAt: { [Op.gt]: new Date() }
                    },
                    ...txOpts
                });
                if (activeHold) {
                    throw createError(409, `Phòng ${room.roomNumber} đang có người giữ chỗ thanh toán cọc. Vui lòng thử lại sau ít phút.`);
                }
            } catch (err) {
                if (err?.statusCode) throw err;
                if (!isOfflineOrMockTxError(err, transaction)) throw err;
            }
        }

        const landlordId = room.building.landlordId;
        const depositAmount = type === 'deposit'
            ? (Number(room.depositAmount) > 0 ? Number(room.depositAmount) : Number(room.price) || 0)
            : 0;

        const authResult = await findOrProvisionTenant({
            guestName: trimmedName,
            guestPhone: normalizedPhone,
            guestEmail,
            password,
            landlordId,
            authenticatedUserId
        }, txOpts);

        const lookupToken = crypto.randomBytes(16).toString('hex');
        const holdExpiresAt = type === 'deposit' ? new Date(Date.now() + 15 * 60 * 1000) : null;

        const booking = await RoomBooking.create({
            roomId: room.id,
            buildingId: room.buildingId,
            landlordId,
            tenantId: authResult.tenant.id,
            guestName: trimmedName,
            guestPhone: normalizedPhone,
            guestEmail: guestEmail || null,
            type,
            viewingDate: viewingDate || null,
            moveInDate: moveInDate || null,
            note: note ? String(note).trim() : null,
            depositAmount,
            paymentStatus: 'unpaid',
            status: 'pending',
            lookupToken,
            holdExpiresAt
        }, txOpts);

        let payment = null;
        if (type === 'deposit') {
            payment = buildDepositPaymentInfo(booking.id, landlordId, depositAmount);
            booking.transferCode = payment.transferCode;
            await booking.save(txOpts);
        }

        try {
            const actionLabel = type === 'deposit' ? 'đặt cọc giữ phòng' : 'đặt lịch xem phòng';
            await notificationService.createNotification(
                landlordId,
                type === 'deposit' ? 'Yêu cầu đặt cọc giữ phòng mới' : 'Lịch hẹn xem phòng mới',
                `Khách ${trimmedName} (${normalizedPhone}) vừa gửi yêu cầu ${actionLabel} cho Phòng ${room.roomNumber} (${room.building.name}).`,
                'room_booking',
                booking.id
            );
            const sseService = require('./sseService');
            sseService.sendToUser(landlordId, 'booking_created', {
                bookingId: booking.id,
                roomId: room.id,
                roomNumber: room.roomNumber,
                type,
                guestName: trimmedName
            });
        } catch {
            // Non-blocking notification
        }

        return {
            message: type === 'deposit'
                ? 'Đã tạo yêu cầu đặt cọc giữ phòng. Vui lòng quét mã QR để hoàn tất.'
                : 'Đã gửi lịch hẹn xem phòng thành công! Chủ nhà sẽ sớm liên hệ xác nhận.',
            booking,
            payment,
            auth: {
                token: authResult.token,
                user: authResult.user,
                isNewAccount: authResult.isNewAccount,
                requiresLogin: authResult.requiresLogin,
                generatedPassword: authResult.generatedPassword
            }
        };
    });
};

// 5. KIỂM TRA TRẠNG THÁI ĐẶT PHÒNG / CỌC (POLLING TỪ TRANG PUBLIC - CHỐNG IDOR BẰNG lookupToken)
exports.getPublicBookingStatus = async (bookingId, lookupToken) => {
    const booking = await RoomBooking.findByPk(bookingId, {
        include: [
            { model: Room, as: 'room', attributes: ['id', 'roomNumber', 'status', 'price', 'depositAmount'] },
            { model: Building, as: 'building', attributes: ['id', 'name', 'address'] }
        ]
    });
    if (!booking) {
        throw createError(404, 'Không tìm thấy thông tin đặt phòng');
    }
    if (!verifyBookingLookupToken(booking, lookupToken)) {
        throw createError(403, 'Bạn không có quyền truy cập thông tin đặt phòng này (mã tra cứu không hợp lệ)');
    }

    const dto = {
        id: booking.id,
        type: booking.type,
        status: booking.status,
        paymentStatus: booking.paymentStatus,
        depositAmount: Number(booking.depositAmount || 0),
        transferCode: booking.transferCode,
        paidAt: booking.paidAt,
        holdExpiresAt: booking.holdExpiresAt || null,
        contractId: booking.contractId || null,
        room: booking.room || null,
        building: booking.building || null
    };

    if (booking.type === 'deposit') {
        dto.payment = buildDepositPaymentInfo(booking.id, booking.landlordId, booking.depositAmount);
    }
    return dto;
};

// 6. KHÁCH BÁO ĐÃ CHUYỂN KHOẢN TIỀN CỌC
exports.markBookingTransferred = async (bookingId, lookupToken) => {
    const booking = await RoomBooking.findByPk(bookingId, {
        include: [{ model: Room, as: 'room', attributes: ['id', 'roomNumber'] }]
    });
    if (!booking) {
        throw createError(404, 'Không tìm thấy yêu cầu đặt cọc');
    }
    if (!verifyBookingLookupToken(booking, lookupToken)) {
        throw createError(403, 'Bạn không có quyền cập nhật trạng thái đặt phòng này (mã tra cứu không hợp lệ)');
    }
    if (booking.type !== 'deposit') {
        throw createError(400, 'Chỉ yêu cầu đặt cọc mới có xác nhận chuyển khoản');
    }
    if (booking.paymentStatus === 'unpaid') {
        booking.paymentStatus = 'pending';
        await booking.save();
    }

    try {
        await notificationService.createNotification(
            booking.landlordId,
            'Khách báo đã chuyển khoản tiền cọc',
            `Khách ${booking.guestName} (${booking.guestPhone}) thông báo đã chuyển khoản ${Number(booking.depositAmount).toLocaleString('vi-VN')}đ cho đặt cọc #${booking.id}.`,
            'room_booking',
            booking.id
        );
    } catch {
        // Non-blocking
    }

    return {
        id: booking.id,
        status: booking.status,
        paymentStatus: booking.paymentStatus,
        message: 'Đã ghi nhận thông báo chuyển khoản. Hệ thống đang đối soát tự động qua SePay.'
    };
};

// 7. DANH SÁCH ĐẶT PHÒNG / ĐẶT CỌC CỦA CHỦ NHÀ & NGƯỜI THUÊ
exports.getLandlordBookings = async (landlordId, query = {}) => {
    const where = { landlordId };
    if (query.status) where.status = query.status;
    if (query.type) where.type = query.type;

    return RoomBooking.findAll({
        where,
        include: [
            { model: Room, as: 'room', attributes: ['id', 'roomNumber', 'price', 'depositAmount', 'status'] },
            { model: Building, as: 'building', attributes: ['id', 'name', 'address'] },
            { model: User, as: 'tenant', attributes: ['id', 'name', 'phone', 'email'] }
        ],
        order: [['createdAt', 'DESC']]
    });
};

exports.getTenantBookings = async (tenantId) => {
    return RoomBooking.findAll({
        where: { tenantId },
        include: [
            { model: Room, as: 'room', attributes: ['id', 'roomNumber', 'price', 'depositAmount', 'status'] },
            { model: Building, as: 'building', attributes: ['id', 'name', 'address'] }
        ],
        order: [['createdAt', 'DESC']]
    });
};

// 8. CHỦ NHÀ CẬP NHẬT TRẠNG THÁI ĐẶT PHÒNG / XÁC NHẬN CỌC THỦ CÔNG
exports.updateBookingStatus = async (landlordId, bookingId, { status, note, forfeitDeposit } = {}) => {
    const ALLOWED = ['confirmed', 'deposit_paid', 'rejected', 'cancelled'];
    if (!ALLOWED.includes(status)) {
        throw createError(400, 'Trạng thái cập nhật không hợp lệ');
    }

    return runInTransaction(async (transaction) => {
        const txOpts = transaction ? { transaction } : {};
        const booking = await RoomBooking.findOne({
            where: { id: bookingId, landlordId },
            include: [{ model: Room, as: 'room' }],
            ...(transaction ? { lock: transaction.LOCK?.UPDATE || true, transaction } : {})
        });
        if (!booking) {
            throw createError(404, 'Không tìm thấy yêu cầu đặt phòng hoặc bạn không có quyền');
        }
        if (booking.status === 'contract_created') {
            throw createError(400, 'Đặt phòng này đã được lập hợp đồng');
        }

        const prevStatus = booking.status;
        const room = booking.room || await Room.findByPk(booking.roomId, txOpts);

        if (status === 'deposit_paid') {
            if (room && room.status === 'occupied') {
                throw createError(400, `Phòng ${room.roomNumber} hiện đang có người thuê, không thể giữ cọc`);
            }
            booking.status = 'deposit_paid';
            booking.paymentStatus = 'paid';
            booking.paidAt = booking.paidAt || new Date();
            if (room && room.status !== 'reserved') {
                room.status = 'reserved';
                await room.save(txOpts);
            }
        } else if (status === 'rejected' || status === 'cancelled') {
            booking.status = status;
            if (prevStatus === 'deposit_paid') {
                if (room && room.status === 'reserved') {
                    let blockingContracts = 0;
                    try {
                        blockingContracts = await Contract.count({
                            where: { roomId: room.id, status: ['active', 'pending_tenant_signature'] },
                            ...txOpts
                        });
                    } catch {
                        blockingContracts = 0;
                    }
                    if (blockingContracts === 0) {
                        room.status = 'empty';
                        await room.save(txOpts);
                    }
                }
                try {
                    const DepositRecord = require('../models/DepositRecord');
                    const nextDepositStatus = (status === 'cancelled' && forfeitDeposit) ? 'forfeited' : 'refunded';
                    await DepositRecord.update(
                        {
                            status: nextDepositStatus,
                            ...(nextDepositStatus === 'refunded'
                                ? { refundedAmount: booking.depositAmount || 0, refundedAt: new Date() }
                                : { deductedAmount: booking.depositAmount || 0 }),
                            note: note ? String(note).trim() : (status === 'rejected' ? 'Hoàn cọc do chủ nhà từ chối đặt phòng' : 'Hoàn cọc do hủy đặt phòng')
                        },
                        {
                            where: { bookingId: booking.id, status: 'held' },
                            ...txOpts
                        }
                    );
                } catch (err) {
                    if (!isOfflineOrMockTxError(err, transaction)) throw err;
                }
            }
        } else {
            booking.status = status;
        }

        if (note !== undefined && String(note).trim()) {
            booking.note = String(note).trim();
        }
        await booking.save(txOpts);

        if (booking.tenantId) {
            try {
                const statusLabels = {
                    confirmed: 'Lịch hẹn xem phòng đã được xác nhận',
                    deposit_paid: 'Tiền cọc giữ phòng đã được xác nhận',
                    rejected: 'Yêu cầu đặt phòng đã bị từ chối',
                    cancelled: 'Yêu cầu đặt phòng đã bị hủy'
                };
                await notificationService.createNotification(
                    booking.tenantId,
                    statusLabels[status] || 'Cập nhật yêu cầu đặt phòng',
                    `Chủ nhà vừa cập nhật yêu cầu #${booking.id} (Phòng ${room?.roomNumber || booking.roomId}).`,
                    'room_booking',
                    booking.id
                );
            } catch {
                // Non-blocking
            }
        }

        try {
            const sseService = require('./sseService');
            const payload = { bookingId: booking.id, roomId: booking.roomId, status: booking.status };
            if (booking.tenantId) sseService.sendToUser(booking.tenantId, 'booking_updated', payload);
            if (landlordId) sseService.sendToUser(landlordId, 'booking_updated', payload);
        } catch {
            // Non-blocking
        }

        return booking;
    });
};

// 9. TỰ ĐỘNG HỦY CÁC PHIÊN GIỮ CHỖ ĐẶT CỌC QUÁ HẠN (SOFT-HOLD 15 PHÚT)
exports.releaseExpiredBookingHolds = async (now = new Date()) => {
    try {
        const res = await RoomBooking.update(
            { status: 'cancelled' },
            {
                where: {
                    type: 'deposit',
                    status: 'pending',
                    holdExpiresAt: { [Op.lt]: now }
                }
            }
        );
        return Array.isArray(res) ? (res[0] || 0) : (Number(res) || 0);
    } catch (err) {
        if (isDbConnectionError(err)) return 0;
        throw err;
    }
};
