const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

// Store the socket connections
let sessions = new Map();

// Function to get auth folder path for a phone number
const getAuthPath = (phoneNumber) => {
    // Validate phone number format
    if (!phoneNumber || !/^[0-9]+$/.test(phoneNumber)) {
        throw new Error('Invalid phone number format');
    }
    return path.join(__dirname, `../auth/auth-${phoneNumber}`);
};

// Function to safely end socket
const safeEndSocket = (phoneNumber) => {
    try {
        const session = sessions.get(phoneNumber);
        if (session?.sock) {
            session.sock.ev.removeAllListeners();
            session.sock.end();
            sessions.set(phoneNumber, { 
                ...session,
                sock: null,
                isConnected: false 
            });
        }
    } catch (error) {
        console.log('Error closing socket:', error);
    }
};

// Function to generate QR and handle auth
const generateQR = async (phoneNumber) => {
    try {
        const AUTH_FOLDER = getAuthPath(phoneNumber);
        
        // Create auth folder if it doesn't exist
        if (!fs.existsSync(AUTH_FOLDER)) {
            fs.mkdirSync(AUTH_FOLDER, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
        
        // Safely end existing socket if any
        safeEndSocket(phoneNumber);
        
        const sock = makeWASocket({
            printQRInTerminal: false,
            auth: state,
            defaultQueryTimeoutMs: undefined
        });

        // Initialize or update session
        sessions.set(phoneNumber, {
            sock,
            qr: null,
            isConnected: false,
            isManualDisconnect: false,
            disconnectTimer: null
        });

        // Handle connection updates
        sock.ev.on('connection.update', async (update) => {
            try {
                const { connection, lastDisconnect, qr: currentQr } = update;
                const session = sessions.get(phoneNumber);

                if (currentQr) {
                    // Generate QR code as base64
                    const qrCode = await qrcode.toDataURL(currentQr);
                    sessions.set(phoneNumber, { ...session, qr: qrCode });
                }

                if (connection === 'close') {
                    const shouldReconnect = !session.isManualDisconnect && 
                        (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                    
                    // Clear disconnect timer if exists
                    if (session.disconnectTimer) {
                        clearTimeout(session.disconnectTimer);
                    }
                    
                    sessions.set(phoneNumber, {
                        ...session,
                        isConnected: false,
                        disconnectTimer: null
                    });
                    
                    if (shouldReconnect) {
                        generateQR(phoneNumber).catch(console.error);
                    }
                }

                if (connection === 'open') {
                    console.log(`Connected to WhatsApp for ${phoneNumber}, will disconnect in 5 seconds`);
                    
                    // Set timer to disconnect after 5 seconds
                    const disconnectTimer = setTimeout(() => {
                        console.log(`Disconnecting ${phoneNumber} after 5 seconds timeout`);
                        sessions.set(phoneNumber, {
                            ...sessions.get(phoneNumber),
                            isManualDisconnect: true
                        });
                        safeEndSocket(phoneNumber);
                    }, 5000);

                    sessions.set(phoneNumber, {
                        ...session,
                        isConnected: true,
                        isManualDisconnect: false,
                        disconnectTimer
                    });
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
            console.log(`WebSocket closed for ${phoneNumber}`);
        });

        // Handle socket errors
        sock.ws.on('error', (err) => {
            console.error(`WebSocket error for ${phoneNumber}:`, err);
        });

    } catch (error) {
        console.error('Error in generateQR:', error);
        throw error;
    }
};

// Controller to get QR code
const getQRCode = async (req, res) => {
    try {
        const { phone } = req.query;
        
        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'Phone number is required as query parameter'
            });
        }

        // Reset QR code
        const session = sessions.get(phone) || {};
        sessions.set(phone, { 
            ...session,
            qr: null,
            isManualDisconnect: false 
        });
        
        // Generate new QR
        await generateQR(phone);

        // Wait for QR to be generated
        let attempts = 0;
        while (!sessions.get(phone)?.qr && attempts < 20) {
            await new Promise(resolve => setTimeout(resolve, 500));
            attempts++;
        }

        const currentSession = sessions.get(phone);
        if (!currentSession?.qr) {
            return res.status(408).json({ 
                success: false, 
                message: 'QR Code generation timeout' 
            });
        }

        res.json({ 
            success: true, 
            qr: currentSession.qr 
        });
    } catch (error) {
        console.error('Error in getQRCode:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Internal server error' 
        });
    }
};

// Function to connect to WhatsApp using saved auth
const connectToWhatsApp = async (phoneNumber) => {
    try {
        // Validate phone number
        if (!phoneNumber || !/^[0-9]+$/.test(phoneNumber)) {
            throw new Error('Invalid phone number format');
        }

        const session = sessions.get(phoneNumber);
        if (session?.isConnected) {
            return { success: true, message: 'Already connected to WhatsApp' };
        }

        const AUTH_FOLDER = getAuthPath(phoneNumber);
        
        // Check if auth files exist
        if (!fs.existsSync(AUTH_FOLDER)) {
            return { success: false, message: 'No authentication data found. Please scan QR code first' };
        }

        const { state } = await useMultiFileAuthState(AUTH_FOLDER);
        
        // If sock exists, close it first
        safeEndSocket(phoneNumber);

        // Clear any existing disconnect timer
        const currentSession = sessions.get(phoneNumber);
        if (currentSession?.disconnectTimer) {
            clearTimeout(currentSession.disconnectTimer);
        }

        // Create new connection
        const sock = makeWASocket({
            printQRInTerminal: false,
            auth: state,
            defaultQueryTimeoutMs: undefined
        });

        // Update session
        sessions.set(phoneNumber, {
            ...currentSession,
            sock,
            isConnected: false,
            isManualDisconnect: false,
            disconnectTimer: null
        });

        return { success: true, message: 'Connection process started' };
    } catch (error) {
        console.error('Error in connectToWhatsApp:', error);
        return { success: false, message: error.message || 'Failed to connect to WhatsApp' };
    }
};

// Controller to connect to WhatsApp
const connect = async (req, res) => {
    try {
        const { phone } = req.query;
        
        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'Phone number is required as query parameter'
            });
        }

        const result = await connectToWhatsApp(phone);
        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    } catch (error) {
        console.error('Error in connect:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Internal server error' 
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
