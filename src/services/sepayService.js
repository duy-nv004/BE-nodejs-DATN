const Invoice = require('../models/Invoice');
const Contract = require('../models/Contract');
const Room = require('../models/Room');
const Building = require('../models/Building');
const User = require('../models/User');
const Plan = require('../models/Plan');
const PlanUpgradeRequest = require('../models/PlanUpgradeRequest');
const AdminLog = require('../models/AdminLog');
const SePayEvent = require('../models/SePayEvent');
const notificationService = require('./notificationService');
const invoiceService = require('./invoiceService');
const crypto = require('crypto');
const { isAnnualCycle, cycleDays, planPriceVnd } = require('../utils/planPricing');

/**
 * Khoá định danh duy nhất cho một giao dịch webhook, dùng để chống xử lý trùng.
 *
 * Ưu tiên ID do SePay cấp. Nếu webhook không kèm ID nào, băm các trường đặc trưng
 * của giao dịch (thời điểm + nội dung + số tiền + số tài khoản). transactionDate do
 * SePay cung cấp có độ phân giải tới giây nên hai giao dịch khác nhau hầu như không
 * bao giờ trùng dấu vân tay.
 */
const buildEventKey = (payload, content, amount) => {
    const sepayId = payload?.id || payload?.referenceCode || payload?.reference_number;
    if (sepayId) return `sepay:${sepayId}`;

    const fingerprint = [
        payload?.transactionDate || '',
        content,
        amount,
        payload?.accountNumber || ''
    ].join('|');
    return `hash:${crypto.createHash('sha256').update(fingerprint).digest('hex')}`;
};

/**
 * Xử lý Webhook gửi từ SePay khi có giao dịch ngân hàng mới.
 * SePay gửi thông tin dạng JSON với cú pháp chuyển khoản ở trường `content` hoặc `description`.
 * 
 * Hỗ trợ 2 luồng tự động gạch nợ / nâng cấp:
 * 1. Thanh toán gói dịch vụ của Chủ nhà: Cú pháp `PLAN <LANDLORD_ID> <PLAN_NAME>` (Ví dụ: `PLAN 5 PRO`)
 * 2. Thanh toán tiền phòng của Người thuê: Cú pháp `HD <INVOICE_ID> LL <LANDLORD_ID>` (Ví dụ: `HD 12 LL 5`)
 */
/**
 * Cổng vào webhook: chống xử lý trùng rồi mới chuyển sang logic nghiệp vụ.
 *
 * SePay gửi lại webhook khi không nhận được HTTP 200, và payload cũ cũng có thể bị
 * gửi lại thủ công. Không có chốt chặn này thì mỗi lần lặp lại một giao dịch
 * "PLAN <id> PRO YEAR" hợp lệ sẽ cộng thêm 365 ngày vào hạn gói cước, vì sau lần
 * đầu tiên PlanUpgradeRequest đã chuyển sang `paid` nên không còn được tìm thấy
 * và giá được tính lại theo bảng Plans.
 */
exports.processWebhookPayload = async (payload) => {
    const { content, description, transferAmount } = payload || {};
    const transferContent = (content || description || '').trim();
    const amount = parseFloat(transferAmount || 0);

    // Nội dung rỗng thì không có gì để nhận diện — để logic bên dưới xử lý và trả về.
    let event = null;
    if (transferContent) {
        const eventKey = buildEventKey(payload, transferContent, amount);
        try {
            event = await SePayEvent.create({
                eventKey,
                content: transferContent,
                transferAmount: amount,
                payload: JSON.stringify(payload)
            });
        } catch (err) {
            if (err.name === 'SequelizeUniqueConstraintError') {
                console.log(`ℹ️ [SePay Webhook] Bỏ qua giao dịch đã xử lý trước đó (key=${eventKey}).`);
                return {
                    success: true,
                    duplicated: true,
                    message: 'Giao dịch này đã được xử lý trước đó, bỏ qua để tránh cộng trùng.'
                };
            }
            throw err;
        }
    }

    const result = await processPayload(payload, transferContent, amount);

    if (event) {
        event.resultType = result?.type || (result?.success ? 'OK' : 'REJECTED');
        await event.save();
    }
    return result;
};

const processPayload = async (payload, transferContent, amount) => {
    console.log('🔔 [SePay Webhook Received]:', JSON.stringify(payload, null, 2));

    const { transferType } = payload || {};

    // Chỉ xử lý tiền vào (transferType = 'in' hoặc tiền nhận > 0)
    if (transferType && transferType.toLowerCase() === 'out') {
        return { success: true, message: 'Bỏ qua giao dịch tiền ra (out)' };
    }

    if (!transferContent) {
        return { success: true, message: 'Không tìm thấy nội dung chuyển khoản' };
    }

    // ─── 1. KIỂM TRA THANH TOÁN GÓI DỊCH VỤ SAAS (CHỦ NHÀ) ──────────────────────
    // Cú pháp: PLAN <LANDLORD_ID> <PLAN_NAME> [YEAR|ANNUAL|NAM] (Ví dụ: PLAN 5 PRO hoặc PLAN 5 PRO YEAR)
    const planMatch = transferContent.match(/PLAN\s+(\d+)\s+([A-Za-z]+)(?:\s+([A-Za-z]+))?/i);
    if (planMatch) {
        const landlordId = parseInt(planMatch[1]);
        const planName = planMatch[2].toLowerCase();
        const cycleToken = planMatch[3] ? planMatch[3].toLowerCase() : '';

        const landlord = await User.findByPk(landlordId);
        if (!landlord) {
            console.warn(`⚠️ [SePay Webhook] Không tìm thấy chủ nhà với ID: ${landlordId}`);
            return { success: false, message: `Không tìm thấy chủ nhà ID ${landlordId}` };
        }

        const plan = await Plan.findOne({ where: { name: planName } });
        if (!plan) {
            console.warn(`⚠️ [SePay Webhook] Gói cước không hợp lệ: ${planName}`);
            return { success: false, message: `Gói cước ${planName} không hợp lệ` };
        }

        // Yêu cầu nâng cấp đang chờ (nếu chủ nhà bấm nâng cấp trên web trước khi chuyển khoản)
        const pendingRequest = await PlanUpgradeRequest.findOne({
            where: { landlordId: landlord.id, planName: plan.name, status: 'pending' },
            order: [['createdAt', 'DESC']]
        });

        // Nội dung chuyển khoản không ghi chu kỳ -> lấy theo chu kỳ đã đăng ký trong yêu cầu chờ
        const isAnnual = cycleToken
            ? isAnnualCycle(cycleToken)
            : pendingRequest?.billingCycle === 'annual';

        const expectedAmount = (pendingRequest && !cycleToken)
            ? parseFloat(pendingRequest.amount)
            : planPriceVnd(plan, isAnnual ? 'annual' : 'monthly');

        // 🔒 Chốt chặn: KHÔNG kích hoạt gói nếu số tiền nhận được nhỏ hơn giá gói cước.
        // Nếu thiếu bước này, chỉ cần chuyển vài nghìn đồng kèm nội dung "PLAN <id> PRO"
        // là chiếm được gói trả phí.
        if (amount < expectedAmount) {
            console.warn(`⚠️ [SePay Webhook] Số tiền không đủ cho gói ${plan.name.toUpperCase()} của chủ nhà ID ${landlord.id}: nhận ${amount} / cần ${expectedAmount}`);

            await AdminLog.create({
                adminId: 1,
                action: 'PLAN_PAYMENT_REJECTED',
                targetUserId: landlord.id,
                description: `[SePay] Từ chối kích hoạt gói ${plan.name.toUpperCase()} cho chủ nhà ${landlord.name || landlord.email} (ID: ${landlord.id}): số tiền nhận được ${amount.toLocaleString('vi-VN')} VNĐ nhỏ hơn giá gói ${expectedAmount.toLocaleString('vi-VN')} VNĐ`
            });

            await notificationService.createNotification(
                landlord.id,
                'Giao dịch chưa đủ để nâng cấp gói dịch vụ',
                `Hệ thống nhận được ${amount.toLocaleString('vi-VN')} VNĐ cho gói ${plan.name.toUpperCase()} nhưng giá gói là ${expectedAmount.toLocaleString('vi-VN')} VNĐ. `
                + `Vui lòng chuyển khoản bổ sung phần còn thiếu với đúng nội dung "${pendingRequest?.transferCode || `PLAN ${landlord.id} ${plan.name.toUpperCase()}`}".`,
                'plan_expiry',
                landlord.id
            );

            return {
                success: false,
                type: 'PLAN_UNDERPAID',
                message: `Số tiền ${amount} VNĐ không đủ để kích hoạt gói ${plan.name.toUpperCase()} (cần ${expectedAmount} VNĐ)`
            };
        }

        // Tự động nâng cấp gói cước cho chủ nhà
        landlord.plan = plan.name;
        const daysToAdd = cycleDays(isAnnual ? 'annual' : 'monthly');
        const now = new Date();
        let baseDate = now;
        if (landlord.planExpiresAt && new Date(landlord.planExpiresAt) > now) {
            baseDate = new Date(landlord.planExpiresAt);
        }
        baseDate.setDate(baseDate.getDate() + daysToAdd);
        landlord.planExpiresAt = baseDate.toISOString().split('T')[0];
        await landlord.save();

        // Đánh dấu yêu cầu nâng cấp đã được thanh toán
        if (pendingRequest) {
            pendingRequest.status = 'paid';
            pendingRequest.paidAt = new Date();
            pendingRequest.transactionReference = String(
                payload.referenceCode || payload.reference_number || payload.id || ''
            ) || null;
            await pendingRequest.save();
        }

        // Ghi nhật ký admin log cho doanh thu SaaS
        await AdminLog.create({
            adminId: 1, // Super Admin hệ thống
            action: 'UPDATE_PLAN',
            targetUserId: landlord.id,
            description: `[SePay Auto Payment] Chủ nhà ${landlord.name || landlord.email} (ID: ${landlord.id}) đã tự động thanh toán ${amount.toLocaleString('vi-VN')} VNĐ để nâng cấp lên gói ${plan.name.toUpperCase()}`
        });

        // Gửi thông báo cho chủ nhà
        await notificationService.createNotification(
            landlord.id,
            'Nâng cấp gói dịch vụ tự động thành công (SePay)',
            `Hệ thống SePay đã xác nhận giao dịch thanh toán. Gói ${plan.name.toUpperCase()} của bạn đã được gia hạn đến ngày ${landlord.planExpiresAt}.`,
            'plan_expiry',
            landlord.id
        );

        console.log(`✅ [SePay Auto Upgrade] Đã tự động kích hoạt gói ${plan.name.toUpperCase()} cho chủ nhà ID ${landlord.id}`);
        return {
            success: true,
            type: 'PLAN_UPGRADE',
            message: `Tự động kích hoạt gói ${plan.name.toUpperCase()} thành công cho chủ nhà ID ${landlord.id}`
        };
    }

    // ─── 2. KIỂM TRA THANH TOÁN TIỀN PHÒNG (NGƯỜI THUÊ) ──────────────────────────
    // Cú pháp: HD <INVOICE_ID> LL <LANDLORD_ID> (Ví dụ: HD 12 LL 5 hoặc HD 12)
    const invoiceMatch = transferContent.match(/HD\s+(\d+)(?:\s+LL\s+(\d+))?/i);
    if (invoiceMatch) {
        const invoiceId = parseInt(invoiceMatch[1]);
        const landlordIdFromContent = invoiceMatch[2] ? parseInt(invoiceMatch[2]) : null;

        const invoice = await Invoice.findByPk(invoiceId, {
            include: [{ model: Room, as: 'roomDetails', include: [{ model: Building, as: 'building' }] }]
        });

        if (!invoice) {
            console.warn(`⚠️ [SePay Webhook] Không tìm thấy hóa đơn ID: ${invoiceId}`);
            return { success: false, message: `Không tìm thấy hóa đơn ID ${invoiceId}` };
        }

        const landlordId = landlordIdFromContent || invoice.roomDetails?.building?.landlordId;

        // Lưu landlordId trực tiếp vào Invoice để tiện cho việc thống kê doanh thu chủ nhà
        if (landlordId && !invoice.landlordId) {
            invoice.landlordId = landlordId;
        }

        if (invoice.isPaid) {
            console.log(`ℹ️ [SePay Webhook] Hóa đơn ID ${invoiceId} đã được gạch nợ trước đó.`);
            return { success: true, message: `Hóa đơn ID ${invoiceId} đã được thanh toán từ trước` };
        }

        // 🔒 Chốt chặn: KHÔNG gạch nợ nếu số tiền nhận được nhỏ hơn tổng tiền hóa đơn.
        // Trước đây nhánh này chỉ kiểm tra invoiceId có tồn tại, nên chuyển vài nghìn
        // đồng kèm nội dung "HD <id>" là hóa đơn được đánh dấu đã thanh toán.
        const invoiceTotal = parseFloat(invoice.totalAmount || 0);
        if (amount < invoiceTotal) {
            console.warn(`⚠️ [SePay Webhook] Số tiền không đủ cho Hóa đơn #${invoiceId}: nhận ${amount} / cần ${invoiceTotal}`);

            await AdminLog.create({
                adminId: 1,
                action: 'INVOICE_PAYMENT_REJECTED',
                targetUserId: landlordId || null,
                description: `[SePay] Từ chối gạch nợ Hóa đơn #${invoiceId} (phòng ${invoice.roomDetails?.roomNumber || 'N/A'}): số tiền nhận được ${amount.toLocaleString('vi-VN')} VNĐ nhỏ hơn tổng hóa đơn ${invoiceTotal.toLocaleString('vi-VN')} VNĐ`
            });

            if (landlordId) {
                await notificationService.createNotification(
                    landlordId,
                    'Giao dịch chưa đủ để tất toán hóa đơn',
                    `Hệ thống nhận được ${amount.toLocaleString('vi-VN')} VNĐ cho Hóa đơn #${invoiceId} (phòng ${invoice.roomDetails?.roomNumber || 'N/A'}) `
                    + `nhưng tổng tiền hóa đơn là ${invoiceTotal.toLocaleString('vi-VN')} VNĐ. Hóa đơn chưa được gạch nợ.`,
                    'invoice_payment',
                    invoiceId
                );
            }

            return {
                success: false,
                type: 'INVOICE_UNDERPAID',
                invoiceId,
                message: `Số tiền ${amount} VNĐ không đủ để tất toán Hóa đơn #${invoiceId} (cần ${invoiceTotal} VNĐ)`
            };
        }

        // Tự động chuyển trạng thái thanh toán
        await invoiceService.updatePaymentStatus(invoiceId, { isPaid: true });

        console.log(`✅ [SePay Auto Gạch Nợ] Đã tự động xác nhận thanh toán cho Hóa đơn #${invoiceId} của Chủ nhà ID ${landlordId}`);
        return {
            success: true,
            type: 'ROOM_INVOICE',
            invoiceId,
            landlordId,
            message: `Tự động gạch nợ thành công cho Hóa đơn #${invoiceId}`
        };
    }

    return {
        success: true,
        message: 'Nội dung chuyển khoản không trùng khớp với cú pháp dịch vụ'
    };
};
