const express = require('express');
const router = express.Router();
const whatsappController = require('../controllers/whatsappController');

// Route to get QR Code for WhatsApp login
router.get('/qr', whatsappController.getQRCode);

module.exports = router;