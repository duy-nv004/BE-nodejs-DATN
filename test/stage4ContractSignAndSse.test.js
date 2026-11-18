/**
 * Stage 4 Backend TDD (RED -> GREEN):
 * - Tạo hợp đồng (createContract) cho phép 0/2 CCCD, chặn 1/2 CCCD với 400, gắn DepositRecord từ booking & phát SSE contract_created
 * - Khách thuê tự tải CCCD 2 mặt khi ký hợp đồng (POST /api/tenant/contract/:id/sign), phát SSE contract_signed
 * - Trả kèm Signed URLs (cccdFrontUrl, cccdBackUrl) trong DTO hợp đồng, người ở, và tenant summary
 * - Phát SSE event (invoice_created, invoice_paid, booking_updated) phục vụ FE cập nhật real-time
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'stage4-test-secret';

const sequelize = require('../src/config/db');
const Contract = require('../src/models/Contract');
const ContractOccupant = require('../src/models/ContractOccupant');
const Room = require('../src/models/Room');
const Building = require('../src/models/Building');
const User = require('../src/models/User');
const MeterReading = require('../src/models/MeterReading');
const DepositRecord = require('../src/models/DepositRecord');
const RoomBooking = require('../src/models/RoomBooking');
const Invoice = require('../src/models/Invoice');
const SupportRequest = require('../src/models/SupportRequest');
const SePayEvent = require('../src/models/SePayEvent');
const AdminLog = require('../src/models/AdminLog');

const contractService = require('../src/services/contractService');
const tenantService = require('../src/services/tenantService');
const tenantController = require('../src/controllers/tenantController');
const tenantRoutes = require('../src/routes/tenantRoutes');
const invoiceService = require('../src/services/invoiceService');
const bookingService = require('../src/services/bookingService');
const sseService = require('../src/services/sseService');
const telegramService = require('../src/utils/telegramService');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

const rec = (fields) => ({
    ...fields,
    saved: 0,
    async save() { this.saved++; return this; },
    toJSON() { return { ...this }; }
});

describe('Stage 4.1: Optional CCCD lúc tạo HĐ, liên kết DepositRecord & SSE contract_created', () => {
    const baseData = {
        tenantId: 8,
        roomId: 5,
        startDate: '2026-11-01',
        endDate: '2027-10-31',
        deposit: 3000000,
        electricityPrice: 3500,
        waterPrice: 20000,
        initialElectricity: 100,
        initialWater: 10,
        landlordSignature: 'data:image/png;base64,AAA',
    };

    const setupCreate = ({ booking = null, existingDep = null } = {}) => {
        stub(sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
        const room = rec({ id: 5, roomNumber: '101', price: 3000000, capacity: 2, status: booking ? 'reserved' : 'empty', building: { landlordId: 1 } });
        stub(Room, 'findByPk', async () => room);
        stub(MeterReading, 'findOne', async () => null);
        stub(User, 'findOne', async () => rec({ id: 8, ownerId: 1, status: 'active' }));
        if (booking) {
            stub(RoomBooking, 'findByPk', async () => booking);
            stub(Contract, 'findOne', async () => null);
        }
        let depCreated = 0;
        stub(DepositRecord, 'findOne', async () => existingDep);
        stub(DepositRecord, 'create', async (d) => { depCreated++; return rec(d); });
        let createdData = null;
        stub(Contract, 'create', async (d) => { createdData = d; return rec({ id: 50, ...d }); });
        const sseCalls = [];
        stub(sseService, 'sendToUser', (uid, ev, data) => { sseCalls.push({ uid, ev, data }); });
        return { room, sseCalls, getCreated: () => createdData, getDepCreated: () => depCreated };
    };

    test('createContract cho phép 0/2 ảnh CCCD khi khởi tạo hợp đồng', async () => {
        const ctx = setupCreate();
        const created = await contractService.createContract(1, baseData, {});
        assert.equal(created.id, 50);
        assert.equal(ctx.getCreated().tenantCccdFront, null);
        assert.equal(ctx.getCreated().tenantCccdBack, null);
        assert.ok(ctx.sseCalls.some((c) => c.uid === 8 && c.ev === 'contract_created'));
    });

    test('createContract chặn 400 nếu chỉ gửi 1 trong 2 mặt CCCD', async () => {
        setupCreate();
        await assert.rejects(
            contractService.createContract(1, baseData, { cccdFront: [{ filename: 'front.jpg' }] }),
            (e) => e.statusCode === 400 && /CCCD/.test(e.message)
        );
    });

    test('createContract từ booking đã có DepositRecord SePay thì gắn contractId vào bản ghi cọc đó, không tạo trùng', async () => {
        const booking = rec({ id: 120, roomId: 5, landlordId: 1, tenantId: 8, status: 'deposit_paid', contractId: null });
        const existingDep = rec({ id: 77, bookingId: 120, contractId: null, amount: 3000000, status: 'held' });
        const ctx = setupCreate({ booking, existingDep });

        await contractService.createContract(1, { ...baseData, bookingId: 120 }, {});
        assert.equal(existingDep.contractId, 50);
        assert.equal(existingDep.saved, 1);
        assert.equal(ctx.getDepCreated(), 0);
    });
});

describe('Stage 4.2: Tenant tự tải 2 mặt CCCD khi ký hợp đồng & SSE contract_signed', () => {
    test('signContractByTenant chặn 400 nếu HĐ mới chưa có CCCD và khách không upload đủ 2 mặt', async () => {
        stub(sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
        const pendingContract = rec({
            id: 21, tenantId: 8, roomId: 5, status: 'pending_tenant_signature',
            startDate: '2026-11-01', endDate: '2027-10-31', initialElectricity: 100, initialWater: 10,
            tenantCccdFront: null, tenantCccdBack: null,
            room: rec({ id: 5, roomNumber: '101', status: 'reserved', building: { landlordId: 1 } })
        });
        stub(Contract, 'findOne', async ({ where }) => (where.status === 'active' ? null : pendingContract));

        await assert.rejects(
            contractService.signContractByTenant(8, 21, 'data:image/png;base64,AAA', {}),
            (e) => e.statusCode === 400 && /CCCD/.test(e.message)
        );
    });

    test('signContractByTenant lưu tenantCccdFront/Back do khách tải lên, gán ContractOccupant và phát SSE contract_signed', async () => {
        stub(sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
        const pendingContract = rec({
            id: 21, tenantId: 8, roomId: 5, status: 'pending_tenant_signature',
            startDate: '2026-11-01', endDate: '2027-10-31', initialElectricity: 100, initialWater: 10,
            rentPrice: 3000000, deposit: 3000000, electricityPrice: 3500, waterPrice: 20000,
            tenantCccdFront: null, tenantCccdBack: null,
            room: rec({ id: 5, roomNumber: '101', status: 'reserved', building: { landlordId: 1 } })
        });
        stub(Contract, 'findOne', async ({ where }) => (where.status === 'active' ? null : pendingContract));
        stub(MeterReading, 'findOrCreate', async ({ defaults }) => [rec(defaults), true]);
        stub(User, 'findByPk', async () => ({ id: 8, name: 'Nguyễn Văn B' }));
        let createdOcc = null;
        stub(ContractOccupant, 'create', async (d) => { createdOcc = d; return rec(d); });
        const sseCalls = [];
        stub(sseService, 'sendToUser', (uid, ev, data) => { sseCalls.push({ uid, ev, data }); });

        const signed = await contractService.signContractByTenant(8, 21, 'data:image/png;base64,AAA', {
            files: { cccdFront: [{ filename: 't-front.jpg' }], cccdBack: [{ filename: 't-back.jpg' }] },
            tenantCccd: '001200012345',
            tenantDob: '2000-01-01',
            tenantHometown: 'Hà Nội',
        });

        assert.equal(signed.status, 'active');
        assert.equal(signed.tenantCccdFront, 't-front.jpg');
        assert.equal(signed.tenantCccdBack, 't-back.jpg');
        assert.equal(createdOcc.cccdFrontImage, 't-front.jpg');
        assert.equal(createdOcc.cccdBackImage, 't-back.jpg');
        assert.ok(sseCalls.some((c) => c.uid === 1 && c.ev === 'contract_signed'));
    });

    test('tenantRoutes POST /contract/:id/sign có middleware upload và tenantController chuyển tiếp req.files', async () => {
        const signLayer = tenantRoutes.stack.find((l) => l.route && l.route.path === '/contract/:id/sign');
        assert.ok(signLayer, 'Phải có route /contract/:id/sign');
        assert.ok(signLayer.route.stack.length >= 2, 'Route ký HĐ phải gắn middleware upload trước controller');

        let receivedMeta = null;
        stub(contractService, 'signContractByTenant', async (_tid, _cid, _sig, meta) => {
            receivedMeta = meta;
            return { id: 21, status: 'active' };
        });

        const req = {
            user: { id: 8 },
            params: { id: '21' },
            body: { signature: 'data:image/png;base64,AAA', tenantCccd: '001099000111' },
            files: { cccdFront: [{ filename: 'f1.jpg' }], cccdBack: [{ filename: 'b1.jpg' }] },
            ip: '127.0.0.1',
            get: () => 'VitestAgent'
        };
        const res = {
            statusCode: 200,
            body: null,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; return this; }
        };
        await tenantController.signContract(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(receivedMeta.files.cccdFront[0].filename, 'f1.jpg');
        assert.equal(receivedMeta.tenantCccd, '001099000111');
    });
});

describe('Stage 4.3: Signed URLs cho ảnh CCCD trên Contract, Occupant & Tenant Dashboard', () => {
    test('getContracts, getContractDetail, listOccupants & tenantService.getDashboardSummary trả kèm cccdFrontUrl/cccdBackUrl', async () => {
        const fakeContract = rec({
            id: 30, roomId: 5, tenantId: 8, status: 'active',
            tenantCccdFront: 'front-abc.jpg', tenantCccdBack: 'back-abc.jpg',
            room: {
                id: 5, roomNumber: '201', price: 3500000,
                building: { id: 1, name: 'A', address: 'HN', landlordId: 1, landlord: { name: 'Chủ A' } }
            }
        });
        stub(Contract, 'findAll', async () => [fakeContract]);
        stub(Contract, 'findByPk', async () => fakeContract);
        stub(ContractOccupant, 'findAll', async () => [
            rec({ id: 2, contractId: 30, fullName: 'Ở ghép', cccdFrontImage: 'occ-f.jpg', cccdBackImage: 'occ-b.jpg' })
        ]);
        stub(User, 'findByPk', async () => ({ id: 8, name: 'Khách', email: 'k@x.vn', phone: '0901234567' }));
        stub(Invoice, 'findAll', async () => []);
        stub(SupportRequest, 'findAll', async () => []);
        stub(DepositRecord, 'findAll', async () => []);

        const list = await contractService.getContracts(1);
        assert.match(list[0].cccdFrontUrl, /^\/api\/storage\/access\?key=cccd%2Ffront-abc\.jpg&expires=\d+&sig=[a-f0-9]+$/);
        assert.match(list[0].cccdBackUrl, /^\/api\/storage\/access\?key=cccd%2Fback-abc\.jpg&expires=\d+&sig=[a-f0-9]+$/);

        const detail = await contractService.getContractDetail(1, 30);
        assert.ok(detail.cccdFrontUrl.includes('front-abc.jpg'));

        const occs = await contractService.listOccupants({ id: 1, role: 'landlord' }, 30);
        assert.ok(occs[0].cccdFrontUrl.includes('occ-f.jpg'));
        assert.ok(occs[0].cccdBackUrl.includes('occ-b.jpg'));

        const dash = await tenantService.getDashboardSummary(8, 30);
        assert.ok(dash.contract.cccdFrontUrl.includes('front-abc.jpg'));
        assert.ok(dash.contract.cccdBackUrl.includes('back-abc.jpg'));
    });
});

describe('Stage 4.4: SSE real-time events cho hóa đơn & đặt phòng', () => {
    test('invoiceService.generateInvoice & updatePaymentStatus và bookingService.updateBookingStatus phát SSE events', async () => {
        const sseCalls = [];
        stub(sseService, 'sendToUser', (uid, ev, data) => { sseCalls.push({ uid, ev, data }); });

        // 1. generateInvoice -> invoice_created
        stub(sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
        stub(Room, 'findByPk', async () => ({ id: 5, roomNumber: '101', price: 3000000, building: { landlordId: 1 } }));
        stub(Contract, 'findOne', async () => ({ id: 2, tenantId: 8, paymentDay: 30, electricityPrice: 3500, waterPrice: 20000, rentPrice: 3000000, endDate: '2027-12-31' }));
        stub(Invoice, 'findOne', async () => null);
        stub(MeterReading, 'findOne', async ({ where }) => ({ readingValue: typeof where.period === 'object' ? 10 : 20 }));
        stub(SupportRequest, 'findAll', async () => []);
        stub(User, 'findOne', async () => null);
        stub(Invoice, 'create', async (d) => rec({ id: 70, ...d }));

        await invoiceService.generateInvoice({ roomId: 5, month: 4, year: 2027 }, 1);
        assert.ok(sseCalls.some((c) => c.uid === 8 && c.ev === 'invoice_created'));

        // 2. updatePaymentStatus -> invoice_paid
        sseCalls.length = 0;
        const inv = rec({
            id: 70, roomId: 5, landlordId: 1, tenantId: 8, month: 4, year: 2027,
            totalAmount: 3000000, isPaid: false, paidAmount: 0, status: 'unpaid',
            roomDetails: { roomNumber: '101', building: { landlordId: 1 } }
        });
        stub(Invoice, 'findByPk', async () => inv);
        stub(User, 'findByPk', async () => ({ id: 8, telegramChatId: null }));
        stub(telegramService, 'sendTextToTelegram', async () => {});

        await invoiceService.updatePaymentStatus(70, { isPaid: true, paymentMethod: 'cash' }, 1);
        assert.ok(sseCalls.some((c) => c.ev === 'invoice_paid' && c.uid === 8));
        assert.ok(sseCalls.some((c) => c.ev === 'invoice_paid' && c.uid === 1));

        // 3. bookingService.updateBookingStatus -> booking_updated
        sseCalls.length = 0;
        const bk = rec({
            id: 33, roomId: 5, landlordId: 1, tenantId: 8, status: 'pending',
            room: rec({ id: 5, roomNumber: '101', status: 'empty' })
        });
        stub(RoomBooking, 'findOne', async () => bk);
        await bookingService.updateBookingStatus(1, 33, { status: 'confirmed' });
        assert.ok(sseCalls.some((c) => c.ev === 'booking_updated' && c.uid === 8));
    });
});
