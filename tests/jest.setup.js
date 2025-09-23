// Initialize global variables for Jest tests here
// Allow overriding the target SillyTavern instance via environment variable.
// Default to the proxy gateway that serves the /st frontend.
global.ST_URL = process.env.ST_URL || 'http://localhost:3080';

if (global.context && typeof global.context.isIncognito !== 'function') {
    global.context.isIncognito = () => false;
}
