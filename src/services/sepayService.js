const Invoice = require('../models/Invoice');
const Contract = require('../models/Contract');
const Room = require('../models/Room');
const Building = require('../models/Building');
const User = require('../models/User');
const Plan = require('../models/Plan');
const AdminLog = require('../models/AdminLog');
const notificationService = require('./notificationService');
const invoiceService = require('./invoiceService');

/**
 * Xử lý Webhook gửi từ SePay khi có giao dịch ngân hàng mới.
 * SePay gửi thông tin dạng JSON với cú pháp chuyển khoản ở trường `content` hoặc `description`.
 * 
 * Hỗ trợ 2 luồng tự động gạch nợ / nâng cấp:
 * 1. Thanh toán gói dịch vụ của Chủ nhà: Cú pháp `PLAN <LANDLORD_ID> <PLAN_NAME>` (Ví dụ: `PLAN 5 PRO`)
 * 2. Thanh toán tiền phòng của Người thuê: Cú pháp `HD <INVOICE_ID> LL <LANDLORD_ID>` (Ví dụ: `HD 12 LL 5`)
 */
exports.processWebhookPayload = async (payload) => {
    console.log('🔔 [SePay Webhook Received]:', JSON.stringify(payload, null, 2));

    const {
        transferType,
        transferAmount,
        content,
        description,
        transactionDate,
        accountNumber
    } = payload || {};

    // Chỉ xử lý tiền vào (transferType = 'in' hoặc tiền nhận > 0)
    if (transferType && transferType.toLowerCase() === 'out') {
        return { success: true, message: 'Bỏ qua giao dịch tiền ra (out)' };
    }

    const transferContent = (content || description || '').trim();
    if (!transferContent) {
        return { success: true, message: 'Không tìm thấy nội dung chuyển khoản' };
    }

    const amount = parseFloat(transferAmount || 0);

    // ─── 1. KIỂM TRA THANH TOÁN GÓI DỊCH VỤ SAAS (CHỦ NHÀ) ──────────────────────
    // Cú pháp: PLAN <LANDLORD_ID> <PLAN_NAME> [YEAR|ANNUAL|NAM] (Ví dụ: PLAN 5 PRO hoặc PLAN 5 PRO YEAR)
    const planMatch = transferContent.match(/PLAN\s+(\d+)\s+([A-Za-z]+)(?:\s+([A-Za-z]+))?/i);
    if (planMatch) {
        const landlordId = parseInt(planMatch[1]);
        const planName = planMatch[2].toLowerCase();
        const cycleToken = planMatch[3] ? planMatch[3].toLowerCase() : '';
        const isAnnual = cycleToken === 'year' || cycleToken === 'annual' || cycleToken === 'nam';

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

        // Tự động nâng cấp gói cước cho chủ nhà
        landlord.plan = plan.name;
        const daysToAdd = isAnnual ? 365 : 30;
        const now = new Date();
        let baseDate = now;
        if (landlord.planExpiresAt && new Date(landlord.planExpiresAt) > now) {
            baseDate = new Date(landlord.planExpiresAt);
        }
        baseDate.setDate(baseDate.getDate() + daysToAdd);
        landlord.planExpiresAt = baseDate.toISOString().split('T')[0];
        await landlord.save();

        // Ghi nhật ký admin log cho doanh thu SaaS
        await AdminLog.create({
            adminId: 1, // Super Admin hệ thống
            action: 'UPDATE_PLAN',
            targetUserId: landlord.id,
            description: `[SePay Auto Payment] Chủ nhà ${landlord.name || landlord.email} (ID: ${landlord.id}) đã tự động thanh toán $${amount.toLocaleString('vi-VN')} VND để nâng cấp lên gói ${plan.name.toUpperCase()}`
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
