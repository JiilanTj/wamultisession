const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

// Store the socket connection
let sock = null;
let qr = null;
let isConnected = false;
let disconnectTimer = null;
let isManualDisconnect = false;

// Create auth folder if it doesn't exist
const AUTH_FOLDER = path.join(__dirname, '../auth');
if (!fs.existsSync(AUTH_FOLDER)) {
    fs.mkdirSync(AUTH_FOLDER);
}

// Function to safely end socket
const safeEndSocket = () => {
    try {
        if (sock) {
            sock.ev.removeAllListeners();
            sock.end();
            sock = null;
        }
    } catch (error) {
        console.log('Error closing socket:', error);
    }
};

// Function to generate QR and handle auth
const generateQR = async () => {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth');
        
        // Safely end existing socket if any
        safeEndSocket();
        
        sock = makeWASocket({
            printQRInTerminal: false, // Disable QR in terminal
            auth: state,
            defaultQueryTimeoutMs: undefined
        });

        // Handle connection updates
        sock.ev.on('connection.update', async (update) => {
            try {
                const { connection, lastDisconnect, qr: currentQr } = update;

                if (currentQr) {
                    // Generate QR code as base64
                    qr = await qrcode.toDataURL(currentQr);
                }

                if (connection === 'close') {
                    const shouldReconnect = !isManualDisconnect && (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                    isConnected = false;
                    
                    // Clear disconnect timer if exists
                    if (disconnectTimer) {
                        clearTimeout(disconnectTimer);
                        disconnectTimer = null;
                    }
                    
                    if (shouldReconnect) {
                        generateQR().catch(console.error);
                    }
                }

                if (connection === 'open') {
                    isConnected = true;
                    isManualDisconnect = false;
                    console.log('Connected to WhatsApp, will disconnect in 5 seconds');
                    
                    // Set timer to disconnect after 5 seconds
                    disconnectTimer = setTimeout(() => {
                        console.log('Disconnecting after 5 seconds timeout');
                        if (sock) {
                            isManualDisconnect = true;
                            safeEndSocket();
                            isConnected = false;
                        }
                    }, 5000); // 5 seconds
                }
            } catch (error) {
                console.error('Error in connection update handler:', error);
            }
        });

        // Handle credentials update
        sock.ev.on('creds.update', async (creds) => {
            try {
                await saveCreds();
            } catch (error) {
                console.error('Error saving credentials:', error);
            }
        });

        // Handle general socket errors
        sock.ev.on('error', (err) => {
            console.error('Socket error:', err);
        });

        // Handle unexpected socket close
        sock.ws.on('close', () => {
            console.log('WebSocket closed');
        });

        // Handle socket errors
        sock.ws.on('error', (err) => {
            console.error('WebSocket error:', err);
        });

    } catch (error) {
        console.error('Error in generateQR:', error);
        throw error;
    }
};

// Function to connect to WhatsApp using saved auth
const connectToWhatsApp = async () => {
    try {
        if (isConnected) {
            return { success: true, message: 'Already connected to WhatsApp' };
        }

        // Check if auth files exist
        const authFiles = fs.readdirSync('auth');
        if (authFiles.length === 0) {
            return { success: false, message: 'No authentication data found. Please scan QR code first' };
        }

        const { state } = await useMultiFileAuthState('auth');
        
        // If sock exists, close it first
        if (sock) {
            isManualDisconnect = true;
            safeEndSocket();
        }

        // Clear any existing disconnect timer
        if (disconnectTimer) {
            clearTimeout(disconnectTimer);
            disconnectTimer = null;
        }

        isManualDisconnect = false;

        // Create new connection
        sock = makeWASocket({
            printQRInTerminal: false,
            auth: state,
            defaultQueryTimeoutMs: undefined
        });

        return { success: true, message: 'Successfully connected to WhatsApp' };
    } catch (error) {
        console.error('Error in connectToWhatsApp:', error);
        return { success: false, message: 'Failed to connect to WhatsApp' };
    }
};

// Controller to get QR code
const getQRCode = async (req, res) => {
    try {
        // Reset QR code
        qr = null;
        isManualDisconnect = false;
        
        // Generate new QR
        await generateQR();

        // Wait for QR to be generated
        let attempts = 0;
        while (!qr && attempts < 20) {
            await new Promise(resolve => setTimeout(resolve, 500));
            attempts++;
        }

        if (!qr) {
            return res.status(408).json({ 
                success: false, 
                message: 'QR Code generation timeout' 
            });
        }

        res.json({ 
            success: true, 
            qr: qr 
        });
    } catch (error) {
        console.error('Error in getQRCode:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error' 
        });
    }
};

// Controller to connect to WhatsApp
const connect = async (req, res) => {
    try {
        const result = await connectToWhatsApp();
        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    } catch (error) {
        console.error('Error in connect:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error' 
        });
    }
};

// Handle process-level promise rejections
process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});

module.exports = {
    getQRCode,
    connect
};
