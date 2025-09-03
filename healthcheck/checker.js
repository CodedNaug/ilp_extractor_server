import fetch from "node-fetch"; // or built-in fetch in Node 18+

function startHealthCheck(url) {
    async function ping() {
        try {
            const res = await fetch(url, { method: "GET" });
            console.log(`[FateCheck] ${url} responded with ${res.status} at ${new Date().toISOString()}`);
        } catch (err) {
            console.error(`[FateCheck] ${url} failed:`, err);
        }

        // schedule next ping randomly within 10 minutes
        const nextDelayMs = Math.floor(Math.random() * 10 * 60 * 1000);
        console.log(`[HealthCheck] Next check in ${(nextDelayMs / 1000 / 60).toFixed(2)} min`);
        setTimeout(ping, nextDelayMs);
    }

    // kick off immediately
    ping();
}