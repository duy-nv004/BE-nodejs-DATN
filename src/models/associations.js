const User = require('./User');
const Role = require('./Role');
const Building = require('./Building');
const Room = require('./Room');
const Service = require('./Service');
const Contract = require('./Contract');
const MeterReading = require('./MeterReading');
const Invoice = require('./Invoice');
const SupportRequest = require('./SupportRequest');
const Plan = require('./Plan');

const setupAssociations = () => {
    // Role - User
    Role.hasMany(User, { foreignKey: 'roleId' });
    User.belongsTo(Role, { foreignKey: 'roleId', as: 'roleData' });

    // User - Building
    User.hasMany(Building, { foreignKey: 'landlordId', as: 'buildings' });
    Building.belongsTo(User, { foreignKey: 'landlordId', as: 'landlord' });

    // Building - Service
    Building.hasOne(Service, { foreignKey: 'buildingId', as: 'service' });
    Service.belongsTo(Building, { foreignKey: 'buildingId' });

    // Building - Room
    Building.hasMany(Room, { foreignKey: 'buildingId', as: 'rooms' });
    Room.belongsTo(Building, { foreignKey: 'buildingId', as: 'building' });

    // Room - Contract
    Room.hasMany(Contract, { foreignKey: 'roomId', as: 'contracts' });
    Contract.belongsTo(Room, { foreignKey: 'roomId', as: 'room' });

    // User - Contract
    User.hasMany(Contract, { foreignKey: 'tenantId', as: 'rentals' });
    Contract.belongsTo(User, { foreignKey: 'tenantId', as: 'tenant' });

    // Room - MeterReading
    Room.hasMany(MeterReading, { foreignKey: 'roomId', as: 'readings' });
    MeterReading.belongsTo(Room, { foreignKey: 'roomId' });

    Room.hasMany(Invoice, { foreignKey: 'roomId', as: 'invoices' });
    Invoice.belongsTo(Room, { foreignKey: 'roomId', as: 'roomDetails' });
    Invoice.belongsTo(User, { foreignKey: 'tenantId', as: 'tenant' });

    // SupportRequest
    User.hasMany(SupportRequest, { foreignKey: 'tenantId', as: 'supportRequests' });
    SupportRequest.belongsTo(User, { foreignKey: 'tenantId', as: 'tenant' });

    Room.hasMany(SupportRequest, { foreignKey: 'roomId', as: 'supportRequests' });
    SupportRequest.belongsTo(Room, { foreignKey: 'roomId', as: 'room' });

    // Notification
    const Notification = require('./Notification');
    User.hasMany(Notification, { foreignKey: 'userId', as: 'notifications' });
    Notification.belongsTo(User, { foreignKey: 'userId', as: 'user' });

    // AdminLog
    const AdminLog = require('./AdminLog');
    User.hasMany(AdminLog, { foreignKey: 'adminId', as: 'adminLogs' });
    AdminLog.belongsTo(User, { foreignKey: 'adminId', as: 'admin' });
    User.hasMany(AdminLog, { foreignKey: 'targetUserId', as: 'targetUserLogs' });
    AdminLog.belongsTo(User, { foreignKey: 'targetUserId', as: 'targetUser' });

    // LandlordTicket
    const LandlordTicket = require('./LandlordTicket');
    User.hasMany(LandlordTicket, { foreignKey: 'landlordId', as: 'tickets' });
    LandlordTicket.belongsTo(User, { foreignKey: 'landlordId', as: 'landlord' });

    // PlanUpgradeRequest
    const PlanUpgradeRequest = require('./PlanUpgradeRequest');
    User.hasMany(PlanUpgradeRequest, { foreignKey: 'landlordId', as: 'planUpgradeRequests' });
    PlanUpgradeRequest.belongsTo(User, { foreignKey: 'landlordId', as: 'landlord' });

    // DepositRecord — theo dõi tiền cọc theo hợp đồng
    const DepositRecord = require('./DepositRecord');
    Contract.hasMany(DepositRecord, { foreignKey: 'contractId', as: 'deposits' });
    DepositRecord.belongsTo(Contract, { foreignKey: 'contractId', as: 'contract' });

    // ContractRequest — yêu cầu trả phòng / gia hạn của khách (C5)
    const ContractRequest = require('./ContractRequest');
    Contract.hasMany(ContractRequest, { foreignKey: 'contractId', as: 'requests' });
    ContractRequest.belongsTo(Contract, { foreignKey: 'contractId', as: 'contract' });
    ContractRequest.belongsTo(User, { foreignKey: 'tenantId', as: 'tenant' });

    // ContractOccupant — người ở cùng & tạm trú (C6)
    const ContractOccupant = require('./ContractOccupant');
    Contract.hasMany(ContractOccupant, { foreignKey: 'contractId', as: 'occupants' });
    ContractOccupant.belongsTo(Contract, { foreignKey: 'contractId', as: 'contract' });

    // RefreshToken — quản lý phiên đăng nhập đơn thiết bị
    const RefreshToken = require('./RefreshToken');
    User.hasMany(RefreshToken, { foreignKey: 'userId', as: 'refreshTokens' });
    RefreshToken.belongsTo(User, { foreignKey: 'userId', as: 'user' });

    // SePayEvent — nhật ký đối soát webhook thanh toán
    const SePayEvent = require('./SePayEvent');
    User.hasMany(SePayEvent, { foreignKey: 'landlordId', as: 'sepayEvents' });
    SePayEvent.belongsTo(User, { foreignKey: 'landlordId', as: 'landlord' });
};

module.exports = setupAssociations;
