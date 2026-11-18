/**
 * Unit test TDD (RED -> GREEN -> REFACTOR) cho:
 * - Tòa nhà có vị trí (city, district, ward, latitude, longitude) & updateBuilding
 * - Phòng có ảnh (tối đa 5), tiện ích, mô tả, tiền cọc
 * - Khám phá phòng công khai & lọc theo vị trí + bán kính GPS Haversine (bookingService)
 * - Đặt lịch xem phòng / Đặt cọc giữ phòng + tự động cấp tài khoản Người thuê
 * - SePay Webhook xử lý nội dung `COC <bookingId> LL <landlordId>`
 * - Chuyển giao đặt phòng sang Hợp đồng (contractService.createContract với bookingId)
 * - Tự đăng ký Người thuê (authService.registerTenant)
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const Building = require('../src/models/Building');
const Room = require('../src/models/Room');
const Service = require('../src/models/Service');
const User = require('../src/models/User');
const Role = require('../src/models/Role');
const Plan = require('../src/models/Plan');
const Contract = require('../src/models/Contract');
const DepositRecord = require('../src/models/DepositRecord');
const MeterReading = require('../src/models/MeterReading');
const SePayEvent = require('../src/models/SePayEvent');
const AdminLog = require('../src/models/AdminLog');
const Notification = require('../src/models/Notification');
const sequelize = require('../src/config/db');
const notificationService = require('../src/services/notificationService');

const buildingService = require('../src/services/buildingService');
const authService = require('../src/services/authService');
const sepayService = require('../src/services/sepayService');
const contractService = require('../src/services/contractService');

// Các module mới cần được triển khai trong bước GREEN
const RoomBooking = require('../src/models/RoomBooking');
const bookingService = require('../src/services/bookingService');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

const makeRecord = (fields) => ({
    ...fields,
    saved: 0,
    async save() { this.saved += 1; return this; },
    toJSON() { return { ...this }; }
});

describe('Building location & Room media (buildingService)', () => {
    test('createBuilding lưu city, district, ward, latitude, longitude', async () => {
        stub(sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
        stub(User, 'findByPk', async () => ({ id: 1, plan: 'pro' }));
        stub(Plan, 'findOne', async () => ({ name: 'pro', maxBuildings: -1, maxRoomsPerBuilding: -1 }));
        let createdPayload = null;
        stub(Building, 'create', async (data) => { createdPayload = data; return makeRecord({ id: 10, ...data }); });
        stub(Service, 'create', async (data) => data);

        const res = await buildingService.createBuilding(1, {
            name: 'HomeSync Cầu Giấy',
            address: '123 Xuân Thủy',
            city: 'Hà Nội',
            district: 'Cầu Giấy',
            ward: 'Dịch Vọng Hậu',
            latitude: 21.0368,
            longitude: 105.7825
        });

        assert.equal(createdPayload.city, 'Hà Nội');
        assert.equal(createdPayload.district, 'Cầu Giấy');
        assert.equal(createdPayload.ward, 'Dịch Vọng Hậu');
        assert.equal(createdPayload.latitude, 21.0368);
        assert.equal(createdPayload.longitude, 105.7825);
        assert.equal(res.id, 10);
    });

    test('createBuilding & updateBuilding từ chối tọa độ GPS không hợp lệ (400)', async () => {
        await assert.rejects(
            buildingService.createBuilding(1, {
                name: 'Sai Tọa Độ',
                address: 'Hà Nội',
                latitude: 95,
                longitude: 105
            }),
            (e) => e.statusCode === 400
        );

        stub(Building, 'findOne', async () => makeRecord({ id: 10, landlordId: 1, name: 'Cũ', address: 'HN' }));
        await assert.rejects(
            buildingService.updateBuilding(1, 10, { longitude: 200 }),
            (e) => e.statusCode === 400
        );
    });

    test('updateBuilding cập nhật địa chỉ và vị trí hành chính + GPS', async () => {
        const b = makeRecord({ id: 10, landlordId: 1, name: 'Cũ', address: 'Số 1', city: 'Hà Nội', district: 'Đống Đa' });
        stub(Building, 'findOne', async () => b);

        const updated = await buildingService.updateBuilding(1, 10, {
            name: 'Mới',
            district: 'Cầu Giấy',
            ward: 'Nghĩa Tân',
            latitude: 21.045,
            longitude: 105.79
        });

        assert.equal(updated.name, 'Mới');
        assert.equal(updated.district, 'Cầu Giấy');
        assert.equal(updated.ward, 'Nghĩa Tân');
        assert.equal(updated.latitude, 21.045);
        assert.equal(updated.saved, 1);
    });

    test('createBuilding & updateBuilding tự suy luận city, district, ward từ address khi không truyền thủ công', async () => {
        stub(sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
        stub(User, 'findByPk', async () => ({ id: 1, plan: 'pro' }));
        stub(Plan, 'findOne', async () => ({ name: 'pro', maxBuildings: -1, maxRoomsPerBuilding: -1 }));
        let createdPayload = null;
        stub(Building, 'create', async (data) => { createdPayload = data; return makeRecord({ id: 22, ...data }); });
        stub(Service, 'create', async (data) => data);

        await buildingService.createBuilding(1, {
            name: 'Map Pin Building',
            address: '15 Xuân Thủy, Dịch Vọng Hậu, Cầu Giấy, Hà Nội',
            latitude: 21.0368,
            longitude: 105.7825
        });

        assert.equal(createdPayload.city, 'Hà Nội');
        assert.equal(createdPayload.district, 'Cầu Giấy');
        assert.equal(createdPayload.ward, 'Dịch Vọng Hậu');

        const existing = makeRecord({
            id: 22,
            landlordId: 1,
            name: 'Map Pin Building',
            address: '15 Xuân Thủy, Dịch Vọng Hậu, Cầu Giấy, Hà Nội',
            city: 'Hà Nội',
            district: 'Cầu Giấy',
            ward: 'Dịch Vọng Hậu'
        });
        stub(Building, 'findOne', async () => existing);

        const updated = await buildingService.updateBuilding(1, 22, {
            address: '88 Nguyễn Huệ, Bến Nghé, Quận 1, TP.HCM',
            latitude: 10.7756,
            longitude: 106.7019
        });

        assert.equal(updated.city, 'TP.HCM');
        assert.equal(updated.district, 'Quận 1');
        assert.equal(updated.ward, 'Bến Nghé');
        assert.equal(updated.latitude, 10.7756);
        assert.equal(updated.longitude, 106.7019);
    });

    test('createRoom & updateRoom lưu tối đa 5 ảnh, amenities, description, depositAmount', async () => {
        stub(sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
        stub(Building, 'findOne', async () => ({ id: 5, landlordId: 1 }));
        stub(User, 'findByPk', async () => ({ id: 1, plan: 'pro' }));
        stub(Plan, 'findOne', async () => ({ name: 'pro', maxBuildings: -1, maxRoomsPerBuilding: -1 }));
        stub(Room, 'findOne', async () => null);
        let createdRoom = null;
        stub(Room, 'create', async (data) => { createdRoom = data; return makeRecord({ id: 99, ...data }); });

        await buildingService.createRoom(1, {
            buildingId: 5,
            roomNumber: '201',
            price: 4200000,
            capacity: 2,
            area: 28,
            depositAmount: 4200000,
            description: 'Phòng full nội thất có ban công',
            amenities: ['Wifi', 'Điều hòa', 'Ban công'],
            images: ['a1.jpg', 'a2.jpg', 'a3.jpg', 'a4.jpg', 'a5.jpg', 'a6.jpg']
        });

        assert.deepEqual(JSON.parse(createdRoom.images), ['a1.jpg', 'a2.jpg', 'a3.jpg', 'a4.jpg', 'a5.jpg']);
        assert.deepEqual(JSON.parse(createdRoom.amenities), ['Wifi', 'Điều hòa', 'Ban công']);
        assert.equal(createdRoom.depositAmount, 4200000);
        assert.equal(createdRoom.description, 'Phòng full nội thất có ban công');

        // Kiểm tra updateRoom gộp existingImages + ảnh mới upload và không vượt 5 ảnh
        const existingRoom = makeRecord({
            id: 99,
            roomNumber: '201',
            buildingId: 5,
            price: 4200000,
            images: JSON.stringify(['a1.jpg', 'a2.jpg']),
            amenities: JSON.stringify(['Wifi']),
            building: { landlordId: 1 }
        });
        stub(Room, 'findByPk', async () => existingRoom);
        const updated = await buildingService.updateRoom(1, 99, {
            existingImages: JSON.stringify(['a1.jpg']),
            images: ['new1.jpg', 'new2.jpg'],
            amenities: ['Wifi', 'Máy giặt'],
            depositAmount: 3000000,
            description: 'Đã nâng cấp máy giặt'
        });

        assert.deepEqual(JSON.parse(updated.images), ['a1.jpg', 'new1.jpg', 'new2.jpg']);
        assert.deepEqual(JSON.parse(updated.amenities), ['Wifi', 'Máy giặt']);
        assert.equal(updated.depositAmount, 3000000);
        assert.equal(updated.description, 'Đã nâng cấp máy giặt');
    });
});

describe('Public Discovery & Location/GPS Search (bookingService)', () => {
    const sampleRooms = [
        {
            id: 1,
            roomNumber: '101',
            price: '3500000.00',
            depositAmount: '3500000.00',
            area: '25.00',
            capacity: 2,
            status: 'empty',
            images: JSON.stringify(['r1.jpg']),
            amenities: JSON.stringify(['Wifi', 'Điều hòa']),
            description: 'Gần ĐH Quốc Gia',
            createdAt: '2026-11-01T00:00:00Z',
            building: {
                id: 10,
                name: 'Nhà trọ Xuân Thủy',
                address: '10 Xuân Thủy, Cầu Giấy, Hà Nội',
                city: 'Hà Nội',
                district: 'Cầu Giấy',
                ward: 'Dịch Vọng Hậu',
                latitude: 21.0368,
                longitude: 105.7825,
                service: { electricityPrice: 3500, waterPrice: 30000, internetPrice: 100000, cleaningPrice: 50000 },
                landlord: { id: 2, name: 'Anh Minh', phone: '0912345678' }
            }
        },
        {
            id: 2,
            roomNumber: '205',
            price: '5500000.00',
            depositAmount: '5500000.00',
            area: '35.00',
            capacity: 3,
            status: 'empty',
            images: JSON.stringify(['r2.jpg']),
            amenities: JSON.stringify(['Wifi', 'Điều hòa', 'Ban công', 'Máy giặt']),
            description: 'Studio cao cấp quận 1',
            createdAt: '2026-11-05T00:00:00Z',
            building: {
                id: 11,
                name: 'Saigon Central',
                address: '20 Lê Lợi, Quận 1, TP.HCM',
                city: 'TP. Hồ Chí Minh',
                district: 'Quận 1',
                ward: 'Bến Nghé',
                latitude: 10.7757,
                longitude: 106.7004,
                service: { electricityPrice: 4000, waterPrice: 35000, internetPrice: 150000, cleaningPrice: 50000 },
                landlord: { id: 3, name: 'Chị Lan', phone: '0988776655' }
            }
        }
    ];

    test('getPublicRooms lọc theo city/district/search/amenities và tính khoảng cách GPS Haversine', async () => {
        let queryWhere = null;
        stub(Room, 'findAll', async (opts) => {
            queryWhere = opts.where;
            return sampleRooms.map((r) => ({ ...r, toJSON: () => ({ ...r }) }));
        });

        // Tìm quanh khu vực Cầu Giấy (21.038, 105.785), bán kính 5km
        const nearby = await bookingService.getPublicRooms({
            lat: 21.038,
            lng: 105.785,
            radiusKm: 5,
            sort: 'nearest'
        });

        assert.equal(queryWhere.status, 'empty');
        assert.equal(nearby.rooms.length, 1);
        assert.equal(nearby.rooms[0].id, 1);
        assert.ok(nearby.rooms[0].distanceKm <= 1.0);

        // Lọc theo thành phố + tiện ích
        const hcm = await bookingService.getPublicRooms({
            city: 'TP. Hồ Chí Minh',
            amenity: 'Ban công'
        });
        assert.equal(hcm.rooms.length, 1);
        assert.equal(hcm.rooms[0].id, 2);
    });

    test('getPublicLocations trả về danh sách Thành phố -> Quận/Huyện có phòng trống', async () => {
        stub(Room, 'findAll', async () => sampleRooms.map((r) => ({ ...r, toJSON: () => ({ ...r }) })));
        const locs = await bookingService.getPublicLocations();
        assert.ok(locs.cities.includes('Hà Nội'));
        assert.ok(locs.cities.includes('TP. Hồ Chí Minh'));
        assert.ok(locs.districtsByCity['Hà Nội'].includes('Cầu Giấy'));
    });

    test('getPublicLocations luôn có đủ 63 tỉnh/thành VN mặc định khi DB trống và tự suy luận từ address', async () => {
        stub(Room, 'findAll', async () => []);
        const emptyLocs = await bookingService.getPublicLocations();
        assert.ok(emptyLocs.cities.length >= 63);
        assert.ok(emptyLocs.cities.includes('Hà Nội'));
        assert.ok(emptyLocs.cities.includes('TP.HCM'));
        assert.ok(emptyLocs.cities.includes('Đà Nẵng'));
        assert.ok(emptyLocs.cities.includes('An Giang'));
        assert.ok(emptyLocs.cities.includes('Cà Mau'));
        assert.ok(emptyLocs.districtsByCity['TP.HCM'].includes('Quận 1'));
        assert.ok((emptyLocs.wardsByDistrict['Hà Nội|Cầu Giấy'] || []).length > 0);
        assert.ok((emptyLocs.wardsByDistrict['An Giang|TP. Long Xuyên'] || []).length > 0);

        const blankColsRoom = {
            id: 99,
            roomNumber: '909',
            price: 3000000,
            status: 'empty',
            building: {
                id: 99,
                name: 'Tòa nhà Ẩn Cột',
                address: '45 Lê Lợi, Phường Bến Nghé, Quận 1, TP. Hồ Chí Minh',
                city: '',
                district: '',
                ward: ''
            }
        };
        stub(Room, 'findAll', async () => [{ ...blankColsRoom, toJSON: () => ({ ...blankColsRoom }) }]);
        const inferredLocs = await bookingService.getPublicLocations();
        assert.ok(inferredLocs.cities.includes('TP.HCM'));
        assert.ok(inferredLocs.districtsByCity['TP.HCM'].includes('Quận 1'));
    });

    test('getPublicRooms khớp alias TP.HCM <-> TP. Hồ Chí Minh và suy luận từ address', async () => {
        stub(Room, 'findAll', async () => sampleRooms.map((r) => ({ ...r, toJSON: () => ({ ...r }) })));
        const aliasRes = await bookingService.getPublicRooms({ city: 'TP.HCM' });
        assert.equal(aliasRes.rooms.length, 1);
        assert.equal(aliasRes.rooms[0].id, 2);

        const addrOnlyRoom = {
            id: 88,
            roomNumber: '808',
            title: 'Phòng Quận 5',
            price: 4000000,
            area: 25,
            capacity: 2,
            status: 'empty',
            amenities: [],
            images: [],
            building: {
                id: 88,
                name: 'Nhà Q5',
                address: '120 Nguyễn Văn Cừ, Quận 5, TP. Hồ Chí Minh',
                city: null,
                district: null,
                ward: null
            }
        };
        stub(Room, 'findAll', async () => [{ ...addrOnlyRoom, toJSON: () => ({ ...addrOnlyRoom }) }]);
        const inferredRes = await bookingService.getPublicRooms({ city: 'TP.HCM', district: 'Quận 5' });
        assert.equal(inferredRes.rooms.length, 1);
        assert.equal(inferredRes.rooms[0].id, 88);
    });
});

describe('Public Booking & Auto Tenant Provisioning (bookingService)', () => {
    test('createPublicBooking cho đặt lịch xem phòng: tự tạo tài khoản tenant mới khi chưa tồn tại', async () => {
        stub(sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
        const emptyRoom = makeRecord({
            id: 1,
            roomNumber: '101',
            price: 3500000,
            depositAmount: 3500000,
            status: 'empty',
            buildingId: 10,
            building: { id: 10, name: 'Nhà trọ A', landlordId: 2 }
        });
        stub(Room, 'findByPk', async () => emptyRoom);
        stub(User, 'findOne', async () => null);
        stub(Role, 'findOne', async () => ({ id: 3, name: 'tenant' }));
        let createdUserPayload = null;
        stub(User, 'create', async (data) => {
            createdUserPayload = data;
            return makeRecord({ id: 55, ...data });
        });
        let createdBookingPayload = null;
        stub(RoomBooking, 'create', async (data) => {
            createdBookingPayload = data;
            return makeRecord({ id: 77, ...data });
        });
        stub(notificationService, 'createNotification', async () => ({}));

        const res = await bookingService.createPublicBooking({
            roomId: 1,
            guestName: 'Nguyễn Khách',
            guestPhone: '0981234567',
            type: 'viewing',
            viewingDate: '2026-11-20T10:00:00Z',
            note: 'Muốn xem buổi sáng'
        });

        assert.equal(createdUserPayload.phone, '0981234567');
        assert.equal(createdUserPayload.ownerId, 2);
        assert.equal(createdBookingPayload.type, 'viewing');
        assert.equal(createdBookingPayload.tenantId, 55);
        assert.equal(res.booking.id, 77);
        assert.ok(res.auth?.token);
        assert.equal(res.auth.user.role, 'tenant');
    });

    test('createPublicBooking cho đặt cọc giữ phòng: sinh transferCode COC <id> LL <landlordId> & VietQR URL', async () => {
        stub(sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
        const emptyRoom = makeRecord({
            id: 2,
            roomNumber: '202',
            price: 4000000,
            depositAmount: 3000000,
            status: 'empty',
            buildingId: 10,
            building: { id: 10, name: 'Nhà trọ B', landlordId: 5 }
        });
        stub(Room, 'findByPk', async () => emptyRoom);
        stub(User, 'findOne', async () => makeRecord({ id: 88, name: 'Khách Cũ', phone: '0909090909', roleData: { name: 'tenant' } }));
        const bookingRec = makeRecord({
            id: 120,
            roomId: 2,
            buildingId: 10,
            landlordId: 5,
            tenantId: 88,
            type: 'deposit',
            depositAmount: 3000000,
            paymentStatus: 'unpaid',
            status: 'pending'
        });
        stub(RoomBooking, 'create', async (data) => Object.assign(bookingRec, data, { id: 120 }));
        stub(notificationService, 'createNotification', async () => ({}));

        const res = await bookingService.createPublicBooking({
            roomId: 2,
            guestName: 'Khách Cũ',
            guestPhone: '0909090909',
            type: 'deposit',
            moveInDate: '2026-12-01'
        });

        assert.equal(res.booking.depositAmount, 3000000);
        assert.equal(res.payment.transferCode, 'COC 120 LL 5');
        assert.match(res.payment.qrCodeUrl, /qr\.sepay\.vn\/img/);
        assert.match(res.payment.qrCodeUrl, /COC%20120%20LL%205/);
    });

    test('updateBookingStatus: chủ nhà xác nhận đã nhận cọc -> khóa phòng sang reserved; từ chối -> mở khóa về empty', async () => {
        stub(sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
        const room = makeRecord({ id: 2, roomNumber: '202', status: 'empty' });
        const booking = makeRecord({
            id: 120,
            roomId: 2,
            landlordId: 5,
            tenantId: 88,
            type: 'deposit',
            status: 'pending',
            paymentStatus: 'pending',
            room
        });
        stub(RoomBooking, 'findOne', async () => booking);
        stub(Room, 'findByPk', async () => room);
        stub(notificationService, 'createNotification', async () => ({}));

        const paidRes = await bookingService.updateBookingStatus(5, 120, { status: 'deposit_paid' });
        assert.equal(paidRes.status, 'deposit_paid');
        assert.equal(paidRes.paymentStatus, 'paid');
        assert.equal(room.status, 'reserved');

        const rejectRes = await bookingService.updateBookingStatus(5, 120, { status: 'rejected' });
        assert.equal(rejectRes.status, 'rejected');
        assert.equal(room.status, 'empty');
    });
});

describe('SePay Webhook cho Tiền Cọc (sepayService)', () => {
    test('nhận nội dung COC <bookingId> LL <landlordId> đủ tiền -> deposit_paid & khóa phòng reserved', async () => {
        stub(sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
        stub(SePayEvent, 'create', async (row) => ({ ...row, async save() {}, async destroy() {} }));
        stub(Role, 'findOne', async () => ({ id: 1 }));
        stub(User, 'findOne', async () => ({ id: 99 }));
        stub(AdminLog, 'create', async () => ({}));
        const notes = [];
        stub(notificationService, 'createNotification', async (...args) => { notes.push(args); });

        const room = makeRecord({ id: 2, roomNumber: '202', status: 'empty', building: { id: 10, landlordId: 5, name: 'Nhà B' } });
        const booking = makeRecord({
            id: 120,
            roomId: 2,
            buildingId: 10,
            landlordId: 5,
            tenantId: 88,
            type: 'deposit',
            depositAmount: 3000000,
            paymentStatus: 'unpaid',
            status: 'pending',
            room
        });
        stub(RoomBooking, 'findByPk', async () => booking);
        stub(Room, 'findByPk', async () => room);

        const res = await sepayService.processWebhookPayload({
            id: 9001,
            transferType: 'in',
            content: 'MBVCB COC 120 LL 5',
            transferAmount: 3000000,
            referenceCode: 'FT12345'
        });

        assert.equal(res.success, true);
        assert.equal(res.type, 'ROOM_BOOKING_DEPOSIT');
        assert.equal(booking.paymentStatus, 'paid');
        assert.equal(booking.status, 'deposit_paid');
        assert.equal(room.status, 'reserved');
        assert.ok(notes.length >= 1);
    });
});

describe('Contract Hand-off & Tenant Registration', () => {
    test('contractService.createContract cho phép lập HĐ từ booking đã đặt cọc (room.status === reserved)', async () => {
        stub(sequelize, 'transaction', async (fn) => fn({}));
        const room = makeRecord({ id: 2, roomNumber: '202', price: 4000000, capacity: 2, status: 'reserved', building: { landlordId: 5 } });
        const booking = makeRecord({ id: 120, roomId: 2, landlordId: 5, tenantId: 88, status: 'deposit_paid', contractId: null });
        stub(Room, 'findByPk', async () => room);
        stub(RoomBooking, 'findByPk', async () => booking);
        stub(Contract, 'findOne', async () => null);
        stub(MeterReading, 'findOne', async () => null);
        stub(User, 'findOne', async () => ({ id: 88, ownerId: 5, status: 'active' }));
        stub(Contract, 'create', async (data) => makeRecord({ id: 500, ...data }));
        stub(DepositRecord, 'create', async () => ({}));

        const created = await contractService.createContract(
            5,
            {
                tenantId: 88,
                roomId: 2,
                bookingId: 120,
                startDate: '2026-12-01',
                endDate: '2027-11-30',
                deposit: 3000000,
                electricityPrice: 3500,
                waterPrice: 20000,
                initialElectricity: 100,
                initialWater: 20,
                landlordSignature: 'data:image/png;base64,AAA'
            },
            { cccdFront: [{ filename: 'f.jpg' }], cccdBack: [{ filename: 'b.jpg' }] }
        );

        assert.equal(created.id, 500);
        assert.equal(booking.status, 'contract_created');
        assert.equal(booking.contractId, 500);
    });

    test('authService.registerTenant tạo tài khoản người thuê với JWT token', async () => {
        stub(User, 'findOne', async () => null);
        stub(Role, 'findOne', async () => ({ id: 3, name: 'tenant' }));
        stub(User, 'create', async (data) => makeRecord({ id: 321, ...data, plan: 'free' }));

        const res = await authService.registerTenant({
            name: 'Trần Thu Hà',
            phone: '0912345678',
            email: 'ha@example.com',
            password: 'password123'
        });

        assert.equal(res.role, 'tenant');
        assert.equal(res.phone, '0912345678');
        assert.ok(res.token);
    });
});
