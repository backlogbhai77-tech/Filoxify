const express = require('express');
const path = require('path');
const archiver = require('archiver');
const fs = require('fs');

const app = express();

let vault = {};

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Auto delete vault items after 15 mins
setInterval(() => {
    const now = Date.now();
    for (const pin in vault) {
        if (now - vault[pin].timestamp > 15 * 60 * 1000) {
            delete vault[pin];
        }
    }
}, 60 * 1000);

// Client direct upload ke baad sirf metadata (URL & Name) save karega
app.post('/api/save-vault', (req, res) => {
    try {
        const { files } = req.body;
        if (!files || files.length === 0) return res.status(400).json({ error: "No files metadata" });

        const pin = Math.floor(1000 + Math.random() * 9000).toString();
        vault[pin] = {
            files: files,
            timestamp: Date.now()
        };

        res.json({ pin });
    } catch (err) {
        res.status(500).json({ error: "Failed to save vault" });
    }
});

app.get('/api/check/:pin', (req, res) => {
    const item = vault[req.params.pin];
    if (!item) return res.status(404).json({ error: "Invalid PIN ya file expire ho chuki hai!" });
    res.json({ 
        files: item.files.map(f => ({ name: f.name, type: f.type, url: f.url })) 
    });
});

module.exports = app;
