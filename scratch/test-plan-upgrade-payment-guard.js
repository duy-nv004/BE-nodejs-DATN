/**
 * Script kiểm thử tạm thời cho bản vá bảo mật "nâng cấp gói cước không cần thanh toán".
 * Tạo một chủ nhà tạm, chạy qua các kịch bản rồi DỌN SẠCH toàn bộ dữ liệu đã tạo.
 * Chạy: node scratch/test-plan-upgrade-payment-guard.js
 */
const sequelize = require('../src/config/db');
const setupAssociations = require('../src/models/associations');
const authController = require('../src/controllers/authController');
const sepayController = require('../src/controllers/sepayController');
const sepayService = require('../src/services/sepayService');
const User = require('../src/models/User');
const Role = require('../src/models/Role');
const Plan = require('../src/models/Plan');
const AdminLog = require('../src/models/AdminLog');
const Notification = require('../src/models/Notification');
const PlanUpgradeRequest = require('../src/models/PlanUpgradeRequest');

const mockRes = () => ({
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
});

const assert = (label, condition, detail) => {
    console.log(`${condition ? '✅ PASS' : '❌ FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
    if (!condition) process.exitCode = 1;
};

async function run() {
    let tempUserId = null;
    try {
        setupAssociations();
        await sequelize.authenticate();
        await sequelize.sync();

        const landlordRole = await Role.findOne({ where: { name: 'landlord' } });

        // ─── Tạo chủ nhà tạm ────────────────────────────────────────────────────
        const suffix = Date.now();
        const tempUser = await User.create({
            email: `zz-sepay-test-${suffix}@example.com`,
            phone: `09${String(suffix).slice(-8)}`,
            password: 'test-password-123',
            name: 'ZZ SePay Test Landlord',
            roleId: landlordRole.id
        });
        tempUserId = tempUser.id;
        console.log(`\n👤 Chủ nhà tạm ID=${tempUserId} (plan=${tempUser.plan})\n`);

        // ─── A. Endpoint upgrade-request KHÔNG được cấp gói trả phí ─────────────
        console.log('── A. POST /auth/upgrade-request với gói pro (annual) ──');
        const resA = mockRes();
        await authController.upgradeRequest({
            body: { planName: 'pro', billingCycle: 'annual' },
            user: { id: tempUserId, roleData: { name: 'landlord' } }
        }, resA);

        const afterA = await User.findByPk(tempUserId);
        assert('Trả về pending = true', resA.body?.pending === true, `pending=${resA.body?.pending}`);
        assert('KHÔNG kích hoạt gói trả phí', afterA.plan === 'free', `user.plan=${afterA.plan}`);
        assert('KHÔNG cấp hạn sử dụng', afterA.planExpiresAt === null, `planExpiresAt=${afterA.planExpiresAt}`);
        assert('Số tiền phải thu = 990 * 25000', resA.body?.request?.amount === 990 * 25000, `amount=${resA.body?.request?.amount}`);
        assert('Mã chuyển khoản đúng cú pháp SePay',
            resA.body?.request?.transferCode === `PLAN ${tempUserId} PRO YEAR`,
            `transferCode="${resA.body?.request?.transferCode}"`);

        const pending = await PlanUpgradeRequest.findOne({ where: { landlordId: tempUserId, status: 'pending' } });
        assert('Có bản ghi PlanUpgradeRequest ở trạng thái pending', !!pending, `id=${pending?.id}, cycle=${pending?.billingCycle}`);

        // ─── B. Webhook SePay: chuyển thiếu tiền -> phải bị từ chối ─────────────
        console.log('\n── B. Webhook SePay: chuyển 1.000đ cho gói PRO (thiếu tiền) ──');
        const resB = await sepayService.processWebhookPayload({
            transferType: 'in',
            transferAmount: 1000,
            content: `PLAN ${tempUserId} PRO YEAR`,
            transactionDate: new Date().toISOString()
        });
        const afterB = await User.findByPk(tempUserId);
        assert('Webhook từ chối giao dịch thiếu tiền', resB.success === false, `success=${resB.success}`);
        assert('Vẫn ở gói free sau khi chuyển thiếu', afterB.plan === 'free', `user.plan=${afterB.plan}`);
        assert('Yêu cầu vẫn ở trạng thái pending', (await PlanUpgradeRequest.findByPk(pending.id)).status === 'pending');

        // ─── C. Webhook SePay: chuyển đúng giá -> kích hoạt gói ────────────────
        console.log('\n── C. Webhook SePay: chuyển đúng 990 * 25000đ ──');
        const resC = await sepayService.processWebhookPayload({
            transferType: 'in',
            transferAmount: 990 * 25000,
            content: `PLAN ${tempUserId} PRO YEAR`,
            transactionDate: new Date().toISOString(),
            referenceCode: 'TEST-REF-0001'
        });
        const afterC = await User.findByPk(tempUserId);
        assert('Webhook chấp nhận giao dịch đủ tiền', resC.success === true, `message=${resC.message}`);
        assert('Kích hoạt đúng gói pro', afterC.plan === 'pro', `user.plan=${afterC.plan}`);
        assert('Hạn sử dụng = hôm nay + 365 ngày',
            afterC.planExpiresAt === new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0],
            `planExpiresAt=${afterC.planExpiresAt}`);

        const settled = await PlanUpgradeRequest.findByPk(pending.id);
        assert('Yêu cầu chuyển sang trạng thái paid', settled.status === 'paid', `status=${settled.status}`);
        assert('Lưu mã giao dịch SePay', settled.transactionReference === 'TEST-REF-0001', `ref=${settled.transactionReference}`);

        // ─── D. Webhook SePay: nâng gói khác không có yêu cầu, thiếu tiền ──────
        console.log('\n── D. Webhook SePay: chuyển 5.000đ cho gói BASIC (không có yêu cầu chờ) ──');
        const resD = await sepayService.processWebhookPayload({
            transferType: 'in',
            transferAmount: 5000,
            content: `PLAN ${tempUserId} BASIC`,
            transactionDate: new Date().toISOString()
        });
        const afterD = await User.findByPk(tempUserId);
        assert('Từ chối vì số tiền < giá gói basic', resD.success === false, `message=${resD.message}`);
        assert('Giữ nguyên gói pro đang dùng', afterD.plan === 'pro', `user.plan=${afterD.plan}`);

        // ─── E. Gói Miễn Phí vẫn được hạ cấp trực tiếp ─────────────────────────
        console.log('\n── E. POST /auth/upgrade-request với gói free (hạ cấp) ──');
        const resE = mockRes();
        await authController.upgradeRequest({
            body: { planName: 'free', billingCycle: 'monthly' },
            user: { id: tempUserId, roleData: { name: 'landlord' } }
        }, resE);
        const afterE = await User.findByPk(tempUserId);
        assert('Hạ cấp về free thành công', afterE.plan === 'free', `user.plan=${afterE.plan}`);
        assert('Xoá hạn sử dụng khi về free', afterE.planExpiresAt === null, `planExpiresAt=${afterE.planExpiresAt}`);

        // ─── F. Gói không tồn tại phải bị từ chối ─────────────────────────────
        console.log('\n── F. POST /auth/upgrade-request với gói không tồn tại ──');
        const resF = mockRes();
        await authController.upgradeRequest({
            body: { planName: 'enterprise-khong-ton-tai' },
            user: { id: tempUserId, roleData: { name: 'landlord' } }
        }, resF);
        assert('Trả về 404', resF.statusCode === 404, `status=${resF.statusCode}`);

        // ─── G. Webhook giả mạo không kèm API Key phải bị chặn ─────────────────
        console.log('\n── G. POST /sepay/webhook giả mạo (không có / sai API Key) ──');
        const forgedBody = {
            transferType: 'in',
            transferAmount: 990 * 25000, // Số tiền "đúng" nhưng do kẻ tấn công tự khai
            content: `PLAN ${tempUserId} PRO YEAR`,
            transactionDate: new Date().toISOString()
        };

        const resG1 = mockRes();
        await sepayController.handleWebhook({ body: forgedBody, headers: {} }, resG1);
        assert('Thiếu header Authorization -> 401', resG1.statusCode === 401, `status=${resG1.statusCode}`);
        assert('Không kích hoạt gói qua webhook giả mạo', (await User.findByPk(tempUserId)).plan === 'free');

        const resG2 = mockRes();
        await sepayController.handleWebhook({ body: forgedBody, headers: { authorization: 'Apikey sai-key-hoan-toan' } }, resG2);
        assert('Sai API Key -> 401', resG2.statusCode === 401, `status=${resG2.statusCode}`);

        const resG3 = mockRes();
        await sepayController.handleWebhook({
            body: { ...forgedBody, content: 'NOI DUNG KHONG KHOP CU PHAP' },
            headers: { authorization: `Apikey ${process.env.SEPAY_API_KEY}` }
        }, resG3);
        assert('Đúng API Key -> xử lý bình thường (không 401)', resG3.statusCode === 200, `status=${resG3.statusCode}`);

        console.log(`\nCác gói hiện có trong hệ thống: ${(await Plan.findAll()).map(p => p.name).join(', ')}`);
    } catch (err) {
        console.error('❌ LỖI KHI CHẠY TEST:', err);
        process.exitCode = 1;
    } finally {
        // ─── Dọn sạch dữ liệu test ─────────────────────────────────────────────
        if (tempUserId) {
            await PlanUpgradeRequest.destroy({ where: { landlordId: tempUserId } });
            await AdminLog.destroy({ where: { targetUserId: tempUserId } });
            await Notification.destroy({ where: { userId: tempUserId } });
            await User.destroy({ where: { id: tempUserId } });
            const leftover = await User.findByPk(tempUserId);
            console.log(leftover
                ? `\n⚠️ Chưa dọn được chủ nhà tạm ID=${tempUserId}`
                : `\n🧹 Đã dọn sạch dữ liệu test (chủ nhà tạm ID=${tempUserId} đã xoá).`);
        }
        await sequelize.close();
    }
}

run();
