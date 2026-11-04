/**
 * Unit test luồng hợp đồng (src/services/contractService.js) — stub model Sequelize, không cần DB.
 * Chạy: npm test
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const sequelize = require('../src/config/db');
const Contract = require('../src/models/Contract');
const Room = require('../src/models/Room');
const DepositRecord = require('../src/models/DepositRecord');
const MeterReading = require('../src/models/MeterReading');
const User = require('../src/models/User');
const Notification = require('../src/models/Notification');
const notificationService = require('../src/services/notificationService');
const Invoice = require('../src/models/Invoice');
const meterService = require('../src/services/meterService');
const invoiceService = require('../src/services/invoiceService');
const dayjs = require('dayjs');
const ContractOccupant = require('../src/models/ContractOccupant');
const ContractRequest = require('../src/models/ContractRequest');
const { Op } = require('sequelize');
const service = require('../src/services/contractService');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
beforeEach(() => { stub(MeterReading, 'findOne', async () => null); });
afterEach(() => { while (restores.length) restores.pop()(); });

const record = (fields) => ({ ...fields, saved: 0, async save() { this.saved++; return this; } });
const LANDLORD = 1;
const TENANT = 7;
const makeRoom = (status) => record({ id: 5, roomNumber: '101', status, building: { landlordId: LANDLORD } });
const noTransaction = () => stub(sequelize, 'transaction', async (fn) => fn({}));

const newContractData = {
    tenantId: TENANT, roomId: 5, startDate: '2026-11-01', endDate: '2027-10-31', deposit: 2000000,
    electricityPrice: 3500, waterPrice: 20000, initialElectricity: 100, initialWater: 10,
    landlordSignature: 'data:image/png;base64,AAA'
};
const CCCD_FILES = { cccdFront: [{ filename: 'front.jpg' }], cccdBack: [{ filename: 'back.jpg' }] };

describe('createContract', () => {
    test('cho phép khách đang thuê phòng khác lập thêm hợp đồng (thuê nhiều phòng)', async () => {
        noTransaction();
        const room = makeRoom('empty');
        stub(Room, 'findByPk', async () => room);
        stub(User, 'findOne', async () => ({ id: TENANT }));
        stub(Contract, 'findOne', async () => record({ id: 2, tenantId: TENANT, roomId: 9, status: 'active' }));
        stub(Contract, 'create', async (data) => record({ id: 10, ...data }));
        stub(DepositRecord, 'create', async () => ({}));
        stub(MeterReading, 'findOne', async () => null);

        const created = await service.createContract(LANDLORD, newContractData, CCCD_FILES);

        assert.equal(created.status, 'pending_tenant_signature');
        assert.equal(room.status, 'reserved');
    });

    test('vẫn chặn phòng không trống', async () => {
        noTransaction();
        stub(Room, 'findByPk', async () => makeRoom('occupied'));
        stub(User, 'findOne', async () => ({ id: TENANT }));
        await assert.rejects(service.createContract(LANDLORD, newContractData, CCCD_FILES), /không ở trạng thái trống/);
    });

    const setupCreate = (roomFields = {}) => {
        noTransaction();
        const out = {};
        stub(Room, 'findByPk', async () => Object.assign(makeRoom('empty'), { price: 3000000, capacity: 2 }, roomFields));
        stub(User, 'findOne', async (opts) => { out.userQuery = opts; return { id: TENANT }; });
        stub(Contract, 'create', async (data) => { out.created = data; return record({ id: 10, ...data }); });
        stub(DepositRecord, 'create', async () => ({}));
        stub(MeterReading, 'findOne', async () => null);
        return out;
    };

    test('C2: khách không thuộc chủ nhà / không phải tenant / bị khóa thì 404', async () => {
        const out = setupCreate();
        stub(User, 'findOne', async (opts) => { out.userQuery = opts; return null; });
        await assert.rejects(service.createContract(LANDLORD, newContractData, CCCD_FILES),
            (e) => e.statusCode === 404 && /không thuộc quyền/.test(e.message));
        assert.deepEqual(out.userQuery.where, { id: TENANT, ownerId: LANDLORD, status: 'active' });
        assert.deepEqual(out.userQuery.include[0].where, { name: 'tenant' });
    });

    test('I5: không gửi rentPrice thì lưu bằng room.price, gửi thì giữ giá gửi', async () => {
        let out = setupCreate();
        await service.createContract(LANDLORD, newContractData, CCCD_FILES);
        assert.equal(out.created.rentPrice, 3000000);
        restores.splice(0).reverse().forEach(r => r());
        out = setupCreate();
        await service.createContract(LANDLORD, { ...newContractData, rentPrice: 2500000 }, CCCD_FILES);
        assert.equal(out.created.rentPrice, 2500000);
    });

    test('C3: dữ liệu số/ngày sai thì 400', async () => {
        const bad = [
            { endDate: '2026-11-01' },
            { endDate: '2026-10-01' },
            { startDate: 'abc' },
            { deposit: -1 },
            { rentPrice: -5 },
            { electricityPrice: -1 },
            { initialWater: 'x' },
            { paymentDay: 0 },
            { paymentDay: 32 },
            { paymentDay: 5.5 },
            { numTenants: 0 },
            { numTenants: 3 },
        ];
        for (const patch of bad) {
            setupCreate();
            await assert.rejects(service.createContract(LANDLORD, { ...newContractData, ...patch }, CCCD_FILES),
                (e) => e.statusCode === 400, JSON.stringify(patch));
            restores.splice(0).reverse().forEach(r => r());
        }
    });

    test('thiếu 1 hoặc 2 mặt CCCD thì 400, lưu tên file khi đủ', async () => {
        for (const files of [{}, { cccdFront: CCCD_FILES.cccdFront }, { cccdBack: CCCD_FILES.cccdBack }]) {
            setupCreate();
            await assert.rejects(service.createContract(LANDLORD, newContractData, files),
                (e) => e.statusCode === 400 && /CCCD/.test(e.message));
            restores.splice(0).reverse().forEach(r => r());
        }
        const out = setupCreate();
        await service.createContract(LANDLORD, newContractData, CCCD_FILES);
        assert.equal(out.created.tenantCccdFront, 'front.jpg');
        assert.equal(out.created.tenantCccdBack, 'back.jpg');
    });
});

describe('renewContract', () => {
    const activeOld = () => record({
        id: 3, tenantId: TENANT, roomId: 5, status: 'active', deposit: 2000000,
        startDate: '2025-11-01', endDate: '2026-10-31', room: makeRoom('occupied')
    });

    test('giữ hợp đồng cũ active, không tạo thêm bản ghi cọc', async () => {
        noTransaction();
        const old = activeOld();
        let created = null;
        let depositCreated = false;
        stub(Contract, 'findByPk', async () => old);
        stub(Contract, 'count', async () => 0);
        stub(Contract, 'create', async (data) => { created = record({ id: 11, ...data }); return created; });
        stub(DepositRecord, 'create', async () => { depositCreated = true; });

        await service.renewContract(LANDLORD, 3, { startDate: '2026-11-01', endDate: '2027-10-31' });

        assert.equal(old.status, 'active');
        assert.equal(created.status, 'pending_tenant_signature');
        assert.equal(created.deposit, 2000000);
        assert.equal(depositCreated, false);
    });

    test('I5: gia hạn copy rentPrice cũ, hoặc nhận giá mới', async () => {
        noTransaction();
        let created = null;
        stub(Contract, 'findByPk', async () => Object.assign(activeOld(), { rentPrice: 2500000, paymentDay: 5 }));
        stub(Contract, 'count', async () => 0);
        stub(Contract, 'create', async (data) => { created = data; return record(data); });
        await service.renewContract(LANDLORD, 3, { startDate: '2026-11-01', endDate: '2027-10-31' });
        assert.equal(created.rentPrice, 2500000);
        await service.renewContract(LANDLORD, 3, { startDate: '2026-11-01', endDate: '2027-10-31', rentPrice: 2800000 });
        assert.equal(created.rentPrice, 2800000);
        await assert.rejects(service.renewContract(LANDLORD, 3, { startDate: '2026-11-01', endDate: '2027-10-31', rentPrice: -1 }),
            (e) => e.statusCode === 400);
    });

    test('T2.3: gia hạn giữ cách tính tháng đầu/cuối của HĐ cũ, hoặc nhận giá trị mới', async () => {
        noTransaction();
        let created = null;
        stub(Contract, 'findByPk', async () => Object.assign(activeOld(), { firstLastMonthPolicy: 'prorated' }));
        stub(Contract, 'count', async () => 0);
        stub(Contract, 'create', async (data) => { created = data; return record(data); });
        await service.renewContract(LANDLORD, 3, { startDate: '2026-11-01', endDate: '2027-10-31' });
        assert.equal(created.firstLastMonthPolicy, 'prorated');
        await service.renewContract(LANDLORD, 3, { startDate: '2026-11-01', endDate: '2027-10-31', firstLastMonthPolicy: 'full' });
        assert.equal(created.firstLastMonthPolicy, 'full');
        await assert.rejects(
            service.renewContract(LANDLORD, 3, { startDate: '2026-11-01', endDate: '2027-10-31', firstLastMonthPolicy: 'weekly' }),
            (e) => e.statusCode === 400);
    });

    test('chặn tạo bản gia hạn thứ hai khi đã có bản chờ ký', async () => {
        noTransaction();
        stub(Contract, 'findByPk', async () => activeOld());
        stub(Contract, 'count', async () => 1);
        await assert.rejects(
            service.renewContract(LANDLORD, 3, { startDate: '2026-11-01', endDate: '2027-10-31' }),
            /đang chờ khách ký/
        );
    });

    test('A6: ngày bắt đầu gia hạn phải sau ngày kết thúc HĐ cũ', async () => {
        noTransaction();
        stub(Contract, 'findByPk', async () => activeOld());
        stub(Contract, 'count', async () => 0);
        stub(Contract, 'create', async (data) => record(data));
        for (const startDate of ['2026-10-31', '2026-06-01']) {
            await assert.rejects(service.renewContract(LANDLORD, 3, { startDate, endDate: '2027-10-31' }),
                (e) => e.statusCode === 400 && /sau ngày kết thúc hợp đồng hiện tại/.test(e.message), startDate);
        }
    });

    test('chặn ngày kết thúc trước ngày bắt đầu', async () => {
        noTransaction();
        stub(Contract, 'findByPk', async () => activeOld());
        stub(Contract, 'count', async () => 0);
        await assert.rejects(
            service.renewContract(LANDLORD, 3, { startDate: '2027-10-31', endDate: '2026-11-01' }),
            /sau ngày bắt đầu/
        );
    });
});

describe('signContractByTenant', () => {
    const pending = () => record({
        id: 11, tenantId: TENANT, roomId: 5, status: 'pending_tenant_signature',
        startDate: '2026-11-01', initialElectricity: 100, initialWater: 10, room: makeRoom('occupied')
    });

    test('ký bản gia hạn: chốt hợp đồng cũ, chuyển cọc, không ghi lại chỉ số đầu kỳ', async () => {
        noTransaction();
        const next = pending();
        const previous = record({ id: 3, tenantId: TENANT, roomId: 5, status: 'active' });
        let depositUpdate = null;
        let meterCreated = false;
        stub(Contract, 'findOne', async ({ where }) => (where.status === 'active' ? previous : next));
        stub(DepositRecord, 'update', async (values, opts) => { depositUpdate = { values, where: opts.where }; });
        stub(MeterReading, 'bulkCreate', async () => { meterCreated = true; });
        stub(MeterReading, 'findOrCreate', async () => { meterCreated = true; return [record({}), true]; });
        let occUpdate = null;
        let occCreated = false;
        stub(ContractOccupant, 'update', async (values, opts) => { occUpdate = { values, where: opts.where }; });
        stub(ContractOccupant, 'create', async () => { occCreated = true; });

        await service.signContractByTenant(TENANT, 11, 'data:image/png;base64,AAA');

        assert.deepEqual(occUpdate, { values: { contractId: 11 }, where: { contractId: 3 } });
        assert.equal(occCreated, false);

        assert.equal(next.status, 'active');
        assert.equal(previous.status, 'renewed');
        assert.deepEqual(depositUpdate.values, { contractId: 11 });
        assert.equal(depositUpdate.where.contractId, 3);
        assert.equal(meterCreated, false);
        assert.equal(next.room.status, 'occupied');
    });

    // Chỉ số bàn giao phải nằm ở kỳ LIỀN TRƯỚC tháng bắt đầu. Nếu nằm đúng tháng bắt đầu,
    // lần chốt số đầu tiên (cùng kỳ) sẽ ghi đè mất mốc bàn giao và hóa đơn tháng đầu
    // tính tiêu thụ từ 0.
    const signFirst = async (startDate, existing = null) => {
        noTransaction();
        const first = pending();
        first.startDate = startDate;
        first.room.status = 'reserved';
        const calls = [];
        stub(Contract, 'findOne', async ({ where }) => (where.status === 'active' ? null : first));
        stub(MeterReading, 'findOrCreate', async ({ where, defaults }) => {
            calls.push({ where, defaults });
            return existing ? [existing[where.type], false] : [record(defaults), true];
        });
        stub(User, 'findByPk', async () => ({ name: 'Khách' }));
        let occupant = null;
        stub(ContractOccupant, 'create', async (data) => { occupant = data; });
        await service.signContractByTenant(TENANT, 11, 'data:image/png;base64,AAA');
        return { first, calls, occupant };
    };

    test('ký hợp đồng đầu tiên: ghi chỉ số bàn giao vào kỳ liền trước và chuyển phòng sang occupied', async () => {
        const { first, calls, occupant } = await signFirst('2026-11-01');
        assert.equal(occupant.isPrimary, true);
        assert.equal(occupant.contractId, 11);
        assert.equal(occupant.fullName, 'Khách');

        assert.equal(first.status, 'active');
        assert.deepEqual(calls.map(c => c.where), [
            { roomId: 5, type: 'electricity', period: '2026-10' },
            { roomId: 5, type: 'water', period: '2026-10' }
        ]);
        assert.equal(calls[0].defaults.readingValue, 100);
        assert.equal(calls[1].defaults.readingValue, 10);
        assert.equal(calls[0].defaults.isInitial, true);
        assert.equal(first.room.status, 'occupied');
    });

    test('hợp đồng bắt đầu tháng 1: kỳ mốc là tháng 12 năm trước', async () => {
        const { calls } = await signFirst('2027-01-01');
        assert.equal(calls[0].where.period, '2026-12');
    });

    test('kỳ mốc đã có chỉ số của khách cũ: ghi đè bằng chỉ số bàn giao thay vì lỗi trùng khóa', async () => {
        const existing = {
            electricity: record({ readingValue: 90, isInitial: false }),
            water: record({ readingValue: 8, isInitial: false })
        };
        await signFirst('2026-11-01', existing);

        assert.equal(existing.electricity.readingValue, 100);
        assert.equal(existing.electricity.isInitial, true);
        assert.equal(existing.electricity.saved, 1);
        assert.equal(existing.water.readingValue, 10);
    });
});

describe('hủy / từ chối hợp đồng chờ ký', () => {
    test('khách từ chối bản gia hạn: phòng vẫn occupied vì hợp đồng cũ còn hiệu lực', async () => {
        noTransaction();
        const next = record({ id: 11, tenantId: TENANT, roomId: 5, status: 'pending_tenant_signature', room: makeRoom('occupied') });
        const previous = record({ id: 3, tenantId: TENANT, roomId: 5, status: 'active' });
        stub(Contract, 'findOne', async ({ where }) => (where.status === 'active' ? previous : next));
        stub(DepositRecord, 'update', async () => {});

        await service.rejectContractByTenant(TENANT, 11, 'Không đồng ý giá');

        assert.equal(next.status, 'rejected');
        assert.equal(next.room.status, 'occupied');
        assert.equal(previous.status, 'active');
    });

    test('chủ nhà hủy hợp đồng đầu tiên: phòng về trống và hoàn cọc đang giữ', async () => {
        noTransaction();
        const contract = record({ id: 10, tenantId: TENANT, roomId: 5, status: 'pending_tenant_signature', room: makeRoom('reserved') });
        let depositUpdate = null;
        stub(Contract, 'findByPk', async () => contract);
        stub(Contract, 'findOne', async () => null);
        stub(DepositRecord, 'update', async (values, opts) => { depositUpdate = { values, where: opts.where }; });

        await service.cancelContractByLandlord(LANDLORD, 10);

        assert.equal(contract.status, 'cancelled');
        assert.equal(contract.room.status, 'empty');
        assert.equal(depositUpdate.values.status, 'refunded');
        assert.deepEqual(depositUpdate.where, { contractId: 10, status: 'held' });
        // A4: ghi số tiền hoàn = tiền cọc, không để 'hoàn 0 ₫'
        assert.equal(depositUpdate.values.refundedAmount.col, 'amount');
        assert.ok(depositUpdate.values.refundedAt instanceof Date);
    });
});

describe('terminateContract (C1)', () => {
    // HĐ active, cọc đang giữ `held`; `finalInv` = hóa đơn kỳ thanh lý (null = chưa xuất)
    const setup = ({ held = 2000000, finalInv = null, otherUnpaid = [] } = {}) => {
        noTransaction();
        const contract = record({
            id: 3, tenantId: TENANT, roomId: 5, status: 'active', startDate: '2026-01-01', endDate: '2027-12-31',
            rentPrice: 3000000, electricityPrice: 3500, waterPrice: 20000, room: makeRoom('occupied')
        });
        const deposit = record({ id: 9, contractId: 3, amount: held, status: 'held' });
        const state = { contract, deposit, finalInv, pendingCancel: null, notified: [], generated: null, readings: null };
        stub(Contract, 'findByPk', async () => contract);
        stub(Contract, 'update', async (values, opts) => { state.pendingCancel = { values, where: opts.where }; });
        state.chain = [];
        stub(Contract, 'findAll', async (opts) => { state.chainQuery = opts.where; return state.chain; });
        state.requestClose = [];
        stub(ContractRequest, 'update', async (values, opts) => { state.requestClose.push({ values, where: opts.where }); });
        stub(Invoice, 'findOne', async ({ where }) => { state.finalWhere ??= where; return state.finalInv; });
        stub(Invoice, 'findAll', async ({ where }) => { state.unpaidWhere = where; return [...otherUnpaid, ...(state.finalInv && !state.finalInv.isPaid ? [state.finalInv] : [])]; });
        stub(DepositRecord, 'findOne', async () => (held > 0 ? deposit : null));
        // Chỉ số kỳ trước: điện 100, nước 10
        stub(MeterReading, 'findOne', async ({ where }) => ({ readingValue: where.type === 'electricity' ? 100 : 10 }));
        stub(meterService, 'validateReading', async (roomId, type, value) => {
            const prev = type === 'electricity' ? 100 : 10;
            if (Number(value) < prev) throw Object.assign(new Error(`Chỉ số mới (${value}) nhỏ hơn chỉ số kỳ trước (${prev})`), { statusCode: 400 });
            return Number(value);
        });
        stub(meterService, 'updateRoomReadings', async (_l, args) => { state.readings = args; });
        stub(invoiceService, 'generateInvoice', async (args, l) => {
            state.generated = { args, l };
            state.finalInv = record({ id: 50, month: 11, year: 2026, isPaid: false, totalAmount: 3170000, electricityNew: 120, waterNew: 15 });
        });
        stub(notificationService, 'createNotification', async (...a) => { state.notified.push(a); });
        return state;
    };
    const inv = (id, totalAmount, extra = {}) => record({ id, month: 11, year: 2026, isPaid: false, totalAmount, electricityNew: 130, waterNew: 12, ...extra });

    test('đã có hóa đơn tháng cuối: cấn trừ vào cọc, lấy chỉ số của hóa đơn, không ghi lại chỉ số', async () => {
        const s = setup({ finalInv: inv(40, 500000), otherUnpaid: [inv(39, 100000, { month: 10 })] });
        const res = await service.terminateContract(LANDLORD, 3, { terminationDate: '2026-11-30' });

        assert.equal(s.readings, null);
        assert.equal(s.generated, null);
        assert.equal(s.finalInv.isPaid, true);
        assert.equal(s.finalInv.paymentMethod, 'deposit');
        assert.equal(s.finalInv.paidAmount, 500000);
        assert.ok(s.finalInv.paidAt instanceof Date);
        assert.equal(s.deposit.status, 'deducted');
        assert.equal(s.deposit.deductedAmount, 600000);
        assert.equal(s.deposit.refundedAmount, 1400000);
        assert.equal(s.contract.status, 'terminated');
        assert.equal(s.contract.terminatedAt, '2026-11-30');
        assert.equal(s.contract.finalElectricity, 130);
        assert.equal(s.contract.finalWater, 12);
        assert.equal(s.contract.room.status, 'empty');
        assert.deepEqual(s.pendingCancel.where, { roomId: 5, status: 'pending_tenant_signature' });
        assert.equal(s.notified[0][0], TENANT);
        assert.equal(res.depositRecord, s.deposit);
    });

    test('chưa có hóa đơn tháng cuối: bắt buộc nhập chỉ số cuối', async () => {
        setup();
        await assert.rejects(service.terminateContract(LANDLORD, 3, { terminationDate: '2026-11-30' }),
            // code để tool chat nhận ra và hỏi lại chủ nhà thay vì trả lỗi thô
            (e) => e.statusCode === 400 && e.code === 'FINAL_READINGS_REQUIRED' && /chỉ số cuối/.test(e.message));
    });

    test('chưa có hóa đơn tháng cuối: ghi chỉ số cuối rồi xuất hóa đơn qua generateInvoice', async () => {
        const s = setup({ held: 5000000 });
        await service.terminateContract(LANDLORD, 3, { terminationDate: '2026-11-30', finalElectricity: 120, finalWater: 15 });

        assert.deepEqual(s.readings, { roomId: 5, electricityValue: 120, waterValue: 15, period: '2026-11' });
        assert.deepEqual(s.generated, { args: { roomId: 5, month: 11, year: 2026 }, l: LANDLORD });
        assert.equal(s.finalInv.isPaid, true);
        assert.equal(s.deposit.deductedAmount, 3170000);
        assert.equal(s.deposit.refundedAmount, 1830000);
        assert.equal(s.contract.finalElectricity, 120);
    });

    test('chỉ số cuối nhỏ hơn kỳ trước thì 400', async () => {
        const s = setup({ held: 5000000 });
        await assert.rejects(service.terminateContract(LANDLORD, 3, { terminationDate: '2026-11-30', finalElectricity: 90, finalWater: 15 }),
            (e) => e.statusCode === 400 && /nhỏ hơn/.test(e.message));
        assert.equal(s.generated, null);
    });

    test('công nợ + hư hỏng vượt cọc thì chặn', async () => {
        const s = setup({ held: 2000000, finalInv: inv(40, 1900000) });
        await assert.rejects(service.terminateContract(LANDLORD, 3, { terminationDate: '2026-11-30', damageAmount: 200000 }),
            (e) => e.statusCode === 400 && /vượt tiền cọc/.test(e.message));
        assert.equal(s.finalInv.isPaid, false);
        assert.equal(s.contract.status, 'active');
    });

    test('vượt cọc khi chưa có hóa đơn tháng cuối: chặn trước khi ghi chỉ số / xuất hóa đơn', async () => {
        const s = setup({ held: 2000000 });
        await assert.rejects(service.terminateContract(LANDLORD, 3, { terminationDate: '2026-11-30', finalElectricity: 120, finalWater: 15 }),
            (e) => e.statusCode === 400 && /vượt tiền cọc/.test(e.message));
        assert.equal(s.readings, null);
        assert.equal(s.generated, null);
    });

    test('Mất cọc: cọc chuyển forfeited, không hoàn', async () => {
        const s = setup({ finalInv: inv(40, 500000) });
        await service.terminateContract(LANDLORD, 3, { terminationDate: '2026-11-30', forfeit: true });
        assert.equal(s.deposit.status, 'forfeited');
        assert.equal(s.deposit.refundedAmount, 0);
        assert.equal(s.deposit.deductedAmount, 2000000);
        assert.equal(s.finalInv.paymentMethod, 'deposit');
    });

    test('preview: vượt cọc thì trả blocked thay vì ném lỗi', async () => {
        setup({ finalInv: inv(40, 2500000) });
        const p = await service.getSettlementPreview(LANDLORD, 3, { terminationDate: '2026-11-30', damageAmount: 100000 });
        assert.equal(p.blocked, true);
        assert.equal(p.deduct, 2600000);
        assert.equal(p.needsReadings, false);
        assert.match(p.blockMessage, /vượt tiền cọc/);
    });

    test('A1: HĐ quá hạn thanh lý sau endDate: kỳ hóa đơn cuối kẹp về tháng endDate', async () => {
        const s = setup({ held: 5000000 });
        s.contract.endDate = '2026-10-31';
        const res = await service.terminateContract(LANDLORD, 3, { terminationDate: '2026-11-30', finalElectricity: 120, finalWater: 15 });
        assert.equal(s.readings.period, '2026-10');
        assert.deepEqual(s.generated.args, { roomId: 5, month: 10, year: 2026 });
        assert.equal(s.contract.terminatedAt, '2026-11-30');
        assert.equal(res.settlement.period, '2026-10');
    });

    test('A2: hóa đơn chưa trả gồm cả các HĐ cũ đã gia hạn trong chuỗi', async () => {
        const s = setup({ finalInv: inv(40, 500000) });
        s.chain = [{ id: 1 }, { id: 2 }];
        await service.getSettlementPreview(LANDLORD, 3, { terminationDate: '2026-11-30' });
        assert.deepEqual(s.chainQuery, { roomId: 5, tenantId: TENANT, status: 'renewed' });
        assert.deepEqual(s.unpaidWhere[Op.or][0], { contractId: [3, 1, 2] });
    });

    test('A3: hóa đơn tháng cuối lọc theo chuỗi hợp đồng, không lấy hóa đơn của khách cũ', async () => {
        const s = setup({ finalInv: inv(40, 500000) });
        s.chain = [{ id: 1 }];
        await service.getSettlementPreview(LANDLORD, 3, { terminationDate: '2026-11-30' });
        assert.deepEqual(s.finalWhere[Op.or], [{ contractId: [3, 1] }, { tenantId: TENANT, contractId: null }]);
        assert.equal(s.finalWhere.month, 11);
    });

    test('A7: thanh lý đóng các yêu cầu đang chờ của HĐ', async () => {
        const s = setup({ finalInv: inv(40, 500000) });
        await service.terminateContract(LANDLORD, 3, { terminationDate: '2026-11-30' });
        assert.deepEqual(s.requestClose.map(r => [r.values.status, r.where]), [
            ['approved', { contractId: 3, status: 'pending', type: 'move_out' }],
            ['rejected', { contractId: 3, status: 'pending', type: 'renewal' }]
        ]);
    });

    test('preview: chưa có hóa đơn tháng cuối thì needsReadings và ước tính hóa đơn tháng cuối', async () => {
        setup({ held: 5000000 });
        const p = await service.getSettlementPreview(LANDLORD, 3, { terminationDate: '2026-11-30', finalElectricity: 120, finalWater: 15 });
        assert.equal(p.needsReadings, true);
        // 3.000.000 tiền phòng + 20 kWh × 3500 + 5 m³ × 20000
        assert.equal(p.finalInvoiceEstimate, 3170000);
        assert.equal(p.refund, 1830000);
        assert.equal(p.blocked, false);
    });

    test('T2.3: preview HĐ prorated trả phòng giữa tháng thì ước tính tiền phòng theo ngày', async () => {
        const s = setup({ held: 5000000 });
        s.contract.firstLastMonthPolicy = 'prorated';
        const p = await service.getSettlementPreview(LANDLORD, 3, { terminationDate: '2026-11-20', finalElectricity: 120, finalWater: 15 });
        // 3.000.000 × 20/30 + 20 kWh × 3500 + 5 m³ × 20000
        assert.equal(p.finalInvoiceEstimate, 2000000 + 70000 + 100000);
        assert.equal(p.refund, 5000000 - 2170000);
    });

    test('T2.3: thanh lý truyền terminationDate cho generateInvoice để tính tháng cuối theo ngày', async () => {
        const s = setup({ held: 5000000 });
        s.contract.firstLastMonthPolicy = 'prorated';
        await service.terminateContract(LANDLORD, 3, { terminationDate: '2026-11-20', finalElectricity: 120, finalWater: 15 });
        assert.deepEqual(s.generated.args, { roomId: 5, month: 11, year: 2026, terminationDate: '2026-11-20' });
    });
});

describe('notifyExpiringContracts (C3)', () => {
    test('chỉ gửi thông báo cho HĐ chưa được nhắc', async () => {
        const c = (id) => ({ id, tenantId: TENANT, endDate: '2026-11-02', room: { roomNumber: '10' + id, building: { landlordId: LANDLORD } } });
        stub(Contract, 'findAll', async () => [c(1), c(2)]);
        let n = 0;
        stub(Notification, 'findOne', async () => (n++ === 0 ? null : { id: 99 }));
        const sent = [];
        stub(notificationService, 'createNotification', async (userId, title, content, type, relatedId) => {
            sent.push({ userId, type, relatedId });
        });

        const count = await service.notifyExpiringContracts();

        assert.equal(count, 1);
        assert.deepEqual(sent, [
            { userId: LANDLORD, type: 'contract_expiry', relatedId: 1 },
            { userId: TENANT, type: 'contract_expiry', relatedId: 1 },
        ]);
    });
});

describe('yêu cầu của khách (C5)', () => {
    const ContractRequest = require('../src/models/ContractRequest');
    const activeOf = (tenantId) => ({ id: 3, tenantId, status: 'active', endDate: '2027-12-31', room: { roomNumber: '101', building: { landlordId: LANDLORD } } });

    test('tạo trên HĐ không phải của khách thì 404', async () => {
        stub(Contract, 'findOne', async () => null);
        await assert.rejects(service.createTenantRequest(TENANT, 3, { type: 'move_out' }), (e) => e.statusCode === 404);
    });

    test('đã có yêu cầu pending cùng loại thì 400', async () => {
        stub(Contract, 'findOne', async () => activeOf(TENANT));
        stub(ContractRequest, 'findOne', async () => ({ id: 1 }));
        await assert.rejects(service.createTenantRequest(TENANT, 3, { type: 'move_out' }),
            (e) => e.statusCode === 400 && /đang chờ/.test(e.message));
    });

    test('báo trả phòng không gửi ngày thì mặc định cuối kỳ hiện tại; báo < 30 ngày thì cảnh báo chủ nhà', async () => {
        stub(Contract, 'findOne', async () => activeOf(TENANT));
        stub(ContractRequest, 'findOne', async () => null);
        let created = null;
        stub(ContractRequest, 'create', async (data) => { created = { id: 20, ...data }; return created; });
        const sent = [];
        stub(notificationService, 'createNotification', async (...a) => { sent.push(a); });

        const res = await service.createTenantRequest(TENANT, 3, { type: 'move_out' });

        const endOfMonth = dayjs().endOf('month').format('YYYY-MM-DD');
        assert.equal(created.desiredDate, endOfMonth);
        assert.equal(created.status, 'pending');
        assert.equal(res.request.shortNotice, true);
        assert.equal(sent[0][0], LANDLORD);
        assert.equal(sent[0][3], 'contract_request');
        assert.match(sent[0][2], /dưới 30 ngày/);
    });

    test('báo trả phòng với ngày trong quá khứ thì 400', async () => {
        stub(Contract, 'findOne', async () => activeOf(TENANT));
        stub(ContractRequest, 'findOne', async () => null);
        await assert.rejects(service.createTenantRequest(TENANT, 3, { type: 'move_out', desiredDate: '2020-01-01' }),
            (e) => e.statusCode === 400);
    });

    test('respondRequest trên yêu cầu đã xử lý thì 400', async () => {
        stub(ContractRequest, 'findByPk', async () => ({ id: 20, status: 'approved', contract: { room: { building: { landlordId: LANDLORD } } } }));
        await assert.rejects(service.respondRequest(LANDLORD, 20, { status: 'rejected' }),
            (e) => e.statusCode === 400 && /đã được xử lý/.test(e.message));
    });

    test('respondRequest duyệt thì đổi trạng thái và báo khách', async () => {
        const reqRec = record({ id: 20, tenantId: TENANT, type: 'renewal', status: 'pending', contract: { room: { roomNumber: '101', building: { landlordId: LANDLORD } } } });
        stub(ContractRequest, 'findByPk', async () => reqRec);
        const sent = [];
        stub(notificationService, 'createNotification', async (...a) => { sent.push(a); });
        await service.respondRequest(LANDLORD, 20, { status: 'approved', responseNote: 'OK' });
        assert.equal(reqRec.status, 'approved');
        assert.equal(reqRec.responseNote, 'OK');
        assert.equal(sent[0][0], TENANT);
    });
});

describe('người ở cùng (C6)', () => {
    const ContractOccupant = require('../src/models/ContractOccupant');
    const landlordUser = { id: LANDLORD, role: 'landlord' };
    const tenantUser = { id: TENANT, role: 'tenant' };
    const contractWith = (capacity = 2) => record({
        id: 3, tenantId: TENANT, status: 'active', numTenants: 1,
        room: { roomNumber: '101', capacity, building: { landlordId: LANDLORD } }
    });

    test('thêm người ở thiếu ảnh CCCD thì 400 (cả chủ nhà lẫn khách)', async () => {
        stub(Contract, 'findByPk', async () => contractWith(3));
        stub(ContractOccupant, 'count', async () => 1);
        for (const user of [landlordUser, tenantUser]) {
            await assert.rejects(service.addOccupant(user, 3, { fullName: 'B' }, { cccdFront: CCCD_FILES.cccdFront }),
                (e) => e.statusCode === 400 && /CCCD/.test(e.message));
        }
    });

    test('thêm vượt capacity thì 400', async () => {
        stub(Contract, 'findByPk', async () => contractWith(2));
        stub(ContractOccupant, 'count', async () => 2);
        await assert.rejects(service.addOccupant(landlordUser, 3, { fullName: 'B' }, CCCD_FILES),
            (e) => e.statusCode === 400 && /tối đa 2/.test(e.message));
    });

    test('thêm thành công thì cập nhật numTenants', async () => {
        const c = contractWith(3);
        stub(Contract, 'findByPk', async () => c);
        let n = 1;
        stub(ContractOccupant, 'count', async () => n);
        let created = null;
        stub(ContractOccupant, 'create', async (data) => { created = data; n++; return { id: 9, ...data }; });
        await service.addOccupant(landlordUser, 3, { fullName: 'B', cccd: '0123', relation: 'Bạn' }, CCCD_FILES);
        assert.equal(created.contractId, 3);
        assert.equal(created.cccdFrontImage, 'front.jpg');
        assert.equal(created.cccdBackImage, 'back.jpg');
        assert.equal(created.isPrimary, false);
        assert.equal(c.numTenants, 2);
        assert.equal(c.saved, 1);
    });

    test('khách gửi residenceStatus thì bị bỏ qua', async () => {
        stub(Contract, 'findByPk', async () => contractWith(3));
        stub(ContractOccupant, 'count', async () => 1);
        let created = null;
        stub(ContractOccupant, 'create', async (data) => { created = data; return data; });
        await service.addOccupant(tenantUser, 3, { fullName: 'B', residenceStatus: 'registered', registeredAt: '2026-01-01' }, CCCD_FILES);
        assert.equal(created.residenceStatus, undefined);
        assert.equal(created.registeredAt, undefined);

        const occ = record({ id: 9, contractId: 3, fullName: 'B', residenceStatus: 'not_registered' });
        stub(ContractOccupant, 'findByPk', async () => occ);
        await service.updateOccupant(tenantUser, 9, { phone: '090', residenceStatus: 'registered' });
        assert.equal(occ.phone, '090');
        assert.equal(occ.residenceStatus, 'not_registered');
        await service.updateOccupant(landlordUser, 9, { residenceStatus: 'registered', registeredAt: '2026-02-01' });
        assert.equal(occ.residenceStatus, 'registered');
        assert.equal(occ.registeredAt, '2026-02-01');
    });

    test('khách thao tác trên HĐ của người khác thì 404', async () => {
        stub(Contract, 'findByPk', async () => contractWith(3));
        await assert.rejects(service.listOccupants({ id: 99, role: 'tenant' }, 3), (e) => e.statusCode === 404);
        await assert.rejects(service.addOccupant({ id: 99, role: 'tenant' }, 3, { fullName: 'B' }, CCCD_FILES), (e) => e.statusCode === 404);
    });

    test('A5: HĐ đầu chờ ký: tính cả khách chính chưa tạo dòng', async () => {
        const c = Object.assign(contractWith(2), { status: 'pending_tenant_signature', roomId: 5 });
        stub(Contract, 'findByPk', async () => c);
        stub(Contract, 'findOne', async () => null);
        let n = 0;
        stub(ContractOccupant, 'count', async () => n);
        stub(ContractOccupant, 'create', async (data) => { n++; return data; });
        await service.addOccupant(landlordUser, 3, { fullName: 'B' }, CCCD_FILES);
        assert.equal(c.numTenants, 2);
        await assert.rejects(service.addOccupant(landlordUser, 3, { fullName: 'C' }, CCCD_FILES),
            (e) => e.statusCode === 400 && /tối đa 2/.test(e.message));
    });

    test('A5: bản gia hạn chờ ký: tính cả người ở của HĐ cũ', async () => {
        const c = Object.assign(contractWith(2), { status: 'pending_tenant_signature', roomId: 5 });
        stub(Contract, 'findByPk', async () => c);
        stub(Contract, 'findOne', async () => ({ id: 2 }));
        stub(ContractOccupant, 'count', async ({ where }) => (where.contractId === 2 ? 2 : 0));
        await assert.rejects(service.addOccupant(landlordUser, 3, { fullName: 'B' }, CCCD_FILES),
            (e) => e.statusCode === 400 && /tối đa 2/.test(e.message));
    });

    test('A7: sửa/xóa người ở trên HĐ đã kết thúc thì 400', async () => {
        stub(Contract, 'findByPk', async () => Object.assign(contractWith(3), { status: 'terminated' }));
        const occ = record({ id: 9, contractId: 3, fullName: 'B', isPrimary: false, async destroy() { this.destroyed = true; } });
        stub(ContractOccupant, 'findByPk', async () => occ);
        await assert.rejects(service.updateOccupant(landlordUser, 9, { phone: '090' }), (e) => e.statusCode === 400);
        await assert.rejects(service.removeOccupant(landlordUser, 9), (e) => e.statusCode === 400);
        assert.equal(occ.phone, undefined);
        assert.equal(occ.destroyed, undefined);
    });

    test('không xóa được dòng khách chính', async () => {
        stub(Contract, 'findByPk', async () => contractWith(3));
        stub(ContractOccupant, 'findByPk', async () => ({ id: 9, contractId: 3, isPrimary: true }));
        await assert.rejects(service.removeOccupant(landlordUser, 9), (e) => e.statusCode === 400);
    });
});

describe('Đợt 1: khóa dòng khi tạo / ký / thanh lý hợp đồng', () => {
    test('createContract: phòng vừa bị request khác giữ chỗ thì 409, không tạo HĐ thứ hai', async () => {
        noTransaction();
        let n = 0;
        stub(Room, 'findByPk', async (id, opts) => {
            n++;
            // Lần đọc đầu (ngoài transaction) thấy trống; lần đọc lại có khóa thấy đã reserved
            return makeRoom(opts?.lock ? 'reserved' : 'empty');
        });
        stub(User, 'findOne', async () => ({ id: TENANT }));
        let created = 0;
        stub(Contract, 'create', async (d) => { created++; return record({ id: 10, ...d }); });
        stub(DepositRecord, 'create', async () => ({}));
        stub(MeterReading, 'findOne', async () => null);
        await assert.rejects(service.createContract(LANDLORD, newContractData, CCCD_FILES), (e) => e.statusCode === 409);
        assert.equal(created, 0);
        assert.ok(n >= 2);
    });

    test('signContractByTenant: HĐ đã được ký ở request khác thì 409', async () => {
        noTransaction();
        const c = record({ id: 4, tenantId: TENANT, roomId: 5, status: 'pending_tenant_signature', startDate: '2026-11-01', room: makeRoom('reserved') });
        stub(Contract, 'findOne', async (opts) => (opts?.lock ? null : c));
        await assert.rejects(service.signContractByTenant(TENANT, 4, 'data:image/png;base64,AAA'), (e) => e.statusCode === 409);
        assert.equal(c.status, 'pending_tenant_signature');
    });

    test('terminateContract: HĐ đã thanh lý ở request khác thì 409, không cấn trừ cọc lần hai', async () => {
        noTransaction();
        const room = makeRoom('occupied');
        room.building = { landlordId: LANDLORD };
        const c = record({ id: 3, tenantId: TENANT, roomId: 5, status: 'active', startDate: '2026-01-01', endDate: '2027-12-31', rentPrice: 3000000, room });
        stub(Contract, 'findByPk', async (id, opts) => (opts?.lock ? { ...c, status: 'terminated' } : c));
        stub(Contract, 'findAll', async () => [c]);
        const fin = record({ id: 40, month: 11, year: 2026, isPaid: false, totalAmount: 500000, electricityNew: 130, waterNew: 12 });
        stub(Invoice, 'findOne', async () => fin);
        stub(Invoice, 'findAll', async () => [fin]);
        stub(DepositRecord, 'findOne', async () => record({ id: 9, contractId: 3, amount: 2000000, status: 'held' }));
        stub(MeterReading, 'findOne', async ({ where }) => ({ readingValue: where.type === 'electricity' ? 100 : 10 }));
        await assert.rejects(service.terminateContract(LANDLORD, 3, { terminationDate: '2026-11-30' }), (e) => e.statusCode === 409);
        assert.equal(fin.isPaid, false);
    });

    test('T1.8: terminateContract với allowDebt=true cho phép thanh lý khi nợ vượt cọc, cấn trừ hóa đơn cũ trước và lưu outstandingAmount', async () => {
        noTransaction();
        const room = makeRoom('occupied');
        const contract = record({
            id: 3, tenantId: TENANT, roomId: 5, status: 'active', startDate: '2026-01-01', endDate: '2027-12-31',
            rentPrice: 3000000, electricityPrice: 3500, waterPrice: 20000, room
        });
        const deposit = record({ id: 9, contractId: 3, amount: 2000000, status: 'held' });
        const inv1 = record({ id: 38, month: 9, year: 2026, isPaid: false, totalAmount: 1500000 });
        const inv2 = record({ id: 39, month: 10, year: 2026, isPaid: false, totalAmount: 1000000 });
        const finalInv = record({ id: 40, month: 11, year: 2026, isPaid: false, totalAmount: 1200000, electricityNew: 130, waterNew: 12 });

        stub(Contract, 'findByPk', async () => contract);
        stub(Contract, 'findAll', async () => []);
        stub(Contract, 'update', async () => {});
        stub(ContractRequest, 'update', async () => {});
        stub(Invoice, 'findOne', async () => finalInv);
        stub(Invoice, 'findAll', async () => [finalInv, inv2, inv1]);
        stub(DepositRecord, 'findOne', async () => deposit);
        stub(notificationService, 'createNotification', async () => {});

        const res = await service.terminateContract(LANDLORD, 3, { terminationDate: '2026-11-30', allowDebt: true });

        assert.equal(inv1.isPaid, true);
        assert.equal(inv1.paidAmount, 1500000);
        assert.equal(inv1.status, 'paid');
        assert.equal(inv1.paymentMethod, 'deposit');

        assert.equal(inv2.isPaid, false);
        assert.equal(inv2.paidAmount, 500000);
        assert.equal(inv2.status, 'partial');
        assert.equal(inv2.paymentMethod, 'deposit');

        assert.equal(finalInv.isPaid, false);
        assert.equal(contract.outstandingAmount, 1700000);
        assert.equal(deposit.deductedAmount, 2000000);
        assert.equal(deposit.refundedAmount, 0);
        assert.equal(deposit.status, 'deducted');
        assert.equal(res.settlement.outstandingAmount, 1700000);
    });

    test('T2.6: terminateContract truyền cùng transaction vào updateRoomReadings và generateInvoice', async () => {
        const txObj = { id: 'term-tx' };
        stub(sequelize, 'transaction', async (fn) => fn(txObj));
        const room = makeRoom('occupied');
        const contract = record({
            id: 3, tenantId: TENANT, roomId: 5, status: 'active', startDate: '2026-01-01', endDate: '2027-12-31',
            rentPrice: 1000000, electricityPrice: 3500, waterPrice: 20000, room
        });
        const deposit = record({ id: 9, contractId: 3, amount: 5000000, status: 'held' });
        let finalInv = null;
        let readingTx = null;
        let invoiceTx = null;

        stub(Contract, 'findByPk', async () => contract);
        stub(Contract, 'findAll', async () => []);
        stub(Contract, 'update', async () => {});
        stub(ContractRequest, 'update', async () => {});
        stub(Invoice, 'findOne', async () => finalInv);
        stub(Invoice, 'findAll', async () => (finalInv ? [finalInv] : []));
        stub(DepositRecord, 'findOne', async () => deposit);
        stub(MeterReading, 'findOne', async ({ where }) => ({ readingValue: where.type === 'electricity' ? 100 : 10 }));
        stub(meterService, 'validateReading', async (_r, _t, val) => Number(val));
        stub(meterService, 'updateRoomReadings', async (_l, _args, opts) => { readingTx = opts?.transaction; });
        stub(invoiceService, 'generateInvoice', async (_args, _l, opts) => {
            invoiceTx = opts?.transaction;
            finalInv = record({ id: 50, month: 11, year: 2026, isPaid: false, totalAmount: 1170000, electricityNew: 120, waterNew: 15 });
        });
        stub(notificationService, 'createNotification', async () => {});

        await service.terminateContract(LANDLORD, 3, { terminationDate: '2026-11-30', finalElectricity: 120, finalWater: 15 });
        assert.equal(readingTx, txObj);
        assert.equal(invoiceTx, txObj);
    });

    test('T2.7: createContract chặn chỉ số bàn giao nhỏ hơn chỉ số cuối của phòng (nếu không bật meterReset)', async () => {
        noTransaction();
        stub(Room, 'findByPk', async () => Object.assign(makeRoom('empty'), { price: 3000000, capacity: 2 }));
        stub(User, 'findOne', async () => ({ id: TENANT }));
        stub(MeterReading, 'findOne', async ({ where }) => (where.type === 'electricity' ? { readingValue: 250 } : { readingValue: 10 }));

        await assert.rejects(
            service.createContract(LANDLORD, { ...newContractData, initialElectricity: 200 }, CCCD_FILES),
            (e) => e.statusCode === 400 && /Chỉ số bàn giao nhỏ hơn chỉ số cuối của phòng/.test(e.message)
        );
    });

    test('T2.7: signContractByTenant chặn ký khi hợp đồng đã quá ngày kết thúc', async () => {
        noTransaction();
        const expiredPending = record({
            id: 11, tenantId: TENANT, roomId: 5, status: 'pending_tenant_signature',
            startDate: '2020-01-01', endDate: '2020-12-31', room: makeRoom('reserved')
        });
        stub(Contract, 'findOne', async () => expiredPending);
        await assert.rejects(
            service.signContractByTenant(TENANT, 11, 'data:image/png;base64,AAA'),
            (e) => e.statusCode === 400 && /Hợp đồng đã quá ngày kết thúc, không thể ký/.test(e.message)
        );
    });

    test('T2.7: renewContract kiểm tra sức chứa phòng qua validateContractNumbers', async () => {
        noTransaction();
        const old = record({
            id: 3, tenantId: TENANT, roomId: 5, status: 'active', deposit: 2000000,
            startDate: '2025-11-01', endDate: '2026-10-31',
            room: Object.assign(makeRoom('occupied'), { capacity: 2 })
        });
        stub(Contract, 'findByPk', async () => old);
        stub(Contract, 'count', async () => 0);

        await assert.rejects(
            service.renewContract(LANDLORD, 3, { startDate: '2026-11-01', endDate: '2027-10-31', numTenants: 4 }),
            (e) => e.statusCode === 400 && /tối đa 2 người/.test(e.message)
        );
    });

    test('T2.7: expireStalePendingContracts hủy HĐ chờ ký quá 7 ngày và trả phòng về empty nếu không có HĐ active', async () => {
        noTransaction();
        const room1 = makeRoom('reserved');
        const room2 = makeRoom('occupied');
        const stale1 = record({ id: 21, roomId: 5, status: 'pending_tenant_signature', room: room1 });
        const stale2 = record({ id: 22, roomId: 6, status: 'pending_tenant_signature', room: room2 });
        stub(Contract, 'findAll', async () => [stale1, stale2]);
        stub(Contract, 'findOne', async ({ where }) => (where.roomId === 6 ? { id: 99, status: 'active' } : null));
        stub(DepositRecord, 'update', async () => {});

        const count = await service.expireStalePendingContracts(new Date('2026-11-15T00:00:00Z'));
        assert.equal(count, 2);
        assert.equal(stale1.status, 'cancelled');
        assert.equal(room1.status, 'empty');
        assert.equal(stale2.status, 'cancelled');
        assert.equal(room2.status, 'occupied');
    });

    test('T2.9: validate chữ ký base64 và lưu tenantSignedIp, tenantSignedUserAgent, contentHash khi khách ký', async () => {
        noTransaction();
        const first = record({
            id: 11, tenantId: TENANT, roomId: 5, status: 'pending_tenant_signature',
            startDate: '2026-11-01', endDate: '2027-10-31', rentPrice: 3000000, deposit: 2000000,
            electricityPrice: 3500, waterPrice: 20000, initialElectricity: 100, initialWater: 10,
            room: makeRoom('reserved')
        });
        stub(Contract, 'findOne', async ({ where }) => (where.status === 'active' ? null : first));
        stub(MeterReading, 'findOrCreate', async ({ defaults }) => [record(defaults), true]);
        stub(User, 'findByPk', async () => ({ name: 'Khách' }));
        stub(ContractOccupant, 'create', async () => ({}));

        await assert.rejects(
            service.signContractByTenant(TENANT, 11, 'not-a-valid-base64'),
            (e) => e.statusCode === 400
        );
        const hugeSig = 'data:image/png;base64,' + 'A'.repeat(205 * 1024);
        await assert.rejects(
            service.signContractByTenant(TENANT, 11, hugeSig),
            (e) => e.statusCode === 400
        );

        await service.signContractByTenant(TENANT, 11, 'data:image/png;base64,QUJDRA==', {
            ip: '127.0.0.1',
            userAgent: 'Mozilla/5.0 Test'
        });
        assert.equal(first.tenantSignedIp, '127.0.0.1');
        assert.equal(first.tenantSignedUserAgent, 'Mozilla/5.0 Test');
        assert.match(first.contentHash, /^[a-f0-9]{64}$/);
    });
});
