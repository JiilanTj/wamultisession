const express = require('express');
const router = express.Router();
const whatsappController = require('../controllers/whatsappController');

// Route to get QR Code for WhatsApp login
router.get('/qr', whatsappController.getQRCode);

// Route to connect to WhatsApp using saved auth
router.get('/connect', whatsappController.connect);

module.exports = router;