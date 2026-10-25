const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const app = express();

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ 
    dest: 'uploads/', 
    limits: { fileSize: 300 * 1024 * 1024 } 
});

let vault = {};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 15-Minute Auto Delete
setInterval(() => {
    const now = Date.now();
    for (const pin in vault) {
        if (now - vault[pin].timestamp > 15 * 60 * 1000) {
            vault[pin].files.forEach(f => {
                try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch (e) {}
            });
            delete vault[pin];
        }
    }
}, 60 * 1000);

app.post('/api/upload', upload.array('files', 20), (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No files" });
    const pin = Math.floor(1000 + Math.random() * 9000).toString();
    vault[pin] = {
        files: req.files.map(f => ({ 
            path: f.path, 
            name: f.originalname,
            type: f.mimetype 
        })),
        timestamp: Date.now()
    };
    res.json({ pin });
});

app.get('/api/check/:pin', (req, res) => {
    const item = vault[req.params.pin];
    if (!item) return res.status(404).json({ error: "Invalid PIN ya file expire ho chuki hai!" });
    res.json({ 
        files: item.files.map(f => ({ name: f.name, type: f.type })) 
    });
});

// View / Preview Route (In-Browser Stream)
app.get('/api/view/:pin/:index', (req, res) => {
    const item = vault[req.params.pin];
    if (!item) return res.status(404).send("Expired");
    const file = item.files[parseInt(req.params.index)];
    if (!file || !fs.existsSync(file.path)) return res.status(404).send("Missing");

    res.sendFile(path.resolve(file.path));
});

// Direct File Download
app.get('/api/file/:pin/:index', (req, res) => {
    const item = vault[req.params.pin];
    if (!item) return res.status(404).send("Expired");
    const file = item.files[parseInt(req.params.index)];
    if (!file || !fs.existsSync(file.path)) return res.status(404).send("Missing");

    res.download(file.path, file.name);
});

// ZIP Download
app.get('/api/zip/:pin', (req, res) => {
    const item = vault[req.params.pin];
    if (!item) return res.status(404).send("Expired");
    
    res.attachment(`bundle_${req.params.pin}.zip`);
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(res);
    item.files.forEach(f => {
        if (fs.existsSync(f.path)) archive.file(f.path, { name: f.name });
    });
    archive.finalize();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Vault running on ' + PORT));
