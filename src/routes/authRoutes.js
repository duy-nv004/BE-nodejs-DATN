const express = require('express');
const router = express.Router();
const { registerLandlord, login, createTenant } = require('../controllers/authController');
const { protect, authorize } = require('../middleware/authMiddleware');

router.post('/register', registerLandlord);
router.post('/login', login);
router.post('/create-tenant', protect, authorize('landlord'), createTenant);

module.exports = router;