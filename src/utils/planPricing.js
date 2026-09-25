/**
 * Quy đổi giá gói cước từ USD (lưu trong bảng Plans) sang VND để tạo mã QR SePay.
 * Tỷ giá này phải khớp với hàm formatPriceVND ở Frontend (Plans.jsx).
 */
const VND_PER_USD = 25000;

const ANNUAL_TOKENS = ['annual', 'year', 'yearly', 'nam'];

/** Chu kỳ thanh toán có phải theo năm hay không */
const isAnnualCycle = (billingCycle) =>
    ANNUAL_TOKENS.includes(String(billingCycle || '').trim().toLowerCase());

/** Chu kỳ đã chuẩn hoá để lưu xuống DB */
const normalizeCycle = (billingCycle) => (isAnnualCycle(billingCycle) ? 'annual' : 'monthly');

/** Số ngày cộng thêm vào hạn sử dụng của gói theo chu kỳ */
const cycleDays = (billingCycle) => (isAnnualCycle(billingCycle) ? 365 : 30);

/**
 * Số tiền phải thu (VND) của một gói cước theo chu kỳ thanh toán.
 * @param {{price: number|string, annualPrice: number|string}} plan
 * @param {string} billingCycle
 */
const planPriceVnd = (plan, billingCycle) => {
    const usdPrice = isAnnualCycle(billingCycle) ? plan.annualPrice : plan.price;
    return Math.round(parseFloat(usdPrice || 0) * VND_PER_USD);
};

/**
 * Nội dung chuyển khoản mà SePay sẽ gửi lại trong webhook.
 * Cú pháp: `PLAN <LANDLORD_ID> <PLAN_NAME> [YEAR]`
 */
const buildTransferCode = (landlordId, planName, billingCycle) =>
    `PLAN ${landlordId} ${String(planName).toUpperCase()}${isAnnualCycle(billingCycle) ? ' YEAR' : ''}`;

module.exports = {
    VND_PER_USD,
    isAnnualCycle,
    normalizeCycle,
    cycleDays,
    planPriceVnd,
    buildTransferCode
};
