require('dotenv').config();
const express = require('express');
const cors = require('cors');
const imaps = require('imap-simple');
const { simpleParser } = require('mailparser');

const app = express();
app.use(cors());

let latestEaCode = null;
let lastCodeTime = null;

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
        console.log('Connected to email inbox. Listening for EA codes...');
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
                
                // Regex looking for standard 6-digit verification codes
                const codeMatch = mail.text.match(/\b\d{6}\b/); 
                
                if (codeMatch) {
                    latestEaCode = codeMatch[0];
                    lastCodeTime = new Date();
                    console.log('Intercepted new code:', latestEaCode);
                }
            }
        });
    } catch (error) {
        console.error('IMAP Connection Error:', error.message);
    }
}
// Keep a simple count of how many times each PIN is used
const userStats = {};

app.get('/api/get-code', async (req, res) => {
    const pin = req.query.pin;

    // Ensure they provided a 4-digit PIN
    if (!pin || pin.length !== 4 || isNaN(pin)) {
        return res.json({ status: 'error', message: 'A valid 4-digit PIN is required.' });
    }

    if (!latestEaCode) {
        return res.json({ status: 'waiting', message: 'No recent code found.' });
    }
    
    const now = new Date();
    const diffMins = Math.round((now - lastCodeTime) / 60000);
    
    if (diffMins > 10) {
        latestEaCode = null; 
        return res.json({ status: 'expired', message: 'Code expired. Please request a new one.' });
    }

    // --- TRACKING AND NOTIFICATION LOGIC ---
    // Increase the count for this specific PIN
    userStats[pin] = (userStats[pin] || 0) + 1;

    // Send a notification to Discord
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (webhookUrl) {
        try {
            await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    content: `🚨 **Code Retrieved!**\nUser PIN: \`${pin}\`\nTotal times this PIN has been used: **${userStats[pin]}**` 
                })
            });
        } catch (err) {
            console.error('Failed to send Discord webhook:', err.message);
        }
    }

    // Return the code to the user
    res.json({ status: 'success', code: latestEaCode });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Web server running on port ${PORT}`);
    startImapListener();
});