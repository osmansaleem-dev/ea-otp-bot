require('dotenv').config();
const express = require('express');
const cors = require('cors');
const imaps = require('imap-simple');
const { simpleParser } = require('mailparser');

const app = express();
app.use(cors());

// State variables
let latestEaCode = null;
let lastEaTime = null;
let latestSteamCode = null;
let lastSteamTime = null;
const userStats = {};

const config = {
    imap: {
        user: process.env.EMAIL_USER,
        password: process.env.EMAIL_APP_PASSWORD,
        host: process.env.EMAIL_HOST,
        port: process.env.EMAIL_PORT,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 5000
    }
};

async function startImapListener() {
    try {
        const connection = await imaps.connect(config);
        console.log('Connected to email inbox. Listening for EA and Steam codes...');
        await connection.openBox('INBOX');

        connection.on('mail', async () => {
            const searchCriteria = ['UNSEEN'];
            const fetchOptions = { bodies: [''], markSeen: true };
            
            const messages = await connection.search(searchCriteria, fetchOptions);
            
            for (let item of messages) {
                const all = item.parts.find(part => part.which === '');
                const id = item.attributes.uid;
                const idHeader = 'Imap-Id: ' + id + '\r\n';
                
                const mail = await simpleParser(idHeader + all.body);
                const emailContent = (mail.text || mail.html || "").toString();

                // 1. Steam Guard parsing (5-character uppercase alphanumeric)
                const steamMatch = emailContent.match(/\b[A-Z0-9]{5}\b/);
                if (steamMatch && emailContent.toLowerCase().includes('steam')) {
                    latestSteamCode = steamMatch[0];
                    lastSteamTime = new Date();
                    console.log('Intercepted Steam code:', latestSteamCode);
                }

                // 2. EA verification parsing (6-digit numeric)
                const eaMatch = emailContent.match(/\b\d{6}\b/);
                if (eaMatch) {
                    latestEaCode = eaMatch[0];
                    lastEaTime = new Date();
                    console.log('Intercepted EA code:', latestEaCode);
                }
            }
        });
    } catch (error) {
        console.error('IMAP Connection Error:', error.message);
    }
}

app.get('/api/get-code', async (req, res) => {
    const pin = req.query.pin;
    const service = (req.query.service || 'ea').toLowerCase(); // 'ea' or 'steam'

    // Validate 4-digit numeric PIN
    if (!pin || pin.length !== 4 || isNaN(pin)) {
        return res.json({ status: 'error', message: 'A valid 4-digit PIN is required.' });
    }

    let codeToReturn = null;
    let timeToCheck = null;

    if (service === 'steam') {
        codeToReturn = latestSteamCode;
        timeToCheck = lastSteamTime;
    } else {
        codeToReturn = latestEaCode;
        timeToCheck = lastEaTime;
    }

    if (!codeToReturn) {
        return res.json({ 
            status: 'waiting', 
            message: `No recent ${service.toUpperCase()} code found.` 
        });
    }
    
    // Check 10-minute expiration window
    const now = new Date();
    const diffMins = Math.round((now - timeToCheck) / 60000);
    
    if (diffMins > 10) {
        if (service === 'steam') latestSteamCode = null;
        else latestEaCode = null;
        return res.json({ status: 'expired', message: 'Code expired. Please request a new one.' });
    }

    // Update PIN stats
    userStats[pin] = (userStats[pin] || 0) + 1;

    // Discord Webhook Notification
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (webhookUrl) {
        try {
            await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    content: `🚨 **${service.toUpperCase()} Code Retrieved!**\nUser PIN: \`${pin}\`\nTotal times used: **${userStats[pin]}**` 
                })
            });
        } catch (err) {
            console.error('Failed to send Discord webhook:', err.message);
        }
    }

    // Return the code
    res.json({ status: 'success', code: codeToReturn });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Web server running on port ${PORT}`);
    startImapListener();
});