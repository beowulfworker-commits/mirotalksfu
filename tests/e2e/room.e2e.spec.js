const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const baseURL = process.env.E2E_BASE_URL || 'https://localhost:3010';
let serverProcess;
let usingExistingServer = false;

async function waitForServer(url, retries = 30) {
    let lastError;
    for (let attempt = 0; attempt < retries; attempt += 1) {
        try {
            const response = await fetch(url, { redirect: 'manual' });
            if (response.ok || response.status === 302) return;
            lastError = new Error(`Unexpected response status: ${response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw lastError;
}

async function openClient(browser, roomId, name) {
    const context = await browser.newContext({
        permissions: ['camera', 'microphone'],
        ignoreHTTPSErrors: true,
    });

    await context.addInitScript(() => {
        const fakeDisplayMedia = async (constraints) => {
            const canvas = document.createElement('canvas');
            canvas.width = 1280;
            canvas.height = 720;
            const ctx = canvas.getContext('2d');
            let frame = 0;
            setInterval(() => {
                if (!ctx) return;
                ctx.fillStyle = `hsl(${frame % 360}, 70%, 45%)`;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.fillStyle = '#ffffff';
                ctx.font = '48px sans-serif';
                ctx.fillText(`Screen ${frame}`, 40, 80);
                frame += 1;
            }, 100);
            return canvas.captureStream(10);
        };

        if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
            navigator.mediaDevices.getDisplayMedia = fakeDisplayMedia;
        }
        if (navigator.getDisplayMedia) {
            navigator.getDisplayMedia = fakeDisplayMedia;
        }
    });

    const page = await context.newPage();
    const joinUrl = `${baseURL}/join?room=${roomId}&name=${name}&audio=1&video=1&screen=0&notify=0&chat=0`;

    await page.goto(joinUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof rc !== 'undefined' && rc && rc.socket && rc.socket.connected);
    await page.waitForFunction(() => typeof rc !== 'undefined' && rc && rc.peer_id);

    return { context, page };
}

async function ensureVideoOn(page) {
    const stopButton = page.locator('#stopVideoButton');
    if (await stopButton.isVisible()) return;
    await page.click('#startVideoButton');
    await page.waitForSelector('#stopVideoButton', { state: 'visible' });
}

async function ensureAudioOn(page) {
    const stopButton = page.locator('#stopAudioButton');
    if (await stopButton.isVisible()) return;
    await page.click('#startAudioButton');
    await page.waitForSelector('#stopAudioButton', { state: 'visible' });
}

async function assertNoScreenTiles(page) {
    await page.waitForFunction(() => document.querySelectorAll('.Camera[data-kind="screen"]').length === 0);
    const result = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.Camera[data-kind="screen"]'));
        const emptyCards = cards.filter((card) => !card.querySelector('video'));
        return { count: cards.length, emptyCount: emptyCards.length };
    });
    expect(result.count).toBe(0);
    expect(result.emptyCount).toBe(0);
}

async function waitForRemoteAudioIcon(page, peerId, shouldBeOn) {
    await page.waitForFunction(
        ({ remotePeerId, expectOn }) => {
            const audioButton = document.getElementById(`${remotePeerId}__audio`);
            if (!audioButton) return false;
            const className = audioButton.className || '';
            const isOff = className.includes('fa-microphone-slash');
            return expectOn ? !isOff : isOff;
        },
        { remotePeerId: peerId, expectOn: shouldBeOn }
    );
}

test.beforeAll(async () => {
    const serverPort = new URL(baseURL).port || '3010';
    try {
        await waitForServer(baseURL, 1);
        usingExistingServer = true;
        return;
    } catch (error) {
        serverProcess = spawn('node', ['app/src/Server.js'], {
            env: { ...process.env, SERVER_LISTEN_PORT: serverPort },
            stdio: 'inherit',
        });
        await waitForServer(baseURL);
    }
});

test.afterAll(async () => {
    if (!serverProcess || usingExistingServer) return;
    serverProcess.kill('SIGTERM');
});

test('room media controls clean up screen share tiles', async ({ browser }) => {
    test.setTimeout(300000);
    const roomId = `e2e-room-${Date.now()}`;

    const clientA = await openClient(browser, roomId, 'UserA');
    const clientB = await openClient(browser, roomId, 'UserB');

    const pageA = clientA.page;
    const pageB = clientB.page;

    await ensureVideoOn(pageA);
    await ensureVideoOn(pageB);
    await ensureAudioOn(pageA);

    await pageA.waitForFunction(() => document.querySelectorAll('.Camera').length >= 2);
    await pageB.waitForFunction(() => document.querySelectorAll('.Camera').length >= 2);

    const peerAId = await pageA.evaluate(() => rc.peer_id);
    const peerBId = await pageB.evaluate(() => rc.peer_id);

    await pageA.waitForFunction(
        (peerId) => !!document.querySelector(`.Camera[data-peer-id="${peerId}"][data-kind="camera"] video`),
        peerBId
    );
    await pageB.waitForFunction(
        (peerId) => !!document.querySelector(`.Camera[data-peer-id="${peerId}"][data-kind="camera"] video`),
        peerAId
    );

    for (let i = 0; i < 2; i += 1) {
        await pageA.click('#stopVideoButton');
        await pageB.waitForFunction(
            (peerId) => !document.querySelector(`.Camera[data-peer-id="${peerId}"][data-kind="camera"] video`),
            peerAId
        );

        await pageA.click('#startVideoButton');
        await pageB.waitForFunction(
            (peerId) => !!document.querySelector(`.Camera[data-peer-id="${peerId}"][data-kind="camera"] video`),
            peerAId
        );
    }

    for (let i = 0; i < 2; i += 1) {
        await pageA.click('#stopAudioButton');
        await waitForRemoteAudioIcon(pageB, peerAId, false);

        await pageA.click('#startAudioButton');
        await waitForRemoteAudioIcon(pageB, peerAId, true);
    }

    for (let i = 0; i < 1; i += 1) {
        await pageA.click('#startScreenButton');
        await pageB.waitForFunction((peerId) => {
            const peerEntry = rc?.peers?.get(peerId);
            return !!peerEntry?.peer_info?.peer_screen;
        }, peerAId);

        await pageA.click('#stopScreenButton');
        await assertNoScreenTiles(pageA);
        await assertNoScreenTiles(pageB);
    }

    await pageA.click('#startScreenButton');
    await pageB.waitForFunction((peerId) => {
        const peerEntry = rc?.peers?.get(peerId);
        return !!peerEntry?.peer_info?.peer_screen;
    }, peerAId);

    await pageA.evaluate(() => {
        const producerId = rc.screenProducerId;
        const videoEl = producerId ? document.getElementById(producerId) : null;
        const track = videoEl?.srcObject?.getVideoTracks()?.[0] || null;
        if (track) track.stop();
    });

    await assertNoScreenTiles(pageA);
    await assertNoScreenTiles(pageB);

    await clientA.context.close();
    await clientB.context.close();
});
