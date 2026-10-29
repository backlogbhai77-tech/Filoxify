// Vercel catch-all API function. Keeps /api/* requests on the Express API
// instead of accidentally returning the static index.html page.
module.exports = require('../server');
