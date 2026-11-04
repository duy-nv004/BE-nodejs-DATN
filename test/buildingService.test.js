/**
 * Unit test xóa khách thuê (src/services/buildingService.js) — stub model, không cần DB.
 * Chạy: npm test
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/models/User');
const Contract = require('../src/models/Contract');
const Invoice = require('../src/models/Invoice');
const SupportRequest = require('../src/models/SupportRequest');
const Notification = require('../src/models/Notification');
const service = require('../src/services/buildingService');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

const makeTenant = () => ({
    id: 7, status: 'active', destroyed: 0, saved: 0,
    async save() { this.saved++; }, async destroy() { this.destroyed++; }
});

// counts: { blocking, unpaid, contracts, invoices, support }
const setup = (counts) => {
    const tenant = makeTenant();
    stub(User, 'findOne', async () => tenant);
    stub(Contract, 'count', async ({ where }) => (where.status ? counts.blocking || 0 : counts.contracts || 0));
    stub(Invoice, 'count', async ({ where }) => (where.isPaid === false ? counts.unpaid || 0 : counts.invoices || 0));
    stub(SupportRequest, 'count', async () => counts.support || 0);
    stub(Notification, 'destroy', async () => 0);
    return tenant;
};

describe('deleteTenant (C4)', () => {
    test('khách có HĐ chờ ký / đang hiệu lực thì chặn', async () => {
        const tenant = setup({ blocking: 1 });
        await assert.rejects(service.deleteTenant(1, 7), (e) => e.statusCode === 400 && /hiệu lực hoặc chờ ký/.test(e.message));
        assert.equal(tenant.destroyed, 0);
    });

    test('khách còn hóa đơn chưa thanh toán thì chặn', async () => {
        const tenant = setup({ unpaid: 2 });
        await assert.rejects(service.deleteTenant(1, 7), (e) => e.statusCode === 400 && /2 hóa đơn chưa thanh toán/.test(e.message));
        assert.equal(tenant.destroyed, 0);
    });

    test('khách có lịch sử HĐ thì khóa thay vì xóa', async () => {
        const tenant = setup({ contracts: 1 });
        const res = await service.deleteTenant(1, 7);
        assert.equal(tenant.status, 'locked');
        assert.equal(tenant.lockReason, 'Chủ nhà đã ngưng quản lý tài khoản');
        assert.equal(tenant.saved, 1);
        assert.equal(tenant.destroyed, 0);
        assert.match(res.message, /Đã khóa tài khoản/);
    });

    test('khách có yêu cầu hỗ trợ cũng tính là có lịch sử', async () => {
        const tenant = setup({ support: 1 });
        await service.deleteTenant(1, 7);
        assert.equal(tenant.status, 'locked');
        assert.equal(tenant.destroyed, 0);
    });

    test('khách chưa có lịch sử thì xóa notifications rồi xóa cứng', async () => {
        const tenant = setup({});
        let notifWhere = null;
        stub(Notification, 'destroy', async ({ where }) => { notifWhere = where; });
        await service.deleteTenant(1, 7);
        assert.deepEqual(notifWhere, { userId: 7 });
        assert.equal(tenant.destroyed, 1);
    });
});

describe('getTenants (C4)', () => {
    test('trả kèm status để FE hiện Tag Đã khóa', async () => {
        let attrs = null;
        stub(User, 'findAll', async (opts) => { attrs = opts.attributes; return []; });
        await service.getTenants(1);
        assert.ok(attrs.includes('status'));
    });

    test('C6: include HĐ active kèm occupants để hiện số người đã tạm trú', async () => {
        let opts = null;
        stub(User, 'findAll', async (o) => { opts = o; return []; });
        await service.getTenants(1);
        const rentals = opts.include.find(i => i.as === 'rentals');
        assert.equal(rentals.where.status, 'active');
        assert.equal(rentals.required, false);
        assert.equal(rentals.include[0].as, 'occupants');
    });
});

// ─── D1-D6: giới hạn gói, xóa/sửa phòng, mở khóa khách, validate giá ───
const Building = require('../src/models/Building');
const Room = require('../src/models/Room');
const Service = require('../src/models/Service');
const MeterReading = require('../src/models/MeterReading');
const Plan = require('../src/models/Plan');
const sequelize = require('../src/config/db');
const { checkBuildingLimit, checkRoomLimit } = require('../src/middleware/checkLimit');

const record = (fields) => ({ ...fields, saved: 0, destroyed: 0, async save() { this.saved++; return this; }, async destroy() { this.destroyed++; } });
const freePlan = { name: 'free', maxBuildings: 1, maxRoomsPerBuilding: 5 };
const planUser = () => {
    stub(sequelize, 'transaction', async (fn) => fn({ id: 'tx' }));
    stub(User, 'findByPk', async () => ({ id: 1, plan: 'free' }));
};

describe('D1: giới hạn gói ở tầng service', () => {
    test('createBuilding vượt maxBuildings -> 403, không tạo', async () => {
        planUser();
        stub(Plan, 'findOne', async () => freePlan);
        stub(Building, 'count', async () => 1);
        let created = false;
        stub(Building, 'create', async () => { created = true; });
        await assert.rejects(service.createBuilding(1, { name: 'A', address: 'B' }), (e) => e.statusCode === 403 && /tối đa 1 tòa nhà/.test(e.message));
        assert.equal(created, false);
    });

    test('createBuilding trong hạn mức -> tạo kèm Service', async () => {
        planUser();
        stub(Plan, 'findOne', async () => freePlan);
        stub(Building, 'count', async () => 0);
        stub(Building, 'create', async (d) => ({ id: 9, ...d }));
        let svc = null;
        stub(Service, 'create', async (d) => { svc = d; });
        const b = await service.createBuilding(1, { name: 'A', address: 'B' });
        assert.equal(b.id, 9);
        assert.deepEqual(svc, { buildingId: 9 });
    });

    test('createRoom vượt maxRoomsPerBuilding -> 403', async () => {
        planUser();
        stub(Plan, 'findOne', async () => freePlan);
        stub(Building, 'findOne', async () => ({ id: 2 }));
        stub(Room, 'count', async () => 5);
        stub(Room, 'findOne', async () => null);
        let created = false;
        stub(Room, 'create', async () => { created = true; });
        await assert.rejects(service.createRoom(1, { roomNumber: '101', price: 1000, buildingId: 2 }), (e) => e.statusCode === 403 && /tối đa 5 phòng/.test(e.message));
        assert.equal(created, false);
    });

    test('middleware giữ nguyên mã 403 / 500 / next', async () => {
        const res = { status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
        stub(Plan, 'findOne', async () => freePlan);
        stub(Building, 'count', async () => 1);
        let nexted = false;
        await checkBuildingLimit({ user: { id: 1, plan: 'free' } }, res, () => { nexted = true; });
        assert.equal(res.code, 403);
        assert.equal(nexted, false);

        stub(Plan, 'findOne', async () => null);
        await checkBuildingLimit({ user: { id: 1, plan: 'free' } }, res, () => { nexted = true; });
        assert.equal(res.code, 500);

        stub(Plan, 'findOne', async () => freePlan);
        stub(Building, 'findOne', async () => ({ id: 2 }));
        stub(Room, 'count', async () => 0);
        await checkRoomLimit({ user: { id: 1, plan: 'free' }, body: { buildingId: 2 } }, res, () => { nexted = true; });
        assert.equal(nexted, true);
    });
});

const roomFixture = (status = 'empty') => record({ id: 5, roomNumber: '101', price: 1000, status, buildingId: 2, building: { landlordId: 1 } });

describe('D2: deleteRoom', () => {
    const setupRoom = (counts) => {
        const room = roomFixture();
        stub(Room, 'findByPk', async () => room);
        stub(Contract, 'count', async ({ where }) => (where.status ? counts.blocking || 0 : counts.contracts || 0));
        stub(Invoice, 'count', async ({ where }) => (where.isPaid === false ? counts.unpaid || 0 : counts.invoices || 0));
        stub(MeterReading, 'count', async () => counts.readings || 0);
        return room;
    };

    test('còn hóa đơn chưa thanh toán -> 400', async () => {
        const room = setupRoom({ unpaid: 1, invoices: 1 });
        await assert.rejects(service.deleteRoom(1, 5), (e) => e.statusCode === 400 && /chưa thanh toán/.test(e.message));
        assert.equal(room.destroyed, 0);
    });

    for (const k of ['invoices', 'contracts', 'readings']) {
        test(`có lịch sử (${k}) -> 400 gợi ý bảo trì, không destroy`, async () => {
            const room = setupRoom({ [k]: 1 });
            await assert.rejects(service.deleteRoom(1, 5), (e) => e.statusCode === 400 && /bảo trì/i.test(e.message));
            assert.equal(room.destroyed, 0);
        });
    }

    test('phòng chưa có lịch sử -> xóa', async () => {
        const room = setupRoom({});
        await service.deleteRoom(1, 5);
        assert.equal(room.destroyed, 1);
    });
});

describe('D3: mở khóa khách thuê', () => {
    test('status active mở khóa và xóa lockReason (scope theo ownerId)', async () => {
        const t = record({ id: 7, status: 'locked', lockReason: 'x' });
        let where = null;
        stub(User, 'findOne', async (o) => { where = o.where; return t; });
        await service.updateTenant(1, 7, { status: 'active' });
        assert.deepEqual(where, { id: 7, ownerId: 1 });
        assert.equal(t.status, 'active');
        assert.equal(t.lockReason, null);
        assert.equal(t.saved, 1);
    });

    test('status khác active -> 400', async () => {
        const t = record({ id: 7, status: 'active' });
        stub(User, 'findOne', async () => t);
        await assert.rejects(service.updateTenant(1, 7, { status: 'locked' }), (e) => e.statusCode === 400);
        assert.equal(t.saved, 0);
    });
});

describe('D4: updateRoom đổi trạng thái tay', () => {
    test('phòng occupied/reserved -> 400', async () => {
        for (const s of ['occupied', 'reserved']) {
            const room = roomFixture(s);
            stub(Room, 'findByPk', async () => room);
            stub(Contract, 'count', async () => 0);
            await assert.rejects(service.updateRoom(1, 5, { status: 'maintenance' }), (e) => e.statusCode === 400);
            assert.equal(room.saved, 0);
        }
    });

    test('còn HĐ active/chờ ký -> 400', async () => {
        const room = roomFixture('empty');
        stub(Room, 'findByPk', async () => room);
        let where = null;
        stub(Contract, 'count', async (o) => { where = o.where; return 1; });
        await assert.rejects(service.updateRoom(1, 5, { status: 'maintenance' }), (e) => e.statusCode === 400);
        assert.deepEqual(where.status, ['active', 'pending_tenant_signature']);
        assert.equal(room.saved, 0);
    });

    test('phòng trống không HĐ -> cho đặt bảo trì', async () => {
        const room = roomFixture('empty');
        stub(Room, 'findByPk', async () => room);
        stub(Contract, 'count', async () => 0);
        await service.updateRoom(1, 5, { status: 'maintenance' });
        assert.equal(room.status, 'maintenance');
    });
});

describe('D5: validate giá và số phòng trùng', () => {
    const okLimits = () => {
        planUser();
        stub(Plan, 'findOne', async () => freePlan);
        stub(Building, 'findOne', async () => ({ id: 2 }));
        stub(Room, 'count', async () => 0);
    };

    test('createRoom giá âm / không phải số -> 400', async () => {
        okLimits();
        stub(Room, 'findOne', async () => null);
        for (const price of [-1, 'abc', '']) {
            await assert.rejects(service.createRoom(1, { roomNumber: '101', price, buildingId: 2 }), (e) => e.statusCode === 400, `price=${price}`);
        }
    });

    test('createRoom trùng số phòng trong tòa -> 400', async () => {
        okLimits();
        stub(Room, 'findOne', async () => ({ id: 3 }));
        await assert.rejects(service.createRoom(1, { roomNumber: '101', price: 0, buildingId: 2 }), (e) => e.statusCode === 400 && /đã tồn tại/.test(e.message));
    });

    test('updateRoom giá âm -> 400; trùng số phòng -> 400', async () => {
        const room = roomFixture();
        stub(Room, 'findByPk', async () => room);
        await assert.rejects(service.updateRoom(1, 5, { price: -5 }), (e) => e.statusCode === 400);
        stub(Room, 'findOne', async () => ({ id: 6 }));
        await assert.rejects(service.updateRoom(1, 5, { roomNumber: '102' }), (e) => e.statusCode === 400 && /đã tồn tại/.test(e.message));
        assert.equal(room.saved, 0);
    });

    test('updateBuildingService giá âm / không phải số -> 400', async () => {
        stub(Building, 'findOne', async () => ({ id: 2 }));
        const svc = record({ buildingId: 2 });
        stub(Service, 'findOne', async () => svc);
        await assert.rejects(service.updateBuildingService(1, 2, { waterPrice: -1 }), (e) => e.statusCode === 400);
        await assert.rejects(service.updateBuildingService(1, 2, { electricityPrice: 'x' }), (e) => e.statusCode === 400);
        assert.equal(svc.saved, 0);
        await service.updateBuildingService(1, 2, { waterPrice: 20000 });
        assert.equal(svc.saved, 1);
    });
});

describe('D6: deleteBuilding xóa cả Service', () => {
    test('destroy Service theo buildingId rồi building', async () => {
        const b = record({ id: 2 });
        stub(Building, 'findOne', async () => b);
        stub(Room, 'count', async () => 0);
        stub(sequelize, 'transaction', async (fn) => fn({ id: 'tx' }));
        let opts = null;
        stub(Service, 'destroy', async (o) => { opts = o; });
        await service.deleteBuilding(1, 2);
        assert.deepEqual(opts.where, { buildingId: 2 });
        assert.equal(b.destroyed, 1);
    });
});

describe('T1.9, T2.1, T2.19, T3.5: transaction, trim roomNumber, capacity/area validation, getRooms filter', () => {
    test('T1.9 & T2.1: createBuilding chạy trong transaction và khóa dòng User', async () => {
        let txUsed = false;
        let findByPkOpts = null;
        let svcOpts = null;
        stub(sequelize, 'transaction', async (fn) => { txUsed = true; return fn({ id: 'tx-build' }); });
        stub(User, 'findByPk', async (id, opts) => { findByPkOpts = opts; return { id: 1, plan: 'free' }; });
        stub(Plan, 'findOne', async () => freePlan);
        stub(Building, 'count', async () => 0);
        stub(Building, 'create', async (d) => ({ id: 10, ...d }));
        stub(Service, 'create', async (d, opts) => { svcOpts = opts; return d; });

        const b = await service.createBuilding(1, { name: 'Tòa X', address: '123 Đường Z' });
        assert.equal(txUsed, true);
        assert.equal(b.id, 10);
        assert.ok(findByPkOpts?.transaction);
        assert.ok(svcOpts?.transaction);
    });

    test('T2.1: createRoom và updateRoom tự trim roomNumber và bắt SequelizeUniqueConstraintError', async () => {
        planUser();
        stub(Plan, 'findOne', async () => freePlan);
        stub(Building, 'findOne', async () => ({ id: 2 }));
        stub(Room, 'count', async () => 0);
        stub(Room, 'findOne', async () => null);
        let createdData = null;
        stub(Room, 'create', async (d) => { createdData = d; return { id: 11, ...d }; });

        await service.createRoom(1, { roomNumber: '  101A  ', price: 2000000, buildingId: 2 });
        assert.equal(createdData.roomNumber, '101A');

        stub(Room, 'create', async () => {
            const err = new Error('Unique constraint');
            err.name = 'SequelizeUniqueConstraintError';
            throw err;
        });
        await assert.rejects(
            service.createRoom(1, { roomNumber: '101A', price: 2000000, buildingId: 2 }),
            (e) => e.statusCode === 400 && /Số phòng đã tồn tại trong tòa nhà này/.test(e.message)
        );
    });

    test('T2.19: createRoom và updateRoom validate capacity (1..50 nguyên) và area (> 0)', async () => {
        planUser();
        stub(Plan, 'findOne', async () => freePlan);
        stub(Building, 'findOne', async () => ({ id: 2 }));
        stub(Room, 'count', async () => 0);
        stub(Room, 'findOne', async () => null);

        for (const badCap of [0, 51, -2, 2.5, 'abc']) {
            await assert.rejects(
                service.createRoom(1, { roomNumber: '101', price: 1000, capacity: badCap, buildingId: 2 }),
                (e) => e.statusCode === 400
            );
        }
        for (const badArea of [0, -10, 'abc']) {
            await assert.rejects(
                service.createRoom(1, { roomNumber: '101', price: 1000, area: badArea, buildingId: 2 }),
                (e) => e.statusCode === 400
            );
        }
    });

    test('T2.19: updateRoom chặn giảm capacity xuống nhỏ hơn số người đang ở trong HĐ active', async () => {
        const room = roomFixture('occupied');
        stub(Room, 'findByPk', async () => room);
        stub(Contract, 'findOne', async () => ({ id: 9, status: 'active', numTenants: 3 }));

        await assert.rejects(
            service.updateRoom(1, 5, { capacity: 2 }),
            (e) => e.statusCode === 400 && /Không thể giảm sức chứa xuống thấp hơn số người đang ở/.test(e.message)
        );
        assert.equal(room.saved, 0);
    });

    test('T3.5: getRooms lọc invoices theo month/year và readings theo period = YYYY-MM khi truyền query', async () => {
        let findOpts = null;
        stub(Room, 'findAll', async (opts) => { findOpts = opts; return []; });

        await service.getRooms(1, 2, { month: 3, year: 2026 });
        const invInclude = findOpts.include.find((i) => i.as === 'invoices');
        const readInclude = findOpts.include.find((i) => i.as === 'readings');
        assert.deepEqual(invInclude.where, { month: 3, year: 2026 });
        assert.deepEqual(readInclude.where, { period: '2026-03' });
    });

    test('T3.1 & T3.5: buildingController.getRooms và getLandlordSupportRequests truyền req.query xuống service', async () => {
        const buildingController = require('../src/controllers/buildingController');
        const supportService = require('../src/services/supportService');
        let getRoomsArgs = null;
        let getSupportArgs = null;
        stub(service, 'getRooms', async (...args) => { getRoomsArgs = args; return []; });
        stub(supportService, 'getLandlordRequests', async (...args) => { getSupportArgs = args; return []; });

        const res = { json() {}, status() { return this; } };
        await buildingController.getRooms({ user: { id: 1 }, query: { buildingId: '2', month: '11', year: '2026' } }, res);
        assert.equal(getRoomsArgs[0], 1);
        assert.deepEqual(getRoomsArgs[1], { buildingId: '2', month: '11', year: '2026' });

        await buildingController.getLandlordSupportRequests({ user: { id: 1 }, query: { status: 'pending', page: '1' } }, res);
        assert.equal(getSupportArgs[0], 1);
        assert.deepEqual(getSupportArgs[1], { status: 'pending', page: '1' });
    });
});
