const Invoice = require('../models/Invoice');
const Contract = require('../models/Contract');
const Room = require('../models/Room');
const Building = require('../models/Building');
const User = require('../models/User');
const Plan = require('../models/Plan');
const PlanUpgradeRequest = require('../models/PlanUpgradeRequest');
const AdminLog = require('../models/AdminLog');
const SePayEvent = require('../models/SePayEvent');
const Role = require('../models/Role');
const notificationService = require('./notificationService');
const invoiceService = require('./invoiceService');
const { computeConvertedPlanExpiry } = require('./planService');
const crypto = require('crypto');
const sequelize = require('../config/db');
const { isAnnualCycle, cycleDays, planPriceVnd } = require('../utils/planPricing');

/**
 * Chạy callback trong transaction nếu DB/stub sẵn sàng; fallback an toàn khi unit test không stub DB.
 */
const withTransaction = async (fn) => {
    if (sequelize && typeof sequelize.transaction === 'function') {
        try {
            return await sequelize.transaction(fn);
        } catch (err) {
            if (
                err?.name === 'SequelizeConnectionRefusedError' ||
                err?.name === 'SequelizeConnectionError' ||
                err?.name === 'SequelizeHostNotReachableError'
            ) {
                return await fn(null);
            }
            throw err;
        }
    }
    return await fn(null);
};

/**
 * Khoá định danh duy nhất cho một giao dịch webhook, dùng để chống xử lý trùng.
 */
const buildEventKey = (payload, content, amount) => {
    const sepayId = payload?.id || payload?.referenceCode || payload?.reference_number;
    if (sepayId) return `sepay:${sepayId}`;

    const fingerprint = [
        payload?.transactionDate || '',
        content,
        amount,
        payload?.accountNumber || '',
        payload?.subAccount || ''
    ].join('|');
    return `hash:${crypto.createHash('sha256').update(fingerprint).digest('hex')}`;
};

const getTxRef = (payload) =>
    String(payload?.referenceCode || payload?.reference_number || payload?.id || '').trim() || 'N/A';

/**
 * Ghi AdminLog cho webhook dưới tên tài khoản admin thật (AdminLog.adminId NOT NULL).
 * Nuốt lỗi: log chạy sau khi trạng thái đã lưu, lỗi ở đây không được biến thành 500.
 */
const writeAdminLog = async (data) => {
    try {
        const role = await Role.findOne({ where: { name: 'admin' } });
        const admin = role && await User.findOne({ where: { roleId: role.id }, order: [['id', 'ASC']] });
        if (!admin) {
            console.warn(`⚠️ [SePay Webhook] Không có tài khoản admin, bỏ qua AdminLog ${data.action}`);
            return;
        }
        await AdminLog.create({ ...data, adminId: admin.id });
    } catch (err) {
        console.error(`❌ [SePay Webhook] Ghi AdminLog ${data.action} thất bại:`, err.message);
    }
};

/**
 * Cổng vào webhook: chống xử lý trùng, theo dõi vòng đời SePayEvent (PROCESSING -> PROCESSED/REJECTED/FAILED).
 */
exports.processWebhookPayload = async (payload) => {
    const { content, description, transferAmount } = payload || {};
    const transferContent = (content || description || '').trim();
    const amount = parseFloat(transferAmount || 0);

    let event = null;
    if (transferContent) {
        const eventKey = buildEventKey(payload, transferContent, amount);
        try {
            event = await SePayEvent.create({
                eventKey,
                content: transferContent,
                transferAmount: amount,
                status: 'PROCESSING',
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

    let result;
    try {
        result = await processPayload(payload, transferContent, amount);
    } catch (err) {
        if (event) {
            if (err.afterStateWritten) {
                event.status = 'FAILED';
                event.errorReason = err.message;
                await event.save().catch(() => {});
            } else {
                await event.destroy().catch(() => {});
            }
        }
        throw err;
    }

    if (event) {
        event.resultType = result?.type || (result?.success ? 'OK' : 'REJECTED');
        event.status = result?.success === false ? 'REJECTED' : 'PROCESSED';
        event.invoiceId = result?.invoiceId || null;
        event.landlordId = result?.landlordId || null;
        event.errorReason = result?.success === false ? (result?.message || null) : null;
        await event.save();
    }
    return result;
};

const processPayload = async (payload, transferContent, amount) => {
    console.log('🔔 [SePay Webhook Received]:', JSON.stringify(payload, null, 2));

    const { transferType } = payload || {};
    const txRef = getTxRef(payload);

    if (transferType && String(transferType).toLowerCase() === 'out') {
        return { success: true, message: 'Bỏ qua giao dịch tiền ra (out)' };
    }

    if (!transferContent) {
        return { success: true, message: 'Không tìm thấy nội dung chuyển khoản' };
    }

    // ─── 1. KIỂM TRA THANH TOÁN GÓI DỊCH VỤ SAAS (CHỦ NHÀ) ──────────────────────
    const planMatch = transferContent.match(/PLAN\s+(\d+)\s+([A-Za-z]+)(?:\s+([A-Za-z]+))?/i);
    if (planMatch) {
        const landlordId = parseInt(planMatch[1], 10);
        const planName = planMatch[2].toLowerCase();
        const cycleToken = planMatch[3] ? planMatch[3].toLowerCase() : '';

        const landlord = await User.findByPk(landlordId, { include: [{ model: Role, as: 'roleData' }] });
        if (!landlord || landlord.roleData?.name !== 'landlord') {
            const msg = `Không tìm thấy chủ nhà ID ${landlordId}`;
            console.warn(`⚠️ [SePay Webhook] ${msg}`);
            await writeAdminLog({
                action: 'SEPAY_UNMATCHED',
                targetUserId: null,
                description: `[SePay] ${msg}. Số tiền: ${amount.toLocaleString('vi-VN')} VNĐ, Nội dung: "${transferContent}", Mã GD: ${txRef}`,
            });
            return { success: false, type: 'SEPAY_UNMATCHED', landlordId, message: msg };
        }

        const plan = await Plan.findOne({ where: { name: planName } });
        if (!plan || plan.name === 'free') {
            const msg = `Gói cước ${planName} không hợp lệ`;
            console.warn(`⚠️ [SePay Webhook] ${msg}`);
            await writeAdminLog({
                action: 'PLAN_INVALID',
                targetUserId: landlord.id,
                description: `[SePay] ${msg} cho chủ nhà ID ${landlord.id}. Số tiền: ${amount.toLocaleString('vi-VN')} VNĐ, Nội dung: "${transferContent}", Mã GD: ${txRef}`,
            });
            return { success: false, type: 'PLAN_INVALID', landlordId: landlord.id, message: msg };
        }

        const pendingRequest = await PlanUpgradeRequest.findOne({
            where: { landlordId: landlord.id, planName: plan.name, status: 'pending' },
            order: [['createdAt', 'DESC']]
        });

        const annualPrice = parseFloat(plan.annualPrice || 0);
        const isAnnual = cycleToken
            ? isAnnualCycle(cycleToken)
            : (pendingRequest
                ? pendingRequest.billingCycle === 'annual'
                : (annualPrice > 0 && amount >= annualPrice));

        const expectedAmount = (pendingRequest && !cycleToken)
            ? parseFloat(pendingRequest.amount)
            : planPriceVnd(plan, isAnnual ? 'annual' : 'monthly');

        if (amount < expectedAmount) {
            console.warn(`⚠️ [SePay Webhook] Số tiền không đủ cho gói ${plan.name.toUpperCase()} của chủ nhà ID ${landlord.id}: nhận ${amount} / cần ${expectedAmount}`);

            await writeAdminLog({
                action: 'PLAN_PAYMENT_REJECTED',
                targetUserId: landlord.id,
                description: `[SePay] Từ chối kích hoạt gói ${plan.name.toUpperCase()} cho chủ nhà ${landlord.name || landlord.email} (ID: ${landlord.id}): số tiền nhận được ${amount.toLocaleString('vi-VN')} VNĐ nhỏ hơn giá gói ${expectedAmount.toLocaleString('vi-VN')} VNĐ (Mã GD: ${txRef})`
            });

            await notificationService.createNotification(
                landlord.id,
                'Giao dịch chưa đủ để nâng cấp gói dịch vụ',
                `Hệ thống nhận được ${amount.toLocaleString('vi-VN')} VNĐ cho gói ${plan.name.toUpperCase()} nhưng giá gói là ${expectedAmount.toLocaleString('vi-VN')} VNĐ. `
                + `Vui lòng chuyển khoản lại toàn bộ ${expectedAmount.toLocaleString('vi-VN')} VNĐ với đúng nội dung "${pendingRequest?.transferCode || `PLAN ${landlord.id} ${plan.name.toUpperCase()}`}". `
                + 'Khoản đã chuyển trước đó sẽ được quản trị viên đối soát và hoàn lại thủ công.',
                'plan_expiry',
                landlord.id
            );

            return {
                success: false,
                type: 'PLAN_UNDERPAID',
                landlordId: landlord.id,
                message: `Số tiền ${amount} VNĐ không đủ để kích hoạt gói ${plan.name.toUpperCase()} (cần ${expectedAmount} VNĐ)`
            };
        }

        const cycle = isAnnual ? 'annual' : 'monthly';
        const daysToAdd = cycleDays(cycle);
        const activated = await withTransaction(async (t) => {
            const txOpt = t ? { transaction: t } : {};
            let request = null;
            if (pendingRequest) {
                request = await PlanUpgradeRequest.findByPk(pendingRequest.id, {
                    ...(t ? { lock: t.LOCK?.UPDATE || true, transaction: t } : { lock: true }),
                });
                if (!request || request.status !== 'pending') return null;
            }
            const locked = (await User.findByPk(landlord.id, {
                ...(t ? { lock: t.LOCK?.UPDATE || true, transaction: t } : { lock: true }),
            })) || landlord;

            const oldPlan = locked.plan;
            const oldExpiresAt = locked.planExpiresAt;
            let oldPrice = 0;
            if (oldPlan && oldPlan !== 'free' && oldPlan !== plan.name) {
                try {
                    const oldPlanObj = await Plan.findOne({ where: { name: oldPlan }, ...txOpt });
                    oldPrice = parseFloat(oldPlanObj?.price) || 0;
                } catch {
                    oldPrice = 0;
                }
            }

            locked.plan = plan.name;
            locked.planExpiresAt = computeConvertedPlanExpiry({
                oldPlan,
                oldExpiresAt,
                newPlan: plan.name,
                daysToAdd,
                oldPrice,
                newPrice: parseFloat(plan.price) || 0,
            });
            locked.billingCycle = cycle;
            locked.planSource = 'sepay';
            await locked.save(txOpt);

            if (request) {
                request.status = 'paid';
                request.paidAt = new Date();
                request.transactionReference = String(
                    payload.referenceCode || payload.reference_number || payload.id || ''
                ) || null;
                await request.save(txOpt);
            }
            return locked;
        });

        if (!activated) {
            console.log(`ℹ️ [SePay Webhook] Yêu cầu nâng cấp #${pendingRequest?.id} đã được xử lý ở giao dịch khác, bỏ qua.`);
            return {
                success: true,
                duplicated: true,
                landlordId: landlord.id,
                message: 'Yêu cầu nâng cấp đã được thanh toán trước đó, không cộng hạn lần hai.'
            };
        }
        landlord.planExpiresAt = activated.planExpiresAt;
        landlord.billingCycle = activated.billingCycle;
        landlord.planSource = activated.planSource;

        await writeAdminLog({
            action: 'UPDATE_PLAN',
            targetUserId: landlord.id,
            description: `[SePay Auto Payment] Chủ nhà ${landlord.name || landlord.email} (ID: ${landlord.id}) đã tự động thanh toán ${amount.toLocaleString('vi-VN')} VNĐ để nâng cấp lên gói ${plan.name.toUpperCase()} (${cycle})`
        });

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
            landlordId: landlord.id,
            message: `Tự động kích hoạt gói ${plan.name.toUpperCase()} thành công cho chủ nhà ID ${landlord.id}`
        };
    }

    // ─── 2. KIỂM TRA THANH TOÁN TIỀN PHÒNG (NGƯỜI THUÊ) ──────────────────────────
    const invoiceMatch = transferContent.match(/HD\s+(\d+)(?:\s+LL\s+(\d+))?/i);
    if (invoiceMatch) {
        const invoiceId = parseInt(invoiceMatch[1], 10);
        const landlordIdFromContent = invoiceMatch[2] ? parseInt(invoiceMatch[2], 10) : null;

        return withTransaction(async (t) => {
            const txOpt = t ? { transaction: t } : {};
            const invoice = await Invoice.findByPk(invoiceId, {
                include: [{ model: Room, as: 'roomDetails', include: [{ model: Building, as: 'building' }] }],
                ...(t ? { lock: t.LOCK?.UPDATE || true, transaction: t } : {}),
            });

            if (!invoice) {
                const msg = `Không tìm thấy hóa đơn ID ${invoiceId}`;
                console.warn(`⚠️ [SePay Webhook] ${msg}`);
                await writeAdminLog({
                    action: 'UNKNOWN_INVOICE',
                    targetUserId: landlordIdFromContent || null,
                    description: `[SePay] ${msg}. Số tiền: ${amount.toLocaleString('vi-VN')} VNĐ, Nội dung: "${transferContent}", Mã GD: ${txRef}`,
                });
                return { success: false, type: 'UNKNOWN_INVOICE', invoiceId, message: msg };
            }

            const landlordId = invoice.landlordId || invoice.roomDetails?.building?.landlordId;
            if (landlordIdFromContent && landlordId && landlordIdFromContent !== landlordId) {
                const msg = `Mã chủ nhà trong nội dung không khớp Hóa đơn #${invoiceId}`;
                console.warn(`⚠️ [SePay Webhook] LL ${landlordIdFromContent} không khớp chủ của Hóa đơn #${invoiceId} (${landlordId})`);
                await writeAdminLog({
                    action: 'INVOICE_LANDLORD_MISMATCH',
                    targetUserId: landlordId || null,
                    description: `[SePay] ${msg} (ghi LL ${landlordIdFromContent}, chủ thật ${landlordId}). Số tiền: ${amount.toLocaleString('vi-VN')} VNĐ, Nội dung: "${transferContent}", Mã GD: ${txRef}`,
                });
                return { success: false, type: 'INVOICE_LANDLORD_MISMATCH', invoiceId, landlordId, message: msg };
            }

            if (landlordId && !invoice.landlordId) {
                invoice.landlordId = landlordId;
            }

            if (invoice.isPaid) {
                console.warn(`⚠️ [SePay Webhook] Hóa đơn ID ${invoiceId} đã được gạch nợ trước đó, nhận thêm ${amount}.`);
                await writeAdminLog({
                    action: 'INVOICE_DUPLICATE_PAYMENT',
                    targetUserId: landlordId || null,
                    description: `[SePay] Nhận thêm ${amount.toLocaleString('vi-VN')} VNĐ cho Hóa đơn #${invoiceId} (phòng ${invoice.roomDetails?.roomNumber || 'N/A'}) đã thanh toán trước đó. Cần đối soát và hoàn tiền thủ công.`
                });
                if (landlordId) {
                    await notificationService.createNotification(
                        landlordId,
                        'Nhận tiền cho hóa đơn đã thanh toán',
                        `Hệ thống nhận thêm ${amount.toLocaleString('vi-VN')} VNĐ cho Hóa đơn #${invoiceId} (phòng ${invoice.roomDetails?.roomNumber || 'N/A'}) dù hóa đơn đã được thanh toán. `
                        + 'Vui lòng kiểm tra và hoàn lại cho người thuê nếu chuyển nhầm.',
                        'invoice_payment',
                        invoiceId
                    );
                }
                return { success: true, type: 'INVOICE_DUPLICATE_PAYMENT', invoiceId, landlordId, message: `Hóa đơn ID ${invoiceId} đã được thanh toán từ trước` };
            }

            const invoiceTotal = parseFloat(invoice.totalAmount || 0);
            const currentPaid = parseFloat(invoice.paidAmount || 0);
            const remainingAmount = Math.max(0, invoiceTotal - currentPaid);
            const newPaidAmount = currentPaid + amount;
            const roomNumber = invoice.roomDetails?.roomNumber || 'N/A';

            // T2.2: Thanh toán một phần (amount < remainingAmount)
            if (amount < remainingAmount) {
                console.log(`ℹ️ [SePay Webhook] Thanh toán một phần cho Hóa đơn #${invoiceId}: nhận ${amount} / còn thiếu ${remainingAmount}`);

                await invoiceService.updatePaymentStatus(
                    invoiceId,
                    { isPaid: false, paymentMethod: 'sepay', paidAmount: newPaidAmount },
                    null,
                    txOpt
                );

                try {
                    const sseService = require('./sseService');
                    if (landlordId) sseService.sendToUser(landlordId, 'payment_success', { invoiceId, amount, isFull: false, remaining: Math.max(0, invoiceTotal - newPaidAmount), roomNumber });
                    if (invoice.tenantId) sseService.sendToUser(invoice.tenantId, 'payment_success', { invoiceId, amount, isFull: false, remaining: Math.max(0, invoiceTotal - newPaidAmount), roomNumber });
                } catch (e) {}

                const remainingAfter = Math.max(0, invoiceTotal - newPaidAmount);
                await writeAdminLog({
                    action: 'INVOICE_PARTIAL_PAYMENT',
                    targetUserId: landlordId || null,
                    description: `[SePay] Đã nhận ${amount.toLocaleString('vi-VN')} / ${invoiceTotal.toLocaleString('vi-VN')} VNĐ cho Hóa đơn #${invoiceId} (phòng ${roomNumber}). Lũy kế đã thu: ${newPaidAmount.toLocaleString('vi-VN')} VNĐ, còn lại: ${remainingAfter.toLocaleString('vi-VN')} VNĐ.`
                });

                if (landlordId) {
                    await notificationService.createNotification(
                        landlordId,
                        'Nhận thanh toán một phần hóa đơn',
                        `Đã nhận ${amount.toLocaleString('vi-VN')} / ${invoiceTotal.toLocaleString('vi-VN')} VNĐ cho Hóa đơn #${invoiceId} (phòng ${roomNumber}). Đã thu lũy kế ${newPaidAmount.toLocaleString('vi-VN')} VNĐ, còn thiếu ${remainingAfter.toLocaleString('vi-VN')} VNĐ.`,
                        'invoice_payment',
                        invoiceId
                    );
                }
                if (invoice.tenantId) {
                    await notificationService.createNotification(
                        invoice.tenantId,
                        'Đã ghi nhận thanh toán một phần',
                        `Hệ thống đã nhận ${amount.toLocaleString('vi-VN')} / ${invoiceTotal.toLocaleString('vi-VN')} VNĐ cho Hóa đơn #${invoiceId} (phòng ${roomNumber}). Số tiền còn thiếu là ${remainingAfter.toLocaleString('vi-VN')} VNĐ.`,
                        'invoice_payment',
                        invoiceId
                    );
                }

                return {
                    success: true,
                    type: 'INVOICE_PARTIAL',
                    invoiceId,
                    landlordId,
                    paidAmount: newPaidAmount,
                    remainingAmount: remainingAfter,
                    message: `Đã nhận ${amount.toLocaleString('vi-VN')}/${invoiceTotal.toLocaleString('vi-VN')} VNĐ cho Hóa đơn #${invoiceId}`
                };
            }

            // Gạch nợ đủ hóa đơn (bao gồm cả trường hợp trả vừa đủ hoặc trả thừa)
            await invoiceService.updatePaymentStatus(
                invoiceId,
                { isPaid: true, paymentMethod: 'sepay', paidAmount: newPaidAmount },
                null,
                txOpt
            );

            try {
                const sseService = require('./sseService');
                if (landlordId) sseService.sendToUser(landlordId, 'payment_success', { invoiceId, amount, isFull: true, roomNumber });
                if (invoice.tenantId) sseService.sendToUser(invoice.tenantId, 'payment_success', { invoiceId, amount, isFull: true, roomNumber });
            } catch (e) {}

            // T2.2: Trả thừa (amount > remainingAmount)
            if (amount > remainingAmount) {
                const overpaidAmount = amount - remainingAmount;
                console.warn(`⚠️ [SePay Webhook] Hóa đơn #${invoiceId} nhận dư ${overpaidAmount} VNĐ (nhận ${amount}, cần ${remainingAmount}).`);

                await writeAdminLog({
                    action: 'INVOICE_OVERPAID',
                    targetUserId: landlordId || null,
                    description: `[SePay] Hóa đơn #${invoiceId} (phòng ${roomNumber}) nhận thừa ${overpaidAmount.toLocaleString('vi-VN')} VNĐ (nhận ${amount.toLocaleString('vi-VN')} VNĐ / cần thanh toán ${remainingAmount.toLocaleString('vi-VN')} VNĐ, Mã GD: ${txRef}). Cần hoàn trả hoặc đối trừ kỳ sau.`
                });

                if (landlordId) {
                    await notificationService.createNotification(
                        landlordId,
                        'Khách thuê chuyển thừa tiền hóa đơn',
                        `Hóa đơn #${invoiceId} (phòng ${roomNumber}) đã được gạch nợ đủ, kèm khoản tiền thừa ${overpaidAmount.toLocaleString('vi-VN')} VNĐ. Vui lòng hoàn trả hoặc đối trừ vào kỳ sau cho khách thuê.`,
                        'invoice_payment',
                        invoiceId
                    );
                }
                if (invoice.tenantId) {
                    await notificationService.createNotification(
                        invoice.tenantId,
                        'Thanh toán hóa đơn thành công (có tiền thừa)',
                        `Hóa đơn #${invoiceId} (phòng ${roomNumber}) đã được tất toán. Bạn đã chuyển dư ${overpaidAmount.toLocaleString('vi-VN')} VNĐ; chủ nhà sẽ liên hệ để hoàn lại hoặc đối trừ vào kỳ sau.`,
                        'invoice_payment',
                        invoiceId
                    );
                }
            }

            console.log(`✅ [SePay Auto Gạch Nợ] Đã tự động xác nhận thanh toán cho Hóa đơn #${invoiceId} của Chủ nhà ID ${landlordId}`);
            return {
                success: true,
                type: 'ROOM_INVOICE',
                invoiceId,
                landlordId,
                overpaidAmount: amount > remainingAmount ? (amount - remainingAmount) : 0,
                message: `Tự động gạch nợ thành công cho Hóa đơn #${invoiceId}`
            };
        });
    }

    const unmatchedMsg = 'Nội dung chuyển khoản không trùng khớp với cú pháp dịch vụ';
    await writeAdminLog({
        action: 'SEPAY_UNMATCHED',
        targetUserId: null,
        description: `[SePay] ${unmatchedMsg}. Số tiền: ${amount.toLocaleString('vi-VN')} VNĐ, Nội dung: "${transferContent}", Mã GD: ${txRef}`,
    });

    return {
        success: false,
        type: 'SEPAY_UNMATCHED',
        message: unmatchedMsg
    };
};
