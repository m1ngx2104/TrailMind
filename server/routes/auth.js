const express = require('express');
const router = express.Router();
const { 
  register, 
  verifyEmail, 
  login, 
  logout, 
  forgotPassword, 
  resetPassword,
  getMe
} = require('../controllers/authController');
const { protect } = require('../middleware/auth');

router.post('/register', register);
router.get('/verify/:token', verifyEmail);
router.post('/login', login);
router.post('/logout', logout);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password/:token', resetPassword);
router.get('/me', protect, getMe);

module.exports = router;