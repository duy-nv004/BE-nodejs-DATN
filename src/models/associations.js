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
};

module.exports = setupAssociations;