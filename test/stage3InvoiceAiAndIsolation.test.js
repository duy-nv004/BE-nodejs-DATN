/**
 * Stage 3 TDD (RED -> GREEN):
 * - Hóa đơn: xóa mềm + xuất lại (re-issue), gỡ liên kết SupportRequest, xuất hóa đơn hàng loạt generateBulkInvoices
 * - AI/Chat & Admin: chuẩn hóa chữ ký 3/4 tham số, đọc landlordCount/estimatedMrr, trừ paidAmount khỏi công nợ
 * - Cô lập Multi-tenant: buildingService.getTenants scoping theo landlordId & authService.createTenant gắn kết tenant rảnh
 * - Hiệu năng truy vấn Public & Index: đẩy minPrice/maxPrice/minArea/capacity xuống SQL + composite indexes
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const sequelize = require('../src/config/db');
const Invoice = require('../src/models/Invoice');
const Room = require('../src/models/Room');
const Building = require('../src/models/Building');
const Contract = require('../src/models/Contract');
const MeterReading = require('../src/models/MeterReading');
const SupportRequest = require('../src/models/SupportRequest');
const SePayEvent = require('../src/models/SePayEvent');
const User = require('../src/models/User');
const Role = require('../src/models/Role');
const AdminLog = require('../src/models/AdminLog');
const LandlordTicket = require('../src/models/LandlordTicket');

const invoiceService = require('../src/services/invoiceService');
const invoiceController = require('../src/controllers/invoiceController');
const invoiceRoutes = require('../src/routes/invoiceRoutes');
const adminService = require('../src/services/adminService');
const { executeTool } = require('../src/services/chatTools');
const chatService = require('../src/services/chatService');
const buildingService = require('../src/services/buildingService');
const authService = require('../src/services/authService');
const bookingService = require('../src/services/bookingService');
const { runBootstrapMigrations } = require('../src/config/bootstrapMigrations');
const emailService = require('../src/services/emailService');
const cacheHelper = require('../src/utils/cacheHelper');
const userCache = require('../src/utils/userCache');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

const makeMockRes = () => ({
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
});

describe('Stage 3.1: Hóa đơn xóa mềm xuất lại & Xuất hàng loạt (invoiceService + routes)', () => {
    test('deleteInvoice gỡ liên kết SupportRequest.invoiceId = null trước khi xóa mềm', async () => {
        const srUpdates = [];
        const inv = {
            id: 55, roomId: 5, landlordId: 1, month: 4, year: 2026,
            isPaid: false, paidAmount: 0, status: 'unpaid', deletedAt: null,
            roomDetails: { building: { landlordId: 1 } },
            async save() { this.saved = true; return this; },
            async destroy() { this.destroyed = true; }
        };
        stub(Invoice, 'findByPk', async () => inv);
        stub(SePayEvent, 'findOne', async () => null);
        stub(SupportRequest, 'update', async (fields, opts) => {
            srUpdates.push({ fields, opts });
            return [1];
        });

        await invoiceService.deleteInvoice(55, 1);

        assert.equal(srUpdates.length, 1);
        assert.deepEqual(srUpdates[0].fields, { invoiceId: null });
        assert.deepEqual(srUpdates[0].opts.where, { invoiceId: 55 });
        assert.equal(inv.destroyed, true);
    });

    test('generateInvoice dọn bản ghi đã xóa mềm cùng (roomId, month, year) bằng force:true trước khi tạo mới', async () => {
        stub(sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
        stub(Room, 'findByPk', async () => ({ id: 5, roomNumber: '101', price: 3000000, building: { landlordId: 1 } }));
        stub(Contract, 'findOne', async () => ({ id: 2, tenantId: 7, paymentDay: 30, electricityPrice: 3500, waterPrice: 20000, rentPrice: 3000000, endDate: '2027-12-31' }));
        stub(MeterReading, 'findOne', async ({ where }) => ({ readingValue: typeof where.period === 'object' ? 10 : 20 }));
        stub(SupportRequest, 'findAll', async () => []);
        stub(User, 'findOne', async () => null);

        let forceDestroyedOpts = null;
        const softDeletedRow = {
            id: 44,
            roomId: 5,
            month: 3,
            year: 2027,
            deletedAt: new Date('2027-03-02'),
            async destroy(opts) { forceDestroyedOpts = opts; }
        };

        stub(Invoice, 'findOne', async (opts = {}) => {
            if (opts.paranoid === false) return softDeletedRow;
            return null;
        });

        let created = null;
        stub(Invoice, 'create', async (data) => {
            created = data;
            return { id: 88, ...data, async save() { return this; } };
        });

        const res = await invoiceService.generateInvoice({ roomId: 5, month: 3, year: 2027 }, 1);
        assert.ok(forceDestroyedOpts, 'Phải gọi destroy({ force: true }) lên bản ghi xóa mềm cũ');
        assert.equal(forceDestroyedOpts.force, true);
        assert.equal(created.roomId, 5);
        assert.equal(res.invoice.id, 88);
    });

    test('generateBulkInvoices trả về summary created/skipped/failed và POST /generate-bulk hoạt động', async () => {
        const postRoutes = invoiceRoutes.stack
            .filter((l) => l.route && l.route.methods.post)
            .map((l) => l.route.path);
        assert.ok(postRoutes.includes('/generate-bulk'), 'invoiceRoutes phải khai báo POST /generate-bulk');

        stub(Building, 'findAll', async () => [{ id: 10, landlordId: 1 }]);
        stub(Room, 'findAll', async () => [
            { id: 101, roomNumber: 'P101', buildingId: 10 },
            { id: 102, roomNumber: 'P102', buildingId: 10 },
            { id: 103, roomNumber: 'P103', buildingId: 10 },
        ]);
        stub(invoiceService, 'generateInvoice', async ({ roomId }) => {
            if (roomId === 101) return { invoice: { id: 901, totalAmount: 3500000 } };
            if (roomId === 102) {
                const e = new Error('Phòng P102 đã có hóa đơn tháng 4/2026');
                e.statusCode = 409;
                throw e;
            }
            const e = new Error('Chưa chốt đủ chỉ số');
            e.statusCode = 400;
            throw e;
        });

        const req = { user: { id: 1 }, body: { buildingId: 10, month: 4, year: 2026 } };
        const res = makeMockRes();
        await invoiceController.generateBulkInvoices(req, res);

        assert.equal(res.statusCode, 201);
        assert.deepEqual(res.body.summary, {
            total: 3,
            createdCount: 1,
            skippedCount: 1,
            failedCount: 1,
        });
        assert.equal(res.body.created[0].roomId, 101);
        assert.equal(res.body.skipped[0].roomId, 102);
        assert.equal(res.body.failed[0].roomId, 103);
    });
});

describe('Stage 3.2: Chuẩn hóa AI tools, adminService 3/4-arg và công nợ paidAmount', () => {
    test('adminService.updateLandlordStatus & resolveLandlordTicket hỗ trợ cả chữ ký 3 tham số từ chatTools', async () => {
        const landlord = {
            id: 12,
            email: 'll@test.vn',
            name: 'Chủ trọ A',
            status: 'active',
            tokenVersion: 1,
            roleData: { name: 'landlord' },
            async save() { this.saved = true; }
        };
        stub(User, 'findByPk', async () => landlord);
        stub(userCache, 'del', async () => {});
        stub(cacheHelper, 'del', async () => {});
        let logCreated = null;
        stub(AdminLog, 'create', async (d) => { logCreated = d; return d; });
        stub(Contract, 'findAll', async () => []);

        const lockRes = await adminService.updateLandlordStatus(99, 12, {
            status: 'locked',
            lockReason: 'Vi phạm quy định nền tảng'
        });
        assert.equal(landlord.status, 'locked');
        assert.equal(landlord.lockReason, 'Vi phạm quy định nền tảng');
        assert.equal(logCreated.adminId, 99);
        assert.match(lockRes.message, /LOCKED/);

        const ticket = { id: 4, landlordId: 12, email: 'll@test.vn', status: 'pending' };
        stub(LandlordTicket, 'findByPk', async () => ticket);
        stub(LandlordTicket, 'update', async () => [1]);
        stub(emailService, 'sendTicketRejectedEmail', async () => true);

        const ticketRes = await adminService.resolveLandlordTicket(99, 4, {
            status: 'rejected',
            adminResponse: 'Hồ sơ chưa hợp lệ cần bổ sung'
        });
        assert.equal(ticket.status, 'rejected');
        assert.equal(ticket.rejectReason, 'Hồ sơ chưa hợp lệ cần bổ sung');
        assert.match(ticketRes.message, /REJECTED/);
    });

    test('chatTools.get_platform_metrics & chatService.adminContext đọc đúng nested stats (landlordCount/estimatedMrr)', async () => {
        const admin = { id: 1, roleData: { name: 'admin' } };
        const toolRes = await executeTool(admin, 'get_platform_metrics', {}, {
            adminService: {
                getSystemStats: async () => ({
                    stats: { totalRevenue: 45000000, estimatedMrr: 18000000, landlordCount: 42, userCount: 200 },
                    packages: { free: 20, basic: 15, pro: 7, total: 42 },
                })
            }
        });
        assert.match(toolRes.message, /42/);
        assert.match(toolRes.message, /18/);
        assert.equal(toolRes.stats.totalLandlords, 42);
        assert.equal(toolRes.stats.mrr, 18000000);

        const ctx = await chatService.buildContext(admin, {
            adminSnapshot: async () => ({
                stats: { stats: { totalRevenue: 45000000, estimatedMrr: 18000000, landlordCount: 42 } },
                pendingTickets: 3,
                failedSepayCount: 1,
            })
        });
        assert.match(ctx, /Tổng số chủ nhà: 42/);
        assert.match(ctx, /18\.000\.000/);
    });

    test('chatService truy vấn paidAmount và trừ số đã trả khi tính dư nợ hóa đơn', async () => {
        let tenantInvAttrs = null;
        let landlordInvAttrs = null;
        stub(Contract, 'findAll', async (opts) => {
            if (opts?.where?.tenantId) {
                return [{ id: 1, room: { roomNumber: '101', price: 3000000, building: { name: 'A', address: 'HN' } }, startDate: '2026-01-01', endDate: '2027-01-01', paymentDay: 5 }];
            }
            return [];
        });
        stub(Building, 'findAll', async () => [{ id: 1, name: 'Building A' }]);
        stub(Room, 'findAll', async () => [{ id: 10, roomNumber: '101', status: 'occupied', buildingId: 1 }]);
        stub(SupportRequest, 'count', async () => 0);
        stub(SupportRequest, 'findAll', async () => []);
        stub(Contract, 'count', async () => 0);
        stub(invoiceService, 'getRevenueStats', async () => null);
        stub(Invoice, 'findAll', async (opts) => {
            if (opts.where.contractId) {
                tenantInvAttrs = opts.attributes;
                return [{ contractId: 1, month: 4, year: 2026, totalAmount: 3000000, paidAmount: 1000000 }];
            }
            landlordInvAttrs = opts.attributes;
            return [{ id: 5, roomId: 10, month: 4, year: 2026, totalAmount: 3000000, paidAmount: 1200000 }];
        });

        const tSnap = await chatService.defaultRepo.tenantSnapshot(7);
        const lSnap = await chatService.defaultRepo.landlordSnapshot(1);

        assert.ok(tenantInvAttrs.includes('paidAmount'), 'tenantSnapshot phải select paidAmount');
        assert.ok(landlordInvAttrs.includes('paidAmount'), 'landlordSnapshot phải select paidAmount');
        assert.equal(tSnap.unpaidInvoices[0].remainingAmount, 2000000);
        assert.equal(lSnap.unpaidInvoices.total, 1800000);
    });
});

describe('Stage 3.3: Cô lập chủ trọ getTenants & gắn kết tenant trong createTenant', () => {
    test('buildingService.getTenants cô lập rentals theo landlordId nhưng giữ occupants ở include[0]', async () => {
        let findOpts = null;
        stub(User, 'findAll', async (o) => { findOpts = o; return []; });
        await buildingService.getTenants(42);

        const rentals = findOpts.include.find((i) => i.as === 'rentals');
        assert.equal(rentals.include[0].as, 'occupants');
        const roomInc = rentals.include[1];
        assert.equal(roomInc.as, 'room');
        assert.equal(roomInc.required, true);
        const buildingInc = roomInc.include?.find((i) => i.as === 'building');
        assert.ok(buildingInc, 'Phải include Building trong Room để lọc theo landlordId');
        assert.equal(buildingInc.required, true);
        assert.deepEqual(buildingInc.where, { landlordId: 42 });
    });

    test('authService.createTenant liên kết tài khoản tenant rảnh sẵn có thay vì chặn 400', async () => {
        const freeTenant = {
            id: 77,
            phone: '0912345678',
            roleId: 3,
            ownerId: null,
            async save() { this.saved = true; }
        };
        stub(User, 'findOne', async () => freeTenant);
        stub(Role, 'findByPk', async () => ({ id: 3, name: 'tenant' }));
        stub(Contract, 'count', async () => 0);

        const res = await authService.createTenant(5, { phone: '0912345678', password: 'password123', name: 'Khách A' });
        assert.equal(res.tenantId, 77);
        assert.equal(res.linkedExisting, true);
        assert.equal(freeTenant.ownerId, 5);
        assert.equal(freeTenant.saved, true);

        stub(Contract, 'count', async () => 1);
        await assert.rejects(
            authService.createTenant(5, { phone: '0912345678', password: 'password123', name: 'Khách A' }),
            (e) => e.statusCode === 409
        );
    });
});

describe('Stage 3.4: SQL push-down filters ở getPublicRooms & composite indexes', () => {
    test('getPublicRooms đẩy minPrice, maxPrice, minArea, capacity xuống SQL Room.findAll where', async () => {
        let capturedWhere = null;
        stub(Room, 'findAll', async (opts) => {
            capturedWhere = opts.where;
            return [];
        });

        await bookingService.getPublicRooms({
            minPrice: 2000000,
            maxPrice: 5000000,
            minArea: 22,
            capacity: 3
        });

        assert.equal(capturedWhere.status, 'empty');
        assert.equal(capturedWhere.price[Op.gte], 2000000);
        assert.equal(capturedWhere.price[Op.lte], 5000000);
        assert.equal(capturedWhere.area[Op.gte], 22);
        assert.equal(capturedWhere.capacity[Op.gte], 3);
    });

    test('runBootstrapMigrations tạo các composite index cho Rooms, Buildings, Invoices', async () => {
        const addedIndexes = [];
        const mockQI = {
            describeTable: async () => ({
                status: true, aiUseCountThisMonth: true, lastAiUseMonth: true,
                chatUseCountThisMonth: true, lastChatUseMonth: true,
                cccd: true, dob: true, hometown: true, planExpiresAt: true,
                billingCycle: true, planSource: true, telegramLinkToken: true,
                telegramLinkTokenExpiresAt: true, lockReason: true, tokenVersion: true,
                roomId: true, tenantId: true, contractId: true, landlordId: true, dueDate: true,
                paidAmount: true, paidAt: true, paymentMethod: true,
                electricityOld: true, electricityNew: true, waterOld: true, waterNew: true,
                electricityPrice: true, waterPrice: true, prorated: true, daysCharged: true,
                deletedAt: true, firstLastMonthPolicy: true, maxChatCallsPerMonth: true,
                category: true, images: true, landlordNote: true, repairCost: true, chargeToTenant: true, invoiceId: true,
                period: true, meterReset: true, resetReason: true,
                city: true, district: true, ward: true, latitude: true, longitude: true,
                capacity: true, area: true, amenities: true, description: true, depositAmount: true,
                lookupToken: true, holdExpiresAt: true, bookingId: true,
            }),
            addColumn: async () => {},
            removeColumn: async () => {},
            changeColumn: async () => {},
            showIndex: async () => [],
            addIndex: async (table, fields, opts) => {
                addedIndexes.push({ table, fields, name: opts.name, unique: !!opts.unique });
            }
        };
        const mockSequelize = {
            getQueryInterface: () => mockQI,
            query: async () => [[]]
        };

        await runBootstrapMigrations(mockSequelize);

        const names = addedIndexes.map((i) => i.name);
        assert.ok(names.includes('rooms_status_price_area_idx'), 'Phải tạo rooms_status_price_area_idx');
        assert.ok(names.includes('buildings_city_district_idx'), 'Phải tạo buildings_city_district_idx');
        assert.ok(names.includes('invoices_landlord_year_month_status_idx'), 'Phải tạo invoices_landlord_year_month_status_idx');
    });
});
