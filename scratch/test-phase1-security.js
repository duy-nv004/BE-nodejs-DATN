/**
 * Regression test cho các bản vá bảo mật Phase 1:
 *   A. Webhook Telegram: chặn khi thiếu/sai secret token
 *   B. Deep-link Telegram: token ngắn hạn thay cho user.id, dùng một lần
 *   C. Webhook SePay: chống replay (cùng eventKey chỉ xử lý 1 lần)
 *   D. Webhook SePay: từ chối gạch nợ hóa đơn khi chuyển thiếu tiền
 *
 * Tạo dữ liệu tạm rồi DỌN SẠCH. Chạy: node scratch/test-phase1-security.js
 */
process.env.TELEGRAM_WEBHOOK_SECRET = 'test-secret-phase1';

const sequelize = require('../src/config/db');
const setupAssociations = require('../src/models/associations');
const User = require('../src/models/User');
const Role = require('../src/models/Role');
const Building = require('../src/models/Building');
const Room = require('../src/models/Room');
const Contract = require('../src/models/Contract');
const Invoice = require('../src/models/Invoice');
const SePayEvent = require('../src/models/SePayEvent');
const Notification = require('../src/models/Notification');
const AdminLog = require('../src/models/AdminLog');
const authService = require('../src/services/authService');
const sepayService = require('../src/services/sepayService');

const assert = (label, condition, detail) => {
    console.log(`${condition ? '✅ PASS' : '❌ FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
    if (!condition) process.exitCode = 1;
};

// ─── Giả lập axios để không gọi Telegram thật ──────────────────────────────────
const axios = require('axios');
const sentMessages = [];
axios.post = async (url, body) => {
    sentMessages.push({ url, body });
    return { data: { ok: true } };
};

// Gọi handler webhook Telegram trực tiếp, bỏ qua HTTP layer
const callTelegramWebhook = (body, headers = {}) => new Promise((resolve) => {
    const router = require('../src/routes/telegramRoutes');
    const layer = router.stack.find(l => l.route && l.route.path === '/webhook');
    const handler = layer.route.stack[0].handle;
    const req = { body, headers };
    const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        send(payload) { resolve({ statusCode: this.statusCode, payload }); }
    };
    Promise.resolve(handler(req, res)).catch(err => {
        console.error('handler error:', err);
        resolve({ statusCode: 500, payload: String(err) });
    });
});

async function run() {
    const cleanup = { users: [], buildings: [], rooms: [], contracts: [], invoices: [], events: [] };

    try {
        setupAssociations();
        await sequelize.authenticate();
        await sequelize.sync();

        const tenantRole = await Role.findOne({ where: { name: 'tenant' } });
        const landlordRole = await Role.findOne({ where: { name: 'landlord' } });

        // ─── Dữ liệu nền: 1 landlord, 1 building, 1 room, 1 tenant, 1 contract ──
        const suffix = Date.now();
        const landlord = await User.create({
            email: `zz-p1-landlord-${suffix}@example.com`,
            password: 'test-password-123',
            name: 'ZZ P1 Landlord',
            roleId: landlordRole.id
        });
        cleanup.users.push(landlord.id);

        const tenant = await User.create({
            phone: `08${String(suffix).slice(-8)}`,
            password: 'test-password-123',
            name: 'ZZ P1 Tenant',
            roleId: tenantRole.id,
            ownerId: landlord.id
        });
        cleanup.users.push(tenant.id);

        const building = await Building.create({ name: 'ZZ P1 Building', address: 'Test', landlordId: landlord.id });
        cleanup.buildings.push(building.id);

        const room = await Room.create({ roomNumber: 'P101', price: 3000000, buildingId: building.id, status: 'occupied' });
        cleanup.rooms.push(room.id);

        const contract = await Contract.create({
            tenantId: tenant.id, roomId: room.id,
            startDate: '2026-01-01', endDate: '2026-12-31',
            electricityPrice: 3500, waterPrice: 30000,
            status: 'active'
        });
        cleanup.contracts.push(contract.id);

        // ═══ A. Telegram webhook: xác thực secret ═════════════════════════════
        console.log('\n── A. Webhook Telegram: xác thực secret token ──');

        const resA1 = await callTelegramWebhook({ message: { chat: { id: 111 }, text: '/menu' } }, {});
        assert('Thiếu header secret -> 401', resA1.statusCode === 401, `status=${resA1.statusCode}`);

        const resA2 = await callTelegramWebhook(
            { message: { chat: { id: 111 }, text: '/menu' } },
            { 'x-telegram-bot-api-secret-token': 'sai-secret' }
        );
        assert('Sai secret -> 401', resA2.statusCode === 401, `status=${resA2.statusCode}`);

        const resA3 = await callTelegramWebhook(
            { message: { chat: { id: 111 }, text: '/menu' } },
            { 'x-telegram-bot-api-secret-token': 'test-secret-phase1' }
        );
        assert('Đúng secret -> xử lý bình thường (200)', resA3.statusCode === 200, `status=${resA3.statusCode}`);

        // ═══ B. Deep-link: token thay user.id, dùng một lần ═══════════════════
        console.log('\n── B. Deep-link Telegram: token ngắn hạn, dùng một lần ──');

        const link = await authService.generateTelegramLink(tenant.id);
        const token = link.telegramConnectLink.split('start=')[1];
        assert('Link chứa token ngẫu nhiên, KHÔNG phải user.id',
            token !== String(tenant.id) && token.length === 64,
            `token=${token.slice(0, 12)}... len=${token.length}`);

        // B1. /start <user.id> cũ phải KHÔNG còn liên kết được
        const before = await User.findByPk(tenant.id);
        assert('Sau khi sinh link, telegramChatId vẫn trống', !before.telegramChatId);

        await callTelegramWebhook(
            { message: { chat: { id: 999 }, text: `/start ${tenant.id}` } },
            { 'x-telegram-bot-api-secret-token': 'test-secret-phase1' }
        );
        const afterB1 = await User.findByPk(tenant.id);
        assert('KHÔNG liên kết được bằng user.id', !afterB1.telegramChatId,
            `telegramChatId=${afterB1.telegramChatId}`);

        // B2. /start <token> hợp lệ phải liên kết thành công
        await callTelegramWebhook(
            { message: { chat: { id: 999 }, text: `/start ${token}` } },
            { 'x-telegram-bot-api-secret-token': 'test-secret-phase1' }
        );
        const afterB2 = await User.findByPk(tenant.id);
        assert('Liên kết thành công bằng token hợp lệ', afterB2.telegramChatId === '999',
            `telegramChatId=${afterB2.telegramChatId}`);

        // B3. Token phải bị xoá sau khi dùng (dùng một lần)
        assert('Token bị xoá sau khi dùng', afterB2.telegramLinkToken === null,
            `token=${afterB2.telegramLinkToken}`);

        // B4. Dùng lại token cũ phải thất bại
        await User.update({ telegramChatId: null }, { where: { id: tenant.id } });
        await callTelegramWebhook(
            { message: { chat: { id: 888 }, text: `/start ${token}` } },
            { 'x-telegram-bot-api-secret-token': 'test-secret-phase1' }
        );
        const afterB4 = await User.findByPk(tenant.id);
        assert('Dùng lại token cũ thất bại', !afterB4.telegramChatId,
            `telegramChatId=${afterB4.telegramChatId}`);

        // ═══ C. SePay: chống replay ═══════════════════════════════════════════
        console.log('\n── C. Webhook SePay: chống xử lý trùng ──');

        const invoice = await Invoice.create({
            roomId: room.id, landlordId: landlord.id,
            month: 10, year: 2026,
            roomPrice: 3000000, electricityTotal: 350000, waterTotal: 90000,
            serviceTotal: 150000, totalAmount: 3590000
        });
        cleanup.invoices.push(invoice.id);

        const invoicePayload = {
            id: 555001,
            transferType: 'in',
            transferAmount: 3590000,
            content: `HD ${invoice.id} LL ${landlord.id}`,
            transactionDate: '2026-10-06T10:00:00Z'
        };

        const resC1 = await sepayService.processWebhookPayload(invoicePayload);
        cleanup.events.push('sepay:555001');
        assert('Lần 1: gạch nợ thành công', resC1.type === 'ROOM_INVOICE', `type=${resC1.type}`);
        assert('Hóa đơn đã được đánh dấu thanh toán', (await Invoice.findByPk(invoice.id)).isPaid === true);

        // Gửi lại y nguyên payload (SePay retry / kẻ tấn công replay)
        const resC2 = await sepayService.processWebhookPayload(invoicePayload);
        assert('Lần 2 (replay): bị nhận diện là trùng', resC2.duplicated === true,
            `duplicated=${resC2.duplicated}, message=${resC2.message}`);

        // ═══ D. SePay: chuyển thiếu tiền cho hóa đơn ══════════════════════════
        console.log('\n── D. Webhook SePay: hóa đơn chuyển thiếu tiền ──');

        const invoice2 = await Invoice.create({
            roomId: room.id, landlordId: landlord.id,
            month: 11, year: 2026,
            roomPrice: 3000000, electricityTotal: 0, waterTotal: 0,
            serviceTotal: 0, totalAmount: 3000000
        });
        cleanup.invoices.push(invoice2.id);

        const resD = await sepayService.processWebhookPayload({
            id: 555002,
            transferType: 'in',
            transferAmount: 1000, // chỉ 1.000đ cho hóa đơn 3.000.000đ
            content: `HD ${invoice2.id} LL ${landlord.id}`,
            transactionDate: '2026-10-06T11:00:00Z'
        });
        cleanup.events.push('sepay:555002');

        assert('Từ chối gạch nợ khi thiếu tiền', resD.type === 'INVOICE_UNDERPAID', `type=${resD.type}`);
        assert('Hóa đơn vẫn CHƯA thanh toán', (await Invoice.findByPk(invoice2.id)).isPaid === false);
        assert('Có ghi AdminLog cảnh báo',
            (await AdminLog.count({ where: { action: 'INVOICE_PAYMENT_REJECTED', targetUserId: landlord.id } })) > 0);

        console.log(`\n(Tổng ${sentMessages.length} tin nhắn Telegram đã được giả lập gửi)`);
    } catch (err) {
        console.error('❌ LỖI KHI CHẠY TEST:', err);
        process.exitCode = 1;
    } finally {
        // ─── Dọn sạch dữ liệu test ─────────────────────────────────────────────
        for (const id of cleanup.invoices) await Invoice.destroy({ where: { id } });
        for (const id of cleanup.contracts) await Contract.destroy({ where: { id } });
        for (const id of cleanup.rooms) await Room.destroy({ where: { id } });
        for (const id of cleanup.buildings) await Building.destroy({ where: { id } });
        for (const key of cleanup.events) await SePayEvent.destroy({ where: { eventKey: key } });
        for (const id of cleanup.users) {
            await Notification.destroy({ where: { userId: id } });
            await AdminLog.destroy({ where: { targetUserId: id } });
            await User.destroy({ where: { id } });
        }
        console.log('\n🧹 Đã dọn sạch dữ liệu test.');
        await sequelize.close();
    }
}

run();
