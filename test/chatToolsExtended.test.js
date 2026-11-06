/**
 * Test TDD cho các công cụ mở rộng của Chatbot AI (Tenant, Admin, Landlord nâng cao)
 * và cơ chế Scope Guardrails & Capability Discovery.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { CHAT_TOOLS, validateToolCall, executeTool, toolsForUser } = require('../src/services/chatTools');

const landlord = { id: 3, roleData: { name: 'landlord' } };
const tenant = { id: 7, roleData: { name: 'tenant' } };
const admin = { id: 1, roleData: { name: 'admin' } };

const expectStatus = (fn, status) =>
    assert.throws(fn, (err) => err.statusCode === status);

describe('Mở rộng CHAT_TOOLS cho Tenant', () => {
    test('có các tool: request_move_out, request_renewal, get_invoice_payment_qr, add_roommate', () => {
        assert.ok(CHAT_TOOLS.request_move_out, 'thiếu request_move_out');
        assert.deepEqual(CHAT_TOOLS.request_move_out.allowedRoles, ['tenant']);

        assert.ok(CHAT_TOOLS.request_renewal, 'thiếu request_renewal');
        assert.deepEqual(CHAT_TOOLS.request_renewal.allowedRoles, ['tenant']);

        assert.ok(CHAT_TOOLS.get_invoice_payment_qr, 'thiếu get_invoice_payment_qr');
        assert.deepEqual(CHAT_TOOLS.get_invoice_payment_qr.allowedRoles, ['tenant']);

        assert.ok(CHAT_TOOLS.add_roommate, 'thiếu add_roommate');
        assert.deepEqual(CHAT_TOOLS.add_roommate.allowedRoles, ['tenant']);
    });

    test('toolsForUser cho tenant trả về đủ 5 công cụ (gồm create_support_request)', () => {
        const names = toolsForUser(tenant).map((t) => t.function.name);
        assert.ok(names.includes('create_support_request'));
        assert.ok(names.includes('request_move_out'));
        assert.ok(names.includes('request_renewal'));
        assert.ok(names.includes('get_invoice_payment_qr'));
        assert.ok(names.includes('add_roommate'));
    });

    test('request_move_out: chỉ tenant được gọi, gọi contractService.createTenantRequest với type=move_out', async () => {
        let called;
        const contractService = {
            createTenantRequest: async (userId, contractId, data) => {
                called = [userId, contractId, data];
                return { message: 'Đã gửi yêu cầu trả phòng tới chủ nhà' };
            }
        };
        const params = { contractId: 10, desiredDate: '2026-12-31', note: 'Hết hạn công tác' };
        const res = await executeTool(tenant, 'request_move_out', params, { contractService });
        assert.deepEqual(called, [7, 10, { type: 'move_out', desiredDate: '2026-12-31', note: 'Hết hạn công tác' }]);
        assert.match(res.message, /trả phòng/i);

        // Landlord/Admin không được gọi
        await assert.rejects(() => executeTool(landlord, 'request_move_out', params, { contractService }),
            (e) => e.statusCode === 403);
    });

    test('request_renewal: gọi contractService.createTenantRequest với type=renewal', async () => {
        let called;
        const contractService = {
            createTenantRequest: async (userId, contractId, data) => {
                called = [userId, contractId, data];
                return { message: 'Đã gửi đề nghị gia hạn hợp đồng tới chủ nhà' };
            }
        };
        const params = { contractId: 10, desiredDate: '2027-12-31', note: 'Gia hạn 1 năm' };
        const res = await executeTool(tenant, 'request_renewal', params, { contractService });
        assert.deepEqual(called, [7, 10, { type: 'renewal', desiredDate: '2027-12-31', note: 'Gia hạn 1 năm' }]);
        assert.match(res.message, /gia hạn/i);
    });

    test('get_invoice_payment_qr: đọc danh sách hóa đơn nợ của tenant và trả về QR', async () => {
        let calledUserId;
        const tenantService = {
            getInvoices: async (userId) => {
                calledUserId = userId;
                return [
                    { id: 101, isPaid: false, month: 11, year: 2026, totalAmount: 3500000, qrCodeUrl: 'https://qr.sepay.vn/inv101', roomDetails: { roomNumber: '201' } },
                    { id: 99, isPaid: true, month: 10, year: 2026, totalAmount: 3500000, qrCodeUrl: 'https://qr.sepay.vn/inv99' }
                ];
            }
        };
        const res = await executeTool(tenant, 'get_invoice_payment_qr', {}, { tenantService });
        assert.equal(calledUserId, 7);
        assert.equal(res.unpaidCount, 1);
        assert.equal(res.latestInvoice.id, 101);
        assert.equal(res.latestInvoice.qrCodeUrl, 'https://qr.sepay.vn/inv101');
    });

    test('add_roommate: gọi contractService.addOccupant với thông tin người ở cùng', async () => {
        let called;
        const contractService = {
            addOccupant: async (user, contractId, data) => {
                called = [user.id, contractId, data];
                return { message: 'Đã thêm người ở cùng', occupant: { id: 1, fullName: data.fullName } };
            }
        };
        const params = { contractId: 10, fullName: 'Trần Thị B', phone: '0987654321', relation: 'Bạn cùng phòng' };
        const res = await executeTool(tenant, 'add_roommate', params, { contractService });
        assert.deepEqual(called, [7, 10, { fullName: 'Trần Thị B', phone: '0987654321', relation: 'Bạn cùng phòng' }]);
        assert.match(res.message, /thêm người ở cùng/i);
    });
});

describe('Mở rộng CHAT_TOOLS cho Super Admin', () => {
    test('có các tool: get_platform_metrics, query_failed_sepay, resolve_landlord_ticket, update_landlord_status', () => {
        assert.ok(CHAT_TOOLS.get_platform_metrics, 'thiếu get_platform_metrics');
        assert.deepEqual(CHAT_TOOLS.get_platform_metrics.allowedRoles, ['admin']);

        assert.ok(CHAT_TOOLS.query_failed_sepay, 'thiếu query_failed_sepay');
        assert.deepEqual(CHAT_TOOLS.query_failed_sepay.allowedRoles, ['admin']);

        assert.ok(CHAT_TOOLS.resolve_landlord_ticket, 'thiếu resolve_landlord_ticket');
        assert.deepEqual(CHAT_TOOLS.resolve_landlord_ticket.allowedRoles, ['admin']);

        assert.ok(CHAT_TOOLS.update_landlord_status, 'thiếu update_landlord_status');
        assert.deepEqual(CHAT_TOOLS.update_landlord_status.allowedRoles, ['admin']);
    });

    test('get_platform_metrics: gọi adminService.getSystemStats', async () => {
        const adminService = {
            getSystemStats: async () => ({
                totalRevenue: 50000000,
                mrr: 12000000,
                totalLandlords: 25,
                planDistribution: { free: 15, basic: 7, pro: 3 }
            })
        };
        const res = await executeTool(admin, 'get_platform_metrics', {}, { adminService });
        assert.equal(res.stats.mrr, 12000000);
        assert.equal(res.stats.totalLandlords, 25);
    });

    test('query_failed_sepay: gọi adminService.getSePayEvents với status=REJECTED', async () => {
        let calledFilter;
        const adminService = {
            getSePayEvents: async (filter) => {
                calledFilter = filter;
                return { count: 1, rows: [{ id: 1, content: 'HD 999', status: 'REJECTED', errorReason: 'Hóa đơn không tồn tại' }] };
            }
        };
        const res = await executeTool(admin, 'query_failed_sepay', { limit: 5 }, { adminService });
        assert.equal(calledFilter.status, 'REJECTED');
        assert.equal(res.count, 1);
    });

    test('resolve_landlord_ticket: gọi adminService.resolveLandlordTicket với ticketId và status', async () => {
        let called;
        const adminService = {
            resolveLandlordTicket: async (adminId, ticketId, body) => {
                called = [adminId, ticketId, body];
                return { message: 'Đã mở khóa tài khoản chủ nhà thành công' };
            }
        };
        const params = { ticketId: 4, status: 'resolved', adminResponse: 'Đã xác minh đầy đủ giấy tờ' };
        const res = await executeTool(admin, 'resolve_landlord_ticket', params, { adminService });
        assert.deepEqual(called, [1, 4, { status: 'resolved', adminResponse: 'Đã xác minh đầy đủ giấy tờ' }]);
        assert.match(res.message, /thành công/i);
    });

    test('update_landlord_status: gọi adminService.updateLandlordStatus khóa/mở khóa', async () => {
        let called;
        const adminService = {
            updateLandlordStatus: async (adminId, landlordId, body) => {
                called = [adminId, landlordId, body];
                return { message: 'Đã khóa tài khoản chủ nhà' };
            }
        };
        const params = { landlordId: 12, status: 'locked', lockReason: 'Vi phạm hợp đồng dịch vụ' };
        const res = await executeTool(admin, 'update_landlord_status', params, { adminService });
        assert.deepEqual(called, [1, 12, { status: 'locked', lockReason: 'Vi phạm hợp đồng dịch vụ' }]);
        assert.match(res.message, /khóa tài khoản/i);
    });
});

describe('Mở rộng CHAT_TOOLS cho Landlord', () => {
    test('có tool: renew_contract_quick, send_overdue_reminders, get_revenue_stats', () => {
        assert.ok(CHAT_TOOLS.renew_contract_quick, 'thiếu renew_contract_quick');
        assert.deepEqual(CHAT_TOOLS.renew_contract_quick.allowedRoles, ['landlord']);

        assert.ok(CHAT_TOOLS.send_overdue_reminders, 'thiếu send_overdue_reminders');
        assert.deepEqual(CHAT_TOOLS.send_overdue_reminders.allowedRoles, ['landlord']);

        assert.ok(CHAT_TOOLS.get_revenue_stats, 'thiếu get_revenue_stats');
        assert.deepEqual(CHAT_TOOLS.get_revenue_stats.allowedRoles, ['landlord']);
    });

    test('get_revenue_stats: gọi invoiceService.getRevenueStats theo tháng (month=10, year=2026)', async () => {
        let called;
        const invoiceService = {
            getRevenueStats: async (landlordId, filter) => {
                called = [landlordId, filter];
                return {
                    period: '10/2026',
                    stats: {
                        totalExpected: 35000000,
                        totalCollected: 30000000,
                        cashCollected: 30000000,
                        depositOffset: 0,
                        unpaidAmount: 5000000,
                        unpaidRooms: 1,
                        invoiceCount: 7
                    }
                };
            }
        };
        const params = { month: '10', year: 2026 };
        const res = await executeTool(landlord, 'get_revenue_stats', params, { invoiceService });
        assert.deepEqual(called, [3, { month: '10', year: 2026 }]);
        assert.equal(res.period, 'Tháng 10/2026');
        assert.equal(res.stats.collectionRate, '85.7%');
        assert.match(res.message, /Tháng 10\/2026/);
        assert.match(res.message, /30\.000\.000 VNĐ/);

        // Tenant gọi bị 403
        await assert.rejects(() => executeTool(tenant, 'get_revenue_stats', params, { invoiceService }),
            (e) => e.statusCode === 403);
    });

    test('get_revenue_stats: gọi invoiceService.getRevenueStats theo cả năm (month=all)', async () => {
        let called;
        const invoiceService = {
            getRevenueStats: async (landlordId, filter) => {
                called = [landlordId, filter];
                return {
                    period: 'all/2026',
                    stats: {
                        totalExpected: 120000000,
                        totalCollected: 110000000,
                        cashCollected: 100000000,
                        depositOffset: 10000000,
                        unpaidAmount: 10000000,
                        unpaidRooms: 2,
                        invoiceCount: 24
                    }
                };
            }
        };
        const res = await executeTool(landlord, 'get_revenue_stats', { year: 2026, month: 'all' }, { invoiceService });
        assert.deepEqual(called, [3, { month: 'all', year: 2026 }]);
        assert.equal(res.period, 'Năm 2026');
        assert.equal(res.stats.collectionRate, '91.7%');
        assert.match(res.message, /Năm 2026/);
    });

    test('renew_contract_quick: gọi contractService.renewContract', async () => {
        let called;
        const contractService = {
            renewContract: async (landlordId, contractId, data) => {
                called = [landlordId, contractId, data];
                return { message: 'Đã tạo hợp đồng gia hạn. Chờ khách ký.' };
            }
        };
        const params = { contractId: 8, startDate: '2027-01-01', endDate: '2027-12-31', rentPrice: 4000000 };
        const res = await executeTool(landlord, 'renew_contract_quick', params, { contractService });
        assert.deepEqual(called, [3, 8, { startDate: '2027-01-01', endDate: '2027-12-31', rentPrice: 4000000 }]);
        assert.match(res.message, /hợp đồng gia hạn/i);
    });
});

