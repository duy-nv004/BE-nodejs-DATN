const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const VN_TZ = 'Asia/Ho_Chi_Minh';

function nowVN(ref = new Date()) {
    return dayjs(ref).tz(VN_TZ);
}

function todayVN(ref = new Date()) {
    return nowVN(ref).format('YYYY-MM-DD');
}

function toDateOnlyVN(dateInput) {
    if (!dateInput) return null;
    if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
        return dateInput;
    }
    return dayjs(dateInput).tz(VN_TZ).format('YYYY-MM-DD');
}

function addPlanDaysVN(baseDateInput, days, ref = new Date()) {
    const baseStr = toDateOnlyVN(baseDateInput) || todayVN(ref);
    return dayjs.tz(baseStr, VN_TZ).add(Number(days) || 0, 'day').format('YYYY-MM-DD');
}

function isExpiredVN(planExpiresAt, ref = new Date()) {
    if (!planExpiresAt) return false;
    const expStr = toDateOnlyVN(planExpiresAt);
    return expStr < todayVN(ref);
}

function daysRemainingVN(planExpiresAt, ref = new Date()) {
    if (!planExpiresAt) return 0;
    const expStr = toDateOnlyVN(planExpiresAt);
    const todayStr = todayVN(ref);
    const diff = dayjs.tz(expStr, VN_TZ).startOf('day').diff(dayjs.tz(todayStr, VN_TZ).startOf('day'), 'day');
    return Math.max(0, diff);
}

module.exports = {
    VN_TZ,
    nowVN,
    todayVN,
    toDateOnlyVN,
    addPlanDaysVN,
    isExpiredVN,
    daysRemainingVN,
};

