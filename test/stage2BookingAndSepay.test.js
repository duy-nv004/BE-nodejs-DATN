const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const sequelize = require('../src/config/db');
const Room = require('../src/models/Room');
const User = require('../src/models/User');
const Role = require('../src/models/Role');
const RoomBooking = require('../src/models/RoomBooking');
const DepositRecord = require('../src/models/DepositRecord');
const SePayEvent = require('../src/models/SePayEvent');
const AdminLog = require('../src/models/AdminLog');
const notificationService = require('../src/services/notificationService');
const sseService = require('../src/services/sseService');

const bookingService = require('../src/services/bookingService');
const sepayService = require('../src/services/sepayService');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => {
    while (restores.length) restores.pop()();
});

const makeRecord = (data) => ({
    ...data,
    save: async function () { return this; },
    toJSON() { return { ...this }; }
});

describe('Stage 2 (P0+P1): Public Booking Security (ATO/IDOR), Soft-Hold 15m & SePay Conflict', () => {
    test('createPublicBooking không trả JWT (token === null, requiresLogin === true) khi SĐT đã có tài khoản', async () => {
        stub(sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
        stub(Room, 'findByPk', async () => makeRecord({
            id: 1, roomNumber: '101', price: 3500000, depositAmount: 3500000, status: 'empty',
            buildingId: 10, building: { id: 10, name: 'Nhà A', landlordId: 2 }
        }));
        stub(RoomBooking, 'findOne', async () => null);
        stub(User, 'findOne', async () => makeRecord({
            id: 77, name: 'Victim Tenant', phone: '0912345678', status: 'active', roleData: { name: 'tenant' }
        }));
        stub(RoomBooking, 'create', async (data) => makeRecord({ id: 201, ...data }));
        stub(notificationService, 'createNotification', async () => ({}));

        const res = await bookingService.createPublicBooking({
            roomId: 1,
            guestName: 'Attacker',
            guestPhone: '0912345678',
            type: 'viewing'
        });

        assert.equal(res.auth.token, null);
        assert.equal(res.auth.isNewAccount, false);
        assert.equal(res.auth.requiresLogin, true);
        assert.ok(typeof res.booking.lookupToken === 'string' && res.booking.lookupToken.length >= 16);
    });

    test('getPublicBookingStatus & markBookingTransferred chặn IDOR bằng lookupToken (403 khi sai hoặc thiếu)', async () => {
        const booking = makeRecord({
            id: 55,
            roomId: 1,
            landlordId: 2,
            type: 'deposit',
            status: 'pending',
            paymentStatus: 'unpaid',
            depositAmount: 3500000,
            transferCode: 'COC 55 LL 2',
            lookupToken: 'secret-lookup-token-55',
            room: { id: 1, roomNumber: '101', status: 'empty' },
            building: { id: 10, name: 'Nhà A', address: '12 Láng Hạ' }
        });
        stub(RoomBooking, 'findByPk', async () => booking);
        stub(notificationService, 'createNotification', async () => ({}));

        await assert.rejects(
            () => bookingService.getPublicBookingStatus(55),
            (e) => e.statusCode === 403
        );
        await assert.rejects(
            () => bookingService.getPublicBookingStatus(55, 'wrong-token'),
            (e) => e.statusCode === 403
        );
        await assert.rejects(
            () => bookingService.markBookingTransferred(55, 'wrong-token'),
            (e) => e.statusCode === 403
        );

        const okStatus = await bookingService.getPublicBookingStatus(55, 'secret-lookup-token-55');
        assert.equal(okStatus.id, 55);
        assert.equal(okStatus.paymentStatus, 'unpaid');

        const okMarked = await bookingService.markBookingTransferred(55, 'secret-lookup-token-55');
        assert.equal(okMarked.paymentStatus, 'pending');
    });

    test('Soft-Hold 15 phút: đặt cọc tạo holdExpiresAt và chặn người thứ 2 cùng phòng với 409; releaseExpiredBookingHolds hủy đơn hết hạn', async () => {
        stub(sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
        stub(Room, 'findByPk', async () => makeRecord({
            id: 9, roomNumber: '301', price: 4000000, depositAmount: 4000000, status: 'empty',
            buildingId: 10, building: { id: 10, name: 'Nhà A', landlordId: 2 }
        }));
        stub(User, 'findOne', async () => null);
        stub(Role, 'findOne', async () => ({ id: 3, name: 'tenant' }));
        stub(User, 'create', async (d) => makeRecord({ id: 91, ...d }));
        stub(notificationService, 'createNotification', async () => ({}));

        let capturedHold = null;
        stub(RoomBooking, 'findOne', async () => capturedHold);
        stub(RoomBooking, 'create', async (d) => {
            capturedHold = makeRecord({ id: 300, ...d });
            return capturedHold;
        });

        const first = await bookingService.createPublicBooking({
            roomId: 9, guestName: 'Khách 1', guestPhone: '0981111111', type: 'deposit'
        });
        assert.ok(first.booking.holdExpiresAt instanceof Date || typeof first.booking.holdExpiresAt === 'string');
        assert.ok(new Date(first.booking.holdExpiresAt).getTime() > Date.now() + 10 * 60 * 1000);

        await assert.rejects(
            () => bookingService.createPublicBooking({
                roomId: 9, guestName: 'Khách 2', guestPhone: '0982222222', type: 'deposit'
            }),
            (e) => e.statusCode === 409
        );

        let updateCalled = false;
        stub(RoomBooking, 'update', async (vals, opts) => {
            updateCalled = opts.where.status === 'pending' && opts.where.type === 'deposit';
            return [2];
        });
        const releasedCount = await bookingService.releaseExpiredBookingHolds();
        assert.equal(updateCalled, true);
        assert.equal(releasedCount, 2);
    });

    test('SePay đặt cọc khi phòng trống -> tạo DepositRecord(held); khi phòng đã reserved/occupied -> deposit_conflict', async () => {
        stub(sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
        stub(SePayEvent, 'create', async (row) => ({ ...row, async save() {}, async destroy() {} }));
        stub(Role, 'findOne', async () => ({ id: 1 }));
        stub(User, 'findOne', async () => ({ id: 99 }));
        stub(AdminLog, 'create', async () => ({}));

        const events = [];
        stub(sseService, 'sendToUser', (uid, ev, data) => { events.push({ uid, ev, data }); });
        const notes = [];
        stub(notificationService, 'createNotification', async (...args) => { notes.push(args); });

        let createdDeposit = null;
        stub(DepositRecord, 'create', async (d) => { createdDeposit = d; return d; });

        // Case A: Phòng đang trống -> thành công & tạo DepositRecord
        const emptyRoom = makeRecord({ id: 2, roomNumber: '202', status: 'empty', building: { id: 10, landlordId: 5, name: 'Nhà B' } });
        const b1 = makeRecord({
            id: 120, roomId: 2, buildingId: 10, landlordId: 5, tenantId: 88, type: 'deposit',
            depositAmount: 3000000, paymentStatus: 'unpaid', status: 'pending', contractId: null, room: emptyRoom
        });
        stub(RoomBooking, 'findByPk', async () => b1);
        stub(Room, 'findByPk', async () => emptyRoom);

        const okRes = await sepayService.processWebhookPayload({
            id: 9010, transferType: 'in', content: 'COC 120 LL 5', transferAmount: 3000000, referenceCode: 'FT9010'
        });
        assert.equal(okRes.success, true);
        assert.equal(b1.status, 'deposit_paid');
        assert.equal(emptyRoom.status, 'reserved');
        assert.equal(createdDeposit.bookingId, 120);
        assert.equal(createdDeposit.status, 'held');

        // Case B: Phòng đã bị người khác đặt/thuê trước -> đánh dấu deposit_conflict, không ghi đè room.status
        const reservedRoom = makeRecord({ id: 3, roomNumber: '203', status: 'reserved', building: { id: 10, landlordId: 5, name: 'Nhà B' } });
        const b2 = makeRecord({
            id: 121, roomId: 3, buildingId: 10, landlordId: 5, tenantId: 89, type: 'deposit',
            depositAmount: 3000000, paymentStatus: 'unpaid', status: 'pending', contractId: null, room: reservedRoom
        });
        stub(RoomBooking, 'findByPk', async () => b2);
        stub(Room, 'findByPk', async () => reservedRoom);

        const conflictRes = await sepayService.processWebhookPayload({
            id: 9011, transferType: 'in', content: 'COC 121 LL 5', transferAmount: 3000000, referenceCode: 'FT9011'
        });
        assert.equal(conflictRes.conflict, true);
        assert.equal(conflictRes.type, 'BOOKING_DEPOSIT_CONFLICT');
        assert.equal(b2.status, 'deposit_conflict');
        assert.equal(reservedRoom.status, 'reserved');
        assert.ok(events.some((e) => e.ev === 'booking_deposit_conflict'));
    });

    test('publicRoutes & RoomBooking model & cronWorker có rate limit và deposit_conflict + hold cleanup', () => {
        const publicRoutesSrc = fs.readFileSync(path.join(__dirname, '../src/routes/publicRoutes.js'), 'utf8');
        assert.match(publicRoutesSrc, /\/bookings\/:id\/status['"][^\n]*Limiter/);
        assert.match(publicRoutesSrc, /\/bookings\/:id\/mark-transferred['"][^\n]*bookingLimiter/);

        const bookingModelSrc = fs.readFileSync(path.join(__dirname, '../src/models/RoomBooking.js'), 'utf8');
        assert.match(bookingModelSrc, /deposit_conflict/);
        assert.match(bookingModelSrc, /lookupToken/);
        assert.match(bookingModelSrc, /holdExpiresAt/);

        const cronSrc = fs.readFileSync(path.join(__dirname, '../src/jobs/cronWorker.js'), 'utf8');
        assert.match(cronSrc, /releaseExpiredBookingHolds/);
    });
});
