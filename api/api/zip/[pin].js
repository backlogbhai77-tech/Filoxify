// Explicit Vercel route for /api/zip/:pin.
// The shared Express app contains the actual ZIP validation and streaming logic.
const app = require('../../server');
module.exports = app;
