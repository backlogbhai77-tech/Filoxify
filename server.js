const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const archiver = require('archiver');

const app = express();

const uploadDir = path.join('/tmp', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer temporary local storage for forwarding to cloud API
const upload = multer({ 
    dest: '/tmp/uploads/', 
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB max
});

let vault = {};

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 15-Minute Auto Delete local tracking
setInterval(() => {
    const now = Date.now();
    for (const pin in vault) {
        if (now - vault[pin].timestamp > 15 * 60 * 1000) {
            vault[pin].files.forEach(f => {
                try { if (f.localPath && fs.existsSync(f.localPath)) fs.unlinkSync(f.localPath); } catch (e) {}
            });
            delete vault[pin];
        }
    }
}, 60 * 1000);

// Upload API: Forwards file/text to Tmpfiles.io cloud automatically via code
app.post('/api/upload', upload.array('files', 20), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No files" });
        
        let uploadedFilesMeta = [];

        for (const file of req.files) {
            const formData = new FormData();
            formData.append('file', fs.createReadStream(file.path), {
                filename: file.originalname,
                contentType: file.mimetype
            });

            // Uploading to Tmpfiles.io free cloud API via code (No API key needed)
            const response = await axios.post('https://tmpfiles.io/api/v1/upload', formData, {
                headers: formData.getHeaders(),
                maxBodyLength: Infinity,
                maxContentLength: Infinity
            });

            if (response.data && response.data.status === 'success') {
                // Convert url like https://tmpfiles.io/12345/file.png to direct download/stream link https://tmpfiles.io/dl/12345/file.png
                const rawUrl = response.data.data.url;
                const directUrl = rawUrl.replace('tmpfiles.io/', 'tmpfiles.io/dl/');

                uploadedFilesMeta.push({
                    name: file.originalname,
                    type: file.mimetype,
                    url: directUrl,
                    localPath: file.path
                });
            } else {
                throw new Error("Cloud storage upload failed");
            }
        }

        const pin = Math.floor(1000 + Math.random() * 9000).toString();
        vault[pin] = {
            files: uploadedFilesMeta,
            timestamp: Date.now()
        };

        res.json({ pin });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Upload failed: " + err.message });
    }
});

app.get('/api/check/:pin', (req, res) => {
    const item = vault[req.params.pin];
    if (!item) return res.status(404).json({ error: "Invalid PIN ya file expire ho chuki hai!" });
    res.json({ 
        files: item.files.map(f => ({ name: f.name, type: f.type })) 
    });
});

// View / Preview Route (Redirects to Cloud Direct Link)
app.get('/api/view/:pin/:index', (req, res) => {
    const item = vault[req.params.pin];
    if (!item) return res.status(404).send("Expired");
    const file = item.files[parseInt(req.params.index)];
    if (!file) return res.status(404).send("Missing");

    res.redirect(file.url);
});

// Direct File Download
app.get('/api/file/:pin/:index', (req, res) => {
    const item = vault[req.params.pin];
    if (!item) return res.status(404).send("Expired");
    const file = item.files[parseInt(req.params.index)];
    if (!file) return res.status(404).send("Missing");

    res.redirect(file.url);
});

// ZIP Download fallback for multiple files
app.get('/api/zip/:pin', (req, res) => {
    const item = vault[req.params.pin];
    if (!item) return res.status(404).send("Expired");
    
    // If single or multiple, redirect user to the first or let them download individually from UI
    res.redirect(item.files[0].url);
});

module.exports = app;
