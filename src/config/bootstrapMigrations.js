const { DataTypes: DT } = require('sequelize');

const ensureIndexWithOptions = async (queryInterface, table, name, fields, { unique = false } = {}) => {
  try {
    const indexes = await queryInterface.showIndex(table);
    const exists = indexes.some(idx => idx.name === name);
    if (!exists) {
      await queryInterface.addIndex(table, fields, { unique, name });
      console.log(`${unique ? '🔒 Đã thêm unique index' : '📇 Đã thêm index'} ${name} trên bảng ${table}`);
    }
  } catch (err) {
    console.warn(`⚠️ Không thể thêm index ${name} trên ${table}:`, err.message);
  }
};

/**
 * Đảm bảo unique index tồn tại mà không ném lỗi nếu index đã có trước đó.
 */
const ensureUniqueIndex = (queryInterface, table, name, fields) =>
  ensureIndexWithOptions(queryInterface, table, name, fields, { unique: true });

const ensureIndex = (queryInterface, table, name, fields) =>
  ensureIndexWithOptions(queryInterface, table, name, fields, { unique: false });

/**
 * Đồng bộ hóa các cột mở rộng và unique index khi khởi động hệ thống.
 * Tách biệt khỏi index.js để giữ file khởi động gọn gàng và chuẩn kiến trúc.
 */
const runBootstrapMigrations = async (sequelize) => {
  const queryInterface = sequelize.getQueryInterface();

  // 1. Đồng bộ cột cho bảng Users
  const tableDefinition = await queryInterface.describeTable('Users');
  const userCols = {
    status: { type: DT.STRING, defaultValue: 'active' },
    aiUseCountThisMonth: { type: DT.INTEGER, defaultValue: 0 },
    lastAiUseMonth: { type: DT.STRING, allowNull: true },
    chatUseCountThisMonth: { type: DT.INTEGER, defaultValue: 0 },
    lastChatUseMonth: { type: DT.STRING, allowNull: true },
    cccd: { type: DT.STRING, allowNull: true },
    dob: { type: DT.STRING, allowNull: true },
    hometown: { type: DT.TEXT, allowNull: true },
    planExpiresAt: { type: DT.DATEONLY, allowNull: true },
    billingCycle: { type: DT.ENUM('monthly', 'annual'), allowNull: true },
    planSource: { type: DT.ENUM('sepay', 'admin'), allowNull: true },
    telegramLinkToken: { type: DT.STRING, allowNull: true },
    telegramLinkTokenExpiresAt: { type: DT.DATE, allowNull: true },
    lockReason: { type: DT.STRING(500), allowNull: true },
    tokenVersion: { type: DT.INTEGER, allowNull: false, defaultValue: 0 },
    resetPasswordToken: { type: DT.STRING, allowNull: true },
    resetPasswordExpiresAt: { type: DT.DATE, allowNull: true },
  };
  for (const [col, def] of Object.entries(userCols)) {
    if (!tableDefinition[col]) {
      await queryInterface.addColumn('Users', col, def);
      console.log(`📁 Thêm cột ${col} vào bảng Users thành công!`);
    }
  }

  // Tự động dọn dẹp các cột cấu hình ngân hàng cũ của chủ trọ nếu còn tồn tại
  for (const oldCol of ['bankId', 'bankAccount', 'bankAccountName']) {
    if (tableDefinition[oldCol]) {
      try {
        await queryInterface.removeColumn('Users', oldCol);
        console.log(`🗑️ Đã xóa cột cũ ${oldCol} khỏi bảng Users`);
      } catch (e) {
        // bỏ qua nếu đã xóa
      }
    }
  }

  // 2. Đồng bộ thêm cột cho bảng Contracts
  const contractsTableDefinition = await queryInterface.describeTable('Contracts');
  const contractCols = {
    landlordName: { type: DT.STRING, allowNull: true },
    landlordPhone: { type: DT.STRING, allowNull: true },
    landlordCccd: { type: DT.STRING, allowNull: true },
    landlordDob: { type: DT.STRING, allowNull: true },
    landlordHometown: { type: DT.TEXT, allowNull: true },
    landlordAddress: { type: DT.TEXT, allowNull: true },
    tenantCccd: { type: DT.STRING, allowNull: true },
    tenantDob: { type: DT.STRING, allowNull: true },
    tenantHometown: { type: DT.TEXT, allowNull: true },
    tenantPhone: { type: DT.STRING, allowNull: true },
    numTenants: { type: DT.INTEGER, defaultValue: 1 },
    paymentDay: { type: DT.INTEGER, defaultValue: 30 },
    inventory: { type: DT.TEXT, allowNull: true },
    landlordSignature: { type: DT.TEXT('long'), allowNull: true },
    landlordSignedAt: { type: DT.DATE, allowNull: true },
    tenantSignature: { type: DT.TEXT('long'), allowNull: true },
    tenantSignedAt: { type: DT.DATE, allowNull: true },
    tenantSignedIp: { type: DT.STRING(64), allowNull: true },
    tenantSignedUserAgent: { type: DT.STRING(500), allowNull: true },
    contentHash: { type: DT.STRING(64), allowNull: true },
    rejectionReason: { type: DT.TEXT, allowNull: true },
    initialElectricity: { type: DT.DECIMAL(10, 2), defaultValue: 0 },
    initialWater: { type: DT.DECIMAL(10, 2), defaultValue: 0 },
    rentPrice: { type: DT.DECIMAL(10, 2), allowNull: true },
    terminatedAt: { type: DT.DATEONLY, allowNull: true },
    finalElectricity: { type: DT.INTEGER, allowNull: true },
    finalWater: { type: DT.INTEGER, allowNull: true },
    terminationNote: { type: DT.TEXT, allowNull: true },
    outstandingAmount: { type: DT.DECIMAL(12, 2), allowNull: true, defaultValue: 0 },
    tenantCccdFront: { type: DT.STRING, allowNull: true },
    tenantCccdBack: { type: DT.STRING, allowNull: true },
    firstLastMonthPolicy: { type: DT.STRING(10), allowNull: false, defaultValue: 'full' },
  };
  for (const [col, def] of Object.entries(contractCols)) {
    if (!contractsTableDefinition[col]) {
      await queryInterface.addColumn('Contracts', col, def);
    }
  }
  await sequelize.query(
    "UPDATE Contracts c JOIN Rooms r ON r.id = c.roomId SET c.rentPrice = r.price WHERE c.rentPrice IS NULL"
  );

  const occupantsTableDefinition = await queryInterface.describeTable('ContractOccupants');
  for (const col of ['cccdFrontImage', 'cccdBackImage']) {
    if (!occupantsTableDefinition[col]) {
      await queryInterface.addColumn('ContractOccupants', col, { type: DT.STRING, allowNull: true });
    }
  }
  await sequelize.query(
    "INSERT INTO ContractOccupants (contractId, fullName, cccd, dob, phone, isPrimary, residenceStatus, createdAt, updatedAt) "
    + "SELECT c.id, COALESCE(u.name, 'Khách thuê'), c.tenantCccd, c.tenantDob, c.tenantPhone, 1, 'not_registered', NOW(), NOW() "
    + "FROM Contracts c LEFT JOIN Users u ON u.id = c.tenantId "
    + "WHERE c.status IN ('active', 'pending_tenant_signature') "
    + "AND NOT EXISTS (SELECT 1 FROM ContractOccupants o WHERE o.contractId = c.id)"
  );
  console.log("📁 Đồng bộ hóa cấu trúc bảng Contracts thành công!");

  // 3. Đồng bộ cột cho bảng Invoices
  const invoicesTableDefinition = await queryInterface.describeTable('Invoices');
  const newInvoiceColumns = {
    tenantId: { type: DT.INTEGER, allowNull: true },
    contractId: { type: DT.INTEGER, allowNull: true },
    dueDate: { type: DT.DATEONLY, allowNull: true },
    paidAmount: { type: DT.DECIMAL(10, 2), defaultValue: 0 },
    paidAt: { type: DT.DATE, allowNull: true },
    paymentMethod: { type: DT.STRING(20), allowNull: true },
    electricityOld: { type: DT.INTEGER, allowNull: true },
    electricityNew: { type: DT.INTEGER, allowNull: true },
    waterOld: { type: DT.INTEGER, allowNull: true },
    waterNew: { type: DT.INTEGER, allowNull: true },
    electricityPrice: { type: DT.DECIMAL(10, 2), allowNull: true },
    waterPrice: { type: DT.DECIMAL(10, 2), allowNull: true },
    repairFee: { type: DT.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    prorated: { type: DT.BOOLEAN, allowNull: false, defaultValue: false },
    daysCharged: { type: DT.INTEGER, allowNull: true },
    status: { type: DT.STRING(20), allowNull: true, defaultValue: 'unpaid' },
    deletedAt: { type: DT.DATE, allowNull: true },
  };
  for (const [col, def] of Object.entries(newInvoiceColumns)) {
    if (!invoicesTableDefinition[col]) {
      await queryInterface.addColumn('Invoices', col, def);
      console.log(`📁 Thêm cột ${col} vào bảng Invoices thành công!`);
    }
  }
  await sequelize.query(
    "UPDATE Invoices SET paidAt = updatedAt, paidAmount = totalAmount WHERE isPaid = 1 AND paidAt IS NULL"
  );
  await sequelize.query(
    "UPDATE Invoices SET status = 'paid' WHERE isPaid = 1 AND (status IS NULL OR status = 'unpaid')"
  );
  await sequelize.query(
    "UPDATE Invoices i JOIN Contracts c ON c.id = i.contractId "
    + "SET i.dueDate = DATE_ADD(MAKEDATE(i.year, 1), INTERVAL (i.month - 1) MONTH) "
    + "+ INTERVAL (LEAST(COALESCE(c.paymentDay, 30), DAY(LAST_DAY(DATE_ADD(MAKEDATE(i.year, 1), INTERVAL (i.month - 1) MONTH)))) - 1) DAY "
    + "WHERE i.dueDate IS NULL"
  );

  // 4. Đồng bộ cột cho bảng SePayEvents (T1.2, T1.3)
  const sepayTableDefinition = await queryInterface.describeTable('SePayEvents');
  const newSepayColumns = {
    status: { type: DT.STRING(20), allowNull: false, defaultValue: 'PROCESSED' },
    invoiceId: { type: DT.INTEGER, allowNull: true },
    landlordId: { type: DT.INTEGER, allowNull: true },
    errorReason: { type: DT.TEXT, allowNull: true },
  };
  for (const [col, def] of Object.entries(newSepayColumns)) {
    if (!sepayTableDefinition[col]) {
      await queryInterface.addColumn('SePayEvents', col, def);
    }
  }

  // 5. Đồng bộ cột cho bảng SupportRequests (S1)
  const supportTableDefinition = await queryInterface.describeTable('SupportRequests');
  const newSupportColumns = {
    category: { type: DT.STRING(30), allowNull: false, defaultValue: 'other' },
    images: { type: DT.TEXT, allowNull: true },
    landlordNote: { type: DT.TEXT, allowNull: true },
    repairCost: { type: DT.DECIMAL(12, 0), allowNull: true },
    chargeToTenant: { type: DT.BOOLEAN, allowNull: false, defaultValue: false },
    invoiceId: { type: DT.INTEGER, allowNull: true }
  };
  for (const [col, def] of Object.entries(newSupportColumns)) {
    if (!supportTableDefinition[col]) {
      await queryInterface.addColumn('SupportRequests', col, def);
      console.log(`📁 Thêm cột ${col} vào bảng SupportRequests thành công!`);
    }
  }

  // 6. T2.17: lý do từ chối ticket khiếu nại
  const ticketsTableDefinition = await queryInterface.describeTable('LandlordTickets');
  if (!ticketsTableDefinition.rejectReason) {
    await queryInterface.addColumn('LandlordTickets', 'rejectReason', { type: DT.TEXT, allowNull: true });
    console.log("📁 Thêm cột rejectReason vào bảng LandlordTickets thành công!");
  }

  // 7. Đồng bộ cột cho bảng MeterReadings (kỳ chốt số & thay đồng hồ T2.4)
  const readingsTableDefinition = await queryInterface.describeTable('MeterReadings');
  for (const [col, def] of Object.entries({
    period: { type: DT.STRING(7), allowNull: true },
    meterReset: { type: DT.BOOLEAN, defaultValue: false },
    resetReason: { type: DT.STRING(255), allowNull: true },
  })) {
    if (!readingsTableDefinition[col]) {
      await queryInterface.addColumn('MeterReadings', col, def);
    }
  }

  // 8. Đồng bộ thêm cột cho bảng Rooms và Buildings
  const buildingsTableDefinition = await queryInterface.describeTable('Buildings');
  for (const [col, def] of Object.entries({
    city: { type: DT.STRING, allowNull: true },
    district: { type: DT.STRING, allowNull: true },
    ward: { type: DT.STRING, allowNull: true },
    latitude: { type: DT.DOUBLE, allowNull: true },
    longitude: { type: DT.DOUBLE, allowNull: true },
  })) {
    if (!buildingsTableDefinition[col]) {
      await queryInterface.addColumn('Buildings', col, def);
    }
  }

  const roomsTableDefinition = await queryInterface.describeTable('Rooms');
  for (const [col, def] of Object.entries({
    capacity: { type: DT.INTEGER, defaultValue: 2, allowNull: true },
    area: { type: DT.DECIMAL(10, 2), defaultValue: 20, allowNull: true },
    images: { type: DT.TEXT, allowNull: true },
    amenities: { type: DT.TEXT, allowNull: true },
    description: { type: DT.TEXT, allowNull: true },
    depositAmount: { type: DT.DECIMAL(12, 2), defaultValue: 0, allowNull: true },
  })) {
    if (!roomsTableDefinition[col]) {
      await queryInterface.addColumn('Rooms', col, def);
    }
  }

  // 9. Đồng bộ cột maxChatCallsPerMonth cho bảng Plans
  const plansTableDefinition = await queryInterface.describeTable('Plans');
  if (!plansTableDefinition.maxChatCallsPerMonth) {
    await queryInterface.addColumn('Plans', 'maxChatCallsPerMonth', { type: DT.INTEGER, defaultValue: 20, allowNull: true });
    console.log("📁 Thêm cột maxChatCallsPerMonth vào bảng Plans thành công!");
  }

  // 9. Đồng bộ các Unique Index cho DB cũ (T1.1, T2.1, T2.13)
  await ensureUniqueIndex(queryInterface, 'Invoices', 'invoices_room_period_unique', ['roomId', 'month', 'year']);
  await ensureUniqueIndex(queryInterface, 'MeterReadings', 'readings_room_type_period_unique', ['roomId', 'type', 'period']);
  await ensureUniqueIndex(queryInterface, 'Rooms', 'rooms_building_roomnumber_unique', ['buildingId', 'roomNumber']);
  await ensureUniqueIndex(queryInterface, 'Services', 'services_building_unique', ['buildingId']);
  await ensureUniqueIndex(queryInterface, 'Users', 'users_telegram_chat_id_unique', ['telegramChatId']);

  // 10. Đồng bộ cột RoomBookings (lookupToken, holdExpiresAt, status deposit_conflict) & DepositRecords (bookingId)
  try {
    const rbTable = await queryInterface.describeTable('RoomBookings');
    if (!rbTable.lookupToken) {
      await queryInterface.addColumn('RoomBookings', 'lookupToken', { type: DT.STRING(64), allowNull: true });
    }
    if (!rbTable.holdExpiresAt) {
      await queryInterface.addColumn('RoomBookings', 'holdExpiresAt', { type: DT.DATE, allowNull: true });
    }
    await sequelize.query(
      "ALTER TABLE RoomBookings MODIFY COLUMN status ENUM('pending','confirmed','deposit_paid','contract_created','cancelled','rejected','deposit_conflict') NOT NULL DEFAULT 'pending'"
    ).catch(() => {});
  } catch {
    // Bỏ qua nếu bảng chưa được sync lần đầu
  }

  try {
    const drTable = await queryInterface.describeTable('DepositRecords');
    if (!drTable.bookingId) {
      await queryInterface.addColumn('DepositRecords', 'bookingId', { type: DT.INTEGER, allowNull: true });
    }
    await queryInterface.changeColumn('DepositRecords', 'contractId', { type: DT.INTEGER, allowNull: true }).catch(() => {});
  } catch {
    // Bỏ qua nếu bảng chưa tồn tại
  }

  // 11. Composite index cho truy vấn phòng công khai & lọc hóa đơn theo chủ trọ + kỳ
  await ensureIndex(queryInterface, 'Rooms', 'rooms_status_price_area_idx', ['status', 'price', 'area']);
  await ensureIndex(queryInterface, 'Buildings', 'buildings_city_district_idx', ['city', 'district']);
  await ensureIndex(queryInterface, 'Invoices', 'invoices_landlord_year_month_status_idx', ['landlordId', 'year', 'month', 'isPaid']);
};

module.exports = {
  ensureUniqueIndex,
  ensureIndex,
  runBootstrapMigrations,
};

