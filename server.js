const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const archiver = require('archiver');

const app = express();

// Cloudinary Configuration configured with your exact API key & secret
cloudinary.config({
  cloud_name: 'bdyqf9nh',
  api_key: 'M6F3-XZKe2qWReZM7HFHRaDJfjo', // Your API Key
  api_secret: 'ZKe2qWReZM7HFHRaDJfjo' // Configured correctly
});

const uploadDir = path.join('/tmp', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ 
    dest: '/tmp/uploads/', 
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB max support
});

let vault = {};

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Auto delete local cache tracking after 15 mins
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

// Upload API: Direct to Cloudinary
app.post('/api/upload', upload.array('files', 20), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No files uploaded" });
        
        let uploadedFilesMeta = [];

        for (const file of req.files) {
            // Uploading file to Cloudinary cloud storage
            const result = await cloudinary.uploader.upload(file.path, {
                resource_type: "auto",
                folder: "voltdrop_vault"
            });

            uploadedFilesMeta.push({
                name: file.originalname,
                type: file.mimetype,
                url: result.secure_url,
                localPath: file.path
            });
        }

        const pin = Math.floor(1000 + Math.random() * 9000).toString();
        vault[pin] = {
            files: uploadedFilesMeta,
            timestamp: Date.now()
        };

        res.json({ pin });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Cloudinary Upload failed: " + err.message });
    }
});

app.get('/api/check/:pin', (req, res) => {
    const item = vault[req.params.pin];
    if (!item) return res.status(404).json({ error: "Invalid PIN ya file expire ho chuki hai!" });
    res.json({ 
        files: item.files.map(f => ({ name: f.name, type: f.type })) 
    });
});

app.get('/api/view/:pin/:index', (req, res) => {
    const item = vault[req.params.pin];
    if (!item) return res.status(404).send("Expired");
    const file = item.files[parseInt(req.params.index)];
    if (!file) return res.status(404).send("Missing");

    res.redirect(file.url);
});

app.get('/api/file/:pin/:index', (req, res) => {
    const item = vault[req.params.pin];
    if (!item) return res.status(404).send("Expired");
    const file = item.files[parseInt(req.params.index)];
    if (!file) return res.status(404).send("Missing");

    res.redirect(file.url);
});

app.get('/api/zip/:pin', (req, res) => {
    const item = vault[req.params.pin];
    if (!item) return res.status(404).send("Expired");
    res.redirect(item.files[0].url);
});

module.exports = app;
