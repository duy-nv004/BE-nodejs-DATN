/**
 * Stage 5 Audit Fixes — Backend TDD (RED -> GREEN -> REFACTOR):
 * - Guarantee 1: Chống IDOR tại meterService/meterController.checkMeterAnomaly (xác thực quyền sở hữu Building.landlordId)
 * - Guarantee 2: Tính đúng cleaningPrice * numTenants trong generateInvoice & computeSettlement,
 *   đồng thời tính pendingRepairFee vào finalInvoiceEstimate trong computeSettlement/getSettlementPreview
 * - Guarantee 3: Minh bạch Overpayment trong invoiceService.getRevenueStats (overpaidAmount, recognizedRevenue)
 * - Guarantee 4: Đồng bộ DepositRecord ('refunded' / 'forfeited') khi booking deposit_paid bị rejected hoặc cancelled
 * - Guarantee 5: Đẩy bộ lọc city/district/ward xuống SQL trong bookingService.getPublicRooms & exclude chữ ký LONGTEXT trong getContracts
 * - Guarantee 6: Trả generatedPassword 1 lần trong createPublicBooking khi tạo tài khoản mới không nhập password &
 *   chặn buildingService.updateTenant sửa hồ sơ gốc nếu khách đang có hợp đồng active với chủ nhà khác (403)
 * - Guarantee 7: Clean Code supportService.js (xóa origSupportUpdate/origUserFindByPk, dùng isOfflineOrMockTxError)
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'stage5-test-secret';

const sequelize = require('../src/config/db');
const Room = require('../src/models/Room');
const Building = require('../src/models/Building');
const MeterReading = require('../src/models/MeterReading');
const Contract = require('../src/models/Contract');
const Invoice = require('../src/models/Invoice');
const DepositRecord = require('../src/models/DepositRecord');
const RoomBooking = require('../src/models/RoomBooking');
const SupportRequest = require('../src/models/SupportRequest');
const User = require('../src/models/User');
const Role = require('../src/models/Role');

const meterService = require('../src/services/meterService');
const meterController = require('../src/controllers/meterController');
const invoiceService = require('../src/services/invoiceService');
const contractService = require('../src/services/contractService');
const bookingService = require('../src/services/bookingService');
const buildingService = require('../src/services/buildingService');
const supportService = require('../src/services/supportService');
const notificationService = require('../src/services/notificationService');
const sseService = require('../src/services/sseService');
const telegramService = require('../src/utils/telegramService');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => {
    while (restores.length) restores.pop()();
});

describe('Guarantee 1: Chống IDOR tại checkMeterAnomaly', () => {
    test('meterService.checkMeterAnomaly(roomId, payload, { landlordId: 1 }) với phòng của landlord 2 -> 404 và không truy vấn MeterReading', async () => {
        let meterQueried = false;
        stub(Room, 'findByPk', async () => ({
            id: 5,
            roomNumber: '101',
            building: { id: 10, landlordId: 2 }
        }));
        stub(MeterReading, 'findAll', async () => {
            meterQueried = true;
            return [];
        });

        await assert.rejects(
            () => meterService.checkMeterAnomaly(5, { electricityValue: 500, period: '2026-10' }, { landlordId: 1 }),
            (e) => e.statusCode === 404 && /Phòng trọ không tồn tại hoặc bạn không có quyền kiểm tra/.test(e.message)
        );
        assert.equal(meterQueried, false);
    });

    test('meterController.checkMeterAnomaly truyền req.user.id vào service và chặn chủ trọ khác với 404', async () => {
        stub(Room, 'findByPk', async () => ({
            id: 5,
            roomNumber: '101',
            building: { id: 10, landlordId: 2 }
        }));
        stub(MeterReading, 'findAll', async () => []);

        let statusCode = null;
        let jsonBody = null;
        const req = {
            user: { id: 1 },
            body: { roomId: 5, electricityValue: 500, period: '2026-10' }
        };
        const res = {
            status(code) { statusCode = code; return res; },
            json(body) { jsonBody = body; return res; }
        };

        await meterController.checkMeterAnomaly(req, res);
        assert.equal(statusCode, 404);
        assert.match(jsonBody?.message || '', /Phòng trọ không tồn tại hoặc bạn không có quyền kiểm tra/);
    });
});

describe('Guarantee 2: cleaningPrice * numTenants & pendingRepairFee trong computeSettlement', () => {
    test('invoiceService.generateInvoice nhân cleaningPrice theo numTenants và giữ mặc định 1 khi undefined', async () => {
        let createdPayload = null;
        const setupGen = (contractOverrides) => {
            stub(sequelize, 'transaction', async (fn) => fn({}));
            stub(Room, 'findByPk', async () => ({ id: 5, roomNumber: '101', price: 3000000, building: { landlordId: 1 } }));
            stub(Contract, 'findOne', async () => ({
                id: 2,
                tenantId: 7,
                rentPrice: 3000000,
                paymentDay: 30,
                electricityPrice: 3500,
                waterPrice: 20000,
                internetPrice: 100000,
                cleaningPrice: 50000,
                initialElectricity: 80,
                initialWater: 8,
                endDate: '2027-12-31',
                ...contractOverrides
            }));
            stub(Invoice, 'findOne', async () => null);
            stub(MeterReading, 'findOne', async ({ where }) => {
                const isPrev = typeof where.period === 'object';
                if (where.type === 'electricity') return { readingValue: isPrev ? 100 : 120 };
                return { readingValue: isPrev ? 10 : 12 };
            });
            stub(SupportRequest, 'findAll', async () => []);
            stub(Invoice, 'create', async (data) => {
                createdPayload = data;
                return { id: 11, ...data, save: async () => {} };
            });
            stub(User, 'findOne', async () => null);
            stub(sseService, 'sendToUser', () => {});
            stub(telegramService, 'sendInvoiceToTelegram', async () => {});
        };

        setupGen({ numTenants: 3 });
        await invoiceService.generateInvoice({ roomId: 5, month: 10, year: 2026 }, 1);
        assert.equal(createdPayload.serviceTotal, 250000); // 100000 + 50000 * 3

        setupGen({ numTenants: 1 });
        await invoiceService.generateInvoice({ roomId: 5, month: 10, year: 2026 }, 1);
        assert.equal(createdPayload.serviceTotal, 150000);

        setupGen({ numTenants: undefined });
        await invoiceService.generateInvoice({ roomId: 5, month: 10, year: 2026 }, 1);
        assert.equal(createdPayload.serviceTotal, 150000);
    });

    test('contractService.getSettlementPreview tính pendingRepairFee và nhân cleaningPrice * numTenants', async () => {
        stub(Contract, 'findByPk', async () => ({
            id: 3,
            roomId: 5,
            tenantId: 7,
            status: 'active',
            startDate: '2026-01-01',
            endDate: '2027-12-31',
            rentPrice: 3000000,
            electricityPrice: 3500,
            waterPrice: 20000,
            internetPrice: 100000,
            cleaningPrice: 50000,
            numTenants: 2,
            initialElectricity: 100,
            initialWater: 10,
            room: { id: 5, roomNumber: '101', price: 3000000, building: { landlordId: 1 } }
        }));
        stub(Contract, 'findAll', async () => []);
        stub(Invoice, 'findOne', async () => null);
        stub(Invoice, 'findAll', async () => []);
        stub(MeterReading, 'findOne', async ({ where }) => {
            if (where?.period?.[Op.gt]) return null;
            if (where.type === 'electricity') return { readingValue: 100 };
            return { readingValue: 10 };
        });
        stub(DepositRecord, 'findOne', async () => ({ id: 8, amount: 5000000, status: 'held' }));
        stub(SupportRequest, 'findAll', async ({ where }) => {
            assert.equal(where.roomId, 5);
            assert.equal(where.chargeToTenant, true);
            assert.equal(where.invoiceId, null);
            return [{ id: 9, repairCost: 200000, chargeToTenant: true, invoiceId: null }];
        });

        const preview = await contractService.getSettlementPreview(1, 3, {
            terminationDate: '2026-11-30',
            finalElectricity: 120,
            finalWater: 15
        });

        // 3.000.000 phòng + 20*3500 điện + 5*20000 nước + 100000 net + 50000*2 rác + 200000 sửa chữa = 3.570.000
        assert.equal(preview.pendingRepairFee, 200000);
        assert.equal(preview.finalInvoiceEstimate, 3570000);
        assert.equal(preview.refund, 5000000 - 3570000);
    });
});

describe('Guarantee 3: Minh bạch Overpayment trong invoiceService.getRevenueStats', () => {
    test('trả overpaidAmount và recognizedRevenue không vượt totalAmount khi khách chuyển thừa', async () => {
        stub(Invoice, 'findAll', async () => [
            { roomId: 1, totalAmount: 100, isPaid: true, paidAmount: 120, paymentMethod: 'transfer', month: 1, year: 2026 }
        ]);
        stub(SupportRequest, 'findAll', async () => []);
        stub(Room, 'count', async () => 0);

        const res = await invoiceService.getRevenueStats(1, { month: 1, year: 2026 });
        assert.equal(res.stats.totalCollected, 120);
        assert.equal(res.stats.overpaidAmount, 20);
        assert.equal(res.stats.recognizedRevenue, 100);
    });
});

describe('Guarantee 4: Đồng bộ DepositRecord khi reject/cancel booking đã đặt cọc', () => {
    const setupBooking = (status = 'deposit_paid') => {
        const booking = {
            id: 40,
            roomId: 5,
            landlordId: 1,
            tenantId: 8,
            status,
            depositAmount: 3000000,
            save: async () => {},
            room: { id: 5, roomNumber: '101', status: 'reserved', save: async () => {} }
        };
        stub(sequelize, 'transaction', async (fn) => fn(null));
        stub(RoomBooking, 'findOne', async () => booking);
        stub(Contract, 'count', async () => 0);
        stub(notificationService, 'createNotification', async () => {});
        stub(sseService, 'sendToUser', () => {});
        let depositUpdateCall = null;
        stub(DepositRecord, 'update', async (values, opts) => {
            depositUpdateCall = { values, opts };
            return [1];
        });
        return { getDepositUpdate: () => depositUpdateCall };
    };

    test('rejected booking deposit_paid chuyển DepositRecord sang refunded với refundedAt', async () => {
        const ctx = setupBooking('deposit_paid');
        await bookingService.updateBookingStatus(1, 40, { status: 'rejected', note: 'Phòng bảo trì đột xuất' });
        const call = ctx.getDepositUpdate();
        assert.ok(call, 'DepositRecord.update phải được gọi');
        assert.equal(call.values.status, 'refunded');
        assert.equal(call.values.refundedAmount, 3000000);
        assert.ok(call.values.refundedAt instanceof Date);
        assert.deepEqual(call.opts.where, { bookingId: 40, status: 'held' });
    });

    test('cancelled booking deposit_paid với forfeitDeposit: true chuyển DepositRecord sang forfeited', async () => {
        const ctx = setupBooking('deposit_paid');
        await bookingService.updateBookingStatus(1, 40, { status: 'cancelled', forfeitDeposit: true, note: 'Khách bỏ cọc' });
        const call = ctx.getDepositUpdate();
        assert.ok(call, 'DepositRecord.update phải được gọi');
        assert.equal(call.values.status, 'forfeited');
        assert.equal(call.values.deductedAmount, 3000000);
        assert.deepEqual(call.opts.where, { bookingId: 40, status: 'held' });
    });
});

describe('Guarantee 5: SQL filter trong getPublicRooms & loại chữ ký trong getContracts', () => {
    test('bookingService.getPublicRooms đẩy bộ lọc city/district/ward xuống include[0].where (SQL)', async () => {
        let capturedOpts = null;
        stub(Room, 'findAll', async (opts) => {
            capturedOpts = opts;
            return [];
        });

        await bookingService.getPublicRooms({ city: 'Hà Nội', district: 'Cầu Giấy', ward: 'Dịch Vọng' });
        const buildingInclude = capturedOpts?.include?.find((i) => i.as === 'building');
        assert.ok(buildingInclude?.where, 'building include phải có where để lọc từ SQL');
        assert.ok(Array.isArray(buildingInclude.where[Op.and]), 'where phải chứa Op.and');
        assert.equal(buildingInclude.where[Op.and].length, 3);
    });

    test('contractService.getContracts exclude landlordSignature và tenantSignature khỏi SQL query', async () => {
        let capturedOpts = null;
        stub(Contract, 'findAll', async (opts) => {
            capturedOpts = opts;
            return [];
        });

        await contractService.getContracts(1);
        assert.ok(Array.isArray(capturedOpts?.attributes?.exclude), 'attributes.exclude phải là mảng');
        assert.ok(capturedOpts.attributes.exclude.includes('landlordSignature'));
        assert.ok(capturedOpts.attributes.exclude.includes('tenantSignature'));
    });
});

describe('Guarantee 6: generatedPassword trả 1 lần & cô lập updateTenant đa chủ trọ', () => {
    const setupCreateBooking = ({ existingUser = null } = {}) => {
        stub(sequelize, 'transaction', async (fn) => fn(null));
        stub(Room, 'findByPk', async () => ({
            id: 5,
            buildingId: 2,
            roomNumber: '101',
            status: 'empty',
            price: 3000000,
            depositAmount: 3000000,
            building: { id: 2, name: 'Nhà Trọ Xanh', landlordId: 1 }
        }));
        stub(RoomBooking, 'findOne', async () => null);
        stub(User, 'findOne', async () => existingUser);
        stub(Role, 'findOne', async () => ({ id: 3, name: 'tenant' }));
        stub(User, 'create', async (data) => ({ id: 88, ...data }));
        stub(RoomBooking, 'create', async (data) => ({ id: 77, ...data, save: async () => {} }));
        stub(notificationService, 'createNotification', async () => {});
        stub(sseService, 'sendToUser', () => {});
    };

    test('createPublicBooking: tài khoản mới không nhập password -> trả auth.generatedPassword dạng Hs@...', async () => {
        setupCreateBooking({ existingUser: null });
        const res = await bookingService.createPublicBooking({
            roomId: 5,
            guestName: 'Nguyễn Văn Khách',
            guestPhone: '0912345678',
            type: 'viewing'
        });
        assert.equal(res.auth.isNewAccount, true);
        assert.match(res.auth.generatedPassword || '', /^Hs@[a-f0-9]+$/);
    });

    test('createPublicBooking: tự nhập password hoặc tài khoản đã có -> generatedPassword === null', async () => {
        setupCreateBooking({ existingUser: null });
        const withCustomPw = await bookingService.createPublicBooking({
            roomId: 5,
            guestName: 'Nguyễn Văn Khách',
            guestPhone: '0912345678',
            password: 'User@1234',
            type: 'viewing'
        });
        assert.equal(withCustomPw.auth.isNewAccount, true);
        assert.equal(withCustomPw.auth.generatedPassword, null);

        setupCreateBooking({
            existingUser: {
                id: 99,
                name: 'Khách Cũ',
                phone: '0912345678',
                status: 'active',
                ownerId: 1,
                roleData: { name: 'tenant' },
                save: async () => {}
            }
        });
        const existingRes = await bookingService.createPublicBooking({
            roomId: 5,
            guestName: 'Khách Cũ',
            guestPhone: '0912345678',
            type: 'viewing'
        });
        assert.equal(existingRes.auth.isNewAccount, false);
        assert.equal(existingRes.auth.generatedPassword, null);
    });

    test('buildingService.updateTenant chặn 403 khi khách đang có hợp đồng active với chủ trọ khác', async () => {
        let saved = false;
        stub(User, 'findOne', async () => ({
            id: 50,
            name: 'Thuê Đa Nơi',
            ownerId: 1,
            phone: '0901112223',
            email: 'a@b.vn',
            save: async () => { saved = true; }
        }));
        stub(Contract, 'count', async ({ where, include }) => {
            assert.equal(where.tenantId, 50);
            assert.equal(where.status, 'active');
            const bWhere = include?.[0]?.include?.[0]?.where;
            assert.ok(bWhere?.landlordId?.[Op.ne] === 1);
            return 1;
        });

        await assert.rejects(
            () => buildingService.updateTenant(1, 50, { name: 'Sửa Trộm' }),
            (e) => e.statusCode === 403 && /hợp đồng hiệu lực với chủ nhà khác/.test(e.message)
        );
        assert.equal(saved, false);
    });
});

describe('Guarantee 7: Clean Code supportService.js (loại bỏ origSupportUpdate & origUserFindByPk)', () => {
    test('supportService.js không còn origSupportUpdate / origUserFindByPk và fallback an toàn khi DB offline', async () => {
        const src = fs.readFileSync(path.join(__dirname, '../src/services/supportService.js'), 'utf8');
        assert.equal(/origSupportUpdate/.test(src), false, 'supportService.js không được chứa origSupportUpdate');
        assert.equal(/origUserFindByPk/.test(src), false, 'supportService.js không được chứa origUserFindByPk');

        const reqObj = {
            id: 3,
            tenantId: 7,
            description: 'Hỏng khóa cửa',
            status: 'in_progress',
            tenant: { id: 7, telegramChatId: null },
            saved: 0,
            save: async () => { reqObj.saved++; }
        };
        stub(SupportRequest, 'findByPk', async () => reqObj);
        stub(SupportRequest, 'update', async () => {
            const err = new Error('connect ECONNREFUSED 127.0.0.1:3306');
            err.name = 'SequelizeConnectionRefusedError';
            throw err;
        });
        stub(notificationService, 'createNotification', async () => {});

        const res = await supportService.updateRequestStatus(2, 3, {
            status: 'resolved',
            landlordNote: 'Đã thay khóa',
            repairCost: 150000
        });
        assert.equal(res.supportRequest.status, 'resolved');
        assert.equal(reqObj.saved, 1);
    });
});
