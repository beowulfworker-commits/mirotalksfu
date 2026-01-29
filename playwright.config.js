const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests/e2e',
    timeout: 120000,
    expect: {
        timeout: 10000,
    },
    retries: 0,
    workers: 1,
    use: {
        baseURL: process.env.E2E_BASE_URL || 'https://localhost:3010',
        headless: true,
        ignoreHTTPSErrors: true,
        launchOptions: {
            args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
        },
    },
    projects: [
        {
            name: 'chromium',
            use: { browserName: 'chromium' },
        },
    ],
});
