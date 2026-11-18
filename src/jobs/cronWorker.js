/**
 * Cron Worker Module with Distributed Locking
 * Tách biệt các tác vụ định kỳ khỏi tiến trình chính và đảm bảo khi scale nhiều pod/container,
 * chỉ duy nhất 1 worker được thực thi tác vụ tại một thời điểm (chống trùng lặp gửi email/hóa đơn).
 */
const { acquireLock, releaseLock } = require('../config/redis');

/**
 * Chạy một tác vụ định kỳ có khóa phân tán.
 * Nếu một pod khác đang chạy tác vụ này, pod hiện tại sẽ an toàn bỏ qua (skip).
 */
const runJobWithLock = async (jobName, taskFn, lockTtlMs = 60000) => {
    // retries = 0: nếu không lấy được khóa ngay thì bỏ qua, tránh việc pod khác chạy lại sau đó
    const lockId = await acquireLock(`cron:${jobName}`, lockTtlMs, 0, 0);
    if (!lockId) {
        return { executed: false, skipped: true, jobName };
    }

    try {
        await taskFn();
        return { executed: true, skipped: false, jobName };
    } catch (err) {
        console.error(`❌ [CronWorker] Lỗi khi chạy job "${jobName}":`, err.message);
        throw err;
    } finally {
        await releaseLock(`cron:${jobName}`, lockId);
    }
};

/**
 * Khởi động các tác vụ định kỳ của hệ thống
 */
const startCronJobs = () => {
    const planService = require('../services/planService');
    const contractService = require('../services/contractService');
    const notificationService = require('../services/notificationService');
    const bookingService = require('../services/bookingService');

    // 1. Quét kiểm tra gói cước hết hạn (mỗi 1 giờ)
    const checkExpiredPlans = async () => {
        await runJobWithLock('autoCheckExpiredPlans', async () => {
            const res = await planService.expireAllOverduePlans();
            const updatedCount = typeof res === 'number' ? res : (res?.updatedCount || 0);
            if (updatedCount > 0) {
                console.log(`⏰ [Cron] Đã chuyển ${updatedCount} tài khoản quá hạn về Free.`);
            }
            if (typeof planService.expirePendingUpgradeRequests === 'function') {
                await planService.expirePendingUpgradeRequests();
            }
        }, 50000);
    };

    // 2. Nhắc hợp đồng sắp hết hạn (mỗi 24 giờ)
    const notifyExpiringContracts = async () => {
        await runJobWithLock('autoNotifyExpiringContracts', async () => {
            const n = await contractService.notifyExpiringContracts();
            if (n > 0) console.log(`⏰ [Cron] Đã gửi nhắc hết hạn cho ${n} hợp đồng.`);
            if (typeof contractService.expireStalePendingContracts === 'function') {
                await contractService.expireStalePendingContracts();
            }
        }, 120000);
    };

    // 3. Nhắc hóa đơn quá hạn (mỗi 1 giờ)
    const remindOverdueInvoices = async () => {
        await runJobWithLock('autoRemindOverdueInvoices', async () => {
            const n = await notificationService.remindOverdueInvoices();
            if (n > 0) console.log(`⏰ [Cron] Đã gửi ${n} nhắc hóa đơn quá hạn.`);
        }, 50000);
    };

    // 4. Hủy giữ chỗ đặt cọc quá hạn 15 phút (mỗi 5 phút)
    const releaseExpiredBookingHolds = async () => {
        await runJobWithLock('autoReleaseExpiredBookingHolds', async () => {
            if (typeof bookingService.releaseExpiredBookingHolds === 'function') {
                const n = await bookingService.releaseExpiredBookingHolds();
                if (n > 0) console.log(`⏰ [Cron] Đã hủy ${n} giữ chỗ đặt cọc quá hạn 15 phút.`);
            }
        }, 60000);
    };

    // Chạy lần đầu
    checkExpiredPlans().catch(() => {});
    notifyExpiringContracts().catch(() => {});
    remindOverdueInvoices().catch(() => {});
    releaseExpiredBookingHolds().catch(() => {});

    // Thiết lập chu kỳ
    const planTimer = setInterval(checkExpiredPlans, 3600000);
    const contractTimer = setInterval(notifyExpiringContracts, 86400000);
    const invoiceTimer = setInterval(remindOverdueInvoices, 3600000);
    const holdTimer = setInterval(releaseExpiredBookingHolds, 300000);

    return {
        stop: () => {
            clearInterval(planTimer);
            clearInterval(contractTimer);
            clearInterval(invoiceTimer);
            clearInterval(holdTimer);
        }
    };
};

module.exports = {
    runJobWithLock,
    startCronJobs
};

